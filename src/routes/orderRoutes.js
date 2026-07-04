const express = require('express');
const orderService = require('../services/orderService');

const router = express.Router();

/**
 * GET /orders?customerId=abc123
 * Single-shard read (fast path — customer_id is the shard key).
 */
router.get('/orders', async (req, res, next) => {
  try {
    const { customerId } = req.query;
    if (!customerId) {
      return res.status(400).json({ error: 'customerId query parameter is required' });
    }
    const result = await orderService.getOrdersByCustomer(customerId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /orders/:orderId
 * Scatter-gather across all shards (see orderService for the trade-off
 * explanation — order_id doesn't encode shard placement under this
 * customer_id-based sharding strategy).
 */
router.get('/orders/:orderId', async (req, res, next) => {
  try {
    const result = await orderService.getOrderById(req.params.orderId);
    if (!result) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
