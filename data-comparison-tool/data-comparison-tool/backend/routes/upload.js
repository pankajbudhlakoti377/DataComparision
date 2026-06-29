const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const fileParser = require('../services/fileParser');
const sessionStore = require('../services/sessionStore');
const activityLogger = require('../utils/activityLogger');

const uploadDir = process.env.UPLOAD_DIR || './uploads';
fs.ensureDirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  destination: (req, file, cb) => {
    const sessionId = req.headers['x-session-id'] || 'default';
    const dir = path.join(uploadDir, sessionId);
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}_${uuidv4().slice(0, 8)}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.csv', '.xlsx', '.xls', '.xlsm', '.tsv', '.txt', '.zip'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${ext}. Allowed: ${allowed.join(', ')}`));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 500) * 1024 * 1024 }
});

// Upload file for internal or vendor side
router.post('/upload/:side', upload.single('file'), async (req, res) => {
  const { side } = req.params;
  const sessionId = req.headers['x-session-id'] || 'default';

  if (!['internal', 'vendor'].includes(side)) {
    return res.status(400).json({ error: 'side must be "internal" or "vendor"' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  activityLogger.info('upload', `Uploading ${side} file: ${req.file.originalname}`, {
    filename: req.file.originalname,
    size: req.file.size,
    side
  });

  try {
    const options = {
      sheetName: req.body.sheetName,
      zipEntry: req.body.zipEntry
    };

    const parsed = await fileParser.parse(req.file.path, options);
    const keyColumns = fileParser.detectKeyColumns(parsed.columns);
    const columnStats = fileParser.getColumnStats(parsed.rows, parsed.columns);
    const columnTypes = fileParser.inferColumnTypes(parsed.rows, parsed.columns);

    const fileData = {
      filePath: req.file.path,
      originalName: req.file.originalname,
      size: req.file.size,
      columns: parsed.columns,
      rows: parsed.rows,
      meta: parsed.meta,
      keyColumns,
      columnStats,
      columnTypes,
      uploadedAt: new Date().toISOString()
    };

    sessionStore.setFileData(sessionId, side, fileData);

    activityLogger.success('upload', `${side} file loaded: ${req.file.originalname} (${parsed.rows.length.toLocaleString()} rows)`, {
      rows: parsed.rows.length,
      columns: parsed.columns.length
    });

    activityLogger.notify('upload', 'File Loaded',
      `${side === 'internal' ? 'Internal' : 'Vendor'} file "${req.file.originalname}" loaded with ${parsed.rows.length.toLocaleString()} rows`,
      'success'
    );

    res.json({
      success: true,
      side,
      filename: req.file.originalname,
      originalName: req.file.originalname,
      storedPath: req.file.path,
      size: req.file.size,
      rows: parsed.rows.length,
      rowCount: parsed.rows.length,
      columns: parsed.columns,
      schema: {
        columns: parsed.columns,
        totalRows: parsed.rows.length
      },
      meta: parsed.meta,
      keyColumns,
      columnStats,
      columnTypes,
      preview: {
        schema: parsed.columns,
        rows: parsed.rows.slice(0, 10),
        totalRows: parsed.rows.length
      }
    });
  } catch (err) {
    // Clean up on error
    await fs.remove(req.file.path).catch(() => {});
    activityLogger.error('upload', `Failed to parse ${side} file: ${err.message}`);
    activityLogger.notify('upload', 'Upload Failed', err.message, 'error');
    res.status(400).json({ error: err.message });
  }
});

// Upload multiple files (will be merged)
router.post('/upload-multi/:side', upload.array('files', 10), async (req, res) => {
  const { side } = req.params;
  const sessionId = req.headers['x-session-id'] || 'default';

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }

  try {
    let allRows = [];
    let columns = [];
    const metaList = [];

    for (const file of req.files) {
      const parsed = await fileParser.parse(file.path);
      if (columns.length === 0) columns = parsed.columns;
      allRows = allRows.concat(parsed.rows);
      metaList.push({ filename: file.originalname, rows: parsed.rows.length, meta: parsed.meta });
    }

    const fileData = {
      filePath: req.files[0].path,
      originalName: req.files.map(f => f.originalname).join(', '),
      size: req.files.reduce((sum, f) => sum + f.size, 0),
      columns,
      rows: allRows,
      meta: { format: 'multi', files: metaList, totalRows: allRows.length },
      keyColumns: fileParser.detectKeyColumns(columns),
      columnStats: fileParser.getColumnStats(allRows, columns),
      columnTypes: fileParser.inferColumnTypes(allRows, columns),
      uploadedAt: new Date().toISOString()
    };

    sessionStore.setFileData(sessionId, side, fileData);

    activityLogger.success('upload', `${side} multi-file loaded: ${allRows.length.toLocaleString()} total rows from ${req.files.length} files`);

    res.json({
      success: true,
      side,
      files: metaList,
      rows: allRows.length,
      columns,
      preview: allRows.slice(0, 5)
    });
  } catch (err) {
    activityLogger.error('upload', `Multi-upload failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// Get session status
router.get('/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const status = sessionStore.getStatus(sessionId);
  const internal = sessionStore.getFileData(sessionId, 'internal');
  const vendor = sessionStore.getFileData(sessionId, 'vendor');

  res.json({
    ...status,
    internal: internal ? {
      filename: internal.originalName,
      rows: internal.rows.length,
      columns: internal.columns,
      uploadedAt: internal.uploadedAt
    } : null,
    vendor: vendor ? {
      filename: vendor.originalName,
      rows: vendor.rows.length,
      columns: vendor.columns,
      uploadedAt: vendor.uploadedAt
    } : null
  });
});

// Get file info for a side
router.get('/info/:side', (req, res) => {
  const sessionId = req.headers['x-session-id'] || 'default';
  const data = sessionStore.getFileData(sessionId, req.params.side);
  if (!data) return res.status(404).json({ error: 'No file loaded for this side' });

  res.json({
    filename: data.originalName,
    originalName: data.originalName,
    size: data.size || 0,
    rows: data.rows.length,
    rowCount: data.rows.length,
    columns: data.columns,
    meta: data.meta,
    keyColumns: data.keyColumns,
    columnStats: data.columnStats,
    columnTypes: data.columnTypes,
    preview: data.rows.slice(0, 20)
  });
});

// Get column distinct values for filter UI
router.post('/column-values', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || 'default';
  const { side, column, limit = 500 } = req.body;

  const data = sessionStore.getFileData(sessionId, side);
  if (!data) return res.status(404).json({ error: 'No file loaded for this side' });

  const comparisonEngine = require('../services/comparisonEngine');
  const values = comparisonEngine.getDistinctValues(data.rows, column, limit);
  res.json({ column, side, values });
});

// Clear session
router.delete('/session/:sessionId', (req, res) => {
  sessionStore.clearSession(req.params.sessionId);
  activityLogger.info('session', 'Session cleared');
  res.json({ success: true });
});

module.exports = router;
