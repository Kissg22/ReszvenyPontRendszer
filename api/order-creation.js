// api/order-creation.js
require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const { google } = require('googleapis');

// Node 18+ global fetch
const fetch = global.fetch;
if (!fetch) console.warn('⚠️ global fetch is not available.');

const app = express();
app.use(express.raw({ type: 'application/json' }));

// 1) HMAC validation
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
  const valid = crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  console.log('✅ HMAC valid:', valid);
  return valid;
}

// 2) Format date to "YYYY.MM.DD HH:mm:ss" (UTC+2)
function formatHuDate(iso) {
  const d = new Date(iso);
  d.setHours(d.getHours() + 2);
  const pad = n => String(n).padStart(2,'0');
  const formatted = `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}` +
                    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  console.log('🗓 Formatted date:', formatted);
  return formatted;
}

// 3) Append to Google Sheet
async function appendOrderToSheet(order) {
  console.log('📥 appendOrderToSheet called');
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:   process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g,'\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version:'v4', auth: client });

  const cust    = order.customer || {};
  const ship    = order.shipping_address || {};
  const phone   = ship.phone || order.phone || cust.phone || '';

  const items   = order.line_items || [];
  const qty     = items.reduce((sum,i)=> sum + (i.quantity||0), 0);
  const names   = items.map(i=>i.title).join(', ');
  const skus    = items.map(i=>i.sku).join(', ');
  const vendors = items.map(i=>i.vendor).join(', ');
  const totals  = items.map(i=>(parseFloat(i.price)*i.quantity).toFixed(2)).join(', ');

  const addr = [ship.zip, ship.city, ship.address1, ship.address2]
               .filter(Boolean).join(', ');
  console.log('🏠 Shipping address:', addr);

  const row = [
    order.id,
    order.name,
    cust.id||'',
    [cust.first_name,cust.last_name].filter(Boolean).join(' '),
    cust.email||'',
    phone,
    formatHuDate(order.created_at),
    qty,
    names,
    skus,
    vendors,
    totals,
    order.subtotal_price,
    order.total_price,
    order.total_tax,
    order.currency,
    order.financial_status,
    order.fulfillment_status||'',
    addr
  ];
  console.log('📋 Row to append:', row);

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME}!A:T`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [row] }
  });
  console.log('📈 Sheet append result:', res.data);
}

app.post('/webhook/order-creation', async (req, res) => {
  console.log('▶️  /webhook/order-creation hit');
  try {
    if (!verifyShopifyWebhook(req)) {
      console.log('⛔ Unauthorized');
      return res.status(401).end('Unauthorized');
    }

    console.log('📥 Parsing payload');
    const order = JSON.parse(req.body.toString('utf8'));
    console.log('📦 Order payload:', JSON.stringify(order, null, 2));

    // --- 4) Metafield update ---
    console.log('🛠 Preparing metafield mutation');
    const shop       = process.env.SHOPIFY_SHOP_NAME;
    const token      = process.env.SHOPIFY_API_ACCESS_TOKEN;
    const shareUnit  = Number(process.env.SHARE_UNIT);
    const gqlEndpoint= `https://${shop}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

    // fetch existing customer metafields
    const custGid = String(order.customer.id).split('/').pop();
    console.log('🆔 Customer GID:', custGid);

    const query = `
      query getCustomer($id: ID!) {
        customer(id: $id) {
          netSpent: metafield(namespace: "loyalty", key: "net_spent_total") { value }
          shares:   metafield(namespace: "loyalty", key: "reszvenyek_szama") { value }
          rem:      metafield(namespace: "custom",  key: "jelenlegi_fennmarado") { value }
        }
      }
    `;
    const readRes = await fetch(gqlEndpoint, {
      method: 'POST',
      headers:{ 'Content-Type':'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables:{ id:`gid://shopify/Customer/${custGid}` } })
    });
    const readJson = await readRes.json();
    console.log('📑 Read customer metafields:', JSON.stringify(readJson, null, 2));

    const prevSpent     = parseFloat(readJson.data.customer.netSpent?.value    || '0');
    const prevShares    = parseInt(readJson.data.customer.shares?.value       || '0', 10);
    const prevRemainder = parseFloat(readJson.data.customer.rem?.value         || '0');
    console.log('📊 Previous:', { prevSpent, prevShares, prevRemainder });

    // compute new totals
    const subtotal     = parseFloat(order.subtotal_price);
    const newTotal     = prevSpent + subtotal;
    const totalShares  = Math.floor(newTotal / shareUnit);
    const earnedShares = totalShares - prevShares;
    const newRemainder = newTotal % shareUnit;
    console.log('📈 Computed:', { newTotal, totalShares, earnedShares, newRemainder });

    // build mutation
    const mutation = `
      mutation updateBoth($custInput: CustomerInput!, $orderInput: OrderInput!) {
        customerUpdate(input:$custInput){ userErrors{field message} }
        orderUpdate(input:$orderInput){ userErrors{field message} }
      }
    `;
    const variables = {
      custInput: {
        id: `gid://shopify/Customer/${custGid}`,
        metafields: [
          { namespace:'loyalty', key:'net_spent_total',  type:'number_decimal', value: newTotal.toFixed(2) },
          { namespace:'loyalty', key:'reszvenyek_szama', type:'number_integer', value: totalShares.toString() },
          { namespace:'custom',  key:'jelenlegi_fennmarado', type:'number_decimal', value: newRemainder.toFixed(2) }
        ]
      },
      orderInput:{
        id: `gid://shopify/Order/${order.id}`,
        metafields:[
          { namespace:'custom', key:'subtotal',        type:'number_decimal', value: subtotal.toFixed(2) },
          { namespace:'custom', key:'order_share',     type:'number_integer', value: earnedShares.toString() },
          { namespace:'custom', key:'order_remainder', type:'number_decimal', value: newRemainder.toFixed(2) }
        ]
      }
    };
    console.log('🔧 Mutation variables:', JSON.stringify(variables, null, 2));

    // execute mutation
    console.log('🚀 Sending mutation');
    const mutRes = await fetch(gqlEndpoint, {
      method:'POST',
      headers:{ 'Content-Type':'application/json','X-Shopify-Access-Token':token },
      body: JSON.stringify({ query:mutation, variables })
    });
    const mutJson = await mutRes.json();
    console.log('📨 Mutation response:', JSON.stringify(mutJson, null, 2));

    if (mutJson.data.customerUpdate.userErrors.length || mutJson.data.orderUpdate.userErrors.length) {
      console.error('❌ Mutation errors:', mutJson.data);
      throw new Error('Metafield update failed');
    }
    console.log('✅ Metafields updated');

    // 5) Append to Sheet
    await appendOrderToSheet(order);
    console.log('✅ Order data written to sheet');

    res.status(200).end('OK');
  } catch (err) {
    console.error('❌ Handler error:', err);
    res.status(500).end('Error');
  }
});

// start server
const PORT = process.env.PORT||3000;
app.listen(PORT, ()=> console.log(`🚀 Listening on ${PORT}`));
