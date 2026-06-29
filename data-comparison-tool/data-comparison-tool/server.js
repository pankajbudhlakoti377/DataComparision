require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs-extra');

const logger = require('./backend/utils/logger');
const { errorHandler, notFound } = require('./backend/middleware/errorHandler');

// Routes
const uploadRoutes = require('./backend/routes/upload');
const comparisonRoutes = require('./backend/routes/comparison');
const exportRoutes = require('./backend/routes/export');
const azureRoutes = require('./backend/routes/azure');
const activityRoutes = require('./backend/routes/activity');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure directories exist
['uploads', 'outputs', 'logs'].forEach(d => fs.ensureDirSync(d));

// Security & performance
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors({
  origin: true,
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Logging
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) }
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'frontend')));

// API Routes
app.use('/api/files', uploadRoutes);
app.use('/api/comparison', comparisonRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/azure', azureRoutes);
app.use('/api/activity', activityRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Serve index.html for all non-API routes (SPA)
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
  }
});

// Error handling
app.use(notFound);
app.use(errorHandler);

// Start server
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Data Comparison Tool v2.0 running at http://localhost:${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

module.exports = app;
