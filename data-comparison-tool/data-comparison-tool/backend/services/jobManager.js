const { v4: uuidv4 } = require('uuid');
const NodeCache = require('node-cache');

class JobManager {
  constructor() {
    this.jobs = new NodeCache({ stdTTL: 7200, checkperiod: 300 }); // 2hr TTL
  }

  create(type, meta = {}) {
    const id = uuidv4();
    const job = {
      id,
      type,
      status: 'pending',
      progress: 0,
      step: '',
      message: 'Initializing...',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
      meta
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  update(id, updates) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const updated = { ...job, ...updates, updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);
    return updated;
  }

  setRunning(id, step, progress, message) {
    return this.update(id, { status: 'running', step, progress, message });
  }

  setComplete(id, result) {
    return this.update(id, { status: 'complete', progress: 100, result, message: 'Complete' });
  }

  setFailed(id, error) {
    return this.update(id, { status: 'failed', error: error.message || String(error), message: 'Failed' });
  }

  list() {
    return this.jobs.keys().map(k => this.jobs.get(k)).filter(Boolean);
  }

  delete(id) {
    this.jobs.del(id);
  }
}

module.exports = new JobManager();
