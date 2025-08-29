'use strict';

/**
 * Vercel szerverless handler (orders/updated | orders/edited | refunds/create):
 * - Nyers body + HMAC
 * - Shop/topic guard (több topic támogatás)
 * - Sor megkeresése (A oszlopban order.id)
 * - L:N frissítése (subtotal, total, tax) + O oszlop (módosítási jegyzet)
 *   - refunds/create esetén, ha elérhető, GraphQL-lel lekérjük a friss totals értékeket
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
  // GraphQL kliens a refunds esethez (opcionális, de próbáljuk)
  shopifyGQL,
} = require('./utils');

requireEnv(['SPREADSHEET_ID', 'SHEET_NAME']);

// Next.js API alatt raw body kell a HMAC-hez
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

function extractAdjustDataFromOrder(order) {
  const subtotal = pickNumberLike(
    order.current_subtotal_price,
    order.subtotal_price,
    order.subtotal_price_set?.shop_money?.amount
  );
  const total = pickNumberLike(
    order.current_total_price,
    order.total_price,
    order.total_price_set?.shop_money?.amount
  );
  const tax = pickNumberLike(
    order.current_total_tax,
    order.total_tax,
    order.total_tax_set?.shop_money?.amount
  );

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

// Refund payloadból próbálunk hasznos jegyzetet csinálni
function buildRefundNote(refund) {
  // Összeg / valuták becslése
  let amountStr = '';
  try {
    if (Array.isArray(refund.transactions) && refund.transactions.length) {
      const sums = {};
      for (const t of refund.transactions) {
        const amt = Number(String(t.amount ?? '0').replace(',', '.')) || 0;
        const cur = (t.currency ?? t.currency_code ?? '').toString();
        if (!sums[cur]) sums[cur] = 0;
        sums[cur] += amt;
      }
      amountStr = Object.entries(sums)
        .map(([cur, amt]) => `${amt}${cur ? ' ' + cur : ''}`)
        .join(', ');
    }
  } catch (_) { /* no-op */ }

  const reason = (refund.note || refund.reason || '').toString().trim();
  const parts = [
    'refund rögzítve',
    amountStr && `összeg: ${amountStr}`,
    reason && `megjegyzés: ${reason}`,
  ].filter(Boolean);

  return parts.join(' | ');
}

// GraphQL-ből lekérjük az order aktuális totals értékeit (ha lehetséges)
async function fetchOrderTotalsViaGQL(orderIdNumeric) {
  // Ha a GQL kliens nincs bekonfigolva, dobni fog – elkapjuk a hívónál
  const gid = `gid://shopify/Order/${orderIdNumeric}`;
  const query = `
    query OrderTotals($id: ID!) {
      order(id: $id) {
        currentSubtotalPriceSet { shopMoney { amount } }
        currentTotalTaxSet     { shopMoney { amount } }
        currentTotalPriceSet   { shopMoney { amount } }
      }
    }
  `;
  const data = await shopifyGQL(query, { id: gid });
  const ord = data?.order;
  if (!ord) throw new Error('OrderTotals: order not found via GraphQL');

  const subtotal = pickNumberLike(ord.currentSubtotalPriceSet?.shopMoney?.amount);
  const tax      = pickNumberLike(ord.currentTotalTaxSet?.shopMoney?.amount);
  const total    = pickNumberLike(ord.currentTotalPriceSet?.shopMoney?.amount);
  return { subtotal, tax, total };
}

// ---- Handler (Vercel) ----
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }

    // Több topicot is elfogadunk
    requireShopAndTopic(req, ['orders/updated', 'orders/edited', 'refunds/create']);

    const topicHeader = (req.headers['x-shopify-topic'] || '').toString();

    // RAW body + HMAC
    const raw = await getRawBody(req);
    if (!verifyHmac(req, raw)) {
      return sendJson(res, 401, { ok: false, error: 'Bad HMAC' });
    }

    const payload = JSON.parse(raw.toString('utf8'));

    // Order ID kinyerése topic szerint
    let orderId = null;
    if (topicHeader === 'refunds/create') {
      // Refund payload: order_id a kulcs
      orderId = payload.order_id ?? payload.order?.id ?? null;
    } else {
      // orders/updated | orders/edited – közvetlenül az order.id
      orderId = payload.id ?? null;
    }

    if (!orderId) {
      return sendJson(res, 400, { ok: false, error: 'Hiányzó order azonosító (order.id / order_id)' });
    }

    const sheets = await getSheets();
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = process.env.SHEET_NAME;

    // Sor megkeresése a táblában
    const row = await findRowByOrderId(sheets, spreadsheetId, sheetName, orderId);
    if (row === -1) {
      return sendJson(res, 404, { ok: false, error: `Order ID nem található a táblában: ${orderId}` });
    }

    // Új értékek és megjegyzés
    let subtotal = null, total = null, tax = null, note = '';

    if (topicHeader === 'refunds/create') {
      // Refund: próbáljuk GraphQL-lel lekérni az aktuális totals értékeket
      note = buildRefundNote(payload);
      try {
        const t = await fetchOrderTotalsViaGQL(orderId);
        subtotal = t.subtotal;
        total = t.total;
        tax = t.tax;
      } catch (e) {
        console.warn('[refunds/create] GraphQL totals lekérés sikertelen:', e?.message || e);
        // Ha nem sikerült totals-t szerezni, csak a megjegyzést írjuk frissítésnek
      }
    } else {
      // orders/updated | orders/edited – payload egy Order
      const extracted = extractAdjustDataFromOrder(payload);
      subtotal = extracted.subtotal;
      total = extracted.total;
      tax = extracted.tax;
      note = extracted.note;
    }

    const noteCellValue = `módosítva: ${formatHuDate(new Date().toISOString())}${note ? ` – ${note}` : ''}`;

    // Batch frissítés összeállítása dinamikusan: ha nincs totals, csak O oszlopot írunk
    const dataRanges = [{ range: sheetRange(sheetName, `O${row}`), values: [[noteCellValue]] }];

    if (subtotal !== null && total !== null && tax !== null) {
      dataRanges.unshift({
        range: sheetRange(sheetName, `L${row}:N${row}`),
        values: [[formatDecimal(subtotal), formatDecimal(total), formatDecimal(tax)]],
      });
    }

    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: dataRanges,
      },
    }));

    return sendJson(res, 200, {
      ok: true,
      topic: topicHeader,
      row,
      updated: {
        ...(subtotal !== null ? { subtotal: formatDecimal(subtotal) } : {}),
        ...(total    !== null ? { total:    formatDecimal(total)    } : {}),
        ...(tax      !== null ? { tax:      formatDecimal(tax)      } : {}),
        note: noteCellValue,
      },
    });
  } catch (err) {
    console.error(err);
    const code = err.status || err.code || 500;
    return sendJson(res, code, { ok: false, error: err.message || 'Internal Server Error' });
  }
};
