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

// 2) Sheet frissítő függvény: megtalálja az orderId-t az A oszlopban, módosítja L–M mezőket, majd a végére “módosítva” sort tesz
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

  // 2.1) Kiolvassuk az A oszlopot, hogy megtaláljuk a megfelelő sort
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `${sheet}!A:A`
  });
  const rows = read.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === String(orderId));
  if (rowIndex === -1) {
    console.warn(`⚠️ Order ID ${orderId} nem található a sheetben`);
  } else {
    const targetRow = rowIndex + 1; // 1-gyel több, mert 1-es alapú sorindex a Sheets API-ban
    // 2.2) L mező = új subtotal (13. oszlop), M mező = új shares (14. oszlop)
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId,
      range: `${sheet}!L${targetRow}:M${targetRow}`,
      valueInputOption: 'RAW',
      resource: { values: [[ newSubtotal.toFixed(2), String(newShares) ]] }
    });
    console.log(`✅ Sheet sor ${targetRow} frissítve: subtotal=${newSubtotal}, shares=${newShares}`);
  }

  // 2.3) A végére egy “módosítva” sor
  const timestamp = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: ssId,
    range: `${sheet}!A:Q`,    // A–Q téren belül pakoljuk az új sort
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: {
      values: [[
        '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        `módosítva: ${timestamp}`
      ]]
    }
  });
  console.log('✅ Végső „módosítva” sor beszúrva');
}

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

  // Order ID és Customer GID
  const orderId = payload.order_id || payload.id;
  if (!orderId) {
    console.error('❌ Missing order ID');
    return res.writeHead(400).end('Missing order ID');
  }
  let custGid = payload.customer?.id;
  if (!custGid) {
    // fallback REST call…
    try {
      const rsp = await fetch(
        `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/orders/${orderId}.json?fields=customer`,
        { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN } }
      );
      const j = await rsp.json();
      custGid = j.order?.customer?.id;
    } catch {}
  }
  if (!custGid) {
    console.error('❌ No customer ID');
    return res.writeHead(400).end('No customer ID');
  }
  const custId = String(custGid).split('/').pop();
  const gqlUrl = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;
  const shareUnit = Number(process.env.SHARE_UNIT);

  // Lekérjük az order subtotal metafieldet
  const orderMetaQ = `
    query($id: ID!){order(id:$id){subtotalMeta: metafield(namespace:"custom",key:"subtotal"){value}}}
  `;
  const omr = await fetch(gqlUrl, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Shopify-Access-Token':process.env.SHOPIFY_API_ACCESS_TOKEN
    },
    body: JSON.stringify({ query: orderMetaQ, variables:{ id:`gid://shopify/Order/${orderId}` } })
  });
  const omj = await omr.json();
  const prevOrderSubtotal = Number(omj.data.order.subtotalMeta?.value || 0);

  // Új order értékek
  const newOrderSubtotal = prevOrderSubtotal - adjustAmount;
  const newOrderShares   = Math.floor(newOrderSubtotal / shareUnit);

  // Lekérjük a customer spendinget
  const custMetaQ = `
    query($id: ID!){customer(id:$id){
      netSpent: metafield(namespace:"loyalty",key:"net_spent_total"){value}
    }}
  `;
  const cmr = await fetch(gqlUrl, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Shopify-Access-Token':process.env.SHOPIFY_API_ACCESS_TOKEN
    },
    body: JSON.stringify({ query: custMetaQ, variables:{ id:`gid://shopify/Customer/${custId}` } })
  });
  const cmj = await cmr.json();
  const prevSpent = Number(cmj.data.customer.netSpent?.value || 0);

  // Új customer érték
  const newCustSpent  = prevSpent - adjustAmount;
  const newCustShares = Math.floor(newCustSpent / shareUnit);

  // Mutáció összeállítása
  const mutation = `
    mutation($c:CustomerInput!,$o:OrderInput!){
      customerUpdate(input:$c){userErrors{field message}}
      orderUpdate(input:$o){userErrors{field message}}
    }
  `;
  const variables = {
    c: {
      id: `gid://shopify/Customer/${custId}`,
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
  // Mutáció futtatása
  const mr = await fetch(gqlUrl, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Shopify-Access-Token':process.env.SHOPIFY_API_ACCESS_TOKEN
    },
    body: JSON.stringify({ query:mutation, variables })
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

  // 11) Sheet módosítása
  await adjustSheet(orderId, newOrderSubtotal, newOrderShares);

  console.log('✅ Sheet adjusted');
  res.writeHead(200).end('OK');
};
