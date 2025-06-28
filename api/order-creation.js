// webhook-to-sheets.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

console.log('🔄 Loaded webhook-to-sheets v11.1');

const app = express();
app.use(bodyParser.raw({ type: 'application/json' }));

// Verify Shopify HMAC signature (using API secret key)
function verifyShopifyWebhook(req) {
  const secret = process.env.SHOPIFY_API_SECRET_KEY;
  if (!secret) throw new Error('Missing SHOPIFY_API_SECRET_KEY');
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.body, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// Format to "YYYY.MM.DD HH:mm:ss" with +2 offset
function formatHuDate(iso) {
  const d = new Date(iso);
  d.setHours(d.getHours() + 2);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}` +
         ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function appendOrderToSheet(order) {
  // Authenticate with Google
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // Extract relevant data
  const customer = order.customer || {};
  const shipping = order.shipping_address || {};

  const phone = shipping.phone || order.phone || customer.phone || '';

  const products = order.line_items || [];
  const totalQuantity = products.reduce((sum, i) => sum + (i.quantity || 0), 0);
  // Product names separated by semicolons
  const productNames = products.map(i => i.title).join('; ');
  const productSkus = products.map(i => i.sku).join('; ');
  const productVendors = products.map(i => i.vendor).join('; ');
  const lineTotals = products.map(i => (parseFloat(i.price) * i.quantity).toFixed(2)).join('; ');

  // Include optional address2 field (floor/door) if present
  const addressParts = [];
  if (shipping.zip) addressParts.push(shipping.zip);
  if (shipping.city) addressParts.push(shipping.city);
  if (shipping.address1) addressParts.push(shipping.address1);
  if (shipping.address2) addressParts.push(shipping.address2);
  const shippingAddress = addressParts.join(', ');

  // Build row
  const row = [
    order.id,                          // Order ID
    order.name,                        // Order number
    customer.id || '',                 // Customer ID
    [customer.first_name, customer.last_name].filter(Boolean).join(' '), // Name
    customer.email || '',              // Email
    phone,                             // Telephone
    formatHuDate(order.created_at),    // Date
    totalQuantity,                     // Total quantity
    productNames,                      // Product names
    productSkus,                       // SKUs
    productVendors,                    // Vendors
    lineTotals,                        // Line totals
    order.subtotal_price,              // Subtotal
    order.total_price,                 // Total
    order.total_tax,                   // Total Tax
    shippingAddress                    // Shipping address
  ];

  console.log('📋 Appending row:', row);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME}!A:T`,
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
    console.log('📦 Full Payload:', JSON.stringify(order, null, 2));
    await appendOrderToSheet(order);
    res.status(200).send('OK');
  } catch (e) {
    console.error('❌ Handler error:', e);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
