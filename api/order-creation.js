// webhook-to-sheets.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

const app = express();
// Shopify sends raw JSON for signature verification
app.use(bodyParser.raw({ type: 'application/json' }));

// Validate Shopify HMAC signature
function verifyShopifyWebhook(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(req.body, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// Append order details to Google Sheet
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

  // Extract needed fields
  const itemsCount = order.line_items.length;
  const subtotal = order.subtotal_price;
  const createdAt = order.created_at;
  const customer = order.customer || {};
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const customerEmail = customer.email || '';

  const values = [[
    order.id,
    itemsCount,
    subtotal,
    createdAt,
    customerName,
    customerEmail,
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME}!A:F`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: { values },
  });

  console.log(`Order written to sheet: ${order.id}`);
}

// Webhook endpoint
app.post('/webhook/order-creation', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      console.error('Webhook signature validation failed');
      return res.status(401).send('Unauthorized');
    }

    const order = JSON.parse(req.body.toString('utf8'));
    await appendOrderToSheet(order);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling webhook:', err);
    res.status(500).send('Error');
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
