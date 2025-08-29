// ✅ Javított /order-adjust handler (idempotens + stabil Google auth)
// - Google SA hitelesítés: GOOGLE_CREDENTIALS_JSON_BASE64 (ajánlott), vagy CLIENT_EMAIL + PRIVATE_KEY fallback
// - Idempotencia: X-Shopify-Webhook-Id alapú deduplikáció (15 perc TTL) + 200 OK hiba esetén is (Shopify ne retri-eljen)
// - HMAC ellenőrzés (hibás HMAC esetén 401 – biztonsági okból)

require('dotenv').config();
const crypto = require('crypto');
const { google } = require('googleapis');

// Node18+ global fetch
const fetch = global.fetch;
if (!fetch) console.warn('⚠️ global fetch not available');

// Google kliens globális opciók: retry OFF, timeout
google.options({ retry: false, timeout: 10000 });

// ---- Idempotencia cache: X-Shopify-Webhook-Id → expiry ----
const seen = new Map();
const SEEN_TTL_MS = 15 * 60 * 1000;
function seenOnce(id) {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
  if (!id) return false;
  if (seen.has(id) && seen.get(id) > now) return true;
  seen.set(id, now + SEEN_TTL_MS);
  return false;
}

// helper for decimal formatting for Sheets: comma as decimal separator
function formatDecimal(num) {
  return Number(num || 0).toFixed(2).replace('.', ',');
}

// Read raw body for HMAC (serverless kompatibilis)
async function getRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// 1) HMAC validation
function verifyShopifyWebhook(req, buf) {
  const secret = process.env.SHOPIFY_API_SECRET_KEY;
  if (!secret) throw new Error('Missing Shopify secret');
  const hmac = req.headers['x-shopify-hmac-sha256'] || '';
  const digest = crypto.createHmac('sha256', secret).update(buf).digest('base64');
  return hmac && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

// ---- Google SA betöltése (ajánlott: base64 JSON) ----
function loadGoogleCreds() {
  const b64 = process.env.GOOGLE_CREDENTIALS_JSON_BASE64;
  if (b64 && b64.trim()) {
    const raw = Buffer.from(b64, 'base64').toString('utf8');
    const json = JSON.parse(raw);
    if (!json.client_email || !json.private_key) {
      throw new Error('Service Account JSON hiányos (client_email/private_key).');
    }
    return json;
  }
  // Fallback: külön env-ek
  const email = (process.env.GOOGLE_CLIENT_EMAIL || '').trim();
  let pk = (process.env.GOOGLE_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/^"+|"+$/g, '')
    .trim();
  if (!email || !pk) throw new Error('Hiányzó Google SA hitelesítés.');
  if (!pk.includes('BEGIN PRIVATE KEY') || !pk.includes('END PRIVATE KEY')) {
    throw new Error('GOOGLE_PRIVATE_KEY nem teljes PEM (hiányzó header/láb).');
  }
  return { client_email: email, private_key: pk };
}

async function getSheetsClient() {
  const credentials = loadGoogleCreds();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// 2) Update Google Sheet: L=subtotal, M=total, N=tax, majd "módosítva" jelzés első üres cellába
async function adjustSheet(orderId, subtotal, total, tax) {
  const sheets = await getSheetsClient();
  const ssId = process.env.SPREADSHEET_ID;
  const sheet = process.env.SHEET_NAME;

  // 2.1) Sor keresése A oszlop alapján (orderId)
  const getA = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `${sheet}!A:A`,
  });
  const A = getA.data.values || [];
  const idx = A.findIndex((r) => r[0] === String(orderId));
  if (idx < 0) {
    console.warn(`Order ${orderId} not in sheet`);
    return;
  }
  const rowNum = idx + 1;

  // 2.2) L, M, N frissítés HU tizedesekkel
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `${sheet}!L${rowNum}:N${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[formatDecimal(subtotal), formatDecimal(total), formatDecimal(tax)]],
    },
  });

  // 2.3) Első üres cella a soron
  const getRow = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `${sheet}!${rowNum}:${rowNum}`,
  });
  const cells = getRow.data.values ? getRow.data.values[0] : [];
  let emptyIdx = cells.findIndex((cell) => !cell || cell === '');
  if (emptyIdx < 0) emptyIdx = cells.length;

  // Zero-based index → excel oszlop betű
  function colLetter(n) {
    let s = '';
    let num = n + 1;
    while (num > 0) {
      const mod = (num - 1) % 26;
      s = String.fromCharCode(65 + mod) + s;
      num = Math.floor((num - mod) / 26);
    }
    return s;
  }
  const col = colLetter(emptyIdx);

  // 2.4) "módosítva" timestamp (UTC+2)
  const now = new Date();
  now.setHours(now.getHours() + 2);
  const pad = (n) => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}` +
    ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const note = `módosítva: ${ts}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `${sheet}!${col}${rowNum}`,
    valueInputOption: 'RAW',
    resource: { values: [[note]] },
  });

  console.log(`Sheet row ${rowNum} updated (L–N, note in ${col}${rowNum})`);
}

module.exports = async (req, res) => {
  console.log('▶️  /order-adjust');

  // Csak POST
  if (req.method !== 'POST') {
    return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
  }

  // Nyers body + HMAC
  let buf;
  try {
    buf = await getRawBody(req);
  } catch (e) {
    console.error('❌ Body read error:', e.message);
    // 200: ne retri-eljen a Shopify
    return res.writeHead(200).end('Bad body');
  }

  try {
    if (!verifyShopifyWebhook(req, buf)) {
      console.warn('❌ HMAC invalid');
      // biztonsági okból 401, ezt NEM fogadjuk el
      return res.writeHead(401).end('Unauthorized');
    }
  } catch (e) {
    console.error('❌ HMAC verify error:', e.message);
    return res.writeHead(401).end('Unauthorized');
  }

  // Deduplikáció
  const hookId = (req.headers['x-shopify-webhook-id'] || '').trim();
  if (seenOnce(hookId)) {
    console.log('🔁 Duplicate webhook, skip:', hookId);
    return res.writeHead(200).end('OK (duplicate ignored)');
  }

  // Payload parse
  let payload;
  try {
    payload = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    console.error('❌ Invalid JSON:', e.message);
    // 200: ne retri-eljen
    return res.writeHead(200).end('Bad JSON');
  }

  // Csak cancelled/refunded
  const topic = (req.headers['x-shopify-topic'] || '').trim().toLowerCase();
  const isCancel = topic === 'orders/cancelled';
  const hasRefund = Boolean(
    payload.refund_line_items ||
      (payload.refunds?.flatMap((r) => r.refund_line_items || []).length)
  );
  if (!isCancel && !hasRefund) {
    return res.writeHead(200).end('Ignored');
  }

  // orderId
  const orderId = payload.order_id || payload.id;
  if (!orderId) {
    console.error('❌ Missing order ID');
    return res.writeHead(200).end('Missing order ID');
  }

  // customer GID
  let custGid = payload.customer?.id;
  if (!custGid) {
    try {
      const r = await fetch(
        `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}` +
          `/orders/${orderId}.json?fields=customer`,
        { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN } }
      );
      const j = await r.json();
      custGid = j.order?.customer?.id;
    } catch (e) {
      console.warn('⚠️ Could not fetch customer via REST:', e.message);
    }
  }
  if (!custGid) {
    console.error('❌ No customer ID');
    return res.writeHead(200).end('No customer ID');
  }
  const custId = String(custGid).split('/').pop();

  // Előkészület
  const gqlUrl = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;
  const shareUnit = Number(process.env.SHARE_UNIT || 1);

  try {
    // 1) Előző és aktuális értékek
    const multiQ = `
      query($oid:ID!,$cid:ID!){
        order: order(id:$oid){
          subtotal: metafield(namespace:"custom",key:"subtotal"){value}
          refunded: metafield(namespace:"custom",key:"refunded_amount"){value}
        }
        customer: customer(id:$cid){spent: metafield(namespace:"loyalty",key:"net_spent_total"){value}}
      }`;

    const [prevRes, currRes] = await Promise.all([
      fetch(gqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN,
        },
        body: JSON.stringify({
          query: multiQ,
          variables: {
            oid: `gid://shopify/Order/${orderId}`,
            cid: `gid://shopify/Customer/${custId}`,
          },
        }),
      }),
      fetch(
        `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}` +
          `/orders/${orderId}.json?fields=current_subtotal_price,current_total_price,current_total_tax`,
        { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN } }
      ),
    ]);

    const prevJson = await prevRes.json();
    if (prevJson.errors?.length) {
      console.warn('⚠️ GraphQL errors (prev):', JSON.stringify(prevJson.errors));
    }
    let prevSub = parseFloat(prevJson?.data?.order?.subtotal?.value || 0);
    let prevRefunded = parseFloat(prevJson?.data?.order?.refunded?.value || 0);
    const prevSpent = parseFloat(prevJson?.data?.customer?.spent?.value || 0);

    const currJson = await currRes.json();
    let currSub = parseFloat(currJson?.order?.current_subtotal_price || 0);
    let currTot = parseFloat(currJson?.order?.current_total_price || 0);
    let currTax = parseFloat(currJson?.order?.current_total_tax || 0);

    if (isCancel) {
      currSub = 0;
      currTot = 0;
      currTax = 0;
    }

    const adjust = prevSub - currSub;
    if (adjust <= 0) {
      console.log('ℹ️ No change needed');
      return res.writeHead(200).end('No change');
    }

    // Új derivált értékek
    const newSub = currSub;
    const newSharesOrder = Math.floor(newSub / shareUnit);
    const newRemOrder = newSub % shareUnit;
    const newRefunded = prevRefunded + adjust;
    const newSpent = prevSpent - adjust;
    const newSharesCust = Math.floor(newSpent / shareUnit);
    const newRemCust = newSpent % shareUnit;

    // 2) Mutáció (ponttal elválasztott tizedesek)
    const mutation = `
      mutation($c:CustomerInput!,$o:OrderInput!){
        customerUpdate(input:$c){userErrors{field message}}
        orderUpdate(input:$o){userErrors{field message}}
      }`;

    const vars = {
      c: {
        id: `gid://shopify/Customer/${custId}`,
        metafields: [
          { namespace: 'loyalty', key: 'net_spent_total', type: 'number_decimal', value: newSpent.toFixed(2) },
          { namespace: 'loyalty', key: 'reszvenyek_szama', type: 'number_integer', value: newSharesCust.toString() },
          { namespace: 'custom', key: 'jelenlegi_fennmarado', type: 'number_decimal', value: newRemCust.toFixed(2) },
        ],
      },
      o: {
        id: `gid://shopify/Order/${orderId}`,
        metafields: [
          { namespace: 'custom', key: 'subtotal', type: 'number_decimal', value: newSub.toFixed(2) },
          { namespace: 'custom', key: 'order_share', type: 'number_integer', value: newSharesOrder.toString() },
          { namespace: 'custom', key: 'order_remainder', type: 'number_decimal', value: newRemOrder.toFixed(2) },
          { namespace: 'custom', key: 'refunded_amount', type: 'number_decimal', value: newRefunded.toFixed(2) },
        ],
      },
    };

    const mr = await fetch(gqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query: mutation, variables: vars }),
    });
    const mj = await mr.json();
    const errs = [
      ...(mj?.data?.customerUpdate?.userErrors || []),
      ...(mj?.data?.orderUpdate?.userErrors || []),
    ];
    if (errs.length) {
      console.error('❌ Metafield mutation errors', errs);
      // 200: ne retri-eljen
      return res.writeHead(200).end('Metafield update failed');
    }
    console.log('✅ Metafields updated');

    // 3) Sheet frissítés (best-effort)
    try {
      await adjustSheet(orderId, currSub, currTot, currTax);
      console.log('✅ Sheet updated');
    } catch (e) {
      console.error('⚠️ Sheet update error:', e.message);
      // nem dobjuk tovább
    }

    return res.writeHead(200).end('OK');
  } catch (e) {
    console.error('🔥 Handler error:', e?.response?.data || e.message || e);
    // 200: ne retri-eljen
    return res.writeHead(200).end('OK (handled with errors)');
  }
};
