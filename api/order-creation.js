// api/order-creation.js
require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const { google } = require('googleapis');

// Use global fetch (Node 18+)
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

// Format ISO date to Hungarian UTC+2
function formatHuDate(iso) {
  const d = new Date(iso);
  d.setHours(d.getHours() + 2);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}` +
         ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Append order data to Google Sheets (columns A:T)
async function appendOrderToSheet(order) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:   process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const cust = order.customer || {};
  const ship = order.shipping_address || {};
  const phone = ship.phone || order.phone || cust.phone || '';

  const items = order.line_items || [];
  const qty   = items.reduce((sum,i)=> sum + (i.quantity || 0), 0);
  const names = items.map(i=>i.title).join(',');
  const skus  = items.map(i=>i.sku).join(',');
  const vendors = items.map(i=>i.vendor).join(',');

  const addrParts = [ship.zip, ship.city, ship.address1, ship.address2].filter(Boolean);
  const addr = addrParts.join(', ');

  const row = [
    order.id,
    order.name,
    cust.id || '',
    [cust.first_name, cust.last_name].filter(Boolean).join(' '),
    cust.email || '',
    phone,
    formatHuDate(order.created_at),
    qty,
    names,
    skus,
    vendors,
    order.subtotal_price,
    order.total_price,
    order.total_tax,
    order.currency,
    order.financial_status,
    order.fulfillment_status || '',
    addr
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME}!A:T`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [row] }
  });
}

app.post('/webhook/order-creation', async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');
  if (!verifyShopifyWebhook(req)) return res.status(401).end('Unauthorized');

  const order = JSON.parse(req.body.toString('utf8'));
  console.log(`Order ${order.id} received`);

  // --- Metafield update ---
  const shop      = process.env.SHOPIFY_SHOP_NAME;
  const token     = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const shareUnit = Number(process.env.SHARE_UNIT);
  const gqlUrl    = `https://${shop}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

  const custGid = String(order.customer.id).split('/').pop();
  console.log(`Customer GID: ${custGid}`);

  // fetch previous loyalty data
  const readQuery = `query($id: ID!){customer(id:$id){netSpent:metafield(namespace:"loyalty",key:"net_spent_total"){value}shares:metafield(namespace:"loyalty",key:"reszvenyek_szama"){value}rem:metafield(namespace:"custom",key:"jelenlegi_fennmarado"){value}}}`;
  const readResp = await fetch(gqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: readQuery, variables: { id: `gid://shopify/Customer/${custGid}` } })
  });
  const readData = await readResp.json();
  const prevSpent  = parseFloat(readData.data.customer.netSpent.value || 0);
  const prevShares = parseInt(readData.data.customer.shares.value || 0, 10);
  console.log(`Prev spent: ${prevSpent.toFixed(2)}, shares: ${prevShares}`);

  // compute new values
  const subtotal     = parseFloat(order.subtotal_price);
  const newTotal     = prevSpent + subtotal;
  const totalShares  = Math.floor(newTotal / shareUnit);
  const earnedShares = totalShares - prevShares;
  const newRem       = newTotal % shareUnit;
  console.log(`Earned shares: ${earnedShares}, remainder: ${newRem.toFixed(2)}`);

  // mutation
  const mutation = `mutation($c:CustomerInput!,$o:OrderInput!){customerUpdate(input:$c){userErrors{}}orderUpdate(input:$o){userErrors{}}}`;
  const variables = {
    c: {
      id: `gid://shopify/Customer/${custGid}`,
      metafields: [
        { namespace:'loyalty',               key:'net_spent_total',  type:'number_decimal', value:newTotal.toFixed(2) },
        { namespace:'loyalty',               key:'reszvenyek_szama', type:'number_integer', value:totalShares.toString() },
        { namespace:'custom',                key:'jelenlegi_fennmarado', type:'number_decimal', value:newRem.toFixed(2) }
      ]
    },
    o: {
      id: `gid://shopify/Order/${order.id}`,
      metafields: [
        { namespace:'custom',key:'subtotal',        type:'number_decimal',  value:subtotal.toFixed(2) },
        { namespace:'custom',key:'order_share',     type:'number_integer',  value:earnedShares.toString() },
        { namespace:'custom',key:'order_remainder', type:'number_decimal',  value:newRem.toFixed(2) }
      ]
    }
  };

  await fetch(gqlUrl, {
    method: 'POST',
    headers: { 'Content-Type':'application/json','X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: mutation, variables: { custInput: variables.c, orderInput: variables.o } })
  });
  console.log('Metafields updated');

  // write to sheet
  await appendOrderToSheet(order);
  console.log('Sheet updated');

  res.status(200).end('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
