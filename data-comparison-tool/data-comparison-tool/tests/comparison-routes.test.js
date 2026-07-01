const test = require('node:test');
const assert = require('node:assert/strict');

const comparisonRoute = require('../backend/routes/comparison');

test('detail payload exposes mapped internal and vendor values for matched rows', () => {
  const result = {
    matched: [
      {
        key: '1001',
        intRow: { SKU: 'ABC', Price: '10' },
        vndRow: { SKU: 'abc', Price: '10' },
        hasDiffs: false,
        diffs: []
      }
    ],
    missingInVendor: [],
    extraInVendor: [],
    config: {
      columnMapping: [{ internal: 'SKU', vendor: 'SKU' }]
    }
  };

  const payload = comparisonRoute._buildDetailPagePayload(result, { status: 'matched', search: '', page: 1, pageSize: 10 });

  assert.equal(payload.mappedColumns.length, 1);
  assert.equal(payload.rows[0]['__int__SKU'], 'ABC');
  assert.equal(payload.rows[0]['__vnd__SKU'], 'abc');
  assert.equal(payload.rows[0]._status, 'matched');
});
