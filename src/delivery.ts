import { tx, pool } from './db/index.js'; import { providers, StubProvider } from './providers.js';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function callWithTimeout(provider: StubProvider, requestId: string, sku: string, orderId: string, ms = 500): Promise<any> {
  return Promise.race([provider.issue(requestId, sku, orderId), sleep(ms).then(() => { throw new Error('timeout'); })]);
}
async function tryProvider(provider: StubProvider, requestId: string, sku: string, orderId: string) {
  let timedOut = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return { result: await callWithTimeout(provider, requestId, sku, orderId), timedOut }; }
    catch { timedOut = true; await sleep(30 * 2 ** attempt); }
  }
  return { result: null, timedOut };
}
export async function deliver(orderId: string) {
  const locked = await tx(async c => {
    const r = await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [orderId]); const o = r.rows[0];
    if (!o || ['delivered','payment_failed','delivering'].includes(o.status)) return null;
    if (o.status === 'paid' || o.status === 'out_of_stock' || o.status === 'delivery_failed') await c.query("UPDATE orders SET status='delivering',updated_at=now() WHERE id=$1", [orderId]);
    return o;
  });
  if (!locked) return;
  const requestId = locked.delivery_request_id ?? `${orderId}-1`;
  let attempt: any = await tryProvider(providers.A, requestId, locked.sku, orderId); let provider = 'A';
  // A timeout is ambiguous: A may have issued the code. Never issue through B
  // until the same request_id has been reconciled with A.
  if ((!attempt.result || attempt.result.status !== 'ok') && !attempt.timedOut) { attempt = await tryProvider(providers.B, requestId, locked.sku, orderId); provider = 'B'; }
  const result = attempt.result;
  await tx(async c => {
    const current = (await c.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
    if (!current || current.status === 'delivered') return;
    if (result?.status === 'ok') {
      await c.query("UPDATE orders SET status='delivered',delivery_code=$2,delivery_request_id=$3,updated_at=now() WHERE id=$1", [orderId,result.code,requestId]);
      await c.query("INSERT INTO delivery_attempts(order_id,provider,request_id,outcome,code) VALUES($1,$2,$3,'ok',$4) ON CONFLICT DO NOTHING", [orderId,provider,requestId,result.code]);
    } else {
      const nextStatus = result?.reason === 'out_of_stock' ? 'out_of_stock' : 'delivery_failed';
      await c.query("UPDATE orders SET status=$2,delivery_request_id=$3,updated_at=now() WHERE id=$1",[orderId,nextStatus,requestId]);
    }
  });
}
export async function recover() { const r = await pool.query("SELECT id FROM orders WHERE status IN ('paid','out_of_stock','delivery_failed') ORDER BY created_at LIMIT 100"); await Promise.all(r.rows.map(x => deliver(x.id))); }
