'use strict';

/**
 * orders/updated webhook feldolgozása:
 * - HMAC + shop/topic guard
 * - Meglévő sor megkeresése (A oszlop: order.id)
 * - L:N frissítése (subtotal, total, tax) + O oszlopban módosítási jegyzet
 *   (Igazítsd, ha más az oszlop-sorrend a tábládban.)
 */

require('dotenv').config();
const express = require('express');
const router = express.Router();

const {
  rawJson,
  verifyHmac,
  requireShopAndTopic,
  getSheets,
  sheetRange,
  formatHuDate,
  formatDecimal,
  asyncHandler,
  withRetry,
  requireEnv,
} = require('./utils');

requireEnv(['SPREADSHEET_ID', 'SHEET_NAME']);

// --- Segédek ---
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

// --- Végpont ---
router.post('/api/order-adjust', rawJson, asyncHandler(async (req, res) => {
  requireShopAndTopic(req, 'orders/updated');
  if (!verifyHmac(req, req.body)) return res.status(401).send('Bad HMAC');

  const order = JSON.parse(req.body.toString('utf8'));
  const orderId = order.id;
  if (!orderId) return res.status(400).send('Hiányzó order.id');

  const sheets = await getSheets();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = process.env.SHEET_NAME;

  const row = await findRowByOrderId(sheets, spreadsheetId, sheetName, orderId);
  if (row === -1) return res.status(404).send(`Order ID nem található a táblában: ${orderId}`);

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

  res.status(200).json({
    ok: true,
    row,
    updated: {
      subtotal: formatDecimal(subtotal),
      total: formatDecimal(total),
      tax: formatDecimal(tax),
      note: noteCellValue,
    },
  });
}));

module.exports = router;
