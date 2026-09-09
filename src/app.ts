import crypto from 'node:crypto';
import type pg from 'pg';
import Fastify from 'fastify';
import { z } from 'zod';
import { pool, tx } from './db/index.js';
import { deliver, recover, startWorker, stopWorker } from './delivery.js';
import { providers, type ProviderConfig } from './providers.js';

const app = Fastify({ logger: process.env.RUN_INTEGRATION_TESTS !== '1' });

const paymentSchema = z.object({
  event_id: z.string().min(1),
  order_id: z.string().min(1),
  status: z.enum(['paid', 'failed']),
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  created_at: z.string().datetime(),
});

const createOrderSchema = z
  .object({
    sku: z.string().min(1).optional(),
    items: z
      .array(
        z.object({
          sku: z.string().min(1),
          quantity: z.number().int().min(1).max(10).default(1),
        }),
      )
      .min(1)
      .max(20)
      .optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
  })
  .superRefine((body, context) => {
    if (Boolean(body.sku) === Boolean(body.items)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provide exactly one of sku or items',
      });
    }
    const count = body.items?.reduce((sum, item) => sum + item.quantity, 0) ?? 1;
    if (count > 50) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'order may contain at most 50 items' });
    }
  });

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

async function appendEvent(
  client: pg.PoolClient,
  orderId: string,
  itemId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await client.query(
    'INSERT INTO order_events(order_id,item_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)',
    [orderId, itemId, eventType, JSON.stringify(payload)],
  );
}

async function readOrder(db: Queryable, orderId: string) {
  const order = (await db.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  if (!order) return null;
  const items = (
    await db.query(
      `SELECT id,position,sku,provider,amount,currency,status,delivery_code,last_error,created_at,updated_at
         FROM order_items WHERE order_id=$1 ORDER BY position`,
      [orderId],
    )
  ).rows;
  const ledger = (
    await db.query(
      `SELECT
         COALESCE(sum(amount) FILTER (WHERE operation='payment'),0)::int AS paid,
         COALESCE(sum(amount) FILTER (WHERE operation='refund'),0)::int AS refunded
       FROM money_ledger WHERE order_id=$1`,
      [orderId],
    )
  ).rows[0];
  const delivered = items
    .filter(item => item.status === 'delivered')
    .reduce((sum, item) => sum + Number(item.amount), 0);
  const paid = Number(ledger.paid);
  const refunded = Number(ledger.refunded);
  const pending = paid - delivered - refunded;
  return {
    ...order,
    items,
    money: {
      paid,
      delivered,
      refunded,
      pending,
      balanced: pending === 0,
      equation: `${paid} = ${delivered} + ${refunded}${pending ? ` + ${pending} pending` : ''}`,
    },
  };
}

async function applyPaid(client: pg.PoolClient, order: any) {
  const inserted = await client.query(
    `INSERT INTO money_ledger(idempotency_key,order_id,operation,amount,currency)
     VALUES($1,$2,'payment',$3,$4)
     ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
    [`payment:${order.id}`, order.id, order.amount, order.currency],
  );
  if (!inserted.rowCount) return false;

  await client.query("UPDATE orders SET status='paid',updated_at=now() WHERE id=$1", [order.id]);
  await client.query(
    "UPDATE order_items SET status='delivery_pending',updated_at=now() WHERE order_id=$1 AND status='awaiting_payment'",
    [order.id],
  );
  await client.query(
    "UPDATE delivery_jobs SET status='queued',priority=100,available_at=now(),updated_at=now() WHERE order_id=$1 AND status='waiting_payment'",
    [order.id],
  );
  await appendEvent(client, order.id, null, 'PAYMENT_RECORDED', {
    status: 'paid',
    amount: Number(order.amount),
    currency: order.currency,
  });
  await appendEvent(client, order.id, null, 'ORDER_STATUS_CHANGED', { status: 'paid' });
  return true;
}

app.post('/orders', async (request, reply) => {
  const body = createOrderSchema.parse(request.body);
  const requested = body.items ?? [{ sku: body.sku!, quantity: 1 }];
  const expandedSkus = requested.flatMap(item => Array.from({ length: item.quantity }, () => item.sku));
  const id = body.idempotency_key ?? `ord_${crypto.randomUUID()}`;

  const outcome = await tx(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
    const existing = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    if (existing.rowCount) {
      const existingItems = (
        await client.query('SELECT sku FROM order_items WHERE order_id=$1 ORDER BY position', [id])
      ).rows.map(row => row.sku);
      if (JSON.stringify(existingItems) !== JSON.stringify(expandedSkus)) {
        throw Object.assign(new Error('idempotency_key_reused_with_different_items'), { statusCode: 409 });
      }
      return { created: false, paid: ['paid', 'processing'].includes(existing.rows[0].status) };
    }

    const products = (
      await client.query('SELECT * FROM products WHERE sku = ANY($1::text[])', [[...new Set(expandedSkus)]])
    ).rows;
    const bySku = new Map(products.map(product => [product.sku, product]));
    const missing = expandedSkus.filter(sku => !bySku.has(sku));
    if (missing.length) {
      throw Object.assign(new Error(`unknown sku: ${[...new Set(missing)].join(', ')}`), { statusCode: 404 });
    }
    const currencies = new Set(products.map(product => product.currency));
    if (currencies.size !== 1) {
      throw Object.assign(new Error('mixed currencies are not supported'), { statusCode: 422 });
    }

    const amount = expandedSkus.reduce((sum, sku) => sum + Number(bySku.get(sku).price), 0);
    const currency = products[0].currency;
    await client.query(
      "INSERT INTO orders(id,sku,amount,currency,status) VALUES($1,$2,$3,$4,'created')",
      [id, expandedSkus.length === 1 ? expandedSkus[0] : null, amount, currency],
    );

    const eventItems: Record<string, unknown>[] = [];
    for (const [index, sku] of expandedSkus.entries()) {
      const product = bySku.get(sku);
      const itemId = `${id}:${index + 1}`;
      await client.query(
        `INSERT INTO order_items(id,order_id,position,sku,provider,amount,currency)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [itemId, id, index + 1, sku, product.provider, product.price, product.currency],
      );
      await client.query(
        'INSERT INTO delivery_jobs(item_id,order_id,provider) VALUES($1,$2,$3)',
        [itemId, id, product.provider],
      );
      eventItems.push({
        id: itemId,
        position: index + 1,
        sku,
        provider: product.provider,
        amount: Number(product.price),
        currency: product.currency,
        status: 'awaiting_payment',
      });
    }
    await appendEvent(client, id, null, 'ORDER_CREATED', {
      id,
      status: 'created',
      amount,
      currency,
      items: eventItems,
    });

    const pendingPayment = (
      await client.query(
        "SELECT * FROM payment_events WHERE order_id=$1 AND status='paid' ORDER BY created_at,received_at LIMIT 1",
        [id],
      )
    ).rows[0];
    let paid = false;
    if (pendingPayment && Number(pendingPayment.amount) === amount && pendingPayment.currency === currency) {
      paid = await applyPaid(client, { id, amount, currency });
    }
    return { created: true, paid };
  });

  if (outcome.paid) void deliver(id);
  const order = await readOrder(pool, id);
  return reply.code(outcome.created ? 201 : 200).send(order);
});

app.get('/orders/:id', async (request, reply) => {
  const order = await readOrder(pool, String((request.params as { id: string }).id));
  return order ?? reply.code(404).send({ error: 'not_found' });
});

app.post('/webhook/payment', async (request, reply) => {
  const event = paymentSchema.parse(request.body);
  const outcome = await tx(async client => {
    const inserted = await client.query(
      `INSERT INTO payment_events(event_id,order_id,status,amount,currency,created_at)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
      [event.event_id, event.order_id, event.status, event.amount, event.currency, event.created_at],
    );
    if (!inserted.rowCount) return 'duplicate';

    const order = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [event.order_id])).rows[0];
    if (!order) return 'pending';
    if (event.amount !== Number(order.amount) || event.currency !== order.currency) {
      throw Object.assign(new Error('amount_mismatch'), { statusCode: 422 });
    }
    if (event.status === 'paid') {
      await applyPaid(client, order);
      return 'paid';
    }

    const paid = await client.query(
      "SELECT 1 FROM money_ledger WHERE order_id=$1 AND operation='payment'",
      [event.order_id],
    );
    if (!paid.rowCount) {
      await client.query("UPDATE orders SET status='payment_failed',updated_at=now() WHERE id=$1", [event.order_id]);
      await appendEvent(client, event.order_id, null, 'ORDER_STATUS_CHANGED', { status: 'payment_failed' });
    }
    return 'failed';
  });
  if (outcome === 'paid') void deliver(event.order_id);
  return reply.code(200).send({ accepted: true, result: outcome });
});

app.get('/orders/:id/history', async (request, reply) => {
  const orderId = String((request.params as { id: string }).id);
  const query = z.object({ at: z.string().datetime().optional() }).parse(request.query);
  const at = query.at ? new Date(query.at) : new Date();
  const events = (
    await pool.query(
      'SELECT id,event_type,item_id,payload,created_at FROM order_events WHERE order_id=$1 AND created_at <= $2 ORDER BY created_at,id',
      [orderId, at],
    )
  ).rows;
  if (!events.length) return reply.code(404).send({ error: 'not_found_at_time' });

  let snapshot: any = null;
  for (const event of events) {
    const payload = event.payload;
    if (event.event_type === 'ORDER_CREATED') snapshot = structuredClone(payload);
    else if (event.event_type === 'ORDER_STATUS_CHANGED' && snapshot) snapshot.status = payload.status;
    else if (event.event_type === 'ITEM_DELIVERED' && snapshot) {
      const item = snapshot.items.find((value: any) => value.id === event.item_id);
      if (item) Object.assign(item, { status: 'delivered', delivery_code: payload.code });
    } else if (event.event_type === 'REFUND_RECORDED' && snapshot) {
      const item = snapshot.items.find((value: any) => value.id === event.item_id);
      if (item) Object.assign(item, { status: 'refunded', last_error: payload.reason });
    }
  }
  const money = (
    await pool.query(
      `SELECT
         COALESCE(sum(amount) FILTER (WHERE operation='payment'),0)::int AS paid,
         COALESCE(sum(amount) FILTER (WHERE operation='refund'),0)::int AS refunded
       FROM money_ledger WHERE order_id=$1 AND created_at <= $2`,
      [orderId, at],
    )
  ).rows[0];
  const delivered = snapshot.items
    .filter((item: any) => item.status === 'delivered')
    .reduce((sum: number, item: any) => sum + Number(item.amount), 0);
  return {
    at: at.toISOString(),
    order: snapshot,
    money: {
      paid: Number(money.paid),
      delivered,
      refunded: Number(money.refunded),
      pending: Number(money.paid) - delivered - Number(money.refunded),
    },
    events,
  };
});

app.get('/admin/reconciliation', async () => {
  const financial = await pool.query(
    `SELECT o.id,o.status,o.amount,
            COALESCE(l.paid,0)::int AS paid,
            COALESCE(i.delivered,0)::int AS delivered,
            COALESCE(l.refunded,0)::int AS refunded
       FROM orders o
       LEFT JOIN (
         SELECT order_id,sum(amount) FILTER (WHERE operation='payment') AS paid,
                sum(amount) FILTER (WHERE operation='refund') AS refunded
           FROM money_ledger GROUP BY order_id
       ) l ON l.order_id=o.id
       LEFT JOIN (
         SELECT order_id,sum(amount) FILTER (WHERE status='delivered') AS delivered
           FROM order_items GROUP BY order_id
       ) i ON i.order_id=o.id
      WHERE o.status='completed'
        AND COALESCE(l.paid,0) <> COALESCE(i.delivered,0)+COALESCE(l.refunded,0)`,
  );
  const provider = await pool.query(
    `SELECT request_id,item_id,order_id,provider,state,last_error,updated_at
       FROM provider_requests WHERE state IN ('unconfirmed','rejected') ORDER BY updated_at DESC`,
  );
  return {
    healthy: financial.rowCount === 0,
    financial_mismatches: financial.rows,
    provider_discrepancies: provider.rows,
  };
});

app.get('/admin/queue', async () => {
  const counts = await pool.query(
    `SELECT
       count(*) FILTER (WHERE j.status='waiting_payment')::int AS unpaid,
       count(*) FILTER (WHERE j.status='queued')::int AS queued,
       count(*) FILTER (WHERE j.status='processing')::int AS processing,
       count(*) FILTER (WHERE i.status='delivered')::int AS delivered,
       count(*) FILTER (WHERE i.status='refunded')::int AS refunded
     FROM delivery_jobs j JOIN order_items i ON i.id=j.item_id`,
  );
  const rateLimits = await pool.query(
    'SELECT provider,limit_per_window,window_ms,window_started_at,used FROM provider_rate_limits ORDER BY provider',
  );
  return { ...counts.rows[0], providers: rateLimits.rows };
});

app.get('/admin/ledger', async (request) => {
  const query = z
    .object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() })
    .parse(request.query);
  const from = query.from ? new Date(query.from) : new Date(0);
  const to = query.to ? new Date(query.to) : new Date();
  const totals = (
    await pool.query(
      `SELECT currency,
              COALESCE(sum(amount) FILTER (WHERE operation='payment'),0)::int AS paid,
              COALESCE(sum(amount) FILTER (WHERE operation='refund'),0)::int AS refunded
         FROM money_ledger WHERE created_at >= $1 AND created_at <= $2 GROUP BY currency`,
      [from, to],
    )
  ).rows;
  return { from: from.toISOString(), to: to.toISOString(), totals };
});

app.post('/admin/recover', async () => {
  await recover();
  return { accepted: true };
});

const issueSchema = z.object({ request_id: z.string(), sku: z.string(), order_id: z.string() });
app.post('/providers/:provider/issue', async (request, reply) => {
  const name = String((request.params as { provider: string }).provider).toUpperCase() as 'A' | 'B';
  const provider = providers[name];
  if (!provider) return reply.code(404).send({ status: 'error', reason: 'unknown_provider' });
  const body = issueSchema.parse(request.body);
  const result = await provider.issue(body.request_id, body.sku, body.order_id);
  return result.status === 'ok'
    ? reply.send(result)
    : reply.code(result.reason === 'out_of_stock' ? 409 : 503).send(result);
});

app.get('/providers/:provider/requests/:requestId', async (request, reply) => {
  const params = request.params as { provider: string; requestId: string };
  const name = params.provider.toUpperCase() as 'A' | 'B';
  const provider = providers[name];
  if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
  const record = await provider.lookup(params.requestId);
  return record ?? reply.code(404).send({ error: 'not_found' });
});

const providerConfigSchema = z.object({
  failRate: z.number().min(0).max(1).optional(),
  timeoutRate: z.number().min(0).max(1).optional(),
  delayMs: z.number().int().min(0).optional(),
  duplicateRate: z.number().min(0).max(1).optional(),
  wrongSkuRate: z.number().min(0).max(1).optional(),
  errorAfterIssueRate: z.number().min(0).max(1).optional(),
  duplicateNext: z.boolean().optional(),
  wrongSkuNext: z.boolean().optional(),
  errorAfterIssueNext: z.boolean().optional(),
  limitPerWindow: z.number().int().positive().optional(),
  windowMs: z.number().int().positive().optional(),
  reset: z.boolean().optional(),
});

app.post('/admin/providers/:provider/config', async (request, reply) => {
  const name = String((request.params as { provider: string }).provider).toUpperCase() as 'A' | 'B';
  const provider = providers[name];
  if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
  const config = providerConfigSchema.parse(request.body);
  if (config.reset) provider.reset();
  const providerConfig: Partial<ProviderConfig> = { ...config };
  delete (providerConfig as any).limitPerWindow;
  delete (providerConfig as any).windowMs;
  delete (providerConfig as any).reset;
  provider.setConfig(providerConfig);
  if (config.limitPerWindow || config.windowMs || config.reset) {
    await pool.query(
      `UPDATE provider_rate_limits
          SET limit_per_window=COALESCE($2,limit_per_window),window_ms=COALESCE($3,window_ms),
              used=0,window_started_at=now()
        WHERE provider=$1`,
      [name, config.limitPerWindow ?? null, config.windowMs ?? null],
    );
  }
  return { accepted: true, provider: provider.getConfig() };
});

app.setErrorHandler((error, _request, reply) => {
  const statusCode = (error as any).statusCode ?? 400;
  return reply.code(statusCode).send({ error: (error as Error).message });
});

app.addHook('onReady', async () => {
  startWorker();
  void recover().catch(error => app.log.error(error));
});
app.addHook('onClose', async () => stopWorker());

export default app;
