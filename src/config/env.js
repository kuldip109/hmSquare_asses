require('dotenv').config();

function requireEnv(name, fallback) {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    namePrefix: process.env.DB_NAME_PREFIX || 'orders_shard',
  },

  shardCount: parseInt(process.env.SHARD_COUNT || '4', 10),
  shardUrls: process.env.SHARD_URLS
    ? process.env.SHARD_URLS.split(',').map((s) => s.trim())
    : null,

  gcp: {
    projectId: process.env.GCP_PROJECT_ID,
    bucketName: requireEnv('GCS_BUCKET_NAME', 'orders-bucket-placeholder'),
  },

  batchSize: parseInt(process.env.BATCH_SIZE || '500', 10),
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
};

module.exports = config;
