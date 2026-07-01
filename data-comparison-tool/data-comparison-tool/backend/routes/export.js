'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs-extra');
const store   = require('../services/sessionStore');
const gen     = require('../services/reportGenerator');
const log     = require('../utils/activityLogger');

const sid = req => req.headers['x-session-id'] || 'default';

// ─── Generate report ───────────────────────────────────────────────────────
router.post('/generate', async (req, res) => {
  const result = store.getComparisonResult(sid(req));
  if (!result) return res.status(400).json({ error: 'No comparison results. Run a comparison first.' });

  const { format = 'excel', section = 'all' } = req.body;
  const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `comparison_${section}_${ts}`;

  log.log({ type: 'info', message: `Generating ${format.toUpperCase()} report (${section})…` });
  try {
    let filePath, filename;

    if (format === 'excel') {
      filename = baseName + '.xlsx';
      const sessionId = sid(req);
      const internalData = store.getFileData(sessionId, 'internal');
      const vendorData = store.getFileData(sessionId, 'vendor');
      const azureData = [internalData, vendorData].filter(Boolean).filter(d => d.azureSource).map(d => ({
        filename: d.filename || d.originalName || 'Azure File',
        azureSource: d.azureSource,
        rows: Array.isArray(d.rows) ? d.rows : []
      }));
      filePath = await gen.generateExcel(result, filename, { internalData, vendorData, azureData });
    } else if (format === 'pdf') {
      filename = baseName + '.pdf';
      filePath = await gen.generatePdf(result, filename);
    } else if (format === 'csv') {
      filename = baseName + '.csv';
      let csvData = [];
      if (section === 'missing')  csvData = (result.missingInVendor || []).map(m => ({ _status: 'Missing', Key: m.key, ...m.intRow }));
      else if (section === 'extra') csvData = (result.extraInVendor || []).map(m => ({ _status: 'Extra',   Key: m.key, ...m.vndRow }));
      else if (section === 'diffs') csvData = (result.fieldDiffs    || []).map(d => ({ RecordKey: d.key, Column: d.column, InternalValue: d.internalValue, VendorValue: d.vendorValue }));
      else csvData = (result.matched || []).map(m => ({ _status: m.hasDiffs ? 'Mismatch' : 'Matched', Key: m.key, ...m.intRow }));
      if (!csvData.length) return res.status(400).json({ error: 'No data to export for this section' });
      filePath = await gen.generateCsv(csvData, filename);
    } else {
      return res.status(400).json({ error: `Unsupported format: ${format}` });
    }

    log.log({ type: 'success', message: `Report ready: ${filename}` });
    res.json({ success: true, filename, format, section });
  } catch (err) {
    log.log({ type: 'error', message: `Export failed: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

// ─── List reports ─────────────────────────────────────────────────────────
router.get('/list', async (req, res) => {
  try {
    const reports = await gen.listReports();
    res.json({ reports });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Download report ──────────────────────────────────────────────────────
router.get('/download/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(process.env.OUTPUT_DIR || './outputs', filename);
  if (!await fs.pathExists(filePath)) return res.status(404).json({ error: 'File not found' });

  const ext = path.extname(filename).toLowerCase();
  const mime = { '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pdf': 'application/pdf', '.csv': 'text/csv' };
  res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ─── Delete report ────────────────────────────────────────────────────────
router.delete('/:filename', async (req, res) => {
  try {
    await gen.deleteReport(path.basename(req.params.filename));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
