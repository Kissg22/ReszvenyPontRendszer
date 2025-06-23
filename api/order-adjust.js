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
  const hmac   = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
                       .update(buf)
                       .digest('base64');
  console.log('🔐 Received HMAC:', hmac);
  console.log('🔑 Computed HMAC:', digest);
  if (!hmac || hmac !== digest) {
    console.error('❌ HMAC validation failed');
    return res.writeHead(401).end('HMAC validation failed');
  }
  console.log('✅ HMAC validation passed');

  // 3) Payload parse
  let payload;
  try {
    payload = JSON.parse(buf.toString());
    console.log('📦 Parsed payload:', { id: payload.id || payload.order_id, customer: payload.customer?.id });
  } catch (e) {
    console.error('❌ Invalid JSON payload:', e);
    return res.writeHead(400).end('Invalid JSON');
  }

  const orderId = payload.id || payload.order_id;
  if (!orderId) {
    console.log('▶️ Not an order event, skipping');
    return res.writeHead(200).end('Not an order event');
  }
  console.log(`🔔 Processing adjustment for order ${orderId}`);

  const shop     = process.env.SHOPIFY_SHOP_NAME;
  const token    = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const endpoint = `https://${shop}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

  // 4) Olvassuk ki az order raktározott értékeket a frissítéskor (magyar mezőnevek)
  const readQuery = `
    query getOrderMeta($id: ID!) {
      order(id: $id) {
        subtotalMeta: metafield(namespace: "custom", key: "subtotal")         { value }
        shareMeta:    metafield(namespace: "custom", key: "order_share")      { value }
        remainderMeta:metafield(namespace: "custom", key: "order_remainder") { value }
        customer { id }
      }
    }
  `;
  let subtotalStored = 0, shares = 0, remainderStored = 0, custId;
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: readQuery, variables: { id: `gid://shopify/Order/${orderId}` } })
    });
    const json = await resp.json();
    console.log('📨 Read meta response:', JSON.stringify(json, null, 2));
    if (json.errors && json.errors.length) throw json.errors;

    subtotalStored  = parseFloat(json.data.order.subtotalMeta?.value || '0');
    shares          = parseInt(json.data.order.shareMeta?.value || '0', 10);
    remainderStored = parseFloat(json.data.order.remainderMeta?.value || '0');
    custId          = json.data.order.customer.id.split('/').pop();

    console.log('📑 Order stored values:', { subtotalStored: subtotalStored.toFixed(2), shares, remainderStored: remainderStored.toFixed(2), custId });
  } catch (e) {
    console.error('❌ Error reading order meta:', e);
    return res.writeHead(500).end('Read meta error');
  }

  // 5) Ha már nullázva, nincs dolga
  if (subtotalStored === 0 && shares === 0 && remainderStored === 0) {
    console.log('ℹ️  Already adjusted, nothing to do');
    return res.writeHead(200).end('Already adjusted');
  }

  // 6) Számoljuk és logoljuk a differenciát a customer számára
  const spentDelta     = -subtotalStored;
  const sharesDelta    = -shares;
  const remainderDelta = -remainderStored;
  console.log('🔢 Computed deltas for customer adjustment:', { spentDelta, sharesDelta, remainderDelta });

  // 7) Előkészítjük a customer mutációt (magyar mezőnevek)
  const custInput = {
    id: `gid://shopify/Customer/${custId}`,
    metafields: [
      { namespace: 'loyalty', key: 'net_spent_total',    type: 'number_decimal', value: spentDelta.toFixed(2) },
      { namespace: 'loyalty', key: 'reszvenyek_szama',   type: 'number_integer', value: sharesDelta.toString() },
      { namespace: 'custom',  key: 'jelenlegi_fennmarado',type: 'number_decimal', value: remainderDelta.toFixed(2) }
    ]
  };
  console.log('📝 Customer mutation input:', JSON.stringify(custInput, null, 2));

  // 8) Előkészítjük az order mutációt a raktározott értékek nullázásához
  const orderInput = {
    id: `gid://shopify/Order/${orderId}`,
    metafields: [
      { namespace: 'custom', key: 'subtotal',         type: 'number_decimal',  value: '0' },
      { namespace: 'custom', key: 'order_share',      type: 'number_integer',  value: '0' },
      { namespace: 'custom', key: 'order_remainder',  type: 'number_decimal',  value: '0' }
    ]
  };
  console.log('📝 Order mutation input:', JSON.stringify(orderInput, null, 2));

  // 9) Végrehajtjuk a mutációt
  try {
    const mutation = `
      mutation adjustCustomer($custInput: CustomerInput!, $orderInput: OrderInput!) {
        customerUpdate(input: $custInput) { userErrors { field message } }
        orderUpdate(input: $orderInput)     { userErrors { field message } }
      }
    `;
    console.log('🔄 Sending mutation...');
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: mutation, variables: { custInput, orderInput } })
    });
    const result = await resp.json();
    console.log('📨 Mutation response:', JSON.stringify(result, null, 2));

    const custErrors  = result.data.customerUpdate.userErrors;
    const orderErrors = result.data.orderUpdate.userErrors;
    if (custErrors.length || orderErrors.length) {
      console.error('❌ Mutation user errors:', { custErrors, orderErrors });
      return res.writeHead(500).end('Adjust error');
    }
    console.log('✅ Adjustment applied successfully');
  } catch (e) {
    console.error('❌ Error performing adjustment mutation:', e);
    return res.writeHead(500).end('Update error');
  }

  // 10) Válasz
  console.log('🏁 /order-adjust finished, sending 200 OK');
  res.writeHead(200).end('OK');
};
