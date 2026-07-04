const express = require('express');
const { healthCheckAll } = require('../db/pool');
const jobService = require('../services/jobService');

const router = express.Router();

router.get('/health', async (req, res) => {
  const shards = await healthCheckAll();
  const allOk = shards.every((s) => s.status === 'ok');
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    shards,
    timestamp: new Date().toISOString(),
  });
});

router.get('/metrics', (req, res) => {
  res.json(jobService.getMetrics());
});

module.exports = router;
