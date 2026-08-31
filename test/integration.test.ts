import test from 'node:test';
import assert from 'node:assert/strict';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { default: app } = await import('../src/app.js');
const { pool } = await import('../src/db/index.js');
const { providers } = await import('../src/providers.js');

let databaseAvailable = Boolean(process.env.TEST_DATABASE_URL);
test.before(async () => { if (!databaseAvailable) return; try { await pool.query('SELECT 1'); } catch { databaseAvailable = false; } });
test.after(async () => { await app.close(); await pool.end(); });

async function reset() {
  await pool.query('TRUNCATE delivery_attempts, payment_events, orders RESTART IDENTITY CASCADE');
  await pool.query("INSERT INTO products(sku,name,type,price,currency) VALUES('TEST-SKU','Test','key',500,'RUB') ON CONFLICT(sku) DO UPDATE SET price=500");
  providers.A.reset(); providers.B.reset(); providers.A.setConfig({ failRate:0, timeoutRate:0, delayMs:0 }); providers.B.setConfig({ failRate:0, timeoutRate:0, delayMs:0 });
}
async function create(id: string) { return app.inject({ method:'POST', url:'/orders', payload:{ sku:'TEST-SKU', idempotency_key:id } }); }
async function pay(id: string, event = `evt-${id}`) { return app.inject({ method:'POST', url:'/webhook/payment', payload:{ event_id:event, order_id:id, status:'paid', amount:500, currency:'RUB', created_at:new Date().toISOString() } }); }
async function waitForDelivered(id: string) { for(let i=0;i<40;i++){ const r=await app.inject({method:'GET',url:`/orders/${id}`}); if(r.json().status==='delivered') return r.json(); await new Promise(r=>setTimeout(r,25)); } throw new Error('delivery did not finish'); }

test('50 parallel payment webhooks produce one delivery', async (t) => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset(); const id='race-order'; await create(id);
  await Promise.all(Array.from({length:50},(_,i)=>pay(id,`race-event-${i}`)));
  const order=await waitForDelivered(id); const attempts=await pool.query("SELECT * FROM delivery_attempts WHERE order_id=$1 AND outcome='ok'",[id]);
  assert.equal(order.status,'delivered'); assert.equal(attempts.rowCount,1);
});

test('duplicate event_id is a no-op', async (t) => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset(); const id='duplicate-order'; await create(id); await pay(id,'same-event'); await waitForDelivered(id); await pay(id,'same-event');
  const attempts=await pool.query("SELECT * FROM delivery_attempts WHERE order_id=$1",[id]); assert.equal(attempts.rowCount,1);
});

test('timeout is retried with the same request_id', async (t) => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset(); providers.A.setConfig({ timeoutRate:1 }); const id='timeout-order'; await create(id); await pay(id); await waitForDelivered(id);
  const attempt=(await pool.query('SELECT provider,request_id FROM delivery_attempts WHERE order_id=$1',[id])).rows[0]; assert.equal(attempt.provider,'A'); assert.equal(attempt.request_id,`${id}-1`);
});

test('known provider failure falls back to B', async (t) => {
  if (!databaseAvailable) return t.skip('PostgreSQL is not running');
  await reset(); providers.A.setConfig({ failRate:1 }); const id='fallback-order'; await create(id); await pay(id); await waitForDelivered(id);
  const attempt=(await pool.query('SELECT provider FROM delivery_attempts WHERE order_id=$1',[id])).rows[0]; assert.equal(attempt.provider,'B');
});
