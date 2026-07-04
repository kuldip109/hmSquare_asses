const logger = require('../utils/logger');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  logger.error('Unhandled request error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
  });

  if (err.message && err.message.includes('File too large')) {
    return res.status(413).json({ error: 'File too large' });
  }

  res.status(err.status || 500).json({
    error: err.publicMessage || 'Internal server error',
  });
}

module.exports = { notFoundHandler, errorHandler };
