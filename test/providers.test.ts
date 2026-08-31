import test from 'node:test';
import assert from 'node:assert/strict';
import { StubProvider } from '../src/providers.js';

test('provider is idempotent for the same request_id', async () => {
  const provider = new StubProvider('TEST');
  const first = await provider.issue('req-1', 'SKU', 'ord-1');
  const second = await provider.issue('req-1', 'SKU', 'ord-1');
  assert.equal(first.status, 'ok');
  assert.deepEqual(second, first);
});

test('provider reports empty inventory', async () => {
  const provider = new StubProvider('TEST');
  for (let i = 0; i < 50; i++) await provider.issue(`req-${i}`, 'SKU', `ord-${i}`);
  assert.deepEqual(await provider.issue('req-last', 'SKU', 'ord-last'), { status: 'error', reason: 'out_of_stock' });
});
