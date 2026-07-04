const express = require('express');
const logger = require('./utils/logger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const uploadRoutes = require('./routes/uploadRoutes');
const orderRoutes = require('./routes/orderRoutes');
const healthRoutes = require('./routes/healthRoutes');

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.originalUrl}`);
  next();
});

app.use('/', uploadRoutes);
app.use('/', orderRoutes);
app.use('/', healthRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
