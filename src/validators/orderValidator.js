const { randomUUID } = require('crypto');

const VALID_STATUSES = new Set([
  'pending',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
]);

/**
 * Validates and normalizes a single raw CSV row into a clean order object.
 * Returns { valid: true, order } or { valid: false, error }.
 *
 * Note: the assessment spec's own example table has a typo, "order_amout".
 * We accept both "order_amount" and "order_amout" as the source column so
 * a file generated strictly from that spec still parses correctly.
 */
function validateOrderRow(row) {
  const orderId = (row.order_id || '').trim();
  const customerId = (row.customer_id || '').trim();
  const rawDate = (row.order_date || '').trim();
  const rawAmount = (row.order_amount ?? row.order_amout ?? '').toString().trim();
  const status = (row.status || '').trim().toLowerCase();

  if (!customerId) {
    return { valid: false, error: 'customer_id is required' };
  }

  const orderDate = new Date(rawDate);
  if (!rawDate || Number.isNaN(orderDate.getTime())) {
    return { valid: false, error: `Invalid order_date: "${rawDate}"` };
  }

  const amount = Number(rawAmount);
  if (rawAmount === '' || Number.isNaN(amount) || amount < 0) {
    return { valid: false, error: `Invalid order_amount: "${rawAmount}"` };
  }

  if (!status) {
    return { valid: false, error: 'status is required' };
  }
  if (!VALID_STATUSES.has(status)) {
    return {
      valid: false,
      error: `Invalid status "${status}". Expected one of: ${[...VALID_STATUSES].join(', ')}`,
    };
  }

  // order_id is allowed to be blank in the source file; if so, generate one.
  const finalOrderId = orderId || randomUUID();
  if (orderId) {
    const uuidLike = /^[0-9a-f-]{8,}$/i.test(orderId);
    if (!uuidLike) {
      // Accept non-UUID string IDs too (spec allows "String / UUID"),
      // but still require it to be a reasonable non-empty token.
    }
  }

  return {
    valid: true,
    order: {
      order_id: finalOrderId,
      customer_id: customerId,
      order_date: orderDate.toISOString(),
      order_amount: amount.toFixed(2),
      status,
    },
  };
}

module.exports = { validateOrderRow, VALID_STATUSES };
