// webhook-to-sheets.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

// Log version
console.log('🔄 Loaded webhook-to-sheets v7');

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
  // Extract customer and shipping data
  const customer = order.customer || {};
  const shipping = order.shipping_address || {};
  const billing = order.billing_address || {};

  // Determine phone number: shipping, billing, or order/contact
  const phone = shipping.phone || billing.phone || order.phone || customer.phone || '';

  // Prepare product arrays
  const products = order.line_items || [];
  const productNames = products.map(i => i.title).join(', ');
  const productSkus = products.map(i => i.sku).join(', ');
  const productVendors = products.map(i => i.vendor).join(', ');

  // Format shipping address with postal code
  const shippingAddress = shipping.zip
    ? `${shipping.zip}, ${shipping.city}, ${shipping.address1 || ''}`.trim()
    : `${shipping.city}, ${shipping.address1 || ''}`.trim();

  // Build row in requested order, no gaps
  const row = [
    phone,                          // Felhasználó telefonszáma
    order.id,                       // Order ID
    order.name,                     // Order number
    customer.id || '',              // Customer ID
    [customer.first_name, customer.last_name].filter(Boolean).join(' '), // Name
    customer.email || '',           // Email
    formatHuDate(order.created_at), // Dátum
    products.length,                // Termékek száma
    productNames,                   // Termék nevek
    productSkus,                    // SKU-k
    productVendors,                 // Vendorok
    order.subtotal_price,           // Subtotal
    order.total_price,              // Total
    order.total_tax,                // Total Tax
    order.currency,                 // Currency
    order.financial_status,         // Financial status
    order.fulfillment_status || '', // Fulfillment status
    shippingAddress                 // Szállítási cím
  ];

  console.log('📋 Appending row:', row);

  await sheets.spreadsheets.values.append({({ version: 'v4', auth: client });

  // Extract customer and shipping data
  const customer = order.customer || {};
  const shipping = order.shipping_address || {};
  // Determine phone number
  const phone = customer.phone || order.phone || '';
  // Prepare product arrays
  const products = order.line_items || [];
  const productNames = products.map(i => i.title).join(', ');
  const productSkus = products.map(i => i.sku).join(', ');
  const productVendors = products.map(i => i.vendor).join(', ');
  // Format shipping address with postal code
  const shippingAddress = shipping.zip
    ? `${shipping.zip}, ${shipping.city}, ${shipping.address1 || ''}`.trim()
    : `${shipping.city}, ${shipping.address1 || ''}`.trim();

  // Build row in requested order, no gaps
  const row = [
    phone,                          // Felhasználó telefonszáma
    order.id,
    order.name,
    order.customer_id || '',
    [customer.first_name, customer.last_name].filter(Boolean).join(' '),
    customer.email || '',
    formatHuDate(order.created_at),
    products.length,
    productNames,
    productSkus,
    productVendors,
    order.subtotal_price,
    order.total_price,
    order.total_tax,
    order.currency,
    order.financial_status,
    order.fulfillment_status || '',
    shippingAddress
  ];

  console.log('📋 Appending row:', row);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME}!A:R`,
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
    console.log('📦 Full Order Payload:', JSON.stringify(order, null, 2));
    await appendOrderToSheet(order);
    res.status(200).send('OK');
  } catch (e) {
    console.error('❌ Handler error:', e);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
