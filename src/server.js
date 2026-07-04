const app = require('./app');
const config = require('./config/env');
const logger = require('./utils/logger');
const { closeAll } = require('./db/pool');

const server = app.listen(config.port, () => {
  logger.info(`Server listening on port ${config.port} (${config.nodeEnv})`);
  logger.info(`Configured for ${config.shardCount} shard(s)`);
});

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    await closeAll();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
