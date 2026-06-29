const express = require('express');
const router = express.Router();
const activityLogger = require('../utils/activityLogger');

// SSE stream for real-time updates
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Keep alive ping
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { clearInterval(ping); }
  }, 25000);

  activityLogger.addClient(res);
  res.on('close', () => clearInterval(ping));
});

// Get activity history
router.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ activities: activityLogger.getAll(limit) });
});

// Clear activity log
router.delete('/logs', (req, res) => {
  activityLogger.clear();
  res.json({ success: true });
});

// Manual notification (for testing)
router.post('/notify', (req, res) => {
  const { type = 'system', title, message, level = 'info' } = req.body;
  activityLogger.notify(type, title, message, level);
  res.json({ success: true });
});

module.exports = router;
