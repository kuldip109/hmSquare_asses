const crypto = require('crypto');

/**
 * Deterministically maps a string key to a shard index in [0, shardCount).
 * Uses MD5 for speed (not for security) and takes the first 4 bytes as an
 * unsigned 32-bit integer before modulo-ing by the shard count. This gives
 * a good, stable distribution across shards for arbitrary string keys.
 */
function getShardIndex(key, shardCount) {
  if (!key) {
    throw new Error('Shard key must be a non-empty string');
  }
  const hash = crypto.createHash('md5').update(String(key)).digest();
  const num = hash.readUInt32BE(0);
  return num % shardCount;
}

module.exports = { getShardIndex };
