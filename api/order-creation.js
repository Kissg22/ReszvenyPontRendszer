// webhook-to-sheets.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

// Log version
console.log('🔄 Loaded webhook-to-sheets v4');

const app = express();
app.use(bodyParser.raw({ type: 'application/json' }));

// Verify Shopify HMAC signature
function verifyShopifyWebhook(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) throw new Error('Missing SHOPIFY_WEBHOOK_SECRET');
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.body, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// Format to "YYYY.MM.DD HH:mm:ss" with +2 hours offset
function formatHuDate(iso) {
  const d = new Date(iso);
  d.setHours(d.getHours() + 2);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}` +
         ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Append order to sheet
async function appendOrderToSheet(order) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  // Build row with extra fields
  const customer = order.customer || {};
  const shipping = order.shipping_address || {};
  const billing = order.billing_address || {};
  const lineItems = order.line_items.map(i => `${i.title} x${i.quantity}`).join('; ');

  const row = [
    order.id,
    order.name,                     // Order number
    order.customer_id || '',
    [customer.first_name, customer.last_name].filter(Boolean).join(' '),
    customer.email || '',
    order.created_at,               // Raw ISO
    formatHuDate(order.created_at), // HU+2
    order.line_items.length,
    lineItems,
    order.subtotal_price,
    order.total_price,
    order.total_tax,
    order.currency,
    order.financial_status,
    order.fulfillment_status || '',
    shipping.name || '',
    `${shipping.address1 || ''} ${shipping.city || ''}`.trim(),
    billing.name || '',
    `${billing.address1 || ''} ${billing.city || ''}`.trim(),
    order.tags,                     // tags
    order.note || ''                // order note
  ];

  console.log('Appending row:', row);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME}!A:U`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [row] },
  });

  console.log(`✅ Order ${order.id} appended with ${row.length} columns`);
}

app.post('/webhook/order-creation', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized');
    const order = JSON.parse(req.body.toString('utf8'));
    await appendOrderToSheet(order);
    res.status(200).send('OK');
  } catch (e) {
    console.error('❌ Handler error:', e);
    res.status(500).send('Error');
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
