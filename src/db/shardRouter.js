const { pools } = require('./pool');
const { getShardIndex } = require('../utils/hash');
const config = require('../config/env');

/**
 * Sharding strategy: hash(customer_id) % SHARD_COUNT
 *
 * customer_id is chosen as the shard key (rather than order_id) because:
 *  - Most real-world access patterns for an orders system query "all
 *    orders for a customer", which then becomes a single-shard query
 *    instead of a scatter-gather across every shard.
 *  - customer_id has good cardinality (many distinct customers), so a
 *    hash-based split gives an even distribution of rows and write load
 *    across shards.
 *
 * Trade-off: looking up a single order by order_id alone (without knowing
 * its customer_id) requires a scatter-gather across all shards, since the
 * order_id itself does not encode shard placement. See orderService for
 * the scatter-gather implementation.
 */
function getPoolForCustomer(customerId) {
  const idx = getShardIndex(customerId, config.shardCount);
  return { pool: pools[idx], shardIndex: idx };
}

function getAllPools() {
  return pools.map((pool, shardIndex) => ({ pool, shardIndex }));
}

module.exports = { getPoolForCustomer, getAllPools };
