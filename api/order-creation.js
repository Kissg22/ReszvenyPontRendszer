// webhook-to-sheets.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const { fetch } = require('undici');  // Use undici for fetch in CJS

console.log('🔄 Loaded webhook-to-sheets v11');

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

// Append order to sheet
async function appendOrderToSheet(order) {
  // Authenticate
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // Extract data
  const customer = order.customer || {};
  const shipping = order.shipping_address || {};
  const phone = shipping.phone || order.phone || customer.phone || '';

  // Products info
  const products = order.line_items || [];
  const totalQuantity = products.reduce((sum, i) => sum + (i.quantity || 0), 0);
  const productNames = products.map(i => i.title).join('; ');
  const productSkus = products.map(i => i.sku).join('; ');
  const productVendors = products.map(i => i.vendor).join('; ');

  // Shopify API for cost
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const costs = await Promise.all(products.map(async item => {
    try {
      // fetch variant for inventory_item_id
      const variantRes = await fetch(
        `https://${shopDomain}/admin/api/2025-01/variants/${item.variant_id}.json`,
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      const { variant } = await variantRes.json();
      const inventoryId = variant.inventory_item_id;
      if (!inventoryId) return 0;
      // fetch inventory item for cost
      const invRes = await fetch(
        `https://${shopDomain}/admin/api/2025-01/inventory_items/${inventoryId}.json`,
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      const { inventory_item } = await invRes.json();
      return parseFloat(inventory_item.cost) || 0;
    } catch (e) {
      console.error('Cost fetch error for variant', item.variant_id, e);
      return 0;
    }
  }));
  const costPerItem = costs.map(c => c.toFixed(2)).join('; ');
  const profitPerItem = products.map((i, idx) =>
    ((parseFloat(i.price) - costs[idx]) * (i.quantity||0)).toFixed(2)
  ).join('; ');

  // Shipping address
  const shippingAddress = shipping.zip
    ? `${shipping.zip}, ${shipping.city}, ${shipping.address1 || ''}`.trim()
    : `${shipping.city}, ${shipping.address1 || ''}`.trim();

  // Build row
  const row = [
    phone,
    customer.id || '',
    order.id,
    order.name,
    [customer.first_name, customer.last_name].filter(Boolean).join(' '),
    customer.email || '',
    formatHuDate(order.created_at),
    totalQuantity,
    productNames,
    productSkus,
    productVendors,
    costPerItem,
    profitPerItem,
    order.subtotal_price,
    order.total_price,
    order.total_tax,
    order.currency,
    shippingAddress
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
