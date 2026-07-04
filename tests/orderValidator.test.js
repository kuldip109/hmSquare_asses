const test = require('node:test');
const assert = require('node:assert');
const { validateOrderRow } = require('../src/validators/orderValidator');
const { getShardIndex } = require('../src/utils/hash');

test('valid row passes validation', () => {
  const result = validateOrderRow({
    order_id: 'ord-1',
    customer_id: 'cust-1',
    order_date: '2024-01-01T00:00:00Z',
    order_amount: '19.99',
    status: 'pending',
  });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.order.customer_id, 'cust-1');
});

test('accepts the spec typo column "order_amout"', () => {
  const result = validateOrderRow({
    order_id: 'ord-2',
    customer_id: 'cust-2',
    order_date: '2024-01-01T00:00:00Z',
    order_amout: '5.50',
    status: 'shipped',
  });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.order.order_amount, '5.50');
});

test('missing customer_id fails validation', () => {
  const result = validateOrderRow({
    order_id: 'ord-3',
    order_date: '2024-01-01T00:00:00Z',
    order_amount: '5.50',
    status: 'pending',
  });
  assert.strictEqual(result.valid, false);
});

test('invalid date fails validation', () => {
  const result = validateOrderRow({
    order_id: 'ord-4',
    customer_id: 'cust-4',
    order_date: 'not-a-date',
    order_amount: '5.50',
    status: 'pending',
  });
  assert.strictEqual(result.valid, false);
});

test('invalid status fails validation', () => {
  const result = validateOrderRow({
    order_id: 'ord-5',
    customer_id: 'cust-5',
    order_date: '2024-01-01T00:00:00Z',
    order_amount: '5.50',
    status: 'not-a-status',
  });
  assert.strictEqual(result.valid, false);
});

test('shard routing is deterministic for the same key', () => {
  const a = getShardIndex('customer-123', 4);
  const b = getShardIndex('customer-123', 4);
  assert.strictEqual(a, b);
  assert.ok(a >= 0 && a < 4);
});

test('shard routing distributes across the full range', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    seen.add(getShardIndex(`customer-${i}`, 4));
  }
  assert.strictEqual(seen.size, 4);
});
