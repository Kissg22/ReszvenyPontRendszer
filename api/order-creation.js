// webhook-to-sheets.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

console.log('🔄 Loaded webhook-to-sheets v9');

const app = express();
app.use(bodyParser.raw({ type: 'application/json' }));

function verifyShopifyWebhook(req) {
  const secret = process.env.SHOPIFY_API_SECRET_KEY;
  if (!secret) throw new Error('Missing SHOPIFY_API_SECRET_KEY');
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto.createHmac('sha256', secret)
    .update(req.body, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

function formatHuDate(iso) {
  const d = new Date(iso);
  d.setHours(d.getHours() + 2);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}` +
         ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function appendOrderToSheet(order) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const customer = order.customer || {};
  const shipping = order.shipping_address || {};

  const phone = shipping.phone || order.phone || customer.phone || '';

  const products = order.line_items || [];

  // Fetch cost per item for each variant via Shopify Admin API
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const fetch = require('node-fetch');
  const variantCosts = await Promise.all(products.map(async item => {
    try {
      const res = await fetch(
        `https://${shopDomain}/admin/api/2025-01/variants/${item.variant_id}.json`,
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );
      const { variant } = await res.json();
      return variant.inventory_item_id && variant.cost ? parseFloat(variant.cost) : 0;
    } catch (e) {
      console.error('Error fetching variant cost:', e);
      return 0;
    }
  }));
  
  const totalQuantity = products.reduce((sum, i) => sum + (i.quantity || 0), 0);
  const productNames = products.map(i => i.title).join('; ');
  const productSkus = products.map(i => i.sku).join('; ');
  const productVendors = products.map(i => i.vendor).join('; ');
  const costPerItem = variantCosts.join('; ');
  const lineTotals = products.map((i, idx) => (parseFloat(i.price) * i.quantity).toFixed(2)).join('; ');
  const costLineTotals = variantCosts.map((cost, idx) => (cost * products[idx].quantity).toFixed(2)).join('; ');(i => (parseFloat(i.price) * i.quantity).toFixed(2)).join('; ');

  const shippingAddress = shipping.zip
    ? `${shipping.zip}, ${shipping.city}, ${shipping.address1 || ''}`.trim()
    : `${shipping.city}, ${shipping.address1 || ''}`.trim();

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
    lineTotals,
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
