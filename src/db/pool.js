const { Pool } = require('pg');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Builds one connection Pool per shard.
 *
 * Either:
 *  - SHARD_URLS is set: one full connection string per shard (comma
 *    separated), OR
 *  - falls back to DB_HOST/DB_USER/DB_PASSWORD + a generated database name
 *    "<DB_NAME_PREFIX>_<index>" for each shard (all shards on one server,
 *    which is the common local-dev / single-host setup).
 */
function buildPools() {
  const pools = [];

  for (let i = 0; i < config.shardCount; i++) {
    let poolConfig;

    if (config.shardUrls && config.shardUrls[i]) {
      poolConfig = { connectionString: config.shardUrls[i] };
    } else {
      poolConfig = {
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: `${config.db.namePrefix}_${i}`,
      };
    }

    const pool = new Pool({
      ...poolConfig,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logger.error(`Unexpected error on idle client for shard ${i}`, { error: err.message });
    });

    pools.push(pool);
  }

  logger.info(`Initialized ${pools.length} shard connection pool(s)`);
  return pools;
}

const pools = buildPools();

async function healthCheckAll() {
  const results = [];
  for (let i = 0; i < pools.length; i++) {
    try {
      await pools[i].query('SELECT 1');
      results.push({ shard: i, status: 'ok' });
    } catch (err) {
      results.push({ shard: i, status: 'error', error: err.message });
    }
  }
  return results;
}

async function closeAll() {
  await Promise.all(pools.map((p) => p.end()));
}

module.exports = { pools, healthCheckAll, closeAll };
