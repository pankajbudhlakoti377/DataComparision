const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs-extra');
const azureStorage  = require('../services/azureStorage');
const fileParser    = require('../services/fileParser');
const sessionStore  = require('../services/sessionStore');
const activityLogger = require('../utils/activityLogger');

// ─── Connect ──────────────────────────────────────────────────────────────────
router.post('/connect', async (req, res) => {
  const { connectionString, accountName, accountKey } = req.body;
  if (!connectionString && (!accountName || !accountKey)) {
    return res.status(400).json({ error: 'Provide connectionString or both accountName and accountKey' });
  }
  try {
    activityLogger.log({ type: 'info', message: 'Connecting to Azure Storage…' });
    const result = await azureStorage.connect(connectionString, accountName, accountKey);
    activityLogger.log({ type: 'success', message: `Azure connected: ${result.accountName}` });
    res.json(result);
  } catch (err) {
    activityLogger.log({ type: 'error', message: `Azure connection failed: ${err.message}` });
    res.status(400).json({ error: err.message });
  }
});

// ─── Status / connection info ─────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json(azureStorage.getInfo());
});

// ─── Disconnect ───────────────────────────────────────────────────────────────
router.post('/disconnect', (req, res) => {
  azureStorage.disconnect();
  activityLogger.log({ type: 'info', message: 'Azure Storage disconnected' });
  res.json({ success: true });
});

// ─── List containers ──────────────────────────────────────────────────────────
router.get('/containers', async (req, res) => {
  try {
    const containers = await azureStorage.listContainers();
    res.json({ containers, accountName: azureStorage.accountName });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── List folders + root files (lazy hierarchy, one level at a time) ──────────
// GET /api/azure/folders/:container?prefix=some/path/
router.get('/folders/:container', async (req, res) => {
  const { container } = req.params;
  const prefix = req.query.prefix || '';
  try {
    const data = await azureStorage.listFolders(container, prefix);
    res.json({ container, prefix, ...data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── List blobs flat in a container/prefix ────────────────────────────────────
// GET /api/azure/blobs/:container?prefix=some/folder/
router.get('/blobs/:container', async (req, res) => {
  const { container } = req.params;
  const prefix = req.query.prefix || '';
  try {
    const blobs = await azureStorage.listBlobs(container, prefix);
    res.json({ container, prefix, blobs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Blob count for a container/prefix ───────────────────────────────────────
router.get('/count/:container', async (req, res) => {
  const { container } = req.params;
  const prefix = req.query.prefix || '';
  try {
    const count = await azureStorage.getBlobCount(container, prefix);
    res.json({ container, prefix, count });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Load a blob into the session ─────────────────────────────────────────────
// Accepts both { blob } and { blobName } for backwards compat
router.post('/load', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || 'default';
  const { container, side } = req.body;
  const blobName = req.body.blobName || req.body.blob;

  if (!['internal', 'vendor'].includes(side)) {
    return res.status(400).json({ error: 'side must be "internal" or "vendor"' });
  }
  if (!container || !blobName) {
    return res.status(400).json({ error: 'container and blob are required' });
  }

  try {
    activityLogger.log({ type: 'info', message: `Loading ${side} file: ${container}/${blobName}` });

    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const localPath = path.join(uploadDir, sessionId, `azure_${Date.now()}_${path.basename(blobName)}`);
    await fs.ensureDir(path.dirname(localPath));

    await azureStorage.downloadBlob(container, blobName, localPath);

    const parsed     = await fileParser.parse(localPath);
    const keyColumns = fileParser.detectKeyColumns(parsed.columns);
    const columnStats = fileParser.getColumnStats(parsed.rows, parsed.columns);
    const columnTypes = fileParser.inferColumnTypes(parsed.rows, parsed.columns);
    const stat        = await fs.stat(localPath);

    const fileData = {
      filePath:     localPath,
      filename:     path.basename(blobName),
      originalName: path.basename(blobName),
      azureSource:  `${container}/${blobName}`,
      container,
      blobPath:     blobName,
      size:         stat.size,
      rows:         parsed.rows.length,
      rowCount:     parsed.rows.length,
      columns:      parsed.columns,
      columnTypes,
      columnStats,
      keyColumns,
      meta:         parsed.meta,
      uploadedAt:   new Date().toISOString()
    };

    // Store rows in session (needed for comparison)
    sessionStore.setFileData(sessionId, side, { ...fileData, rows: parsed.rows });

    activityLogger.log({ type: 'success', message: `Loaded ${path.basename(blobName)}: ${parsed.rows.length.toLocaleString()} rows` });

    // Return without rows (too large)
    const { rows: _rows, ...responseData } = fileData;
    res.json({ success: true, side, ...responseData });
  } catch (err) {
    activityLogger.log({ type: 'error', message: `Azure load failed: ${err.message}` });
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
