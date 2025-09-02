// /order-adjust – stabil, idempotens, refund/cancel-safe, race-proof
// - Támogatott: refunds/create, orders/cancelled, order payload refund delta
// - Refund delta: payloadból számol (nem subtotal diff)
// - Cancel: csak a ténylegesen fennmaradó összeget írja jóvá (race-proof, baseline + aktuális total_refunds)
// - Idempotencia: Upstash Redis (EX=900,NX) -> memória fallback
// - Hibakezelés: tranziensekre 500 (Shopify retry), ignorálható esetekre 200, auth hibára 401
// - Google SA auth: BASE64 JSON (ajánlott) vagy CLIENT_EMAIL + PRIVATE_KEY (PEM) fallback
// - Sheets: L=subtotal(új), M=total(aktuális), N=tax(aktuális), timestamp az első üres cellába

require('dotenv').config();
const crypto = require('crypto');
const { google } = require('googleapis');

// Node18+ fetch
const fetch = global.fetch;
if (!fetch) console.warn('⚠️ global fetch not available');

// Google globális opciók
google.options({ retry: false, timeout: 10000 });

// ===== Idempotencia (Redis + memória fallback) =====
const seenLocal = new Map();
const SEEN_TTL_MS = 15 * 60 * 1000;

function pruneLocal() {
  const now = Date.now();
  for (const [k, exp] of seenLocal) if (exp <= now) seenLocal.delete(k);
}

async function seenOnce(id) {
  if (!id) return false;

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN;

  if (url && token) {
    try {
      // Upstash REST: SET key 1 EX 900 NX
      const res = await fetch(`${url}/set/${encodeURIComponent(`wh:${id}`)}/1?EX=900&NX`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json().catch(() => ({}));
      // result === "OK" -> most állítottuk (nem duplikált)
      // result !== "OK" -> már létezett (duplikált)
      return !j || j.result !== 'OK';
    } catch (e) {
      console.warn('⚠️ Redis idempotencia hiba, memória fallback:', e.message);
    }
  }

  pruneLocal();
  const now = Date.now();
  if (seenLocal.has(id) && seenLocal.get(id) > now) return true;
  seenLocal.set(id, now + SEEN_TTL_MS);
  return false;
}

// ===== Util =====
async function getRawBody(req) {
  if (req.rawBody && Buffer.isBuffer(req.rawBody)) return req.rawBody;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function verifyShopifyWebhook(req, buf) {
  const secret = process.env.SHOPIFY_API_SECRET_KEY;
  if (!secret) throw new Error('Missing SHOPIFY_API_SECRET_KEY');

  const h = req.headers['x-shopify-hmac-sha256'] || '';
  const expectedB64 = crypto.createHmac('sha256', secret).update(buf).digest('base64');

  const sig = Buffer.from(h, 'base64');
  const exp = Buffer.from(expectedB64, 'base64');

  if (sig.length !== exp.length) return false;
  return crypto.timingSafeEqual(exp, sig);
}

function asFloat(x, d = 0) {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : d;
}

// Refund sum a REFUND payloadból (refunds/create)
function sumRefundFromRefundPayload(refundPayload) {
  const txs = Array.isArray(refundPayload.transactions) ? refundPayload.transactions : [];
  let sum = 0;
  for (const t of txs) {
    const kind = String(t.kind || '').toLowerCase();
    const status = String(t.status || '').toLowerCase();
    if ((kind === 'refund' || kind === 'suggested_refund') && (!status || status === 'success')) {
      sum += asFloat(t.amount, 0);
    }
  }
  return sum;
}

// Refund összeg egy ORDER payloadból (összes eddigi refund)
function sumRefundsFromOrderPayload(orderPayload) {
  if (typeof orderPayload.total_refunds !== 'undefined') {
    return asFloat(orderPayload.total_refunds, 0);
  }
  const refunds = Array.isArray(orderPayload.refunds) ? orderPayload.refunds : [];
  let sum = 0;
  for (const r of refunds) {
    const txs = Array.isArray(r.transactions) ? r.transactions : [];
    for (const t of txs) {
      const kind = String(t.kind || '').toLowerCase();
      const status = String(t.status || '').toLowerCase();
      if ((kind === 'refund' || kind === 'suggested_refund') && (!status || status === 'success')) {
        sum += asFloat(t.amount, 0);
      }
    }
  }
  return sum;
}

function payloadType(payload) {
  if (payload && typeof payload === 'object') {
    if (payload.transactions && payload.order_id) return 'refund';
    if (Array.isArray(payload.refunds) || typeof payload.total_refunds !== 'undefined') return 'order';
  }
  return 'order';
}

// ===== Google Sheets =====
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
  const email = (process.env.GOOGLE_CLIENT_EMAIL || '').trim();
  let pk = (process.env.GOOGLE_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/^"+|"+$/g, '')
    .trim();
  if (!email || !pk) throw new Error('Hiányzó Google SA hitelesítés.');
  if (!pk.includes('BEGIN PRIVATE KEY') || !pk.includes('END PRIVATE KEY')) {
    throw new Error('GOOGLE_PRIVATE_KEY nem teljes PEM.');
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

function formatDecimalHU(num) {
  return Number(num || 0).toFixed(2).replace('.', ',');
}

async function updateSheet(orderId, subtotalNew, totalForSheet, taxForSheet) {
  const ssId = process.env.SPREADSHEET_ID;
  const sheet = process.env.SHEET_NAME;
  if (!ssId || !sheet) {
    console.warn('⚠️ Sheet env hiányos, kihagyva az update-et.');
    return;
  }
  const sheets = await getSheetsClient();

  // Sor keresése A oszlop alapján
  const getA = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `${sheet}!A:A`,
  });
  const A = getA.data.values || [];
  const idx = A.findIndex((r) => r[0] === String(orderId));
  if (idx < 0) {
    console.warn(`⚠️ Order ${orderId} nincs a sheetben – kihagyva.`);
    return;
  }
  const rowNum = idx + 1;

  // L, M, N frissítés HU tizedesekkel
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `${sheet}!L${rowNum}:N${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        formatDecimalHU(subtotalNew),
        formatDecimalHU(totalForSheet),
        formatDecimalHU(taxForSheet),
      ]],
    },
  });

  // első üres cella + timestamp megjegyzés
  const getRow = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId, range: `${sheet}!${rowNum}:${rowNum}`,
  });
  const cells = getRow.data.values ? getRow.data.values[0] : [];
  let emptyIdx = cells.findIndex((cell) => !cell || cell === '');
  if (emptyIdx < 0) emptyIdx = cells.length;

  function colLetter(n) {
    let s = ''; let num = n + 1;
    while (num > 0) {
      const mod = (num - 1) % 26;
      s = String.fromCharCode(65 + mod) + s;
      num = Math.floor((num - mod) / 26);
    }
    return s;
  }
  const col = colLetter(emptyIdx);

  const now = new Date();
  // Europe/Budapest egyszerű offset
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
}

// ===== Main handler =====
module.exports = async (req, res) => {
  console.log('▶️  /order-adjust');
  const FORCE200 = process.env.FORCE_200_ON_ERRORS === 'true';

  try {
    if (req.method !== 'POST') {
      return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
    }

    // Nyers body + HMAC
    let buf;
    try {
      buf = await getRawBody(req);
    } catch (e) {
      console.error('❌ Body read error:', e.message);
      return res.writeHead(FORCE200 ? 200 : 500).end(FORCE200 ? 'Bad body (200)' : 'Body read error');
    }

    try {
      if (!verifyShopifyWebhook(req, buf)) {
        console.warn('❌ HMAC invalid');
        return res.writeHead(401).end('Unauthorized');
      }
    } catch (e) {
      console.error('❌ HMAC verify error:', e.message);
      return res.writeHead(401).end('Unauthorized');
    }

    // Idempotencia
    const hookId = (req.headers['x-shopify-webhook-id'] || '').trim();
    if (await seenOnce(hookId)) {
      console.log('🔁 Duplicate webhook, skip:', hookId);
      return res.writeHead(200).end('OK (duplicate)');
    }

    // Topic + payload
    const topic = (req.headers['x-shopify-topic'] || '').trim().toLowerCase();
    let payload;
    try {
      payload = JSON.parse(buf.toString('utf8'));
    } catch (e) {
      console.error('❌ Invalid JSON:', e.message);
      // nem javul retrynél
      return res.writeHead(200).end('Bad JSON');
    }

    const type = payloadType(payload);
    const isRefundWebhook = topic === 'refunds/create' || type === 'refund';
    const isCancel = topic === 'orders/cancelled' || !!payload.cancelled_at;

    // Ha sem refund, sem cancel → nézzük, jelez-e refund összeget; ha nem, ignore
    if (!isCancel && !isRefundWebhook) {
      const maybeTotalRefunds = type === 'order' ? sumRefundsFromOrderPayload(payload) : 0;
      if (maybeTotalRefunds <= 0) {
        return res.writeHead(200).end('Ignored');
      }
    }

    // orderId
    const orderId = payload.order_id || payload.id;
    if (!orderId) {
      console.error('❌ Missing order ID');
      return res.writeHead(200).end('Missing order ID');
    }

    // Shopify env
    const shop = process.env.SHOPIFY_SHOP_NAME;
    const ver = process.env.SHOPIFY_API_VERSION;
    const token = process.env.SHOPIFY_API_ACCESS_TOKEN;
    if (!shop || !ver || !token) {
      console.error('❌ Shopify env hiányos');
      return res.writeHead(FORCE200 ? 200 : 500).end(FORCE200 ? 'Shop env missing (200)' : 'Shop env missing');
    }

    // Customer ID
    let custGid = payload.customer?.id;
    if (!custGid) {
      try {
        const r = await fetch(
          `https://${shop}.myshopify.com/admin/api/${ver}/orders/${orderId}.json?fields=customer`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        if (!r.ok) throw new Error(`REST ${r.status}`);
        const j = await r.json();
        custGid = j.order?.customer?.id;
      } catch (e) {
        console.warn('⚠️ Could not fetch customer via REST:', e.message);
      }
    }
    if (!custGid) {
      console.error('❌ No customer ID');
      // vendég rendelés – customer metafield nem frissíthető; egységesen 200
      return res.writeHead(200).end('No customer ID');
    }
    const custId = String(custGid).split('/').pop();

    const gqlUrl = `https://${shop}.myshopify.com/admin/api/${ver}/graphql.json`;
    const shareUnit = Number(process.env.SHARE_UNIT || 1) || 1;

    // ===== Baseline lekérés (kis retry) =====
    const multiQ = `
      query($oid:ID!,$cid:ID!){
        order: order(id:$oid){
          subtotal: metafield(namespace:"custom",key:"subtotal"){ value }
          refunded: metafield(namespace:"custom",key:"refunded_amount"){ value }
        }
        customer: customer(id:$cid){
          spent: metafield(namespace:"loyalty",key:"net_spent_total"){ value }
        }
      }`;

    async function fetchGQL(query, variables) {
      for (let i = 0; i < 3; i++) {
        const r = await fetch(gqlUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ query, variables }),
        });
        if (r.ok) return r.json();
        if (r.status >= 500 || r.status === 429) {
          await new Promise((s) => setTimeout(s, 200 * (i + 1)));
          continue;
        }
        const j = await r.text();
        throw new Error(`GraphQL ${r.status}: ${j}`);
      }
      throw new Error('GraphQL retry exhausted');
    }

    let prevSub = 0, prevRefunded = 0, prevSpent = 0;
    try {
      const prevJson = await fetchGQL(multiQ, {
        oid: `gid://shopify/Order/${orderId}`,
        cid: `gid://shopify/Customer/${custId}`,
      });
      if (prevJson.errors?.length) {
        console.warn('⚠️ GraphQL errors:', JSON.stringify(prevJson.errors));
      }
      prevSub = asFloat(prevJson?.data?.order?.subtotal?.value, 0);
      prevRefunded = asFloat(prevJson?.data?.order?.refunded?.value, 0);
      prevSpent = asFloat(prevJson?.data?.customer?.spent?.value, 0);
    } catch (e) {
      console.error('❌ GraphQL baseline hiba:', e.message);
      return res.writeHead(FORCE200 ? 200 : 500).end(FORCE200 ? 'GQL baseline error (200)' : 'GQL baseline error');
    }

    // Fallback baseline subtotal (első futás/cold start eset)
    if (prevSub <= 0) {
      try {
        const r = await fetch(
          `https://${shop}.myshopify.com/admin/api/${ver}/orders/${orderId}.json?fields=subtotal_price,total_line_items_price,total_refunds`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        if (r.ok) {
          const j = await r.json();
          const ord = j.order || {};
          const fallbackSub = asFloat(ord.subtotal_price || ord.total_line_items_price, 0);
          if (fallbackSub > 0) prevSub = fallbackSub;
          if (prevRefunded <= 0 && typeof ord.total_refunds !== 'undefined') {
            prevRefunded = asFloat(ord.total_refunds, 0);
          }
        }
      } catch (e) {
        console.warn('⚠️ REST fallback subtotal hiba:', e.message);
      }
    }

    // ===== Delta számítás =====
    let deltaRefund = 0;
    let totalRefundedNow = 0;

    if (isCancel) {
      // Race-proof cancel: a mostanáig refundolt összegtől függően csak a fennmaradót írjuk jóvá.
      // baselineTracked = amit eddig mi nyilvántartunk: prevSub (maradék) + prevRefunded (eddigi refund)
      const baselineTracked = prevSub + prevRefunded;

      // próbáljuk a cancel payloadból/order payloadból kinyerni az aktuális total_refunds értéket
      totalRefundedNow = sumRefundsFromOrderPayload(payload);

      // ha nincs jelzés, REST-ből egy gyors lekérés csak total_refunds-ra
      if (!totalRefundedNow) {
        try {
          const r = await fetch(
            `https://${shop}.myshopify.com/admin/api/${ver}/orders/${orderId}.json?fields=total_refunds`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          if (r.ok) {
            const j = await r.json();
            totalRefundedNow = asFloat(j?.order?.total_refunds, 0);
          }
        } catch (_) {}
      }

      // fennmaradó rész, amit még nem refundoltak
      const remainingToZero = Math.max(0, baselineTracked - (totalRefundedNow || 0));
      deltaRefund = Math.min(remainingToZero, prevSub); // sose lépje túl a maradékot
    } else if (isRefundWebhook) {
      // refunds/create → a friss refund tranzakciók összege
      deltaRefund = sumRefundFromRefundPayload(payload);
      deltaRefund = Math.max(0, Math.min(deltaRefund, prevSub));
    } else {
      // order payload → delta = total_refunds_now - prevRefunded
      totalRefundedNow = sumRefundsFromOrderPayload(payload);
      deltaRefund = Math.max(0, Math.min(totalRefundedNow - prevRefunded, prevSub));
    }

    if (deltaRefund <= 0 && !isCancel) {
      console.log('ℹ️ No new refund to apply');
      return res.writeHead(200).end('No new refund');
    }

    // ===== Új értékek =====
    let newSub, newRefunded;

    if (isCancel) {
      // Cancel után a rendelés nettója 0, refunded_amount pedig baseline-ig nőhet
      newSub = 0;
      const baselineTracked = prevSub + prevRefunded;
      newRefunded = Math.min(baselineTracked, prevRefunded + (deltaRefund || 0));
    } else {
      newSub = Math.max(0, prevSub - deltaRefund);
      newRefunded = prevRefunded + deltaRefund;
    }

    const prevSpentSafe = Math.max(0, prevSpent);
    const newSpent = Math.max(0, prevSpentSafe - deltaRefund);

    const newSharesOrder = Math.floor(newSub / shareUnit);
    const newRemOrder = newSub % shareUnit;
    const newSharesCust = Math.floor(newSpent / shareUnit);
    const newRemCust = newSpent % shareUnit;

    // ===== Metafield update =====
    const mutation = `
      mutation($c:CustomerInput!,$o:OrderInput!){
        customerUpdate(input:$c){ userErrors{ field message } }
        orderUpdate(input:$o){ userErrors{ field message } }
      }`;

    const vars = {
      c: {
        id: `gid://shopify/Customer/${custId}`,
        metafields: [
          { namespace: 'loyalty', key: 'net_spent_total',   type: 'number_decimal', value: newSpent.toFixed(2) },
          { namespace: 'loyalty', key: 'reszvenyek_szama',  type: 'number_integer', value: String(newSharesCust) },
          { namespace: 'custom',  key: 'jelenlegi_fennmarado', type: 'number_decimal', value: newRemCust.toFixed(2) },
        ],
      },
      o: {
        id: `gid://shopify/Order/${orderId}`,
        metafields: [
          { namespace: 'custom', key: 'subtotal',         type: 'number_decimal', value: newSub.toFixed(2) },
          { namespace: 'custom', key: 'order_share',      type: 'number_integer', value: String(newSharesOrder) },
          { namespace: 'custom', key: 'order_remainder',  type: 'number_decimal', value: newRemOrder.toFixed(2) },
          { namespace: 'custom', key: 'refunded_amount',  type: 'number_decimal', value: newRefunded.toFixed(2) },
        ],
      },
    };

    let mj;
    try {
      const mr = await fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: mutation, variables: vars }),
      });
      mj = await mr.json();
    } catch (e) {
      console.error('❌ GraphQL mutation hiba:', e.message);
      return res.writeHead(FORCE200 ? 200 : 500).end(FORCE200 ? 'GQL mutation error (200)' : 'GQL mutation error');
    }

    const userErrs = [
      ...(mj?.data?.customerUpdate?.userErrors || []),
      ...(mj?.data?.orderUpdate?.userErrors || []),
    ];
    if (userErrs.length) {
      console.error('❌ Metafield userErrors:', userErrs);
      return res.writeHead(FORCE200 ? 200 : 500).end(FORCE200 ? 'Metafield userErrors (200)' : 'Metafield userErrors');
    }
    console.log('✅ Metafields updated');

    // ===== Sheets update (best-effort) =====
    try {
      let sheetTotal = 0, sheetTax = 0;
      if (!isCancel) {
        try {
          const r = await fetch(
            `https://${shop}.myshopify.com/admin/api/${ver}/orders/${orderId}.json?fields=current_total_price,current_total_tax,total_price,total_tax`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          if (r.ok) {
            const j = await r.json();
            const ord = j.order || {};
            sheetTotal = asFloat(ord.current_total_price ?? ord.total_price, 0);
            sheetTax   = asFloat(ord.current_total_tax  ?? ord.total_tax, 0);
          }
        } catch (e) {
          console.warn('⚠️ REST totals hiba:', e.message);
        }
      } // cancelnél marad 0,0

      await updateSheet(orderId, newSub, sheetTotal, sheetTax);
      console.log('✅ Sheet updated');
    } catch (e) {
      console.error('⚠️ Sheet update error:', e.message);
    }

    return res.writeHead(200).end('OK');
  } catch (e) {
    console.error('🔥 Handler fatal error:', e?.response?.data || e.message || e);
    return res.writeHead(process.env.FORCE_200_ON_ERRORS === 'true' ? 200 : 500)
      .end(process.env.FORCE_200_ON_ERRORS === 'true' ? 'Internal error (200)' : 'Internal error');
  }
};
