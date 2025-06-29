// api/order-creation.js
require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const { google } = require('googleapis');

// Node 18+ global fetch
const fetch = global.fetch;
if (!fetch) console.warn('⚠️ global fetch not available');

const app = express();
app.use(express.raw({ type: 'application/json' }));

// HMAC validation
function verifyShopifyWebhook(req) {
  const secret = process.env.SHOPIFY_API_SECRET_KEY;
  if (!secret) throw new Error('Missing SHOPIFY_API_SECRET_KEY');
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto.createHmac('sha256', secret)
                      .update(req.body)
                      .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// Format date to Hungarian UTC+2
function formatHuDate(iso) {
  const d = new Date(iso);
  d.setHours(d.getHours() + 2);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}` +
         ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Append to Google Sheets A:T
async function appendOrderToSheet(order) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:   process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g,'\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const cust    = order.customer || {};
  const ship    = order.shipping_address || {};
  const phone   = ship.phone || order.phone || cust.phone || '';

  const items   = order.line_items || [];
  const qty     = items.reduce((s,i)=> s + (i.quantity||0),0);
  const names   = items.map(i=>i.title).join(',');
  const skus    = items.map(i=>i.sku).join(',');
  const vendors = items.map(i=>i.vendor).join(',');

  const addr = [ship.zip, ship.city, ship.address1, ship.address2]
               .filter(Boolean).join(', ');

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
    order.subtotal_price,
    order.total_price,
    order.total_tax,
    addr
  ];

await sheets.spreadsheets.values.append({
  spreadsheetId: process.env.SPREADSHEET_ID,
  range: `${process.env.SHEET_NAME}!A:T`,    // csak oszlopok, nincs sor
  valueInputOption: 'RAW',
  insertDataOption: 'INSERT_ROWS',
  resource: { values: [ row ] }
});


}

app.post('/webhook/order-creation', async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');
  if (!verifyShopifyWebhook(req)) return res.status(401).end('Unauthorized');

  const order = JSON.parse(req.body.toString('utf8'));
  console.log(`▶️ Order ${order.id} received`);

  // --- Metafield update ---
  const shop      = process.env.SHOPIFY_SHOP_NAME;
  const token     = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const shareUnit = Number(process.env.SHARE_UNIT);
  const endpoint  = `https://${shop}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

  const custGid = String(order.customer.id).split('/').pop();
  console.log(`🆔 Customer GID: ${custGid}`);

  // 1) Read existing metafields
  const readRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type':'application/json','X-Shopify-Access-Token':token },
    body: JSON.stringify({
      query: `query getCustomer($id: ID!) { customer(id: $id) {
        netSpent: metafield(namespace: "loyalty", key: "net_spent_total") { value }
        sharesCount: metafield(namespace: "loyalty", key: "reszvenyek_szama") { value }
        remainder: metafield(namespace: "custom", key: "jelenlegi_fennmarado") { value }
      }}`,
      variables: { id: `gid://shopify/Customer/${custGid}` }
    })
  });
  const { data, errors } = await readRes.json();
  if (errors?.length) throw errors;
  const prevSpent     = parseFloat(data.customer.netSpent?.value || '0');
  const prevShares    = parseInt(data.customer.sharesCount?.value || '0',10);
  const prevRemainder = parseFloat(data.customer.remainder?.value || '0');
  console.log(`PrevSpent:${prevSpent} Shares:${prevShares}`);

  // 2) Compute new values
  const subtotal     = parseFloat(order.subtotal_price);
  const newTotal     = prevSpent + subtotal;
  const totalShares  = Math.floor(newTotal / shareUnit);
  const earnedShares = totalShares - prevShares;
  const newRemainder = newTotal % shareUnit;
  console.log(`Earned:${earnedShares}`);

  // 3) Mutate
  const mutation = `mutation updateBoth($custInput: CustomerInput!, $orderInput: OrderInput!) {
    customerUpdate(input: $custInput) { userErrors { field message } }
    orderUpdate(input: $orderInput) { userErrors { field message } }
  }`;
  const variables = {
    custInput: {
      id: `gid://shopify/Customer/${custGid}`,
      metafields: [
        { namespace:'loyalty', key:'net_spent_total', type:'number_decimal', value:newTotal.toFixed(2) },
        { namespace:'loyalty', key:'reszvenyek_szama', type:'number_integer', value:totalShares.toString() },
        { namespace:'custom',  key:'jelenlegi_fennmarado', type:'number_decimal', value:newRemainder.toFixed(2) }
      ]
    },
    orderInput: {
      id: `gid://shopify/Order/${order.id}`,
      metafields: [
        { namespace:'custom', key:'subtotal', type:'number_decimal', value:subtotal.toFixed(2) },
        { namespace:'custom', key:'order_share', type:'number_integer', value:earnedShares.toString() },
        { namespace:'custom', key:'order_remainder', type:'number_decimal', value:newRemainder.toFixed(2) }
      ]
    }
  };
  const mutRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type':'application/json','X-Shopify-Access-Token':token },
    body: JSON.stringify({ query: mutation, variables })
  });
  const mutJson = await mutRes.json();
  const custErrs = mutJson.data.customerUpdate.userErrors;
  const orderErrs = mutJson.data.orderUpdate.userErrors;
  if (custErrs.length || orderErrs.length) {
    console.error('Mutation errors',custErrs,orderErrs);
    return res.status(500).end('Metafield update failed');
  }
  console.log('✅ Metafields updated');

  // 4) Sheet write
  await appendOrderToSheet(order);
  console.log('✅ Sheet updated');

  res.writeHead(200).end('OK');
});

const PORT = process.env.PORT||3000;
app.listen(PORT,()=>console.log(`🚀 Listening on ${PORT}`));
