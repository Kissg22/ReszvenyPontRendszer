// api/order-adjust.js  ← közös helper endpoint cancel + refund számára
require('dotenv').config();
const crypto = require('crypto');
const { fetch } = require('undici');

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  console.log('▶️  /order-adjust endpoint hit');

  // 1) Csak POST
  if (req.method !== 'POST') {
    console.log(`✋ Method not allowed: ${req.method}`);
    return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
  }

  // 2) Raw body + HMAC validáció
  let buf;
  try {
    buf = await getRawBody(req);
    console.log('✅ Raw body read, length:', buf.length);
  } catch (e) {
    console.error('❌ Error reading body:', e);
    return res.writeHead(400).end('Invalid body');
  }
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const computedHmac = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');
  console.log('🔐 Received HMAC:', hmacHeader);
  console.log('🔑 Computed HMAC:', computedHmac);
  if (!hmacHeader || hmacHeader !== computedHmac) {
    console.error('❌ HMAC validation failed');
    return res.writeHead(401).end('HMAC validation failed');
  }
  console.log('✅ HMAC validation passed');

  // 3) Payload parse
  let payload;
  try {
    payload = JSON.parse(buf.toString());
    console.log('📦 Parsed payload:', { orderId: payload.id, order_id: payload.order_id });
  } catch (e) {
    console.error('❌ Invalid JSON payload:', e);
    return res.writeHead(400).end('Invalid JSON');
  }

  // 4) Order ID kinyerése (refund/cancel esetén order_id)
  const orderId = payload.order_id || payload.id;
  if (!orderId) {
    console.log('▶️ Not an order event, skipping');
    return res.writeHead(200).end('Not an order event');
  }
  console.log(`🔔 Processing adjustment for order ${orderId}`);

  const shop      = process.env.SHOPIFY_SHOP_NAME;
  const token     = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const apiVer    = process.env.SHOPIFY_API_VERSION;
  const endpoint  = `https://${shop}.myshopify.com/admin/api/${apiVer}/graphql.json`;
  const shareUnit = Number(process.env.SHARE_UNIT);
  console.log('🔢 Share unit:', shareUnit);

  // 5) Olvassuk ki az order Meta adatokat
  const orderMetaQuery = `
    query getOrderMeta($id: ID!) {
      order(id: $id) {
        subtotalMeta  : metafield(namespace: "custom", key: "subtotal")         { value }
        orderShareMeta: metafield(namespace: "custom", key: "order_share")      { value }
        orderRemMeta  : metafield(namespace: "custom", key: "order_remainder")  { value }
        customer { id }
      }
    }
  `;
  let subtotalStored = 0, sharesStored = 0, remainderStored = 0, custGid;
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: orderMetaQuery,
        variables: { id: `gid://shopify/Order/${orderId}` }
      })
    });
    const { data, errors } = await resp.json();
    if (errors?.length) throw errors;
    const ord = data.order;
    if (!ord) throw new Error('Order not found in GraphQL');

    subtotalStored  = parseFloat(ord.subtotalMeta?.value   || '0');
    sharesStored    = parseInt(ord.orderShareMeta?.value   || '0', 10);
    remainderStored = parseFloat(ord.orderRemMeta?.value   || '0');
    custGid         = ord.customer.id.split('/').pop();
    console.log('📑 Order stored values:', { subtotalStored, sharesStored, remainderStored, custGid });
  } catch (e) {
    console.error('❌ Error reading order meta:', e);
    return res.writeHead(500).end('Read order meta error');
  }

  // 6) Ha már nullázva, nincs dolga
  if (subtotalStored === 0 && sharesStored === 0 && remainderStored === 0) {
    console.log('ℹ️  Already adjusted, nothing to do');
    return res.writeHead(200).end('Already adjusted');
  }

  // 7) Lekérdezzük a customer aktuális állapotát
  const customerMetaQuery = `
    query getCustomer($id: ID!) {
      customer(id: $id) {
        netSpentMeta:       metafield(namespace: "loyalty", key: "net_spent_total")   { value }
        sharesCountMeta:    metafield(namespace: "loyalty", key: "reszvenyek_szama")  { value }
        currRemMeta:        metafield(namespace: "custom",  key: "jelenlegi_fennmarado"){ value }
      }
    }
  `;
  let prevSpent = 0, prevShares = 0, prevRemainder = 0;
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token 
      },
      body: JSON.stringify({
        query: customerMetaQuery,
        variables: { id: `gid://shopify/Customer/${custGid}` }
      })
    });
    const { data, errors } = await resp.json();
    if (errors?.length) throw errors;
    const cus = data.customer;
    prevSpent     = parseFloat(cus.netSpentMeta?.value   || '0');
    prevShares    = parseInt(cus.sharesCountMeta?.value || '0', 10);
    prevRemainder = parseFloat(cus.currRemMeta?.value   || '0');
    console.log('📑 Previous customer state:', { prevSpent, prevShares, prevRemainder });
  } catch (e) {
    console.error('❌ Error fetching customer state:', e);
    return res.writeHead(500).end('Fetch customer meta error');
  }

  // 8) Számoljuk az új customer-értékeket: nettó költés maradéka shareUnit-tel osztva
  const newTotal     = prevSpent - subtotalStored;
  const newShares    = Math.floor(newTotal / shareUnit);
  const newRemainder = newTotal % shareUnit;
  console.log('📈 Computed new customer state:', { newTotal, newShares, newRemainder });

  // 9) GraphQL mutáció előkészítése
  const mutation = `
    mutation adjust(
      $custInput: CustomerInput!, 
      $orderInput: OrderInput!
    ) {
      customerUpdate(input: $custInput) { userErrors { field message } }
      orderUpdate(input: $orderInput)   { userErrors { field message } }
    }
  `;
  const custInput = {
    id: `gid://shopify/Customer/${custGid}`,
    metafields: [
      { namespace: 'loyalty', key: 'net_spent_total',     type: 'number_decimal', value: newTotal.toFixed(2) },
      { namespace: 'loyalty', key: 'reszvenyek_szama',    type: 'number_integer', value: newShares.toString() },
      { namespace: 'custom',  key: 'jelenlegi_fennmarado', type: 'number_decimal', value: newRemainder.toFixed(2) }
    ]
  };
  const orderInput = {
    id: `gid://shopify/Order/${orderId}`,
    metafields: [
      { namespace: 'custom', key: 'subtotal',        type: 'number_decimal', value: '0' },
      { namespace: 'custom', key: 'order_share',     type: 'number_integer', value: '0' },
      { namespace: 'custom', key: 'order_remainder', type: 'number_decimal', value: '0' }
    ]
  };
  console.log('📝 Mutation inputs:', { custInput, orderInput });

  // 10) Mutáció végrehajtása
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token 
      },
      body: JSON.stringify({ query: mutation, variables: { custInput, orderInput } })
    });
    const result = await resp.json();
    console.log('📨 Mutation response:', JSON.stringify(result, null, 2));
    const errs = [
      ...result.data.customerUpdate.userErrors,
      ...result.data.orderUpdate.userErrors
    ];
    if (errs.length) {
      console.error('❌ Mutation user errors:', errs);
      return res.writeHead(500).end('Adjust error');
    }
    console.log('✅ Adjustment applied successfully');
  } catch (e) {
    console.error('❌ Error performing mutation:', e);
    return res.writeHead(500).end('Update error');
  }

  // 11) Válasz
  console.log('🏁 /order-adjust finished, sending 200 OK');
  res.writeHead(200).end('OK');
};
