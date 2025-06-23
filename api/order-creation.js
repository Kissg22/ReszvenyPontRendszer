// api/order-creation.js
require('dotenv').config();
const crypto = require('crypto');
const { fetch } = require('undici');

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  console.log('▶️  /order-creation endpoint hit');

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
  let order;
  try {
    order = JSON.parse(buf.toString());
    console.log('📦 Parsed order payload:', {
      id: order.id,
      subtotal_price: order.subtotal_price,
      customer_id: order.customer?.id,
      created_at: order.created_at
    });
  } catch (e) {
    console.error('❌ Invalid JSON payload:', e);
    return res.writeHead(400).end('Invalid JSON');
  }

  // 4) Változók beállítása
  const subtotal  = parseFloat(order.subtotal_price);
  const shop      = process.env.SHOPIFY_SHOP_NAME;
  const token     = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const shareUnit = Number(process.env.SHARE_UNIT);
  const endpoint  = `https://${shop}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

  console.log('🔢 Computed values:', { subtotal, shareUnit });

  // 5) Lekérdezzük a customer aktuális állapotát
  // order.customer.id lehet GID-string vagy Number
  const rawCustId = order.customer.id;
  const custGid   = String(rawCustId).split('/').pop();
  let prevSpent      = 0;
  let prevShares     = 0;
  let prevLastOrder  = 0;
  let prevRemainder  = 0;

  try {
    const readRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: `
          query getCustomer($id: ID!) {
            customer(id: $id) {
              netSpent:      metafield(namespace: "loyalty", key: "net_spent_total")    { value }
              sharesCount:   metafield(namespace: "loyalty", key: "reszvenyek_szama")   { value }
              lastOrderVal:  metafield(namespace: "loyalty", key: "last_order_value")    { value }
              remainder:     metafield(namespace: "custom",  key: "jelenlegi_fennmarado") { value }
            }
          }
        `,
        variables: { id: `gid://shopify/Customer/${custGid}` }
      })
    });
    const { data, errors } = await readRes.json();
    if (errors?.length) throw errors;

    prevSpent     = parseFloat(data.customer.netSpent?.value    || '0');
    prevShares    = parseInt(data.customer.sharesCount?.value   || '0', 10);
    prevLastOrder = parseFloat(data.customer.lastOrderVal?.value || '0');
    prevRemainder = parseFloat(data.customer.remainder?.value    || '0');

    console.log('📑 Previous customer state:', {
      prevSpent:     prevSpent.toFixed(2),
      prevShares,
      prevLastOrder: prevLastOrder.toFixed(2),
      prevRemainder: prevRemainder.toFixed(2)
    });
  } catch (e) {
    console.error('❌ Error fetching customer state:', e);
    return res.writeHead(500).end('Fetch customer error');
  }

  // 6) Új értékek kiszámolása és logolása
  const newTotal       = prevSpent + subtotal;
  const totalShares    = Math.floor(newTotal / shareUnit);
  const earnedShares   = totalShares - prevShares;
  const newRemainder   = newTotal % shareUnit;

  console.log('📈 Calculated new values:', {
    newTotal:     newTotal.toFixed(2),
    totalShares,
    earnedShares,
    newRemainder: newRemainder.toFixed(2)
  });

  // 7) GraphQL mutáció előkészítése
  const mutation = `
    mutation updateBoth($custInput: CustomerInput!, $orderInput: OrderInput!) {
      customerUpdate(input: $custInput) { userErrors { field message } }
      orderUpdate(input: $orderInput)     { userErrors { field message } }
    }
  `;
  const variables = {
    custInput: {
      id: `gid://shopify/Customer/${custGid}`,
      metafields: [
        { namespace: 'loyalty', key: 'net_spent_total',    type: 'number_decimal', value: newTotal.toFixed(2) },
        { namespace: 'loyalty', key: 'reszvenyek_szama',   type: 'number_integer', value: totalShares.toString() },
        { namespace: 'loyalty', key: 'last_order_value',   type: 'number_decimal', value: subtotal.toFixed(2) },
        { namespace: 'custom',  key: 'jelenlegi_fennmarado',type: 'number_decimal', value: newRemainder.toFixed(2) }
      ]
    },
    orderInput: {
      id: `gid://shopify/Order/${order.id}`,
      metafields: [
        { namespace: 'custom', key: 'osszes_koltes',      type: 'number_decimal',  value: subtotal.toFixed(2) },
        { namespace: 'custom', key: 'order_share',        type: 'number_integer',  value: earnedShares.toString() },
        { namespace: 'custom', key: 'fennmarado_osszeg',  type: 'number_decimal',  value: newRemainder.toFixed(2) }
      ]
    }
  };

  console.log('📝 Mutation variables:', JSON.stringify(variables, null, 2));

  // 8) Mutáció végrehajtása
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: mutation, variables })
    });
    const json = await resp.json();
    console.log('📨 Mutation response:', JSON.stringify(json, null, 2));

    const custErrs  = json.data.customerUpdate.userErrors;
    const orderErrs = json.data.orderUpdate.userErrors;
    if (custErrs.length || orderErrs.length) {
      console.error('❌ Mutation user errors:', { custErrs, orderErrs });
      return res.writeHead(500).end('Mutation error');
    }
    console.log('✅ All metafields updated successfully');
  } catch (e) {
    console.error('❌ Error updating metafields:', e);
    return res.writeHead(500).end('Update error');
  }

  // 9) Válasz
  console.log('🏁 /order-creation finished, sending 200 OK');
  res.writeHead(200).end('OK');
};
