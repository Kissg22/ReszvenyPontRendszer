require('dotenv').config();
const crypto = require('crypto');
const { google } = require('googleapis');

// Node18+ global fetch
const fetch = global.fetch;
if (!fetch) console.warn('⚠️ global fetch not available');

// Read raw body for HMAC
async function getRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// 1) HMAC validation
function verifyShopifyWebhook(req, buf) {
  const secret = process.env.SHOPIFY_API_SECRET_KEY;
  if (!secret) throw new Error('Missing Shopify secret');
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto.createHmac('sha256', secret).update(buf).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

// 2) Update Google Sheet: L=subtotal, M=total, N=tax, Q="módosítva"
async function adjustSheet(orderId, subtotal, total, tax) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const ssId = process.env.SPREADSHEET_ID;
  const sheet = process.env.SHEET_NAME;

  // find row by A
  const { values: A } = (await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `${sheet}!A:A`,
  })).data;
  const idx = (A || []).findIndex((r) => r[0] === String(orderId));
  if (idx < 0) return console.warn(`Order ${orderId} not in sheet`);
  const row = idx + 1;

  // update L,M,N
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `${sheet}!L${row}:N${row}`,
    valueInputOption: 'RAW',
    resource: { values: [[subtotal.toFixed(2), total.toFixed(2), tax.toFixed(2)]] },
  });

  // fetch & append Q
  const { values: Q } = (await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `${sheet}!Q${row}`,
  })).data;
  const prev = Q?.[0]?.[0] || '';
  const now = new Date();
  now.setHours(now.getHours() + 2);
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}` +
             ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const note = `módosítva: ${ts}`;
  const updated = prev ? `${prev}; ${note}` : note;
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `${sheet}!Q${row}`,
    valueInputOption: 'RAW',
    resource: { values: [[updated]] },
  });

  console.log(`Sheet row ${row} updated (L–N, Q)`);
}

module.exports = async (req, res) => {
  console.log('▶️  /order-adjust');

  if (req.method !== 'POST') {
    return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
  }

  // raw body + HMAC
  let buf;
  try {
    buf = await getRawBody(req);
  } catch {
    return res.writeHead(400).end('Invalid body');
  }
  if (!verifyShopifyWebhook(req, buf)) {
    return res.writeHead(401).end('Unauthorized');
  }

  // parse payload
  let payload;
  try {
    payload = JSON.parse(buf.toString());
  } catch {
    return res.writeHead(400).end('Invalid JSON');
  }

  // detect event
  const topicHeader = req.headers['x-shopify-topic'] || '';
  const topic = topicHeader.trim().toLowerCase();
  console.log('Webhook topic:', topicHeader);
  console.log('Normalized topic:', topic);
  const isCancel = topic === 'orders/cancelled';
  const hasRefund = Boolean(
    payload.refund_line_items || payload.refunds?.flatMap((r) => r.refund_line_items || []).length
  );
  if (!isCancel && !hasRefund) {
    console.log('ℹ️ Nem cancel vagy refund esemény, skip.');
    return res.writeHead(200).end('Ignored');
  }

  // order + customer IDs
  const orderId = payload.order_id || payload.id;
  if (!orderId) return res.writeHead(400).end('Missing order ID');

  // ensure we have customer GID
  let custGid = payload.customer?.id;
  if (!custGid) {
    try {
      const r = await fetch(
        `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/orders/${orderId}.json?fields=customer`,
        { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN } }
      );
      custGid = (await r.json()).order?.customer?.id;
    } catch {}
  }
  if (!custGid) return res.writeHead(400).end('No customer ID');
  const custId = String(custGid).split('/').pop();

  const gqlUrl = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;
  const shareUnit = Number(process.env.SHARE_UNIT);

  // --- fetch prev metafields & current REST ---
  const multiQ = `
    query($oid:ID!,$cid:ID!){
      order: order(id:$oid){ subtotal: metafield(namespace:\"custom\",key:\"subtotal\"){value} }
      customer: customer(id:$cid){ spent: metafield(namespace:\"loyalty\",key:\"net_spent_total\"){value} }
    }`;
  const [prevRes, currRes] = await Promise.all([
    fetch(gqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query: multiQ, variables: { oid: `gid://shopify/Order/${orderId}`, cid: `gid://shopify/Customer/${custId}` } }),
    }),
    fetch(
      `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/orders/${orderId}.json?fields=current_subtotal_price,current_total_price,current_total_tax`,
      { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN } }
    ),
  ]);
  const prevJson = await prevRes.json();
  const prevSub = Number(prevJson.data.order.subtotal?.value || 0);
  const prevSpent = Number(prevJson.data.customer.spent?.value || 0);
  let currJson = await currRes.json();
  let currSub = parseFloat(currJson.order.current_subtotal_price);
  let currTot = parseFloat(currJson.order.current_total_price);
  let currTax = parseFloat(currJson.order.current_total_tax);

  // --- cancel without refund: zero out values ---
  if (isCancel && !hasRefund) {
    console.log('ℹ️ Cancellation without refund: zeroing order values');
    currSub = 0;
    currTot = 0;
    currTax = 0;
  }

  // compute adjust = what to subtract
  const adjust = prevSub - currSub;
  if (adjust <= 0) {
    console.log('ℹ️ Nincs levonásra váró összeg, skip.');
    return res.writeHead(200).end('No change');
  }

  // new values
  const newSub = currSub;
  const newSharesOrder = Math.floor(newSub / shareUnit);
  const newRemOrder = newSub % shareUnit;
  const newSpent = prevSpent - adjust;
  const newSharesCust = Math.floor(newSpent / shareUnit);
  const newRemCust = newSpent % shareUnit;

  // GraphQL mutation
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
  const errs = [...mj.data.customerUpdate.userErrors, ...mj.data.orderUpdate.userErrors];
  if (errs.length) {
    console.error('❌ Metafield mutation errors', errs);
    return res.writeHead(500).end('Metafield update failed');
  }
  console.log('✅ Metafields updated');

  // update sheet
  await adjustSheet(orderId, currSub, currTot, currTax);
  console.log('✅ Sheet updated');

  res.writeHead(200).end('OK');
};
