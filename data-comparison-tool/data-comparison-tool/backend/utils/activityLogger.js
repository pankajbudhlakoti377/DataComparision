const EventEmitter = require('events');

class ActivityLogger extends EventEmitter {
  constructor() {
    super();
    this.activities = [];
    this.maxActivities = 500;
    this.clients = new Set();
  }

  log(typeOrObj, message, details = {}, level = 'info') {
    let type, msg, det, lvl;
    if (typeof typeOrObj === 'object' && typeOrObj !== null) {
      type = typeOrObj.type || 'info'; msg = typeOrObj.message || ''; det = typeOrObj.details || {}; lvl = typeOrObj.level || typeOrObj.type || 'info';
    } else {
      type = typeOrObj; msg = message; det = details; lvl = level;
    }
    const entry = {
      id: Date.now() + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      type: lvl, message: msg, details: det
    };
    this.activities.unshift(entry);
    if (this.activities.length > this.maxActivities) this.activities = this.activities.slice(0, this.maxActivities);
    this.broadcast(`data: ${JSON.stringify(entry)}\n\n`);
    return entry;
  }

  info(type, message, details)    { return this.log({ type: 'info',    message: message || type, details }); }
  success(type, message, details) { return this.log({ type: 'success', message: message || type, details }); }
  warning(type, message, details) { return this.log({ type: 'warning', message: message || type, details }); }
  error(type, message, details)   { return this.log({ type: 'error',   message: message || type, details }); }

  progress(jobId, step, percent, message) {
    const entry = { type: 'progress', message: message || step, pct: percent };
    this.broadcast(`data: ${JSON.stringify(entry)}\n\n`);
  }

  notify(type, title, message, level = 'info') {
    this.log({ type: level, message: `${title}: ${message}` });
  }

  addClient(res) {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  broadcast(str) {
    this.clients.forEach(res => {
      try { res.write(str); } catch { this.clients.delete(res); }
    });
  }

  getAll(limit = 100) { return this.activities.slice(0, limit); }

  clear() { this.activities = []; }
}

module.exports = new ActivityLogger();
