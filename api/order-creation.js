// ✅ Javított, idempotens, egyszer futó Shopify webhook handler Google Sheets írással
// - NINCS OpenSSL/PEM mizéria: teljes SA JSON base64-ben is támogatott
// - NINCS többszöri próbálkozás: deduplikáció X-Shopify-Webhook-Id alapján + 200 OK hiba esetén is
// - HMAC ellenőrzés megtartva
//
// KÖRNYEZETI VÁLTOZÓK (ajánlott):
// - GOOGLE_CREDENTIALS_JSON_BASE64  (base64-elt teljes service-account JSON)  ← ajánlott
// - SPREADSHEET_ID
// - SHEET_NAME
// - SHOPIFY_API_SECRET_KEY
// - SHOPIFY_API_ACCESS_TOKEN
// - SHOPIFY_SHOP_NAME
// - SHOPIFY_API_VERSION
// - SHARE_UNIT
//
// (Alternatíva, ha nem használsz base64 JSON-t)
// - GOOGLE_CLIENT_EMAIL
// - GOOGLE_PRIVATE_KEY   (egysoros, \n escape-ekkel, PEM header/láb sorokkal)
//

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');

const fetch = global.fetch;
if (!fetch) console.warn('⚠️ global fetch not available');

const app = express();

// Google API kliens globális opciók: retry OFF, timeout beállítás
google.options({ retry: false, timeout: 10000 });

// ---- Idempotencia: feldolgozott webhookok cache-e (TTL) ----
const seenWebhookIds = new Map(); // id -> expiry epoch ms
const SEEN_TTL_MS = 15 * 60 * 1000; // 15 perc
function rememberOnce(id) {
  const now = Date.now();
  // töröljük a lejártakat
  for (const [k, v] of seenWebhookIds) if (v <= now) seenWebhookIds.delete(k);
  if (!id) return false;
  if (seenWebhookIds.has(id) && seenWebhookIds.get(id) > now) return true; // már láttuk, még érvényes
  seenWebhookIds.set(id, now + SEEN_TTL_MS);
  return false;
}

// ---- Google hitelesítés (base64 JSON → ajánlott) ----
function loadGoogleCreds() {
  const b64 = process.env.GOOGLE_CREDENTIALS_JSON_BASE64;
  if (b64 && b64.trim()) {
    try {
      const raw = Buffer.from(b64, 'base64').toString('utf8');
      const json = JSON.parse(raw);
      if (!json.client_email || !json.private_key) {
        throw new Error('Service Account JSON hiányos (client_email/private_key).');
      }
      return json;
    } catch (e) {
      console.error('❌ GOOGLE_CREDENTIALS_JSON_BASE64 feldolgozási hiba:', e.message);
      throw e;
    }
  }

  // VISSZAESÉS: külön env-ek (client_email + private_key)
  const email = (process.env.GOOGLE_CLIENT_EMAIL || '').trim();
  let pk = (process.env.GOOGLE_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/^"+|"+$/g, '')
    .trim();

  if (!email || !pk) {
    throw new Error('Hiányzó Google SA hitelesítés (GOOGLE_CREDENTIALS_JSON_BASE64 vagy CLIENT_EMAIL + PRIVATE_KEY).');
  }
  if (!pk.includes('BEGIN PRIVATE KEY') || !pk.includes('END PRIVATE KEY')) {
    throw new Error('GOOGLE_PRIVATE_KEY nem teljes PEM (hiányzó header/láb).');
  }
  return { client_email: email, private_key: pk };
}

async function getSheets() {
  const credentials = loadGoogleCreds();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// ---- HMAC ellenőrzés (Shopify) ----
function verifyShopifyWebhook(req) {
  const secret = process.env.SHOPIFY_API_SECRET_KEY?.trim();
  if (!secret) throw new Error('Missing SHOPIFY_API_SECRET_KEY');

  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto.createHmac('sha256', secret).update(req.body).digest('base64');

  const valid =
    hmacHeader &&
    crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));

  return valid;
}

// ---- Segéd: magyar idő formázás ----
function formatHuDate(iso) {
  const d = new Date(iso);
  d.setHours(d.getHours() + 2);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// ---- Google Sheet: A:T append ----
async function appendOrderToSheet(order) {
  const sheets = await getSheets();

  const cust = order.customer || {};
  const ship = order.shipping_address || {};
  const phone = ship.phone || order.phone || cust.phone || '';

  const items = order.line_items || [];
  const qty = items.reduce((s, i) => s + (i.quantity || 0), 0);
  const names = items.map((i) => i.title).join(';');
  const skus = items.map((i) => i.sku).join(';');
  const vendors = items.map((i) => i.vendor).join(';');

  const addr = [ship.zip, ship.city, ship.address1, ship.address2]
    .filter(Boolean)
    .join('; ');

  const toHu = (s) => String(s ?? '').replace('.', ',');

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
    toHu(order.subtotal_price),
    toHu(order.total_price),
    toHu(order.total_tax),
    addr,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME}!A:T`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [row] },
  });
}

// ---- Webhook handler: Order Creation ----
app.post(
  '/webhook/order-creation',
  // nyers body kell a HMAC-hez
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    console.log('▶️ order-creation handler called, method:', req.method);

    // 1) Csak POST
    if (req.method !== 'POST') {
      return res.status(405).end('Method Not Allowed');
    }

    // 2) HMAC ellenőrzés
    try {
      const snippet = req.body.slice(0, 200).toString('utf8');
      console.log('📦 Raw body (first 200 bytes):', snippet);

      if (!verifyShopifyWebhook(req)) {
        console.log('❌ HMAC validation failed');
        return res.status(401).end('Unauthorized');
      }
    } catch (e) {
      console.error('❌ HMAC error:', e);
      // 401-et adunk vissza, hogy ne fogadjuk el az érvénytelen kérést
      return res.status(401).end('Unauthorized');
    }

    // 3) Deduplikáció (X-Shopify-Webhook-Id)
    const hookId = req.get('X-Shopify-Webhook-Id') || '';
    if (rememberOnce(hookId)) {
      console.log('🔁 Webhook már feldolgozva, skip:', hookId);
      return res.status(200).end('OK (duplicate ignored)');
    }

    // 4) JSON parse
    let order;
    try {
      order = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
      console.error('❌ Invalid JSON payload:', e.message);
      // 200-zal válaszolunk, hogy Shopify ne próbálja újra (kérés elfogadva, de nem feldolgozható)
      return res.status(200).end('Bad payload');
    }

    // 5) Üzleti logika
    try {
      console.log(`▶️ Order ${order.id} received`);

      const shop = process.env.SHOPIFY_SHOP_NAME;
      const token = process.env.SHOPIFY_API_ACCESS_TOKEN;
      const shareUnit = Number(process.env.SHARE_UNIT || 1);
      const endpoint = `https://${shop}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

      const custGid = String(order.customer?.id || '').split('/').pop();
      if (!custGid) throw new Error('Missing customer id');
      console.log(`🆔 Customer GID: ${custGid}`);

      // 5.1) Olvasás
      const readRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({
          query: `query getCustomer($id: ID!) {
            customer(id: $id) {
              netSpent: metafield(namespace: "loyalty", key: "net_spent_total") { value }
              sharesCount: metafield(namespace: "loyalty", key: "reszvenyek_szama") { value }
              remainder: metafield(namespace: "custom", key: "jelenlegi_fennmarado") { value }
            }
          }`,
          variables: { id: `gid://shopify/Customer/${custGid}` },
        }),
      });

      const readJson = await readRes.json();
      if (readJson.errors?.length) throw new Error(JSON.stringify(readJson.errors));
      const prevSpent = parseFloat(readJson.data.customer.netSpent?.value || '0');
      const prevShares = parseInt(readJson.data.customer.sharesCount?.value || '0', 10);

      // 5.2) Számítások
      const subtotal = parseFloat(order.subtotal_price || '0');
      const newTotal = prevSpent + subtotal;
      const totalShares = Math.floor(newTotal / shareUnit);
      const earnedShares = totalShares - prevShares;
      const newRemainder = newTotal % shareUnit;

      console.log(`PrevSpent:${prevSpent} Earned:${earnedShares} NewRemainder:${newRemainder}`);

      // 5.3) Mutációk
      const mutation = `mutation updateBoth($custInput: CustomerInput!, $orderInput: OrderInput!) {
        customerUpdate(input: $custInput) { userErrors { field message } }
        orderUpdate(input: $orderInput) { userErrors { field message } }
      }`;
      const variables = {
        custInput: {
          id: `gid://shopify/Customer/${custGid}`,
          metafields: [
            { namespace: 'loyalty', key: 'net_spent_total', type: 'number_decimal', value: newTotal.toFixed(2) },
            { namespace: 'loyalty', key: 'reszvenyek_szama', type: 'number_integer', value: totalShares.toString() },
            { namespace: 'custom', key: 'jelenlegi_fennmarado', type: 'number_decimal', value: newRemainder.toFixed(2) },
          ],
        },
        orderInput: {
          id: `gid://shopify/Order/${order.id}`,
          metafields: [
            { namespace: 'custom', key: 'subtotal', type: 'number_decimal', value: subtotal.toFixed(2) },
            { namespace: 'custom', key: 'order_share', type: 'number_integer', value: earnedShares.toString() },
            { namespace: 'custom', key: 'order_remainder', type: 'number_decimal', value: newRemainder.toFixed(2) },
          ],
        },
      };
      const mutRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query: mutation, variables }),
      });
      const mutJson = await mutRes.json();
      const custErrs = mutJson?.data?.customerUpdate?.userErrors || [];
      const orderErrs = mutJson?.data?.orderUpdate?.userErrors || [];
      if (custErrs.length || orderErrs.length) {
        throw new Error(`Mutation errors: ${JSON.stringify({ custErrs, orderErrs })}`);
      }
      console.log('✅ Metafields updated');

      // 5.4) Sheet írás
      await appendOrderToSheet(order);
      console.log('✅ Sheet updated');

      // 6) Mindig 200-al zárunk, hogy Shopify NE próbálja újra
      return res.status(200).end('OK');
    } catch (err) {
      console.error('🔥 Webhook business error:', err?.response?.data || err?.message || err);
      // Itt is 200-at adunk vissza (kérés elfogadva), hogy NE legyen újrapróbálás Shopify oldalról
      return res.status(200).end('OK (handled with errors)');
    }
  }
);

// ---- Healthcheck ----
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---- Indítás ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
