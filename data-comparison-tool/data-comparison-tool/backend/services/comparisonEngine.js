'use strict';

const logger = require('../utils/logger');
const activityLogger = require('../utils/activityLogger');

class ComparisonEngine {
  // ─── Main Comparison ───────────────────────────────────────────────────────
  async compare(internalData, vendorData, config = {}) {
    const {
      internalKeyColumns = [],
      vendorKeyColumns   = [],
      columnMapping      = [],
      ignoreColumns      = [],
      caseInsensitive    = true,
      trimWhitespace     = true,
      normalizeSpecial   = false,
      filters            = [],
      chunkSize          = 50000,
      jobId
    } = config;

    const t0 = Date.now();
    this._progress(jobId, 5, 'Initialising…');

    if (!internalKeyColumns.length) throw new Error('Internal key column required. Set it in Configure → Primary Key Selection.');
    if (!vendorKeyColumns.length)   throw new Error('Vendor key column required. Set it in Configure → Primary Key Selection.');

    // Apply pre-comparison filters
    let intRows = this._applyFilters(internalData.rows, filters);
    let vndRows = this._applyFilters(vendorData.rows,   filters);
    this._progress(jobId, 12, `Filters applied: ${intRows.length.toLocaleString()} × ${vndRows.length.toLocaleString()} rows`);

    // Build normaliser
    const norm = (v) => {
      if (v == null) return '';
      let s = String(v);
      if (trimWhitespace)    s = s.trim();
      if (caseInsensitive)   s = s.toLowerCase();
      // Remove special characters but preserve spaces - normalize accents first, then remove non-word chars (keeping spaces)
      if (normalizeSpecial)  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
      return s;
    };

    const buildKey = (row, cols) => cols.map(c => norm(row[c] ?? '')).join('\x00');

    // Build mapping lookup: internalCol → vendorCol
    const mapLookup = {};
    (columnMapping || []).forEach(m => {
      const ic = m.internal || m.internalCol;
      const vc = m.vendor   || m.vendorCol;
      if (ic && vc) mapLookup[ic] = vc;
    });
    const ignoreSet = new Set((ignoreColumns || []).map(c => c.toLowerCase()));

    this._progress(jobId, 20, 'Building key indices…');

    // Index vendor rows
    const vndMap = new Map();
    for (const row of vndRows) {
      const k = buildKey(row, vendorKeyColumns);
      if (!vndMap.has(k)) vndMap.set(k, []);
      vndMap.get(k).push(row);
    }

    // Index internal rows (for duplicate detection)
    const intMap = new Map();
    for (const row of intRows) {
      const k = buildKey(row, internalKeyColumns);
      if (!intMap.has(k)) intMap.set(k, []);
      intMap.get(k).push(row);
    }

    // Determine columns to diff
    const intCols = internalData.columns.filter(c => !ignoreSet.has(c.toLowerCase()));

    this._progress(jobId, 30, 'Matching records…');

    const matched       = [];
    const missingInVendor = [];
    const fieldDiffs    = [];
    const dupInternal   = [];
    const dupVendor     = [];

    // Detect duplicates
    for (const [k, rows] of intMap) if (rows.length > 1) dupInternal.push({ key: k, count: rows.length });
    for (const [k, rows] of vndMap) if (rows.length > 1) dupVendor.push({ key: k, count: rows.length });

    // Chunk process internal rows
    const totalChunks = Math.ceil(intRows.length / chunkSize);
    const matchedKeys  = new Set();

    for (let chunk = 0; chunk < totalChunks; chunk++) {
      const pct = 30 + Math.floor((chunk / totalChunks) * 50);
      this._progress(jobId, pct, `Matching chunk ${chunk + 1}/${totalChunks}…`);

      const start = chunk * chunkSize;
      const end   = Math.min(start + chunkSize, intRows.length);

      for (let i = start; i < end; i++) {
        const intRow = intRows[i];
        const key    = buildKey(intRow, internalKeyColumns);
        const vndArr = vndMap.get(key);

        if (!vndArr) {
          missingInVendor.push({ key, intRow, _row: intRow });
        } else {
          matchedKeys.add(key);
          const vndRow = vndArr[0];
          const diffs  = this._diffFields(intRow, vndRow, intCols, mapLookup, norm, ignoreSet);
          matched.push({ key, intRow, vndRow, _internalRow: intRow, hasDiffs: diffs.length > 0, diffs });
          diffs.forEach(d => fieldDiffs.push({ ...d, key }));
        }
      }
      await new Promise(r => setImmediate(r));
    }

    this._progress(jobId, 83, 'Finding extra vendor records…');

    const extraInVendor = [];
    for (const [key, rows] of vndMap) {
      if (!matchedKeys.has(key)) {
        extraInVendor.push({ key, vndRow: rows[0], _row: rows[0] });
      }
    }

    this._progress(jobId, 90, 'Computing analytics…');
    const schemaComparison = this._compareSchemas(internalData.columns, vendorData.columns, columnMapping);
    const analytics        = this._analytics(matched, missingInVendor, extraInVendor, fieldDiffs, intRows.length, vndRows.length);

    const elapsedMs  = Date.now() - t0;
    const matchedCnt = matched.filter(m => !m.hasDiffs).length;
    const totalInt   = intRows.length;

    this._progress(jobId, 100, 'Complete!');

    return {
      summary: {
        totalInternal:    totalInt,
        totalVendor:      vndRows.length,
        matched:          matched.length,
        matchedExact:     matchedCnt,
        mismatched:       matched.filter(m => m.hasDiffs).length,
        missingInVendor:  missingInVendor.length,
        extraInVendor:    extraInVendor.length,
        fieldDifferences: fieldDiffs.length,
        withDifferences:  matched.filter(m => m.hasDiffs).length,
        duplicatesInternal: dupInternal.length,
        duplicatesVendor:   dupVendor.length,
        duplicates:         dupInternal.length + dupVendor.length,
        matchRate:        totalInt > 0 ? ((matched.length / totalInt) * 100).toFixed(2) : '0.00',
        elapsedMs,
        rowsPerSec:       Math.round((totalInt + vndRows.length) / ((elapsedMs || 1) / 1000)),
        chunksUsed:       totalChunks,
        timestamp:        new Date().toISOString(),
        durationMs:       elapsedMs,
        topDiffColumns:   analytics.topDiffColumns,
        schemaSummary: {
          common:       (schemaComparison.common || []).length,
          internalOnly: (schemaComparison.internalOnly || []).length,
          vendorOnly:   (schemaComparison.vendorOnly || []).length,
        }
      },
      matched,
      missingInVendor,
      extraInVendor,
      fieldDiffs,
      duplicates: { internal: dupInternal, vendor: dupVendor },
      schemaComparison,
      analytics,
      config: { internalKeyColumns, vendorKeyColumns, columnMapping, ignoreColumns, caseInsensitive, trimWhitespace, normalizeSpecial }
    };
  }

  // ─── Field-level diff ──────────────────────────────────────────────────────
  _diffFields(intRow, vndRow, intCols, mapLookup, norm, ignoreSet) {
    const diffs = [];
    for (const ic of intCols) {
      if (ignoreSet.has(ic.toLowerCase())) continue;
      const vc = mapLookup[ic] || ic;
      const hasVndCol = vc in vndRow || ic in vndRow;
      if (!hasVndCol) continue;
      const iv = norm(intRow[ic]);
      const vv = norm(vndRow[vc] ?? vndRow[ic]);
      if (iv !== vv) diffs.push({ column: ic, vendorColumn: vc, internalValue: intRow[ic], vendorValue: vndRow[vc] ?? vndRow[ic] });
    }
    return diffs;
  }

  // ─── Schema comparison ─────────────────────────────────────────────────────
  _compareSchemas(intCols, vndCols, mapping) {
    const intSet = new Set(intCols);
    const vndSet = new Set(vndCols);
    const mappedInt = new Set((mapping || []).map(m => m.internal || m.internalCol).filter(Boolean));
    const mappedVnd = new Set((mapping || []).map(m => m.vendor   || m.vendorCol).filter(Boolean));
    return {
      common:       intCols.filter(c => vndSet.has(c)),
      internalOnly: intCols.filter(c => !vndSet.has(c) && !mappedInt.has(c)),
      vendorOnly:   vndCols.filter(c => !intSet.has(c) && !mappedVnd.has(c)),
      mapped:       (mapping || []).filter(m => (m.internal || m.internalCol) && (m.vendor || m.vendorCol)),
      internalColumns: intCols,
      vendorColumns:   vndCols,
    };
  }

  // ─── Analytics ─────────────────────────────────────────────────────────────
  _analytics(matched, missing, extra, diffs, intTotal, vndTotal) {
    const freq = {};
    diffs.forEach(d => { freq[d.column] = (freq[d.column] || 0) + 1; });
    const topDiffColumns = Object.entries(freq)
      .sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([column, count]) => ({ column, count, pct: matched.length > 0 ? ((count / matched.length) * 100).toFixed(1) : '0' }));

    const matchedExact = matched.filter(m => !m.hasDiffs).length;
    return {
      matchRate:     intTotal > 0 ? ((matchedExact / intTotal) * 100).toFixed(2) : '0',
      missingRate:   intTotal > 0 ? ((missing.length / intTotal) * 100).toFixed(2) : '0',
      extraRate:     vndTotal > 0 ? ((extra.length   / vndTotal) * 100).toFixed(2) : '0',
      topDiffColumns,
      totalFieldDiffs: diffs.length,
    };
  }

  // ─── Pre-comparison filter ─────────────────────────────────────────────────
  _applyFilters(rows, filters) {
    if (!filters || !filters.length) return rows;
    return rows.filter(row => {
      for (const f of filters) {
        if (!f.column || !f.values || !f.values.length) continue;
        const val = String(row[f.column] ?? '');
        if (!f.values.includes(val)) return false;
      }
      return true;
    });
  }

  // ─── Distinct values for filter UI ─────────────────────────────────────────
  getDistinctValues(rows, column, limit = 500) {
    const counts = new Map();
    for (const row of rows) {
      const v = String(row[column] ?? '');
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([value, count]) => ({ value, count }));
  }

  // ─── Column mapping suggestions ────────────────────────────────────────────
  suggestMappings(intCols, vndCols) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const used = new Set();
    const suggestions = [];

    for (const ic of intCols) {
      // 1. Exact
      if (vndCols.includes(ic) && !used.has(ic)) {
        suggestions.push({ internal: ic, vendor: ic, confidence: 100 }); used.add(ic); continue;
      }
      // 2. Case-insensitive
      const ci = vndCols.find(v => !used.has(v) && v.toLowerCase() === ic.toLowerCase());
      if (ci) { suggestions.push({ internal: ic, vendor: ci, confidence: 95 }); used.add(ci); continue; }
      // 3. Normalised
      const ni = vndCols.find(v => !used.has(v) && norm(v) === norm(ic));
      if (ni) { suggestions.push({ internal: ic, vendor: ni, confidence: 88 }); used.add(ni); continue; }
      // 4. Fuzzy levenshtein
      let best = null, bestScore = 0;
      for (const vc of vndCols) {
        if (used.has(vc)) continue;
        const a = norm(ic), b = norm(vc);
        if (!a || !b) continue;
        const dist  = this._lev(a, b);
        const score = Math.round((1 - dist / Math.max(a.length, b.length)) * 100);
        if (score > bestScore) { bestScore = score; best = vc; }
      }
      if (best && bestScore >= 60) { suggestions.push({ internal: ic, vendor: best, confidence: bestScore }); used.add(best); }
    }
    return suggestions.filter(s => s.vendor);
  }

  _lev(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
    return dp[m][n];
  }

  _progress(jobId, pct, msg) {
    if (jobId) activityLogger.progress(jobId, msg, pct, msg);
  }
}

module.exports = new ComparisonEngine();
