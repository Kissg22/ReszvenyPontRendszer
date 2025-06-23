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
    console.log('📦 Parsed payload keys:', Object.keys(payload));
  } catch (e) {
    console.error('❌ Invalid JSON payload:', e);
    return res.writeHead(400).end('Invalid JSON');
  }

  // 4) Order ID kinyerése
  const orderId = payload.order_id || payload.id;
  if (!orderId) {
    console.log('▶️ Not an order event, skipping');
    return res.writeHead(200).end('Not an order event');
  }
  console.log(`🔔 Processing adjustment for order ${orderId}`);

  // 5) Refund vs cancel döntés
  const shareUnit = Number(process.env.SHARE_UNIT);
  let adjustAmount = 0;
  if (payload.refund_line_items || payload.refunds) {
    // refund webhook: számoljuk a refundolt összeget
    const items = payload.refund_line_items || payload.refunds.flatMap(r => r.refund_line_items || []);
    for (const li of items) {
      const amt = li.subtotal_set?.presentment_money?.amount
              || li.subtotal
              || 0;
      adjustAmount += Number(amt);
    }
    console.log(`💸 Partial refund amount: ${adjustAmount.toFixed(2)}`);
  } else {
    // cancel webhook: teljes order egyenlege a subtotal Meta-ból
    const endpoint = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;
    const orderMetaQuery = `
      query getOrderMeta($id: ID!) {
        order(id: $id) {
          subtotalMeta: metafield(namespace: "custom", key: "subtotal") { value }
        }
      }
    `;
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN
        },
        body: JSON.stringify({ query: orderMetaQuery, variables: { id: `gid://shopify/Order/${orderId}` } })
      });
      const { data, errors } = await resp.json();
      if (errors?.length) throw errors;
      adjustAmount = Number(data.order.subtotalMeta?.value || 0);
      console.log(`🗑️  Full cancel subtotal from metafield: ${adjustAmount.toFixed(2)}`);
    } catch (e) {
      console.error('❌ Error reading order subtotal meta on cancel:', e);
      return res.writeHead(500).end('Read order subtotal error');
    }
  }

  // 6) Ha nincs semmi levonandó
  if (adjustAmount === 0) {
    console.log('ℹ️  No amount to adjust');
    return res.writeHead(200).end('Nothing to adjust');
  }

  // 7) Számoljuk a shares és remainder értéket
  const adjustShares = Math.floor(adjustAmount / shareUnit);
  const adjustRemainder = adjustAmount % shareUnit;
  console.log('🔢 Computed adjustment:', {
    adjustAmount: adjustAmount.toFixed(2),
    adjustShares,
    adjustRemainder: adjustRemainder.toFixed(2)
  });

  // 8) Lekérdezzük a customer ID-t (ha nincs payload.customer)
  let custGid = payload.customer?.id;
  if (!custGid) {
    try {
      const resp = await fetch(
        `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/orders/${orderId}.json?fields=customer`,
        {
          headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN }
        }
      );
      const orderJson = await resp.json();
      custGid = orderJson.order?.customer?.id;
      console.log('🔍 Fetched customer GID via REST:', custGid);
    } catch (e) {
      console.error('❌ Error fetching customer via REST:', e);
    }
  }
  if (!custGid) {
    console.error('❌ No customer ID, aborting');
    return res.writeHead(400).end('No customer ID');
  }
  const custId = String(custGid).split('/').pop();

  // 9) GraphQL mutáció előkészítése
  const endpoint = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;
  const mutation = `
    mutation adjust($custInput: CustomerInput!, $orderInput: OrderInput!) {
      customerUpdate(input: $custInput) { userErrors { field message } }
      orderUpdate(input: $orderInput)   { userErrors { field message } }
    }
  `;

  const custInput = {
    id: `gid://shopify/Customer/${custId}`,
    metafields: [
      {
        namespace: 'loyalty',
        key: 'net_spent_total',
        type: 'number_decimal',
        value: `-${adjustAmount.toFixed(2)}`
      },
      {
        namespace: 'loyalty',
        key: 'reszvenyek_szama',
        type: 'number_integer',
        value: `-${adjustShares}`
      },
      {
        namespace: 'custom',
        key: 'jelenlegi_fennmarado',
        type: 'number_decimal',
        // új megmaradt rész a teljes spentből
        value: `${( (/* fetch prevSpent first? */0) - adjustAmount ) % shareUnit}`
      }
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
        'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN
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
