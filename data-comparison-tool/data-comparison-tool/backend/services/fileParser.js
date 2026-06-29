const XLSX = require('xlsx');
const fs = require('fs-extra');
const path = require('path');
const csv = require('csv-parser');
const { Readable } = require('stream');
const AdmZip = require('adm-zip');
const logger = require('../utils/logger');

class FileParser {
  /**
   * Parse any supported file to array of row objects
   * @param {string} filePath - absolute path to file
   * @param {object} options - { sheetName, headerRow, encoding }
   * @returns {Promise<{ rows: object[], columns: string[], meta: object }>}
   */
  async parse(filePath, options = {}) {
    const ext = path.extname(filePath).toLowerCase();
    const stat = await fs.stat(filePath);

    logger.info(`Parsing file: ${path.basename(filePath)}, size: ${(stat.size / 1024 / 1024).toFixed(2)} MB, type: ${ext}`);

    try {
      switch (ext) {
        case '.xlsx':
        case '.xls':
        case '.xlsm':
          return await this.parseExcel(filePath, options);
        case '.csv':
          return await this.parseCsv(filePath, options);
        case '.tsv':
          return await this.parseCsv(filePath, { ...options, delimiter: '\t' });
        case '.txt':
          return await this.parseCsv(filePath, { ...options, delimiter: options.delimiter || ',' });
        case '.zip':
          return await this.parseZip(filePath, options);
        default:
          throw new Error(`Unsupported file format: ${ext}. Supported: xlsx, xls, csv, tsv, txt, zip`);
      }
    } catch (err) {
      logger.error(`Parse error for ${filePath}: ${err.message}`);
      throw err;
    }
  }

  async parseExcel(filePath, options = {}) {
    const workbook = XLSX.readFile(filePath, {
      cellDates: true,
      cellNF: false,
      cellText: false,
      raw: false
    });

    const sheetName = options.sheetName || workbook.SheetNames[0];
    if (!workbook.SheetNames.includes(sheetName)) {
      throw new Error(`Sheet "${sheetName}" not found. Available: ${workbook.SheetNames.join(', ')}`);
    }

    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      defval: '',
      raw: false
    });

    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    return {
      rows,
      columns,
      meta: {
        format: 'excel',
        sheets: workbook.SheetNames,
        activeSheet: sheetName,
        totalRows: rows.length,
        totalColumns: columns.length
      }
    };
  }

  parseCsv(filePath, options = {}) {
    return new Promise((resolve, reject) => {
      const rows = [];
      let columns = [];
      const delimiter = options.delimiter || ',';

      fs.createReadStream(filePath, { encoding: options.encoding || 'utf8' })
        .pipe(csv({ separator: delimiter }))
        .on('headers', (headers) => { columns = headers; })
        .on('data', (row) => rows.push(row))
        .on('end', () => resolve({
          rows,
          columns,
          meta: { format: 'csv', delimiter, totalRows: rows.length, totalColumns: columns.length }
        }))
        .on('error', reject);
    });
  }

  async parseZip(filePath, options = {}) {
    let zip;
    try { zip = new AdmZip(filePath); } catch (e) {
      throw new Error('Invalid ZIP file or ZIP is password protected');
    }
    const entries = zip.getEntries().filter(e => !e.isDirectory);
    const supported = entries.filter(e => {
      const ext = path.extname(e.name).toLowerCase();
      return ['.csv', '.xlsx', '.xls', '.tsv'].includes(ext);
    });

    if (supported.length === 0) {
      throw new Error('ZIP contains no supported files (csv, xlsx, xls, tsv)');
    }

    // Use first supported file, or match by name if specified
    const target = options.zipEntry
      ? supported.find(e => e.name === options.zipEntry) || supported[0]
      : supported[0];

    const tmpPath = filePath.replace('.zip', '_extracted' + path.extname(target.name));
    zip.extractEntryTo(target, path.dirname(tmpPath), false, true);

    const result = await this.parse(tmpPath, options);
    await fs.remove(tmpPath);

    return {
      ...result,
      meta: {
        ...result.meta,
        zipSource: target.name,
        allZipFiles: supported.map(e => e.name)
      }
    };
  }

  /**
   * Smart column detection - find potential key columns
   */
  detectKeyColumns(columns) {
    const keyPatterns = [
      /^(sku|sku_id|skuid)$/i,
      /^(id|_id|product_id|item_id)$/i,
      /^(barcode|ean|ean_code|upc|gtin)$/i,
      /^(code|product_code|item_code)$/i,
      /^(asin|vendor_sku|vendor_id)$/i
    ];

    const suggestions = [];
    for (const col of columns) {
      for (const pat of keyPatterns) {
        if (pat.test(col)) {
          suggestions.push(col);
          break;
        }
      }
    }
    return suggestions;
  }

  /**
   * Infer column data types from sample
   */
  inferColumnTypes(rows, columns, sampleSize = 100) {
    const sample = rows.slice(0, sampleSize);
    const types = {};

    for (const col of columns) {
      const values = sample.map(r => r[col]).filter(v => v !== '' && v != null);
      if (values.length === 0) { types[col] = 'empty'; continue; }

      const numVals = values.filter(v => !isNaN(Number(v)));
      if (numVals.length / values.length > 0.9) { types[col] = 'number'; continue; }

      const dateVals = values.filter(v => !isNaN(Date.parse(v)));
      if (dateVals.length / values.length > 0.9) { types[col] = 'date'; continue; }

      const uniqueRatio = new Set(values).size / values.length;
      types[col] = uniqueRatio < 0.1 ? 'categorical' : 'string';
    }
    return types;
  }

  /**
   * Get column stats for smart mapping
   */
  getColumnStats(rows, columns, sampleSize = 200) {
    const sample = rows.slice(0, sampleSize);
    return columns.map(col => {
      const values = sample.map(r => r[col]).filter(v => v !== '' && v != null);
      const unique = new Set(values);
      return {
        name: col,
        nonEmpty: values.length,
        unique: unique.size,
        sample: [...unique].slice(0, 5)
      };
    });
  }
}

module.exports = new FileParser();
