import test from 'node:test';
import assert from 'node:assert/strict';

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { default: app } = await import('../src/app.js');
const { pool } = await import('../src/db/index.js');
const { providers } = await import('../src/providers.js');
const { recover } = await import('../src/delivery.js');

let databaseAvailable = Boolean(process.env.TEST_DATABASE_URL);

test.before(async () => {
  if (!databaseAvailable) return;
  try {
    await pool.query('SELECT 1');
  } catch {
    databaseAvailable = false;
  }
});

test.after(async () => {
  await app.close();
  await pool.end();
});

async function reset() {
  await pool.query(
    `TRUNCATE order_events,money_ledger,issued_codes,provider_requests,delivery_jobs,
              order_items,delivery_attempts,payment_events,orders RESTART IDENTITY CASCADE`,
  );
  await pool.query(
    `INSERT INTO products(sku,name,type,price,currency,provider) VALUES
       ('TEST-A','Test A','key',500,'RUB','A'),
       ('TEST-B','Test B','key',700,'RUB','B')
     ON CONFLICT(sku) DO UPDATE SET price=EXCLUDED.price,provider=EXCLUDED.provider`,
  );
  await pool.query(
    'UPDATE provider_rate_limits SET limit_per_window=60,window_ms=60000,used=0,window_started_at=now()',
  );
  providers.A.reset();
  providers.B.reset();
}

async function create(id: string, skus = ['TEST-A']) {
  return app.inject({
    method: 'POST',
    url: '/orders',
    payload: { items: skus.map(sku => ({ sku })), idempotency_key: id },
  });
}

async function pay(id: string, amount: number, event = `evt-${id}`) {
  return app.inject({
    method: 'POST',
    url: '/webhook/payment',
    payload: {
      event_id: event,
      order_id: id,
      status: 'paid',
      amount,
      currency: 'RUB',
      created_at: new Date().toISOString(),
    },
  });
}

async function read(id: string) {
  const response = await app.inject({ method: 'GET', url: `/orders/${id}` });
  assert.equal(response.statusCode, 200);
  return response.json();
}

async function waitForCompleted(id: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const order = await read(id);
    if (order.status === 'completed') return order;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`order ${id} did not finish`);
}

test('parallel payment webhooks charge and deliver exactly once', async t => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset();
  const id = 'race-order';
  assert.equal((await create(id)).statusCode, 201);
  await Promise.all(Array.from({ length: 50 }, (_, index) => pay(id, 500, `race-event-${index}`)));
  const order = await waitForCompleted(id);
  const attempts = await pool.query("SELECT * FROM delivery_attempts WHERE order_id=$1 AND outcome='ok'", [id]);
  const payments = await pool.query("SELECT * FROM money_ledger WHERE order_id=$1 AND operation='payment'", [id]);
  assert.equal(order.items[0].status, 'delivered');
  assert.equal(attempts.rowCount, 1);
  assert.equal(payments.rowCount, 1);
  assert.equal(order.money.paid, 500);
  assert.equal(order.money.delivered, 500);
  assert.equal(order.money.balanced, true);
});

test('a partial delivery keeps issued goods and refunds only failed items', async t => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset();
  for (let index = 0; index < 50; index++) {
    await providers.B.issue(`consume-${index}`, 'TEST-B', `stock-${index}`);
  }

  const id = 'partial-order';
  await create(id, ['TEST-A', 'TEST-B']);
  await pay(id, 1_200);
  const order = await waitForCompleted(id);

  assert.deepEqual(order.items.map((item: any) => item.status), ['delivered', 'refunded']);
  assert.equal(order.money.paid, 1_200);
  assert.equal(order.money.delivered, 500);
  assert.equal(order.money.refunded, 700);
  assert.equal(order.money.balanced, true);
  assert.equal((await pool.query("SELECT * FROM money_ledger WHERE operation='refund' AND order_id=$1", [id])).rowCount, 1);

  await Promise.all([recover(), recover(), recover()]);
  assert.equal((await pool.query("SELECT * FROM money_ledger WHERE operation='refund' AND order_id=$1", [id])).rowCount, 1);
});

test('an error after issuance is reconciled without issuing a second code', async t => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset();
  providers.A.setConfig({ errorAfterIssueNext: true });

  const id = 'ambiguous-order';
  await create(id);
  await pay(id, 500);
  const order = await waitForCompleted(id);

  assert.equal(order.items[0].status, 'delivered');
  assert.equal(providers.A.metrics().requests, 1);
  assert.equal((await pool.query('SELECT * FROM issued_codes WHERE order_id=$1', [id])).rowCount, 1);
  const event = (
    await pool.query("SELECT payload FROM order_events WHERE order_id=$1 AND event_type='ITEM_DELIVERED'", [id])
  ).rows[0];
  assert.equal(event.payload.reconciled_after_error, true);
});

test('a duplicate provider code is quarantined and replaced automatically', async t => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset();

  await create('first-order');
  await pay('first-order', 500);
  const first = await waitForCompleted('first-order');

  providers.A.setConfig({ duplicateNext: true });
  await create('second-order');
  await pay('second-order', 500);
  const second = await waitForCompleted('second-order');

  assert.notEqual(second.items[0].delivery_code, first.items[0].delivery_code);
  assert.equal((await pool.query('SELECT code,count(*) FROM issued_codes GROUP BY code HAVING count(*) > 1')).rowCount, 0);
  assert.equal(
    (await pool.query("SELECT * FROM order_events WHERE order_id='second-order' AND event_type='PROVIDER_DISCREPANCY'")).rowCount,
    1,
  );
});

test('a code for the wrong SKU is rejected and replaced automatically', async t => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset();
  providers.A.setConfig({ wrongSkuNext: true });

  await create('wrong-sku-order');
  await pay('wrong-sku-order', 500);
  const order = await waitForCompleted('wrong-sku-order');

  assert.equal(order.items[0].status, 'delivered');
  assert.equal(
    (await pool.query("SELECT * FROM order_events WHERE order_id='wrong-sku-order' AND event_type='PROVIDER_DISCREPANCY'")).rowCount,
    1,
  );
});

test('recover resumes a paid job left behind by a crash', async t => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset();
  const id = 'crashed-order';
  await create(id);

  await pool.query("INSERT INTO money_ledger(idempotency_key,order_id,operation,amount,currency) VALUES($1,$2,'payment',500,'RUB')", [`payment:${id}`, id]);
  await pool.query("UPDATE orders SET status='processing' WHERE id=$1", [id]);
  await pool.query("UPDATE order_items SET status='delivering' WHERE order_id=$1", [id]);
  await pool.query("UPDATE delivery_jobs SET status='processing',lease_until=now()-interval '1 second' WHERE order_id=$1", [id]);

  await recover();
  const order = await waitForCompleted(id);
  assert.equal(order.items[0].status, 'delivered');
  assert.equal(order.money.balanced, true);
});

test('provider rate limit keeps excess work queued', async t => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset();
  await pool.query(
    "UPDATE provider_rate_limits SET limit_per_window=1,window_ms=150,used=0,window_started_at=now() WHERE provider='A'",
  );

  const id = 'limited-order';
  await create(id, ['TEST-A', 'TEST-A']);
  await pay(id, 1_000);
  await new Promise(resolve => setTimeout(resolve, 40));
  const intermediate = await read(id);
  assert.equal(intermediate.items.filter((item: any) => item.status === 'delivered').length, 1);
  assert.equal(providers.A.metrics().requests, 1);

  const order = await waitForCompleted(id);
  assert.equal(order.items.filter((item: any) => item.status === 'delivered').length, 2);
  assert.equal(order.money.balanced, true);
});

test('order history is replayable and audit tables reject updates', async t => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset();
  const id = 'history-order';
  const created = new Date();
  await create(id);
  await new Promise(resolve => setTimeout(resolve, 5));
  const beforePayment = new Date();
  await pay(id, 500);
  await waitForCompleted(id);

  const historical = await app.inject({
    method: 'GET',
    url: `/orders/${id}/history?at=${encodeURIComponent(beforePayment.toISOString())}`,
  });
  assert.equal(historical.statusCode, 200);
  assert.equal(historical.json().order.status, 'created');
  assert.equal(historical.json().money.paid, 0);
  assert.ok(new Date(historical.json().at) >= created);

  await assert.rejects(pool.query("UPDATE money_ledger SET amount=0 WHERE order_id=$1", [id]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM order_events WHERE order_id=$1", [id]), /append-only/);
});
