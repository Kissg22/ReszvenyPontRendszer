require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const { getSheets, formatHuDate, formatDecimal } = require('./utils');

// Node 18+ global fetch
const fetch = global.fetch;
if (!fetch) console.warn('⚠️ global fetch not available');

const app = express();

// Track processed webhook deliveries to avoid duplicates.
// Entries expire after one hour to prevent unbounded growth.
const WEBHOOK_ID_TTL_MS = 60 * 60 * 1000; // 1 hour
const processedWebhookIds = new Map(); // id -> timestamp

function rememberWebhookId(id) {
  const now = Date.now();
  processedWebhookIds.set(id, now);
  // Cleanup old entries
  for (const [key, ts] of processedWebhookIds) {
    if (now - ts > WEBHOOK_ID_TTL_MS) processedWebhookIds.delete(key);
  }
}

// HMAC validation with graceful handling of missing/invalid headers
function verifyShopifyWebhook(req) {
  const secret = process.env.SHOPIFY_API_SECRET_KEY?.trim();
  console.log('🔐 Secret loaded:', Boolean(secret));
  if (!secret) return false;

  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  console.log('📥 Shopify HMAC header:', hmacHeader);
  if (!hmacHeader) return false;

  // log first 200 bytes of raw body
  const snippet = req.body.slice(0, 200).toString('utf8');
  console.log('📦 Raw body (first 200 bytes):', snippet);

  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.body)
    .digest();
  const provided = Buffer.from(hmacHeader, 'base64');
  if (digest.length !== provided.length) {
    console.warn('⚠️ HMAC length mismatch');
    return false;
  }
  const valid = crypto.timingSafeEqual(digest, provided);
  console.log('✅ HMAC valid?', valid);
  return valid;
}

// Append to Google Sheets A:T
async function appendOrderToSheet(order) {
  const sheets = await getSheets();

  const cust    = order.customer || {};
  const ship    = order.shipping_address || {};
  const phone   = ship.phone || order.phone || cust.phone || '';

  const items   = order.line_items || [];
  const qty     = items.reduce((s,i)=> s + (i.quantity||0),0);
  const names   = items.map(i=>i.title).join(';');
  const skus    = items.map(i=>i.sku).join(';');
  const vendors = items.map(i=>i.vendor).join(';');

  const addr = [ship.zip, ship.city, ship.address1, ship.address2]
               .filter(Boolean).join('; ');

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
    formatDecimal(order.subtotal_price),
    formatDecimal(order.total_price),
    formatDecimal(order.total_tax),
    addr
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME}!A:T`, 
    valueInputOption: 'USER_ENTERED',     
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [ row ] }
  });
}

app.post(
  '/webhook/order-creation',
  // ensure raw body for any content-type
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    console.log('▶️ order-creation handler called, method:', req.method);

    if (req.method !== 'POST') {
      console.log('⚠️ Nem POST kérés érkezett');
      return res.status(405).end('Method Not Allowed');
    }

    try {
      if (!verifyShopifyWebhook(req)) {
        console.log('❌ HMAC validation failed');
        return res.status(401).end('Unauthorized');
      }

      const webhookId = req.get('X-Shopify-Webhook-Id');
      if (webhookId) {
        const ts = processedWebhookIds.get(webhookId);
        if (ts && Date.now() - ts < WEBHOOK_ID_TTL_MS) {
          console.log(`🔁 Webhook ${webhookId} already processed`);
          return res.status(200).end('Duplicate');
        }
        rememberWebhookId(webhookId);
      }

      const order = JSON.parse(req.body.toString('utf8'));
      console.log(`▶️ Order ${order.id} received`);

      // --- Metafield update ---
      const shop      = process.env.SHOPIFY_SHOP_NAME;
      const token     = process.env.SHOPIFY_API_ACCESS_TOKEN;
      const shareUnit = Number(process.env.SHARE_UNIT);
      const endpoint  = `https://${shop}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

      const custGid = String(order.customer.id).split('/').pop();
      console.log(`🆔 Customer GID: ${custGid}`);

      // 1) Read existing metafields and check for duplicates
      const readRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type':'application/json','X-Shopify-Access-Token':token },
        body: JSON.stringify({
          query: `query getData($cid: ID!, $oid: ID!) {
            customer(id: $cid) {
              netSpent: metafield(namespace: "loyalty", key: "net_spent_total") { value }
              sharesCount: metafield(namespace: "loyalty", key: "reszvenyek_szama") { value }
              remainder: metafield(namespace: "custom", key: "jelenlegi_fennmarado") { value }
            }
            order(id: $oid) {
              subtotalMeta: metafield(namespace: "custom", key: "subtotal") { value }
            }
          }`,
          variables: {
            cid: `gid://shopify/Customer/${custGid}`,
            oid: `gid://shopify/Order/${order.id}`
          }
        })
      });
      if (!readRes.ok) {
        console.error('❌ Shopify read error', readRes.status);
        return res.status(500).end('Shopify read error');
      }
      const { data, errors } = await readRes.json();
      if (errors?.length) throw errors;
      if (data.order?.subtotalMeta?.value) {
        console.log('⚠️ Order already processed, skipping duplicates');
        return res.status(200).end('Already processed');
      }
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
      console.log(`Earned:${earnedShares} NewRemainder:${newRemainder}`);

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
      if (!mutRes.ok) {
        console.error('❌ Shopify mutation error', mutRes.status);
        return res.status(500).end('Shopify mutation error');
      }
      const mutJson = await mutRes.json();
      const custErrs  = mutJson.data.customerUpdate.userErrors;
      const orderErrs = mutJson.data.orderUpdate.userErrors;
      if (custErrs.length || orderErrs.length) {
        console.error('Mutation errors', custErrs, orderErrs);
        return res.status(500).end('Metafield update failed');
      }
      console.log('✅ Metafields updated');

      // 4) Sheet write
      await appendOrderToSheet(order);
      console.log('✅ Sheet updated');

      res.status(200).end('OK');
    } catch (err) {
      const webhookId = req.get('X-Shopify-Webhook-Id');
      if (webhookId) processedWebhookIds.delete(webhookId);
      console.error('🔥 Unexpected error in webhook handler:', err);
      res.status(500).end('Internal Server Error');
    }
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
