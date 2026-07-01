'use strict';

const XLSX = require('xlsx');
const fs   = require('fs-extra');
const path = require('path');
const PDFDocument = require('pdfkit');
const logger = require('../utils/logger');

class ReportGenerator {
  constructor() {
    this.dir = process.env.OUTPUT_DIR || './outputs';
    fs.ensureDirSync(this.dir);
  }

  // ─── Excel (multi-sheet) ────────────────────────────────────────────────
  async generateExcel(result, filename, extraData = {}) {
    const wb = XLSX.utils.book_new();
    const { summary, config, matched = [], missingInVendor = [], extraInVendor = [], fieldDiffs = [], schemaComparison, analytics } = result;
    const { internalData, vendorData, azureData } = extraData;

    // ─ Sheet 1: Comparison Results (existing) ─────────────────────────────
    const comparisonRows = [
      ...matched.slice(0, 100000).map(m => ({
        Status: m.hasDiffs ? 'Mismatch' : 'Matched',
        Key: m.key,
        DiffCount: m.diffs?.length || 0,
        DiffColumns: m.diffs?.map(d => d.column).join(', ') || '',
        ...this._prefix('Internal_', m.intRow),
        ...this._prefix('Vendor_', m.vndRow)
      })),
      ...missingInVendor.slice(0, 100000).map(m => ({
        Status: 'Missing in Vendor',
        Key: m.key,
        DiffCount: '',
        DiffColumns: '',
        ...this._prefix('Internal_', m.intRow || m._row)
      })),
      ...extraInVendor.slice(0, 100000).map(m => ({
        Status: 'Extra in Vendor',
        Key: m.key,
        DiffCount: '',
        DiffColumns: '',
        ...this._prefix('Vendor_', m.vndRow || m._row)
      }))
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(comparisonRows), 'Comparison Results');

    // ─ Sheet 2: Summary ─────────────────────────────────────────────────────
    const top = (analytics?.topDiffColumns || summary.topDiffColumns || []).slice(0, 12);
    const rate = summary.matchRate || (summary.totalInternal > 0 ? ((matched.length || 0) / summary.totalInternal * 100).toFixed(2) : 0);
    const summaryAoa = [
      ['Data Comparison Report', ''],
      ['Generated', new Date().toLocaleString()],
      [],
      ['OVERALL STATISTICS', ''],
      ['Metric', 'Value'],
      ['Internal Total Records',  summary.totalInternal],
      ['Vendor Total Records',    summary.totalVendor],
      ['Total Matched SKU',       matched.length],
      ['  ├─ Exact Match',        matched.filter(m => !m.hasDiffs).length],
      ['  └─ With Differences',   matched.filter(m => m.hasDiffs).length],
      ['Missing in Vendor',       missingInVendor.length || summary.missingInVendor],
      ['Extra in Vendor',         extraInVendor.length || summary.extraInVendor],
      ['Match Rate',              rate + '%'],
      ['Match Quality',           rate >= 90 ? 'Excellent' : rate >= 70 ? 'Good' : rate >= 50 ? 'Fair' : 'Poor'],
      ['Field-level Differences', fieldDiffs.length || summary.fieldDifferences || 0],
      ['Internal Duplicates',     summary.duplicatesInternal || 0],
      ['Vendor Duplicates',       summary.duplicatesVendor   || 0],
      ['Processing Time (ms)',    summary.durationMs || summary.elapsedMs || 0],
      ['Throughput (rows/sec)',   summary.rowsPerSec || 0],
      [],
      ['KEY COLUMNS USED', ''],
      ['Internal Key Columns', (config?.internalKeyColumns || []).join(', ')],
      ['Vendor Key Columns',   (config?.vendorKeyColumns   || []).join(', ')],
      [],
      ['CONFIGURATION', ''],
      ['Case Insensitive',              config?.caseInsensitive !== false ? 'Yes' : 'No'],
      ['Trim Whitespace',               config?.trimWhitespace  !== false ? 'Yes' : 'No'],
      ['Normalize Special Characters',  config?.normalizeSpecial ? 'Yes' : 'No'],
      [],
      ['COLUMN MAPPING SUMMARY', ''],
      ['Total Mapped Columns',       schemaComparison?.mapped?.length || 0],
      ['Common Columns',             schemaComparison?.common?.length || 0],
      ['Internal Only Columns',      schemaComparison?.internalOnly?.length || 0],
      ['Vendor Only Columns',        schemaComparison?.vendorOnly?.length || 0],
      [],
      ['TOP MISMATCHED COLUMNS', ''],
      ['Column', 'Diff Count', 'Diff %'],
      ...top.map(d => [d.column || d.col, d.count, (d.pct || 0) + '%'])
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(summaryAoa);
    ws1['!cols'] = [{ wch: 35 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

    // ─ Sheet 3: Internal File ──────────────────────────────────────────────
    const internalRows = Array.isArray(internalData?.rows) && internalData.rows.length
      ? internalData.rows.map(row => ({ ...row }))
      : (Array.isArray(internalData?.columns) && internalData.columns.length
        ? [internalData.columns.reduce((acc, col) => ({ ...acc, [col]: '' }), {})]
        : [{ _note: 'No records available' }]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(internalRows), 'Internal File');

    // ─ Sheet 4: Vendor File ────────────────────────────────────────────────
    const vendorRows = Array.isArray(vendorData?.rows) && vendorData.rows.length
      ? vendorData.rows.map(row => ({ ...row }))
      : (Array.isArray(vendorData?.columns) && vendorData.columns.length
        ? [vendorData.columns.reduce((acc, col) => ({ ...acc, [col]: '' }), {})]
        : [{ _note: 'No records available' }]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vendorRows), 'Vendor File');

    // ─ Sheet 5: Azure Loaded Data ─────────────────────────────────────────
    const azureRows = Array.isArray(azureData) && azureData.length
      ? azureData.flatMap(item => {
          const rows = Array.isArray(item?.rows) ? item.rows : [];
          return rows.length
            ? rows.map(row => ({ ...row, _source: item?.filename || item?.azureSource || 'Azure' }))
            : [{ _note: 'No Azure records available', _source: item?.filename || item?.azureSource || 'Azure' }];
        })
      : [{ _note: 'No Azure records available' }];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(azureRows), 'Azure Loaded Data');

    // ─ Sheet 6: Field Differences ──────────────────────────────────────────
    if (fieldDiffs.length) {
      const rows = fieldDiffs.slice(0, 100000).map(d => ({
        RecordKey: d.key,
        Column: d.column,
        VendorColumn: d.vendorColumn,
        InternalValue: d.internalValue,
        VendorValue: d.vendorValue,
        DifferenceType: String(d.internalValue) !== String(d.vendorValue) ? 'Value Difference' : 'Format Difference'
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Field Differences');
    }

    // ─ Sheet 7: Column Mapping ────────────────────────────────────────────
    if (schemaComparison) {
      const mappingRows = [
        ['Internal Column', 'Vendor Column', 'Mapping Status'],
        ...(schemaComparison.mapped || []).map(m => [
          m.internal || m.internalCol,
          m.vendor || m.vendorCol,
          'Mapped'
        ]),
        ...((schemaComparison.internalOnly || []).map(c => [c, '', 'Internal Only'])),
        ...((schemaComparison.vendorOnly || []).map(c => ['', c, 'Vendor Only'])),
        ...((schemaComparison.common || []).map(c => [c, c, 'Common']))
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mappingRows), 'Column Mapping');
    }

    const filePath = path.join(this.dir, filename);
    XLSX.writeFile(wb, filePath);
    return filePath;
  }

  // ─── CSV ────────────────────────────────────────────────────────────────
  async generateCsv(data, filename) {
    if (!data || !data.length) throw new Error('No data to export');
    const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(data));
    const fp  = path.join(this.dir, filename);
    await fs.writeFile(fp, csv, 'utf8');
    return fp;
  }

  // ─── PDF summary ─────────────────────────────────────────────────────────
  async generatePdf(result, filename) {
    const { summary, analytics, schemaComparison, config, matched, missingInVendor, extraInVendor, fieldDiffs } = result;
    const fp = path.join(this.dir, filename);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, bufferPages: true });
      const ws  = fs.createWriteStream(fp);
      doc.pipe(ws);

      // Title
      doc.fontSize(24).fillColor('#1e40af').text('Data Comparison Report', { align: 'center' });
      doc.fontSize(11).fillColor('#6b7280').text('Generated: ' + new Date().toLocaleString(), { align: 'center' });
      doc.moveDown(1.5);

      // 1. UPLOAD DETAILS
      doc.fontSize(12).fillColor('#111827').text('1. Upload Details', { underline: true });
      doc.moveDown(0.3);
      const uploadInfo = [
        ['Report Generated', new Date().toLocaleString()],
        ['Processing Duration', (summary.durationMs || 0).toLocaleString() + ' ms'],
        ['Processing Throughput', (summary.rowsPerSec || 0).toLocaleString() + ' rows/sec'],
      ];
      uploadInfo.forEach(([k, v]) => {
        doc.fontSize(9).fillColor('#374151').text(k + ':', { continued: true }).fillColor('#6b7280').text('  ' + (v ?? '—'));
      });
      doc.moveDown(0.8);

      // 2. FILE INFORMATION
      doc.fontSize(12).fillColor('#111827').text('2. File Information', { underline: true });
      doc.moveDown(0.3);
      const fileInfo = [
        ['Internal File', 'Unknown'],
        ['Vendor File', 'Unknown'],
        ['Internal Total Records', summary.totalInternal.toLocaleString()],
        ['Vendor Total Records', summary.totalVendor.toLocaleString()],
      ];
      fileInfo.forEach(([k, v]) => {
        doc.fontSize(9).fillColor('#374151').text(k + ':', { continued: true }).fillColor('#6b7280').text('  ' + (v ?? '—'));
      });
      doc.moveDown(0.8);

      // 3. COMPARISON RESULTS
      doc.fontSize(12).fillColor('#111827').text('3. Comparison Results', { underline: true });
      doc.moveDown(0.3);
      const resultsInfo = [
        ['Total Matched SKU', (matched?.length || 0).toLocaleString()],
        ['  ├─ Exact Match', (matched?.filter(m => !m.hasDiffs).length || 0).toLocaleString()],
        ['  └─ With Differences', (matched?.filter(m => m.hasDiffs).length || 0).toLocaleString()],
        ['Missing in Vendor', (missingInVendor?.length || summary.missingInVendor || 0).toLocaleString()],
        ['Extra in Vendor', (extraInVendor?.length || summary.extraInVendor || 0).toLocaleString()],
        ['Field-Level Differences', (fieldDiffs?.length || summary.fieldDifferences || 0).toLocaleString()],
      ];
      resultsInfo.forEach(([k, v]) => {
        doc.fontSize(9).fillColor('#374151').text(k + ':', { continued: true }).fillColor('#6b7280').text('  ' + (v ?? '—'));
      });
      doc.moveDown(0.8);

      // 4. MATCH STATISTICS
      doc.fontSize(12).fillColor('#111827').text('4. Match Statistics', { underline: true });
      doc.moveDown(0.3);
      const rate = summary.matchRate || (summary.totalInternal > 0 ? ((matched?.length || 0) / summary.totalInternal * 100).toFixed(2) : 0);
      const statsInfo = [
        ['Match Rate', rate + '%'],
        ['Match Quality', rate >= 90 ? 'Excellent' : rate >= 70 ? 'Good' : rate >= 50 ? 'Fair' : 'Poor'],
        ['Internal Duplicates', (summary.duplicatesInternal || 0).toLocaleString()],
        ['Vendor Duplicates', (summary.duplicatesVendor || 0).toLocaleString()],
      ];
      statsInfo.forEach(([k, v]) => {
        doc.fontSize(9).fillColor('#374151').text(k + ':', { continued: true }).fillColor('#6b7280').text('  ' + (v ?? '—'));
      });
      doc.moveDown(0.8);

      // 5. COLUMN INFORMATION
      doc.fontSize(12).fillColor('#111827').text('5. Column Configuration', { underline: true });
      doc.moveDown(0.3);
      const colInfo = [
        ['Internal Key Columns', (config?.internalKeyColumns || []).join(', ') || 'N/A'],
        ['Vendor Key Columns', (config?.vendorKeyColumns || []).join(', ') || 'N/A'],
        ['Total Column Mappings', (schemaComparison?.mapped?.length || 0).toLocaleString()],
        ['Common Columns', (schemaComparison?.common?.length || 0).toLocaleString()],
        ['Internal Only Columns', (schemaComparison?.internalOnly?.length || 0).toLocaleString()],
        ['Vendor Only Columns', (schemaComparison?.vendorOnly?.length || 0).toLocaleString()],
      ];
      colInfo.forEach(([k, v]) => {
        doc.fontSize(9).fillColor('#374151').text(k + ':', { continued: true }).fillColor('#6b7280').text('  ' + (v ?? '—'));
      });
      doc.moveDown(0.8);

      // 6. COMPARISON SETTINGS
      doc.fontSize(12).fillColor('#111827').text('6. Comparison Settings', { underline: true });
      doc.moveDown(0.3);
      const settingsInfo = [
        ['Case Insensitive', config?.caseInsensitive !== false ? 'Yes' : 'No'],
        ['Trim Whitespace', config?.trimWhitespace !== false ? 'Yes' : 'No'],
        ['Normalize Special Characters', config?.normalizeSpecial ? 'Yes' : 'No'],
        ['Ignore Columns', (config?.ignoreColumns?.length || 0) > 0 ? (config.ignoreColumns.join(', ')) : 'None'],
      ];
      settingsInfo.forEach(([k, v]) => {
        doc.fontSize(9).fillColor('#374151').text(k + ':', { continued: true }).fillColor('#6b7280').text('  ' + (v ?? '—'));
      });
      doc.moveDown(0.8);

      // 7. TOP MISMATCHED COLUMNS
      const top = (analytics?.topDiffColumns || summary.topDiffColumns || []).slice(0, 8);
      if (top.length) {
        doc.fontSize(12).fillColor('#111827').text('7. Top Mismatched Columns', { underline: true });
        doc.moveDown(0.3);
        top.forEach((d, idx) => {
          const pct = d.pct || (summary.matched > 0 ? Math.round(d.count / summary.matched * 100) : 0);
          doc.fontSize(9).fillColor('#374151').text(`  ${idx + 1}. ${d.column || d.col}`, { continued: true }).fillColor('#6b7280').text(`  (${d.count} diffs, ${pct}%)`);
        });
      }

      doc.moveDown(2).fontSize(8).fillColor('#9ca3af').text('Generated by Data Comparison Tool v2.0 | ' + new Date().toLocaleString(), { align: 'center' });
      doc.end();
      ws.on('finish', () => resolve(fp));
      ws.on('error', reject);
    });
  }

  _prefix(pfx, row) {
    if (!row) return {};
    const out = {};
    for (const [k, v] of Object.entries(row)) out[pfx + k] = v;
    return out;
  }

  async listReports() {
    const files = await fs.readdir(this.dir).catch(() => []);
    const out   = [];
    for (const f of files.filter(f => /\.(xlsx|csv|pdf)$/i.test(f))) {
      try {
        const stat = await fs.stat(path.join(this.dir, f));
        out.push({ filename: f, size: stat.size, created: stat.birthtime, format: path.extname(f).slice(1).toLowerCase() });
      } catch {}
    }
    return out.sort((a, b) => new Date(b.created) - new Date(a.created));
  }

  async deleteReport(filename) {
    await fs.remove(path.join(this.dir, filename));
  }
}

module.exports = new ReportGenerator();
