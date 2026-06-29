'use strict';

const express = require('express');
const router  = express.Router();
const engine  = require('../services/comparisonEngine');
const store   = require('../services/sessionStore');
const jobs    = require('../services/jobManager');
const log     = require('../utils/activityLogger');

const sid = req => req.headers['x-session-id'] || 'default';

// ─── Run comparison (async, returns jobId immediately) ─────────────────────
router.post('/run', async (req, res) => {
  const sessionId = sid(req);
  const { mappings = [], keyColumnInternal = '', keyColumnVendor = '', options = {}, filters = [] } = req.body;

  const intData = store.getFileData(sessionId, 'internal');
  const vndData = store.getFileData(sessionId, 'vendor');
  if (!intData) return res.status(400).json({ error: 'No internal file loaded — upload it first.' });
  if (!vndData) return res.status(400).json({ error: 'No vendor file loaded — upload it first.' });

  // Resolve key columns
  const intKey = keyColumnInternal || _autoKey(intData.columns);
  const vndKey = keyColumnVendor   || _autoKey(vndData.columns);
  if (!intKey) return res.status(400).json({ error: 'Cannot determine internal key column. Please select one in Configure.' });
  if (!vndKey) return res.status(400).json({ error: 'Cannot determine vendor key column. Please select one in Configure.' });

  const columnMapping = (mappings || [])
    .map(m => ({ internal: m.internal || m.internalCol, vendor: m.vendor || m.vendorCol }))
    .filter(m => m.internal && m.vendor);

  const job = jobs.create('comparison', { sessionId });
  log.log({ type: 'info', message: `Job ${job.id}: ${intData.rows.length.toLocaleString()} internal × ${vndData.rows.length.toLocaleString()} vendor rows` });
  log.log({ type: 'info', message: `Comparison started with key columns: Internal="${intKey}" ↔ Vendor="${vndKey}"` });
  res.json({ jobId: job.id });

  setImmediate(async () => {
    const t0 = Date.now();
    try {
      jobs.setRunning(job.id, 'running', 5, 'Starting comparison…');
      const result = await engine.compare(intData, vndData, {
        internalKeyColumns: [intKey],
        vendorKeyColumns:   [vndKey],
        columnMapping,
        caseInsensitive:  options.caseInsensitive !== false,
        trimWhitespace:   options.trimWhitespace  !== false,
        normalizeSpecial: !!options.normalize,
        ignoreColumns:    options.ignoreColumns || [],
        filters,
        jobId: job.id,
      });
      result.summary.durationMs = Date.now() - t0;
      store.setComparisonResult(sessionId, result);
      jobs.setComplete(job.id, { summary: result.summary });
      log.log({ type: 'success', message: `Comparison done — ${result.summary.matched} matched, ${result.summary.missingInVendor} missing, ${result.summary.extraInVendor} extra (${result.summary.durationMs}ms)` });
    } catch (err) {
      jobs.setFailed(job.id, err);
      log.log({ type: 'error', message: `Comparison failed: ${err.message}` });
    }
  });
});

// ─── Poll job ──────────────────────────────────────────────────────────────
router.get('/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── Get paginated results ─────────────────────────────────────────────────
router.get('/results', (req, res) => {
  const sessionId = sid(req);
  const result    = store.getComparisonResult(sessionId);
  if (!result) return res.status(404).json({ error: 'No results yet. Run a comparison first.' });

  const { section = 'summary', page = 1, pageSize = 100, search = '', status = '', col = '' } = req.query;
  const pg    = Math.max(1, parseInt(page));
  const ps    = Math.min(1000, Math.max(1, parseInt(pageSize)));
  const start = (pg - 1) * ps;
  const q     = search.toLowerCase();

  switch (section) {
    case 'summary':
      return res.json(_buildSummary(result));

    case 'detail': {
      let rows = [
        ...(result.matched       || []).map(r => ({ ...r.intRow, _status: r.hasDiffs ? 'mismatch' : 'matched',  _key: r.key, _diffCount: r.diffs?.length || 0, _diffCols: r.diffs?.map(d => d.column).join(', ') || '' })),
        ...(result.missingInVendor || []).map(r => ({ ...r.intRow,  _status: 'missing', _key: r.key, _diffCount: '', _diffCols: '' })),
        ...(result.extraInVendor   || []).map(r => ({ ...r.vndRow,  _status: 'extra',   _key: r.key, _diffCount: '', _diffCols: '' })),
      ];
      if (status) rows = rows.filter(r => r._status === status);
      if (q)      rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q)));
      return res.json({ total: rows.length, page: pg, pageSize: ps, columns: _cols(rows), rows: rows.slice(start, start + ps) });
    }

    case 'matched': {
      let rows = (result.matched || []).filter(m => !m.hasDiffs).map(r => ({ ...r.intRow, _status: 'matched', _key: r.key }));
      if (q) rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q)));
      return res.json({ total: rows.length, page: pg, pageSize: ps, columns: _cols(rows), rows: rows.slice(start, start + ps) });
    }

    case 'missing': {
      let rows = (result.missingInVendor || []).map(r => ({ ...r.intRow, _status: 'missing', _key: r.key }));
      if (q) rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q)));
      return res.json({ total: rows.length, page: pg, pageSize: ps, columns: _cols(rows), rows: rows.slice(start, start + ps) });
    }

    case 'extra': {
      let rows = (result.extraInVendor || []).map(r => ({ ...r.vndRow, _status: 'extra', _key: r.key }));
      if (q) rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q)));
      return res.json({ total: rows.length, page: pg, pageSize: ps, columns: _cols(rows), rows: rows.slice(start, start + ps) });
    }

    case 'diffs': {
      let diffs = result.fieldDiffs || [];
      if (col) diffs = diffs.filter(d => d.column === col);
      if (q)   diffs = diffs.filter(d => String(d.key || '').toLowerCase().includes(q));
      const allCols = [...new Set(diffs.map(d => d.column))].sort();
      const keysAffected = new Set(diffs.map(d => d.key)).size;
      return res.json({
        total: diffs.length, page: pg, pageSize: ps,
        rows: diffs.slice(start, start + ps),
        availableColumns: allCols,
        summary: {
          total: diffs.length, columns: allCols.length, records: keysAffected,
          diffRate: result.matched.length > 0 ? Math.round(keysAffected / result.matched.length * 100) : 0
        }
      });
    }

    case 'schema':
      return res.json(result.schemaComparison || {});

    case 'duplicates': {
      const dups = result.duplicates || {};
      const intDups = (dups.internal || []).map(d => ({ source: 'Internal', key: d.key, count: d.count }));
      const vndDups = (dups.vendor   || []).map(d => ({ source: 'Vendor',   key: d.key, count: d.count }));
      const all = [...intDups, ...vndDups];
      return res.json({ total: all.length, page: pg, pageSize: ps, rows: all.slice(start, start + ps) });
    }

    default:
      return res.status(400).json({ error: `Unknown section: ${section}` });
  }
});

// ─── Suggest mappings ──────────────────────────────────────────────────────
router.post('/suggest-mappings', (req, res) => {
  const sessionId = sid(req);
  const intData = store.getFileData(sessionId, 'internal');
  const vndData = store.getFileData(sessionId, 'vendor');
  if (!intData || !vndData) return res.status(400).json({ error: 'Both files must be loaded first' });

  const mappings = engine.suggestMappings(intData.columns || [], vndData.columns || []);
  const avg = mappings.length ? Math.round(mappings.reduce((s, m) => s + m.confidence, 0) / mappings.length) : 0;
  
  log.log({ type: 'info', message: `Schema mapping detected: ${intData.columns.length} internal × ${vndData.columns.length} vendor columns` });
  log.log({ type: 'success', message: `Column mapping created: ${mappings.length} mappings with ${avg}% average confidence` });
  
  res.json({ mappings, avgConfidence: avg });
});

// ─── Filter values ──────────────────────────────────────────────────────────
router.post('/filter-values', (req, res) => {
  const sessionId = sid(req);
  const { column } = req.body;
  const intData = store.getFileData(sessionId, 'internal');
  const vndData = store.getFileData(sessionId, 'vendor');
  if (!intData && !vndData) return res.status(404).json({ error: 'No files loaded' });

  const values = [...new Set([
    ...(intData ? engine.getDistinctValues(intData.rows, column).map(v => v.value) : []),
    ...(vndData ? engine.getDistinctValues(vndData.rows, column).map(v => v.value) : []),
  ])].slice(0, 500);

  res.json({ column, values });
});

// ─── Category / Brand analysis ─────────────────────────────────────────────
router.post('/brand-analysis', (req, res) => {
  const sessionId = sid(req);
  const { column, vendorColumn, type = 'category', brands, internalColumns, vendorColumns } = req.body;

  const intData = store.getFileData(sessionId, 'internal');
  const vndData = store.getFileData(sessionId, 'vendor');
  if (!intData || !vndData) return res.status(400).json({ error: 'Both files must be loaded' });

  // Brand keyword mode (textarea)
  if (brands && Array.isArray(brands) && brands.length) {
    const iCols = internalColumns?.length ? internalColumns : intData.columns.slice(0, 5);
    const vCols = vendorColumns?.length   ? vendorColumns   : vndData.columns.slice(0, 5);
    const results = brands.map(brand => {
      const re       = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const intCount = intData.rows.filter(r => iCols.some(c => re.test(String(r[c] ?? '')))).length;
      const vndCount = vndData.rows.filter(r => vCols.some(c => re.test(String(r[c] ?? '')))).length;
      const matched  = Math.min(intCount, vndCount);
      const matchPct = intCount > 0 ? Math.round(matched / intCount * 100) : 0;
      return { brand, value: brand, internalCount: intCount, vendorCount: vndCount, matched, diff: intCount - vndCount, matchPct, matchRate: matchPct };
    });
    log.log({ type: 'success', message: `Brand analysis: ${brands.length} brands` });
    return res.json({ type: 'brand', results });
  }

  // Column group-by mode
  if (!column) return res.status(400).json({ error: 'column is required' });
  const vCol = vendorColumn || column;

  const intVals = engine.getDistinctValues(intData.rows, column).map(v => v.value);
  const vndCountMap = {};
  vndData.rows.forEach(r => { const v = String(r[vCol] ?? ''); vndCountMap[v] = (vndCountMap[v] || 0) + 1; });

  const results = intVals.map(val => {
    const v        = String(val);
    const intCount = intData.rows.filter(r => String(r[column] ?? '') === v).length;
    const vndCount = vndCountMap[v] || 0;
    const matched  = Math.min(intCount, vndCount);
    const matchRate = intCount > 0 ? Math.round(matched / intCount * 100) : 0;
    return { value: v, internalCount: intCount, vendorCount: vndCount, matched, missing: Math.max(0, intCount - vndCount), extra: Math.max(0, vndCount - intCount), matchRate };
  }).sort((a, b) => b.internalCount - a.internalCount);

  log.log({ type: 'success', message: `${type} analysis: ${results.length} values` });
  res.json({ column, vendorColumn: vCol, type, results });
});

// ─── Helpers ───────────────────────────────────────────────────────────────
function _autoKey(cols) {
  if (!cols || !cols.length) return null;
  const patterns = ['sku','ean','barcode','upc','id','code','article','item_no','product_code'];
  return cols.find(c => patterns.some(p => c.toLowerCase().replace(/[^a-z0-9]/g, '').includes(p))) || null;
}

function _buildSummary(result) {
  const s = result.summary;
  return {
    summary: {
      totalInternal:    s.totalInternal,
      totalVendor:      s.totalVendor,
      matched:          result.matched.length,
      matchedExact:     result.matched.filter(m => !m.hasDiffs).length,
      mismatched:       result.matched.filter(m => m.hasDiffs).length,
      missingInVendor:  result.missingInVendor.length,
      extraInVendor:    result.extraInVendor.length,
      fieldDifferences: result.fieldDiffs.length,
      withDifferences:  result.matched.filter(m => m.hasDiffs).length,
      duplicates:       s.duplicates || 0,
      duplicatesInternal: s.duplicatesInternal || 0,
      duplicatesVendor:   s.duplicatesVendor   || 0,
      matchRate:        s.matchRate,
      durationMs:       s.durationMs,
      chunksUsed:       s.chunksUsed,
      topDiffColumns:   (result.analytics?.topDiffColumns || []).map(d => ({ column: d.column, count: d.count })),
      schemaSummary:    s.schemaSummary || null,
    },
    schema: result.schemaComparison
  };
}

function _cols(rows) {
  if (!rows.length) return [];
  return Object.keys(rows[0]).filter(k => !k.startsWith('_')).slice(0, 25);
}

module.exports = router;
