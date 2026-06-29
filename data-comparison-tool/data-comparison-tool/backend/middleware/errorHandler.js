const logger = require('../utils/logger');
const activityLogger = require('../utils/activityLogger');

function errorHandler(err, req, res, next) {
  logger.error(`${req.method} ${req.path} - ${err.message}`, { stack: err.stack });

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    const maxMB = process.env.MAX_FILE_SIZE_MB || 500;
    return res.status(413).json({ error: `File too large. Maximum size is ${maxMB}MB.` });
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Unexpected file field.' });
  }

  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  if (status === 500) {
    activityLogger.error('system', `Server error: ${message}`);
  }

  res.status(status).json({ error: message });
}

function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}

module.exports = { errorHandler, notFound };
