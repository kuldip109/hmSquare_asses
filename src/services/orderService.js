const { getPoolForCustomer, getAllPools } = require('../db/shardRouter');
const logger = require('../utils/logger');

/**
 * Batch-inserts a group of already-validated orders belonging to ONE
 * shard, inside a single transaction, using a single multi-row INSERT
 * (not one-by-one inserts — requirement 5).
 *
 * ON CONFLICT (order_id) DO NOTHING makes re-running the same file (or
 * retrying a failed job) idempotent instead of erroring or duplicating.
 */
async function batchInsertOrders(pool, orders, jobId) {
  if (orders.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const values = [];
    const placeholders = orders
      .map((o, i) => {
        const base = i * 6;
        values.push(o.order_id, o.customer_id, o.order_date, o.order_amount, o.status, jobId);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
      })
      .join(', ');

    const sql = `
      INSERT INTO orders (order_id, customer_id, order_date, order_amount, status, job_id)
      VALUES ${placeholders}
      ON CONFLICT (order_id) DO NOTHING
    `;

    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result.rowCount;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Batch insert failed, transaction rolled back', {
      error: err.message,
      batchSize: orders.length,
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Batch-inserts failed/invalid rows for later inspection (requirement 3.2:
 * "Invalid or malformed rows should be handled gracefully").
 */
async function batchInsertFailedRows(pool, failedRows, jobId) {
  if (failedRows.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const values = [];
    const placeholders = failedRows
      .map((f, i) => {
        const base = i * 3;
        values.push(jobId, JSON.stringify(f.raw), f.error);
        return `($${base + 1}, $${base + 2}, $${base + 3})`;
      })
      .join(', ');

    const sql = `
      INSERT INTO failed_orders (job_id, raw_row, error)
      VALUES ${placeholders}
    `;

    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result.rowCount;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed-row insert failed, transaction rolled back', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * GET /orders?customerId=... — single-shard lookup, fast path, since
 * customer_id IS the shard key.
 */
async function getOrdersByCustomer(customerId) {
  const { pool, shardIndex } = getPoolForCustomer(customerId);
  const { rows } = await pool.query(
    'SELECT * FROM orders WHERE customer_id = $1 ORDER BY order_date DESC LIMIT 200',
    [customerId]
  );
  return { shardIndex, orders: rows };
}

/**
 * GET /orders/:orderId — order_id alone does not reveal its shard (the
 * shard key is customer_id), so this does a scatter-gather across all
 * shards. Documented as a known trade-off of this sharding strategy.
 */
async function getOrderById(orderId) {
  const pools = getAllPools();
  for (const { pool, shardIndex } of pools) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
    if (rows.length > 0) {
      return { shardIndex, order: rows[0] };
    }
  }
  return null;
}

module.exports = {
  batchInsertOrders,
  batchInsertFailedRows,
  getOrdersByCustomer,
  getOrderById,
};
