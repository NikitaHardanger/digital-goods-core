import Fastify from 'fastify'; import crypto from 'node:crypto'; import { z } from 'zod'; import { pool, tx } from './db/index.js'; import { deliver, recover } from './delivery.js'; import { providers } from './providers.js';
const app = Fastify({ logger: true });
const payment = z.object({ event_id:z.string(),order_id:z.string(),status:z.enum(['paid','failed']),amount:z.number(),currency:z.string(),created_at:z.string() });
app.post('/orders', async (req, reply) => { const body = z.object({sku:z.string(), idempotency_key:z.string().optional()}).parse(req.body); const id = body.idempotency_key ?? `ord_${crypto.randomUUID()}`;
  const result = await tx(async c => { const existing=await c.query('SELECT * FROM orders WHERE id=$1',[id]); if(existing.rowCount) return existing.rows[0]; const p=await c.query('SELECT * FROM products WHERE sku=$1',[body.sku]); if(!p.rowCount) throw Object.assign(new Error('unknown sku'),{statusCode:404}); const x=p.rows[0]; const o=(await c.query("INSERT INTO orders(id,sku,amount,currency,status) VALUES($1,$2,$3,$4,'created') RETURNING *",[id,x.sku,x.price,x.currency])).rows[0]; const event=await c.query("SELECT * FROM payment_events WHERE order_id=$1 ORDER BY created_at DESC, received_at DESC LIMIT 1",[id]); if(event.rowCount && event.rows[0].amount===o.amount && event.rows[0].currency===o.currency) return (await c.query("UPDATE orders SET status=$2,updated_at=now() WHERE id=$1 RETURNING *",[id,event.rows[0].status==='paid'?'paid':'payment_failed'])).rows[0]; return o; });
  if(result.status==='paid') void deliver(id); return reply.code(201).send(result);
});
app.get('/orders/:id', async (req, reply) => { const r=await pool.query('SELECT * FROM orders WHERE id=$1',[(req.params as any).id]); return r.rowCount ? r.rows[0] : reply.code(404).send({error:'not_found'}); });
app.post('/webhook/payment', async (req, reply) => { const e=payment.parse(req.body); const status=await tx(async c=>{ const inserted=await c.query("INSERT INTO payment_events(event_id,order_id,status,amount,currency,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_id) DO NOTHING RETURNING event_id",[e.event_id,e.order_id,e.status,e.amount,e.currency,e.created_at]); if(!inserted.rowCount) return 'duplicate'; const o=(await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[e.order_id])).rows[0]; if(!o) return 'pending'; if(e.amount!==o.amount||e.currency!==o.currency) throw Object.assign(new Error('amount_mismatch'),{statusCode:422}); if(e.status==='failed') await c.query("UPDATE orders SET status='payment_failed',updated_at=now() WHERE id=$1 AND status='created'",[e.order_id]); else if(!['delivered','payment_failed'].includes(o.status)) await c.query("UPDATE orders SET status='paid',updated_at=now() WHERE id=$1",[e.order_id]); return e.status; }); if(status==='paid') void deliver(e.order_id); return reply.code(200).send({accepted:true}); });
app.get('/admin/reconciliation', async () => {
  const paidNotDelivered = await pool.query("SELECT id,status FROM orders WHERE status IN ('paid','delivering','out_of_stock','delivery_failed')");
  const deliveredNotPaid = await pool.query("SELECT o.id,o.status FROM orders o LEFT JOIN payment_events p ON p.order_id=o.id AND p.status='paid' WHERE o.status='delivered' AND p.order_id IS NULL");
  return { paid_not_delivered: paidNotDelivered.rows, delivered_not_paid: deliveredNotPaid.rows };
});
app.post('/admin/recover', async () => { await recover(); return { accepted: true }; });
const issue = z.object({ request_id:z.string(), sku:z.string(), order_id:z.string() });
app.post('/providers/:provider/issue', async (req, reply) => {
  const name = String((req.params as any).provider).toUpperCase() as 'A'|'B'; const provider = providers[name];
  if (!provider) return reply.code(404).send({ status:'error', reason:'unknown_provider' });
  const body = issue.parse(req.body); const result = await provider.issue(body.request_id, body.sku, body.order_id);
  return result.status === 'ok' ? reply.send(result) : reply.code(result.reason === 'out_of_stock' ? 409 : 503).send(result);
});
app.post('/admin/providers/:provider/config', async (req, reply) => {
  const name = String((req.params as any).provider).toUpperCase() as 'A'|'B'; const provider = providers[name];
  if (!provider) return reply.code(404).send({ error:'unknown_provider' });
  const config = z.object({ failRate:z.number().min(0).max(1).optional(), timeoutRate:z.number().min(0).max(1).optional(), delayMs:z.number().int().min(0).optional(), reset:z.boolean().optional() }).parse(req.body);
  if (config.reset) provider.reset(); provider.setConfig(config); return { accepted:true };
});
app.setErrorHandler((err,_,reply)=>reply.code((err as any).statusCode??400).send({error:(err as Error).message})); export default app;
