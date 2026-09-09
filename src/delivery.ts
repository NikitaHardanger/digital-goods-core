import type pg from 'pg';
import { pool, tx } from './db/index.js';
import { providers, type ProviderRecord, type ProviderResult, type StubProvider } from './providers.js';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 10_000;
const PROVIDER_TIMEOUT_MS = 500;

type QueueItem = {
  item_id: string;
  order_id: string;
  sku: string;
  provider: 'A' | 'B';
  request_version: number;
  request_id: string;
  attempts: number;
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

async function callWithTimeout(
  provider: StubProvider,
  requestId: string,
  sku: string,
  orderId: string,
): Promise<ProviderResult> {
  return Promise.race([
    provider.issue(requestId, sku, orderId),
    sleep(PROVIDER_TIMEOUT_MS).then(() => ({
      status: 'error' as const,
      reason: 'timeout',
    })),
  ]);
}

async function refreshOrderStatus(client: pg.PoolClient, orderId: string) {
  const summary = (
    await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status IN ('delivered','refunded'))::int AS final,
              count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
              count(*) FILTER (WHERE status = 'refunded')::int AS refunded
         FROM order_items WHERE order_id=$1`,
      [orderId],
    )
  ).rows[0];
  const nextStatus = summary.total > 0 && summary.total === summary.final ? 'completed' : 'processing';
  const current = (await client.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
  if (current && current.status !== nextStatus) {
    await client.query('UPDATE orders SET status=$2,updated_at=now() WHERE id=$1', [orderId, nextStatus]);
    await appendEvent(client, orderId, null, 'ORDER_STATUS_CHANGED', {
      status: nextStatus,
      delivered_items: summary.delivered,
      refunded_items: summary.refunded,
    });
  }
}

async function refundItem(client: pg.PoolClient, item: QueueItem, reason: string) {
  const row = (
    await client.query('SELECT amount,currency,status FROM order_items WHERE id=$1 FOR UPDATE', [item.item_id])
  ).rows[0];
  if (!row || row.status === 'delivered' || row.status === 'refunded') return;

  const inserted = await client.query(
    `INSERT INTO money_ledger(idempotency_key,order_id,item_id,operation,amount,currency)
     VALUES($1,$2,$3,'refund',$4,$5)
     ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
    [`refund:${item.item_id}`, item.order_id, item.item_id, row.amount, row.currency],
  );
  await client.query(
    "UPDATE order_items SET status='refunded',last_error=$2,updated_at=now() WHERE id=$1",
    [item.item_id, reason],
  );
  await client.query(
    "UPDATE delivery_jobs SET status='done',lease_until=NULL,updated_at=now() WHERE item_id=$1",
    [item.item_id],
  );
  if (inserted.rowCount) {
    await appendEvent(client, item.order_id, item.item_id, 'REFUND_RECORDED', {
      status: 'refunded',
      amount: row.amount,
      currency: row.currency,
      reason,
    });
  }
  await refreshOrderStatus(client, item.order_id);
}

async function requeue(
  client: pg.PoolClient,
  item: QueueItem,
  reason: string,
  newRequest: boolean,
) {
  if (item.attempts >= MAX_ATTEMPTS) {
    await refundItem(client, item, reason);
    return;
  }

  await client.query(
    `UPDATE order_items
        SET status='delivery_pending',last_error=$2,
            request_version=request_version + $3,updated_at=now()
      WHERE id=$1`,
    [item.item_id, reason, newRequest ? 1 : 0],
  );
  const backoffMs = newRequest ? 0 : Math.min(100 * 2 ** Math.max(item.attempts - 1, 0), 2_000);
  await client.query(
    `UPDATE delivery_jobs
        SET status='queued',available_at=now()+($2::text || ' milliseconds')::interval,
            lease_until=NULL,updated_at=now()
      WHERE item_id=$1`,
    [item.item_id, backoffMs],
  );
}

async function claimJob(orderId?: string): Promise<QueueItem | null> {
  return tx(async client => {
    await client.query(
      `UPDATE order_items i SET status='delivery_pending',updated_at=now()
        FROM delivery_jobs j
       WHERE j.item_id=i.id AND j.status='processing' AND j.lease_until < now()
         AND i.status NOT IN ('delivered','refunded')`,
    );
    await client.query(
      `UPDATE delivery_jobs j SET status='queued',lease_until=NULL,updated_at=now()
        FROM order_items i
       WHERE j.item_id=i.id AND j.status='processing' AND j.lease_until < now()
         AND i.status NOT IN ('delivered','refunded')`,
    );

    const values: unknown[] = [];
    const orderFilter = orderId ? 'AND j.order_id=$1' : '';
    if (orderId) values.push(orderId);
    const job = (
      await client.query(
        `SELECT j.item_id,j.order_id,j.provider,j.attempts,
                i.sku,i.request_version
           FROM delivery_jobs j
           JOIN order_items i ON i.id=j.item_id
           JOIN orders o ON o.id=j.order_id
           JOIN provider_rate_limits rl ON rl.provider=j.provider
          WHERE j.status='queued' AND j.available_at <= now()
            AND i.status='delivery_pending' AND o.status IN ('paid','processing')
            AND (rl.used < rl.limit_per_window OR
                 now() >= rl.window_started_at + (rl.window_ms::text || ' milliseconds')::interval)
            ${orderFilter}
          ORDER BY j.priority DESC,j.created_at,j.item_id
          FOR UPDATE OF j SKIP LOCKED
          LIMIT 1`,
        values,
      )
    ).rows[0];
    if (!job) return null;

    const rate = (
      await client.query('SELECT * FROM provider_rate_limits WHERE provider=$1 FOR UPDATE', [job.provider])
    ).rows[0];
    const now = Date.now();
    let windowStartedAt = new Date(rate.window_started_at).getTime();
    let used = Number(rate.used);
    if (now >= windowStartedAt + Number(rate.window_ms)) {
      windowStartedAt = now;
      used = 0;
      await client.query(
        'UPDATE provider_rate_limits SET window_started_at=now(),used=0 WHERE provider=$1',
        [job.provider],
      );
    }
    if (used >= Number(rate.limit_per_window)) {
      const availableAt = new Date(windowStartedAt + Number(rate.window_ms));
      await client.query(
        'UPDATE delivery_jobs SET available_at=$2,updated_at=now() WHERE item_id=$1',
        [job.item_id, availableAt],
      );
      return null;
    }

    await client.query('UPDATE provider_rate_limits SET used=used+1 WHERE provider=$1', [job.provider]);
    const attempts = Number(job.attempts) + 1;
    await client.query(
      `UPDATE delivery_jobs
          SET status='processing',attempts=$2,lease_until=now()+($3::text || ' milliseconds')::interval,
              updated_at=now()
        WHERE item_id=$1`,
      [job.item_id, attempts, LEASE_MS],
    );
    await client.query("UPDATE order_items SET status='delivering',updated_at=now() WHERE id=$1", [job.item_id]);

    const requestId = `${job.item_id}-v${job.request_version}`;
    await client.query(
      `INSERT INTO provider_requests(request_id,item_id,order_id,provider,sku)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(request_id) DO NOTHING`,
      [requestId, job.item_id, job.order_id, job.provider, job.sku],
    );
    return { ...job, request_id: requestId, attempts } as QueueItem;
  });
}

async function finishJob(item: QueueItem, result: ProviderResult, record: ProviderRecord | null) {
  await tx(async client => {
    // Serializing finalization per order prevents two last items from both
    // observing the other one as unfinished and leaving the order non-final.
    await client.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [item.order_id]);
    const current = (
      await client.query('SELECT status FROM order_items WHERE id=$1 FOR UPDATE', [item.item_id])
    ).rows[0];
    if (!current || current.status === 'delivered' || current.status === 'refunded') return;

    if (!record) {
      await client.query(
        "UPDATE provider_requests SET state='unconfirmed',last_error=$2,updated_at=now() WHERE request_id=$1",
        [item.request_id, result.status === 'error' ? result.reason : 'missing_provider_record'],
      );
      const reason = result.status === 'error' ? result.reason : 'missing_provider_record';
      if (reason === 'out_of_stock') await refundItem(client, item, reason);
      else await requeue(client, item, reason, false);
      return;
    }

    const mismatch =
      record.request_id !== item.request_id ||
      record.provider !== item.provider ||
      record.sku !== item.sku ||
      record.order_id !== item.order_id;
    if (mismatch) {
      await client.query(
        "UPDATE provider_requests SET state='rejected',code=$2,last_error='provider_data_mismatch',updated_at=now() WHERE request_id=$1",
        [item.request_id, record.code],
      );
      await appendEvent(client, item.order_id, item.item_id, 'PROVIDER_DISCREPANCY', {
        request_id: item.request_id,
        reason: 'provider_data_mismatch',
        expected: { provider: item.provider, sku: item.sku, order_id: item.order_id },
        received: record,
      });
      await requeue(client, item, 'provider_data_mismatch', true);
      return;
    }

    const inserted = await client.query(
      `INSERT INTO issued_codes(code,item_id,order_id,provider,sku,request_id)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING RETURNING code`,
      [record.code, item.item_id, item.order_id, item.provider, item.sku, item.request_id],
    );
    if (!inserted.rowCount) {
      const owner = (await client.query('SELECT item_id,order_id FROM issued_codes WHERE code=$1', [record.code])).rows[0];
      if (owner?.item_id === item.item_id) return;
      await client.query(
        "UPDATE provider_requests SET state='rejected',code=$2,last_error='duplicate_code',updated_at=now() WHERE request_id=$1",
        [item.request_id, record.code],
      );
      await appendEvent(client, item.order_id, item.item_id, 'PROVIDER_DISCREPANCY', {
        request_id: item.request_id,
        reason: 'duplicate_code',
        code: record.code,
        owned_by_order: owner?.order_id,
      });
      await requeue(client, item, 'duplicate_code', true);
      return;
    }

    await client.query(
      "UPDATE provider_requests SET state='accepted',code=$2,last_error=NULL,updated_at=now() WHERE request_id=$1",
      [item.request_id, record.code],
    );
    await client.query(
      "UPDATE order_items SET status='delivered',delivery_code=$2,last_error=NULL,updated_at=now() WHERE id=$1",
      [item.item_id, record.code],
    );
    await client.query(
      "UPDATE delivery_jobs SET status='done',lease_until=NULL,updated_at=now() WHERE item_id=$1",
      [item.item_id],
    );
    await client.query(
      `INSERT INTO delivery_attempts(order_id,provider,request_id,outcome,code)
       VALUES($1,$2,$3,'ok',$4) ON CONFLICT(provider,request_id) DO NOTHING`,
      [item.order_id, item.provider, item.request_id, record.code],
    );
    await appendEvent(client, item.order_id, item.item_id, 'ITEM_DELIVERED', {
      status: 'delivered',
      sku: item.sku,
      provider: item.provider,
      request_id: item.request_id,
      code: record.code,
      reconciled_after_error: result.status === 'error',
    });
    await refreshOrderStatus(client, item.order_id);
  });
}

async function processOne(orderId?: string) {
  const item = await claimJob(orderId);
  if (!item) return false;
  const provider = providers[item.provider];
  const result = await callWithTimeout(provider, item.request_id, item.sku, item.order_id);
  // Never trust the issue response. The lookup is the source used for validation,
  // including the "issued but returned an error" case.
  const record = await provider.lookup(item.request_id);
  await finishJob(item, result, record);
  return true;
}

export async function processQueue(limit = 100, orderId?: string) {
  for (let processed = 0; processed < limit; processed++) {
    if (!(await processOne(orderId))) break;
  }
}

// Kept as the public stage-one entry point.
export async function deliver(orderId: string) {
  await processQueue(100, orderId);
}

export async function recover() {
  await pool.query(
    `UPDATE order_items i SET status='delivery_pending',updated_at=now()
      FROM delivery_jobs j
     WHERE j.item_id=i.id AND j.status='processing' AND j.lease_until < now()
       AND i.status NOT IN ('delivered','refunded')`,
  );
  await pool.query(
    `UPDATE delivery_jobs j SET status='queued',lease_until=NULL,updated_at=now()
      FROM order_items i
     WHERE j.item_id=i.id AND j.status='processing' AND j.lease_until < now()
       AND i.status NOT IN ('delivered','refunded')`,
  );
  await processQueue(100);
}

let worker: NodeJS.Timeout | undefined;
let workerBusy = false;

export function startWorker(intervalMs = 250) {
  if (worker) return;
  worker = setInterval(() => {
    if (workerBusy) return;
    workerBusy = true;
    void recover()
      .catch(error => console.error('delivery worker failed', error))
      .finally(() => {
        workerBusy = false;
      });
  }, intervalMs);
  worker.unref();
}

export function stopWorker() {
  if (worker) clearInterval(worker);
  worker = undefined;
}
