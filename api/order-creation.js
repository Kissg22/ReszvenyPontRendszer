// webhook-to-sheets.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

// Log version at startup
console.log('🔄 Loaded webhook-to-sheets v3');

const app = express();
app.use(bodyParser.raw({ type: 'application/json' }));

// Verify Shopify HMAC signature
function verifyShopifyWebhook(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) throw new Error('Missing SHOPIFY_WEBHOOK_SECRET env var');
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.body, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// Format date manually to Hungarian style
function formatHuDate(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}` +
         ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Append order to sheet
async function appendOrderToSheet(order) {
  // Create auth & client each time to avoid stale promise
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  const row = [
    order.id,
    order.customer_id || '',
    [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' '),
    order.customer?.email || '',
    order.line_items.length,
    order.line_items.map(i => `${i.title} x${i.quantity}`).join('; '),
    order.subtotal_price,
    order.total_price,
    order.currency,
    order.financial_status,
    formatHuDate(order.created_at),
    order.shipping_address
      ? `${order.shipping_address.city}, ${order.shipping_address.address1}`
      : ''
  ];

  console.log('Appending row:', row);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME}!A:L`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [row] },
  });

  console.log(`✅ Order ${order.id} appended`);
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
