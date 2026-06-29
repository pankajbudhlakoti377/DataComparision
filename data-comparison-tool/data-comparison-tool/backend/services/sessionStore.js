const NodeCache = require('node-cache');

class SessionStore {
  constructor() {
    // Store parsed file data in memory with 4hr TTL
    this.store = new NodeCache({ stdTTL: 14400, checkperiod: 600, useClones: false });
    this.comparisonResults = new NodeCache({ stdTTL: 14400, checkperiod: 600, useClones: false });
  }

  setFileData(sessionId, side, data) {
    this.store.set(`${sessionId}:${side}`, data);
  }

  getFileData(sessionId, side) {
    return this.store.get(`${sessionId}:${side}`) || null;
  }

  setComparisonResult(sessionId, result) {
    this.comparisonResults.set(`${sessionId}:result`, result);
  }

  getComparisonResult(sessionId) {
    return this.comparisonResults.get(`${sessionId}:result`) || null;
  }

  clearSession(sessionId) {
    this.store.del(`${sessionId}:internal`);
    this.store.del(`${sessionId}:vendor`);
    this.comparisonResults.del(`${sessionId}:result`);
  }

  getStatus(sessionId) {
    return {
      hasInternal: !!this.store.get(`${sessionId}:internal`),
      hasVendor: !!this.store.get(`${sessionId}:vendor`),
      hasResult: !!this.comparisonResults.get(`${sessionId}:result`)
    };
  }
}

module.exports = new SessionStore();
