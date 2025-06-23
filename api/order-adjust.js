require('dotenv').config();
const crypto = require('crypto');
const { fetch } = require('undici');

// Shared endpoint for handling refund adjustments (partial and full)
module.exports = async (req, res) => {
  console.log('▶️  /order-adjust endpoint hit');

  // 1) Only POST
  if (req.method !== 'POST') {
    console.log(`✋ Method not allowed: ${req.method}`);
    return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
  }

  // 2) Raw body + HMAC validation
  let buf;
  try {
    buf = await getRawBody(req);
    console.log('✅ Raw body read, length:', buf.length);
  } catch (err) {
    console.error('❌ Error reading body:', err);
    return res.writeHead(400).end('Invalid body');
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const computedHmac = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');

  if (!hmacHeader || hmacHeader !== computedHmac) {
    console.error('❌ HMAC validation failed');
    return res.writeHead(401).end('HMAC validation failed');
  }
  console.log('✅ HMAC validation passed');

  // 3) Parse JSON payload
  let payload;
  try {
    payload = JSON.parse(buf.toString());
    console.log('📦 Parsed payload keys:', Object.keys(payload));
  } catch (err) {
    console.error('❌ Invalid JSON payload:', err);
    return res.writeHead(400).end('Invalid JSON');
  }

  // Only handle refund events
  if (!payload.refund_line_items && !payload.refunds) {
    console.log('ℹ️  No refund information - skipping');
    return res.writeHead(200).end('No refund to adjust');
  }

  // 4) Compute refunded amount
  const shareUnit = Number(process.env.SHARE_UNIT);
  let adjustAmount = 0;
  const items = payload.refund_line_items
    || payload.refunds.flatMap(r => r.refund_line_items || []);

  for (const li of items) {
    const amt = li.subtotal_set?.presentment_money?.amount
              || li.subtotal
              || 0;
    adjustAmount += Number(amt);
  }
  console.log(`💸 Refund amount: ${adjustAmount.toFixed(2)}`);

  if (adjustAmount <= 0) {
    console.log('ℹ️  Nothing to adjust');
    return res.writeHead(200).end('Zero refund');
  }

  // 5) Order & Customer IDs
  const orderId = payload.order_id || payload.id;
  if (!orderId) {
    console.error('❌ Missing order ID');
    return res.writeHead(400).end('Missing order ID');
  }

  // 6) Determine customer GID
  let custGid = payload.customer?.id;
  if (!custGid) {
    try {
      const resp = await fetch(
        `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/orders/${orderId}.json?fields=customer`,
        { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN } }
      );
      const orderJson = await resp.json();
      custGid = orderJson.order?.customer?.id;
    } catch (err) {
      console.error('❌ Error fetching customer via REST:', err);
    }
  }
  if (!custGid) {
    console.error('❌ No customer ID');
    return res.writeHead(400).end('No customer ID');
  }
  const custId = String(custGid).split('/').pop();

  // 7) Fetch existing loyalty meta for customer
  const gqlEndpoint = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;
  const customerMetaQuery = `
    query getCustomerMeta($id: ID!) {
      customer(id: $id) {
        netSpent: metafield(namespace: "loyalty", key: "net_spent_total") { value }
        shareCount: metafield(namespace: "loyalty", key: "reszvenyek_szama") { value }
      }
    }
  `;

  let prevSpent = 0;
  let prevShares = 0;
  try {
    const resp = await fetch(gqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN
      },
      body: JSON.stringify({ query: customerMetaQuery, variables: { id: `gid://shopify/Customer/${custId}` } })
    });
    const { data, errors } = await resp.json();
    if (errors?.length) throw errors;
    prevSpent = Number(data.customer.netSpent?.value || 0);
    prevShares = Number(data.customer.shareCount?.value || 0);
    console.log(`🔍 Previous spent: ${prevSpent}, shares: ${prevShares}`);
  } catch (err) {
    console.error('❌ Error reading customer meta:', err);
    return res.writeHead(500).end('Customer meta fetch error');
  }

  // 8) Calculate new loyalty values
  const adjustShares = Math.floor(adjustAmount / shareUnit);
  const newSpent = prevSpent - adjustAmount;
  const newShares = prevShares - adjustShares;
  const newRemainder = newSpent % shareUnit;
  console.log('🔢 Computed new loyalty:', { newSpent, newShares, newRemainder });

  // 9) Prepare mutation to update customer & order metafields
  const mutation = `
    mutation Adjust($custInput: CustomerInput!, $orderInput: OrderInput!) {
      customerUpdate(input: $custInput) { userErrors { field message } }
      orderUpdate(input: $orderInput)   { userErrors { field message } }
    }
  `;

  const custInput = {
    id: `gid://shopify/Customer/${custId}`,
    metafields: [
      { namespace: 'loyalty', key: 'net_spent_total', type: 'number_decimal', value: newSpent.toFixed(2) },
      { namespace: 'loyalty', key: 'reszvenyek_szama', type: 'number_integer', value: String(newShares) },
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

  // 10) Execute mutation
  try {
    const resp = await fetch(gqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN
      },
      body: JSON.stringify({ query: mutation, variables: { custInput, orderInput } })
    });
    const result = await resp.json();
    const errs = [
      ...result.data.customerUpdate.userErrors,
      ...result.data.orderUpdate.userErrors
    ];
    if (errs.length) {
      console.error('❌ Mutation errors:', errs);
      return res.writeHead(500).end('Adjustment error');
    }
    console.log('✅ Adjustment applied successfully');
  } catch (err) {
    console.error('❌ Error performing mutation:', err);
    return res.writeHead(500).end('Update error');
  }

  // 11) Respond OK
  console.log('🏁 /order-adjust finished');
  res.writeHead(200).end('OK');
};

// Helper to read raw body
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
