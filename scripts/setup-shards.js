/**
 * Creates the N shard databases (if they don't exist) and applies the
 * schema migration to each one. Safe to re-run (idempotent).
 *
 * Usage: npm run setup:shards
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require('../src/config/env');

const migrationSql = fs.readFileSync(
  path.join(__dirname, '../migrations/001_init_shard.sql'),
  'utf8'
);

async function ensureDatabaseExists(dbName) {
  // Connect to the default "postgres" maintenance database to issue CREATE DATABASE.
  const adminClient = new Client({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: 'postgres',
  });

  await adminClient.connect();
  try {
    const { rows } = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName]
    );
    if (rows.length === 0) {
      // CREATE DATABASE cannot be parameterized; dbName is generated
      // internally from a config prefix + integer index, never from
      // user input, so this is safe.
      await adminClient.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database: ${dbName}`);
    } else {
      console.log(`Database already exists: ${dbName}`);
    }
  } finally {
    await adminClient.end();
  }
}

async function applyMigration({ connectionString, dbName }) {
  const client = connectionString
    ? new Client({ connectionString })
    : new Client({
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: dbName,
      });

  await client.connect();
  try {
    await client.query(migrationSql);
    console.log(`Applied migration to: ${connectionString || dbName}`);
  } finally {
    await client.end();
  }
}

async function main() {
  if (config.shardUrls) {
    console.log(
      'SHARD_URLS is set — assuming shard databases already exist on their ' +
      'respective hosts. This script only auto-creates databases for the ' +
      'DB_HOST/DB_NAME_PREFIX pattern. Applying migrations only.'
    );
  }

  for (let i = 0; i < config.shardCount; i++) {
    const dbName = `${config.db.namePrefix}_${i}`;
    if (!config.shardUrls) {
      await ensureDatabaseExists(dbName);
    }
    await applyMigration(
      config.shardUrls ? { connectionString: config.shardUrls[i] } : { dbName }
    );
  }

  console.log('All shards are set up.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Shard setup failed:', err);
  process.exit(1);
});
