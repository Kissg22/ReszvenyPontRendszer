// api/order-creation.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const fetch = require('undici').fetch;

console.log('🔄 Loaded api/order-creation v2');

const app = express();
app.use(express.raw({ type: 'application/json' }));

// 1) HMAC ellenőrzés
function verifyShopifyWebhook(req) {
  console.log('🔍 Verifying HMAC...');
  const secret = process.env.SHOPIFY_API_SECRET_KEY;
  if (!secret) throw new Error('Missing SHOPIFY_API_SECRET_KEY');
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  console.log('🔐 Received HMAC:', hmacHeader);
  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.body, 'utf8')
    .digest('base64');
  console.log('🔑 Computed HMAC:', digest);
  const isValid = crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  console.log('✅ HMAC valid:', isValid);
  return isValid;
}

// 2) Dátum formázó
function formatHuDate(iso) {
  const d = new Date(iso);
  d.setHours(d.getHours() + 2);
  const pad = n => String(n).padStart(2,'0');
  const formatted = `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}` +
                    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  console.log('🗓 Formatted date:', formatted);
  return formatted;
}

// 3) Google Sheets-be író függvény
async function appendOrderToSheet(order) {
  console.log('📥 appendOrderToSheet called');
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:   process.env.GOOGLE_PRIVATE_KEY.replace(/\n/g,'\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  console.log('🔑 Authenticating to Google...');
  const client = await auth.getClient();
  const sheets = google.sheets({ version:'v4', auth: client });

  console.log('📂 Preparing row data...');
  const customer = order.customer || {};
  const shipping = order.shipping_address || {};
  const phone = shipping.phone || order.phone || customer.phone || '';
  console.log('📞 Phone:', phone);

  const products = order.line_items || [];
  const totalQuantity = products.reduce((sum,i)=> sum + (i.quantity||0), 0);
  console.log('🔢 Total quantity:', totalQuantity);
  const productNames   = products.map(i=>i.title).join('; ');
  const productSkus    = products.map(i=>i.sku).join('; ');
  const productVendors = products.map(i=>i.vendor).join('; ');
  const lineTotals     = products.map(i=>(parseFloat(i.price)*i.quantity).toFixed(2)).join('; ');
  console.log('📦 Product names:', productNames);

  const addrParts = [];
  [shipping.zip, shipping.city, shipping.address1, shipping.address2]
    .filter(Boolean).forEach(p=> addrParts.push(p));
  const shippingAddress = addrParts.join(', ');
  console.log('🏠 Shipping address:', shippingAddress);

  const row = [
    order.id,
    order.name,
    customer.id||'',
    [customer.first_name,customer.last_name].filter(Boolean).join(' '),
    customer.email||'',
    phone,
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
  console.log('📋 Row to append:', row);

  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME}!A:T`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [row] }
  });
  console.log('📈 Sheet append response:', appendRes.data);
}

// 4) Webhook handler
app.post('/order-creation', async (req, res) => {
  console.log('▶️  /order-creation endpoint hit');
  try {
    if (!verifyShopifyWebhook(req)) {
      console.log('⛔ Unauthorized request');
      return res.status(401).send('Unauthorized');
    }

    console.log('📥 Parsing payload');
    const order = JSON.parse(req.body.toString('utf8'));
    console.log('📦 Parsed order:', JSON.stringify(order, null, 2));

    // Metafield update
    console.log('🛠 Preparing metafield mutation');
    const shop      = process.env.SHOPIFY_SHOP_NAME;
    const token     = process.env.SHOPIFY_API_ACCESS_TOKEN;
    const shareUnit = Number(process.env.SHARE_UNIT);
    const endpoint  = `https://${shop}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

    const custGid = String(order.customer.id).split('/').pop();
    const subtotal = parseFloat(order.subtotal_price);
    console.log('🔢 Calculated subtotal:', subtotal);

    // Build mutation
    const mutation = `
      mutation updateBoth($custInput: CustomerInput!, $orderInput: OrderInput!) {
        customerUpdate(input:$custInput){userErrors{field message}}
        orderUpdate(input:$orderInput){userErrors{field message}}
      }
    `;
    const variables = {
      custInput: { id: `gid://shopify/Customer/${custGid}`, metafields: [ /* ... */ ] },
      orderInput: { id: `gid://shopify/Order/${order.id}`, metafields: [ /* ... */ ] }
    };
    console.log('🔧 Mutation variables:', JSON.stringify(variables, null, 2));

    console.log('🚀 Sending metafield mutation');
    const resp = await fetch(endpoint, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-Shopify-Access-Token':token },
      body: JSON.stringify({ query:mutation, variables })
    });
    const json = await resp.json();
    console.log('📨 Mutation response:', JSON.stringify(json, null, 2));

    if (json.data.customerUpdate.userErrors.length || json.data.orderUpdate.userErrors.length) {
      console.error('❌ Mutation errors:', json.data);
      throw new Error('Metafield update failed');
    }
    console.log('✅ Metafields updated');

    // Append to sheet
    await appendOrderToSheet(order);
    console.log('✅ Data appended to sheet');

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Handler error:', err);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=> console.log(`🚀 Listening on ${PORT}`));
