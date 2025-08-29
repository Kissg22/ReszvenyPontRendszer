'use strict';

/**
 * Vercel szerverless handler (orders/create | orders/paid):
 * - Nyers body + HMAC
 * - Shop/topic guard (több topic támogatás)
 * - Idempotens sor hozzáfűzés Google Sheets-hez
 * - (Opcionális) Shopify metafield frissítés
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
  shopifyGQL,
  withRetry,
  requireEnv,
} = require('./utils');

requireEnv(['SPREADSHEET_ID', 'SHEET_NAME']);

// Next.js API alatt nyers body kell a HMAC-hez
module.exports.config = { api: { bodyParser: false } };

// --- Segédfüggvények ---
function safeLen(arr) {
  return Array.isArray(arr) ? arr.length : 0;
}

function buildRowFromOrder(order) {
  const cust = order?.customer || {};
  const ship = order?.shipping_address || {};
  const payGateways = Array.isArray(order?.payment_gateway_names)
    ? order.payment_gateway_names.join(', ')
    : (order?.payment_gateway_names || '');

  const discountCodes = Array.isArray(order?.discount_codes)
    ? order.discount_codes.map(d => d?.code).filter(Boolean).join(', ')
    : '';

  const tags = (order?.tags || '').toString();

  // Pénzügyi mezők több forrásból
  const subtotal = order?.current_subtotal_price
    ?? order?.subtotal_price
    ?? order?.subtotal_price_set?.shop_money?.amount;

  const total = order?.current_total_price
    ?? order?.total_price
    ?? order?.total_price_set?.shop_money?.amount;

  const tax = order?.current_total_tax
    ?? order?.total_tax
    ?? order?.total_tax_set?.shop_money?.amount;

  const created = order?.created_at || order?.processed_at || new Date().toISOString();

  return [
    String(order?.id ?? ''),                             // A: Order ID
    String(order?.name ?? ''),                           // B: Order name
    formatHuDate(created),                               // C: Létrehozás (HU)
    String(order?.currency ?? ''),                       // D: Deviza
    formatDecimal(subtotal),                             // E: Subtotal
    formatDecimal(tax),                                  // F: Tax
    formatDecimal(total),                                // G: Total
    String(order?.financial_status ?? ''),               // H
    String(order?.fulfillment_status ?? ''),             // I
    Number(safeLen(order?.line_items)),                  // J: Tételszám
    String(payGateways),                                 // K
    String(cust?.id ?? ''),                              // L: Customer ID
    `${cust?.first_name ?? ''} ${cust?.last_name ?? ''}`.trim(), // M: Név
    String(cust?.email ?? ''),                           // N: Email
    String(ship?.city ?? ''),                            // O: Város
    String(ship?.country ?? ''),                         // P: Ország
    String(order?.note ?? ''),                           // Q: Megjegyzés
    String(discountCodes),                               // R: Kuponok
    String(tags),                                        // S: Tag-ek
    formatHuDate(new Date().toISOString()),              // T: Rögzítés ideje (HU)
  ];
}

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

async function appendRowIfNotExists(sheets, spreadsheetId, sheetName, orderId, rowValues) {
  const row = await findRowByOrderId(sheets, spreadsheetId, sheetName, orderId);
  if (row !== -1) return { appended: false, row };

  await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId,
    range: sheetRange(sheetName, 'A1'),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [rowValues] },
  }));

  return { appended: true, row: null };
}

async function updateCustomerMetafieldsIfEnabled(order) {
  if (String(process.env.ENABLE_SHOPIFY_METAFIELDS).toLowerCase() !== 'true') return;

  const custIdNum = order?.customer?.id;
  if (!custIdNum) return;

  const gid = `gid://shopify/Customer/${custIdNum}`;
  const lastTotal = order?.current_total_price
    ?? order?.total_price
    ?? order?.total_price_set?.shop_money?.amount
    ?? '0';

  const lastDate  = order?.created_at || order?.processed_at || new Date().toISOString();

  const mutation = `
    mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace value }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: [
      { ownerId: gid, namespace: "loyalty", key: "last_order_total", type: "number_decimal", value: String(lastTotal) },
      { ownerId: gid, namespace: "loyalty", key: "last_order_date",  type: "single_line_text_field", value: String(lastDate) },
    ],
  };

  const data = await shopifyGQL(mutation, variables);
  const errs = data?.metafieldsSet?.userErrors || [];
  if (Array.isArray(errs) && errs.length) {
    throw new Error(`Shopify metafield userErrors: ${JSON.stringify(errs)}`);
  }
}

// ---- Handler (Vercel) ----
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }

    // Több topicot is elfogadunk a biztonság kedvéért
    requireShopAndTopic(req, ['orders/create', 'orders/paid']);

    // RAW body + HMAC
    const raw = await getRawBody(req);
    if (!verifyHmac(req, raw)) {
      return sendJson(res, 401, { ok: false, error: 'Bad HMAC' });
    }

    const order = JSON.parse(raw.toString('utf8'));

    const sheets = await getSheets();
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = process.env.SHEET_NAME;

    const rowValues = buildRowFromOrder(order);
    const result = await appendRowIfNotExists(sheets, spreadsheetId, sheetName, order.id, rowValues);

    // Opcionális Shopify metafield frissítés (nem blokkol)
    await updateCustomerMetafieldsIfEnabled(order).catch(err => {
      console.error('[metafieldsSet] hiba:', err.message || err);
    });

    return sendJson(res, 200, { ok: true, appended: result.appended, row: result.row });
  } catch (err) {
    console.error(err);
    const code = err.status || err.code || 500;
    return sendJson(res, code, { ok: false, error: err.message || 'Internal Server Error' });
  }
};
