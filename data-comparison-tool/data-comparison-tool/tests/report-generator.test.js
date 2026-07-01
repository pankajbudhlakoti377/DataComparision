const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const XLSX = require('xlsx');

const reportGenerator = require('../backend/services/reportGenerator');

test('excel export adds internal, vendor, and azure worksheets', async () => {
  const tempDir = path.join(__dirname, '..', 'tmp-test-output');
  await fs.remove(tempDir);
  await fs.ensureDir(tempDir);

  process.env.OUTPUT_DIR = tempDir;

  const result = {
    summary: { totalInternal: 2, totalVendor: 2, matched: 0, missingInVendor: 0, extraInVendor: 0 },
    config: {},
    matched: [],
    missingInVendor: [],
    extraInVendor: [],
    fieldDiffs: [],
    schemaComparison: {},
    analytics: {}
  };

  const internalData = {
    columns: ['SKU', 'Name'],
    rows: [{ SKU: 'INT-1', Name: 'Internal One' }]
  };
  const vendorData = {
    columns: ['SKU', 'Name'],
    rows: [{ SKU: 'VEN-1', Name: 'Vendor One' }]
  };
  const azureData = [{
    columns: ['SKU', 'Name'],
    rows: [{ SKU: 'AZ-1', Name: 'Azure One' }],
    filename: 'azure.csv',
    azureSource: 'container/blob.csv'
  }];

  const outputPath = await reportGenerator.generateExcel(result, 'report.xlsx', { internalData, vendorData, azureData });
  const workbook = XLSX.readFile(outputPath);

  assert.ok(workbook.SheetNames.includes('Comparison Results'));
  assert.ok(workbook.SheetNames.includes('Internal File'));
  assert.ok(workbook.SheetNames.includes('Vendor File'));
  assert.ok(workbook.SheetNames.includes('Azure Loaded Data'));

  await fs.remove(tempDir);
});
