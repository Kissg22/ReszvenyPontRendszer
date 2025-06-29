// api/order-adjust.js
require('dotenv').config();
const crypto = require('crypto');
const { google } = require('googleapis');

// Node18+ globális fetch
const fetch = global.fetch;
if (!fetch) console.warn('⚠️ global fetch not available');

// Raw body reader
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// 1) HMAC ellenőrzés
function verifyShopifyWebhook(req, buf) {
  const secret = process.env.SHOPIFY_API_SECRET_KEY;
  if (!secret) throw new Error('Missing SHOPIFY_API_SECRET_KEY');
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto.createHmac('sha256', secret)
                       .update(buf)
                       .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// 2) Sheet frissítő függvény: 
//    megkeresi az orderId-t az A oszlopban,
//    frissíti L–M mezőket,
//    ugyanabban a sorban Q mezőbe fűzi a "módosítva" időbélyeget
async function adjustSheet(orderId, newSubtotal, newShares) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:   process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const ssId  = process.env.SPREADSHEET_ID;
  const sheet = process.env.SHEET_NAME;

  // 2.1) Megkeressük a célsor számát az A-oszlopban
  const { data: readA } = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `${sheet}!A:A`
  });
  const rowsA = readA.values || [];
  const rowIndex = rowsA.findIndex(r => r[0] === String(orderId));
  if (rowIndex === -1) {
    console.warn(`⚠️ Order ID ${orderId} nem található a sheetben`);
    return;
  }
  const targetRow = rowIndex + 1; // 1-es alapú index

  // 2.2) Frissítjük L (12.) és M (13.) oszlopot (A=1 → L=12, M=13)
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `${sheet}!L${targetRow}:M${targetRow}`,
    valueInputOption: 'RAW',
    resource: {
      values: [[ newSubtotal.toFixed(2), String(newShares) ]]
    }
  });

  // 2.3) Q (17.) oszlopba fűzzük hozzá a módosítás időpontját
  const { data: readQ } = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `${sheet}!Q${targetRow}`
  });
  const prev = readQ.values?.[0]?.[0] || '';
  const now = new Date();
  now.setHours(now.getHours() + 2);
  const pad = n => String(n).padStart(2,'0');
  const ts = `${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())}` +
             ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const note = `módosítva: ${ts}`;
  const updatedQ = prev ? `${prev}; ${note}` : note;

  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `${sheet}!Q${targetRow}`,
    valueInputOption: 'RAW',
    resource: {
      values: [[ updatedQ ]]
    }
  });

  console.log(`✅ Sor ${targetRow} frissítve: L,M és Q „módosítva: ${ts}”`);
}

// 3) Webhook handler
module.exports = async (req, res) => {
  console.log('▶️  /order-adjust endpoint hit');

  // Csak POST
  if (req.method !== 'POST') {
    return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
  }

  // Raw body + HMAC
  let buf;
  try {
    buf = await getRawBody(req);
  } catch (e) {
    console.error('❌ Error reading body:', e);
    return res.writeHead(400).end('Invalid body');
  }
  if (!verifyShopifyWebhook(req, buf)) {
    console.error('❌ HMAC validation failed');
    return res.writeHead(401).end('Unauthorized');
  }

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(buf.toString());
  } catch (e) {
    console.error('❌ Invalid JSON payload:', e);
    return res.writeHead(400).end('Invalid JSON');
  }

  // Csak refund esemény
  const items = payload.refund_line_items
             || payload.refunds?.flatMap(r => r.refund_line_items || []);
  if (!items?.length) {
    return res.writeHead(200).end('No refund to adjust');
  }

  // Refund összeg
  const adjustAmount = items.reduce((sum, li) => {
    const amt = li.subtotal_set?.presentment_money?.amount
              || li.subtotal
              || 0;
    return sum + Number(amt);
  }, 0);
  if (adjustAmount <= 0) {
    return res.writeHead(200).end('Zero refund');
  }

  // Order ID
  const orderId = payload.order_id || payload.id;
  if (!orderId) {
    console.error('❌ Missing order ID');
    return res.writeHead(400).end('Missing order ID');
  }

  // Shopify GraphQL endpoint és shareUnit
  const shop      = process.env.SHOPIFY_SHOP_NAME;
  const token     = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const shareUnit = Number(process.env.SHARE_UNIT);
  const gqlUrl    = `https://${shop}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

  // 4) Lekérjük a prevOrderSubtotal metafieldet
  const orderMetaQ = `
    query($id: ID!){order(id:$id){subtotalMeta: metafield(namespace:"custom",key:"subtotal"){value}}}
  `;
  const omResp = await fetch(gqlUrl, {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query: orderMetaQ, variables: { id: `gid://shopify/Order/${orderId}` } })
  });
  const omJson = await omResp.json();
  const prevOrderSubtotal = Number(omJson.data.order.subtotalMeta?.value || 0);

  // 5) Új order értékek
  const newOrderSubtotal = prevOrderSubtotal - adjustAmount;
  const newOrderShares   = Math.floor(newOrderSubtotal / shareUnit);

  // 6) Mutáció összeállítása és futtatása
  const mutation = `
    mutation($c:CustomerInput!,$o:OrderInput!){
      customerUpdate(input:$c){userErrors{field message}}
      orderUpdate(input:$o){userErrors{field message}}
    }
  `;
  // Feltételezve, hogy customerUpdate részében csak net_spent_total és sharesCount változik:
  const custGid = String(payload.customer?.id || '').split('/').pop();
  const prevSpent = Number(payload.customer?.metafields?.find(m=>m.key==='net_spent_total')?.value || 0);
  const newCustSpent  = prevSpent - adjustAmount;
  const newCustShares = Math.floor(newCustSpent / shareUnit);

  const variables = {
    c: {
      id: `gid://shopify/Customer/${custGid}`,
      metafields: [
        { namespace:'loyalty', key:'net_spent_total',  type:'number_decimal', value:newCustSpent.toFixed(2) },
        { namespace:'loyalty', key:'reszvenyek_szama', type:'number_integer', value:newCustShares.toString() }
      ]
    },
    o: {
      id: `gid://shopify/Order/${orderId}`,
      metafields: [
        { namespace:'custom', key:'subtotal',    type:'number_decimal', value:newOrderSubtotal.toFixed(2) },
        { namespace:'custom', key:'order_share', type:'number_integer', value:newOrderShares.toString() }
      ]
    }
  };

  const mr = await fetch(gqlUrl, {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query: mutation, variables })
  });
  const mj = await mr.json();
  const errs = [
    ...mj.data.customerUpdate.userErrors,
    ...mj.data.orderUpdate.userErrors
  ];
  if (errs.length) {
    console.error('❌ Mutation errors:', errs);
    return res.writeHead(500).end('Adjustment error');
  }
  console.log('✅ Metafields updated');

  // 7) Sheet módosítása
  await adjustSheet(orderId, newOrderSubtotal, newOrderShares);
  console.log('✅ Sheet adjusted');

  res.writeHead(200).end('OK');
};
