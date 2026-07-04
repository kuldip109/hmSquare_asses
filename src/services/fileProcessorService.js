const fs = require('fs');
const csvParser = require('csv-parser');
const config = require('../config/env');
const logger = require('../utils/logger');
const { validateOrderRow } = require('../validators/orderValidator');
const { getPoolForCustomer, getAllPools } = require('../db/shardRouter');
const { batchInsertOrders, batchInsertFailedRows } = require('./orderService');
const jobService = require('./jobService');

/**
 * Streams the uploaded CSV file row by row (requirement 5: "The full file
 * should not be loaded into memory at once").
 *
 * Rows are validated, routed to a shard by hash(customer_id), and
 * accumulated into one buffer PER SHARD. Whenever any shard's buffer
 * reaches BATCH_SIZE, that shard's buffer is flushed with a single
 * multi-row transactional INSERT. The source stream is paused while a
 * flush is in-flight so memory usage stays bounded regardless of file
 * size, and resumed once the flush completes (backpressure).
 */
async function processOrdersFile(filePath, jobId) {
  jobService.updateJob(jobId, { status: 'processing' });

  const shardBuffers = new Map(); // shardIndex -> { pool, orders: [] }
  // Failed rows have no reliable shard key (e.g. customer_id itself may be
  // missing/invalid), so they always land in a fixed "home" shard (shard 0)
  // for a single, predictable place to inspect them, rather than being
  // scattered based on insertion order.
  const failedHomePool = getAllPools()[0].pool;
  const failedBuffer = { rows: [] };
  let totalRows = 0;
  let insertedRows = 0;
  let failedRows = 0;
  let pendingFlushes = 0;

  const stream = fs.createReadStream(filePath).pipe(csvParser());

  await new Promise((resolve, reject) => {
    stream.on('data', (row) => {
      totalRows++;

      const result = validateOrderRow(row);

      if (!result.valid) {
        failedRows++;
        failedBuffer.rows.push({ raw: row, error: result.error });
        maybeFlushFailed(false);
        return;
      }

      const { pool, shardIndex } = getPoolForCustomer(result.order.customer_id);
      if (!shardBuffers.has(shardIndex)) {
        shardBuffers.set(shardIndex, { pool, orders: [] });
      }
      const buffer = shardBuffers.get(shardIndex);
      buffer.orders.push(result.order);

      if (buffer.orders.length >= config.batchSize) {
        flushShard(shardIndex, false);
      }
    });

    stream.on('end', async () => {
      try {
        // Flush any remaining partial batches.
        for (const shardIndex of shardBuffers.keys()) {
          await flushShardAsync(shardIndex);
        }
        await flushFailedAsync();
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    stream.on('error', (err) => reject(err));

    // --- helpers that close over the stream to implement backpressure ---

    function flushShard(shardIndex, awaited) {
      const buffer = shardBuffers.get(shardIndex);
      const batch = buffer.orders.splice(0, buffer.orders.length);
      if (batch.length === 0) return;

      stream.pause();
      pendingFlushes++;

      batchInsertOrders(buffer.pool, batch, jobId)
        .then((count) => {
          insertedRows += count;
        })
        .catch((err) => {
          logger.error('Shard batch insert error', { shardIndex, error: err.message });
        })
        .finally(() => {
          pendingFlushes--;
          if (pendingFlushes === 0) stream.resume();
        });
    }

    async function flushShardAsync(shardIndex) {
      const buffer = shardBuffers.get(shardIndex);
      const batch = buffer.orders.splice(0, buffer.orders.length);
      if (batch.length === 0) return;
      const count = await batchInsertOrders(buffer.pool, batch, jobId);
      insertedRows += count;
    }

    function maybeFlushFailed() {
      if (failedBuffer.rows.length >= config.batchSize) {
        stream.pause();
        pendingFlushes++;
        const batch = failedBuffer.rows.splice(0, failedBuffer.rows.length);
        batchInsertFailedRows(failedHomePool, batch, jobId)
          .catch((err) => logger.error('Failed-row flush error', { error: err.message }))
          .finally(() => {
            pendingFlushes--;
            if (pendingFlushes === 0) stream.resume();
          });
      }
    }

    async function flushFailedAsync() {
      const batch = failedBuffer.rows.splice(0, failedBuffer.rows.length);
      if (batch.length === 0) return;
      await batchInsertFailedRows(failedHomePool, batch, jobId);
    }
  });

  jobService.updateJob(jobId, {
    status: 'completed',
    totalRows,
    insertedRows,
    failedRows,
  });

  logger.info('File processing completed', { jobId, totalRows, insertedRows, failedRows });

  return { totalRows, insertedRows, failedRows };
}

module.exports = { processOrdersFile };
