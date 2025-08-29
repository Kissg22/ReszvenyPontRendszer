'use strict';

/**
 * Vercel szerverless handler (orders/updated):
 * - Nyers body + HMAC
 * - Shop/topic guard
 * - Sor megkeresése (A oszlopban order.id)
 * - L:N frissítése (subtotal, total, tax) + O oszlop (módosítási jegyzet)
 */

require('dotenv').config();

const {
  getRawBody,
  verifyHmac,
  requireShopAndTopic,
  sendJson,
  getSheets,
  sheetRange,
  formatHuDate,
  formatDecimal,
  withRetry,
  requireEnv,
} = require('./utils');

requireEnv(['SPREADSHEET_ID', 'SHEET_NAME']);
module.exports.config = { api: { bodyParser: false } };

// --- Segédfüggvények ---
async function findRowByOrderId(sheets, spreadsheetId, sheetName, orderId) {
  const range = sheetRange(sheetName, 'A:A');
  const resp = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    majorDimension: 'COLUMNS',
  }));
  const colA = resp.data?.values?.[0] || [];
  const idx = colA.findIndex(v => String(v) === String(orderId));
  return idx === -1 ? -1 : (idx + 1);
}

function pickNumberLike(...candidates) {
  for (const v of candidates) {
    const n = Number(String(v ?? '').replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function extractAdjustData(order) {
  const subtotal = pickNumberLike(order.current_subtotal_price, order.subtotal_price, order.subtotal_price_set?.shop_money?.amount);
  const total    = pickNumberLike(order.current_total_price,     order.total_price,     order.total_price_set?.shop_money?.amount);
  const tax      = pickNumberLike(order.current_total_tax,       order.total_tax,       order.total_tax_set?.shop_money?.amount);

  let note = (order.note || '').toString();
  if (Array.isArray(order.note_attributes) && order.note_attributes.length) {
    const attrs = order.note_attributes
      .map(a => `${a.name ?? ''}${a.value ? `: ${a.value}` : ''}`.trim())
      .filter(Boolean)
      .join('; ');
    note = [note, attrs].filter(Boolean).join(' | ');
  }

  return { subtotal, total, tax, note };
}

// ---- Handler (Vercel) ----
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }

    requireShopAndTopic(req, 'orders/updated');

    const raw = await getRawBody(req);
    if (!verifyHmac(req, raw)) {
      return sendJson(res, 401, { ok: false, error: 'Bad HMAC' });
    }

    const order = JSON.parse(raw.toString('utf8'));
    const orderId = order.id;
    if (!orderId) return sendJson(res, 400, { ok: false, error: 'Hiányzó order.id' });

    const sheets = await getSheets();
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = process.env.SHEET_NAME;

    const row = await findRowByOrderId(sheets, spreadsheetId, sheetName, orderId);
    if (row === -1) {
      return sendJson(res, 404, { ok: false, error: `Order ID nem található a táblában: ${orderId}` });
    }

    const { subtotal, total, tax, note } = extractAdjustData(order);
    const noteCellValue = `módosítva: ${formatHuDate(new Date().toISOString())}${note ? ` – ${note}` : ''}`;

    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: sheetRange(sheetName, `L${row}:N${row}`), values: [[formatDecimal(subtotal), formatDecimal(total), formatDecimal(tax)]] },
          { range: sheetRange(sheetName, `O${row}`),         values: [[noteCellValue]] },
        ],
      },
    }));

    return sendJson(res, 200, {
      ok: true,
      row,
      updated: {
        subtotal: formatDecimal(subtotal),
        total: formatDecimal(total),
        tax: formatDecimal(tax),
        note: noteCellValue,
      },
    });
  } catch (err) {
    console.error(err);
    const code = err.status || err.code || 500;
    return sendJson(res, code, { ok: false, error: err.message || 'Internal Server Error' });
  }
};
