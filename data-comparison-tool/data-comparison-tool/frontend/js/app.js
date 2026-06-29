/**
 * Data Comparison Tool v2.0 — Frontend Application
 * Bug-fixed production build
 *
 * Fixed bugs:
 * 1. showView() now sets display style directly (inline style beats CSS class)
 * 2. azureSearch() alias added (called from HTML)
 * 3. Toggle option reading fixed (null-safe boolean)
 * 4. _checkBoth() now enables az-next-btn for Azure flow
 * 5. _show() enhanced with flex-mode for flex containers
 * 6. _populateCatBrand() always repopulates (removed stale-cache guard)
 * 7. detailSearch debounce fixed
 * 8. Progress.update() updates overlay-msg element
 * 9. Azure: file selection flow hardened
 * 10. Azure: azureSetSide() works without pre-selecting blob when called from quick-set
 *
 * AZURE FILE SELECTION FIX (this patch):
 * - _azFileRowHTML: stores file metadata in a module-level Map keyed by index;
 *   onclick passes only the numeric index — no JSON serialisation in HTML at all.
 * - _azRenderFileList: rebuilds the Map before rendering; re-applies highlight to
 *   the already-selected blob so highlight survives list re-renders.
 * - _azSelectFile: looks up the file object from the Map by index; no JSON.parse.
 * - _azQuickSet: looks up by index; passes the resolved object directly to
 *   azureSetSide() to avoid any selectedBlob race condition.
 * - azureSetSide: accepts an optional second argument (file object) so _azQuickSet
 *   does not depend on selectedBlob being set first; ext check handles leading dot
 *   and empty-ext files correctly.
 */
'use strict';

/* ─── STATE ────────────────────────────────────────────────────────────────── */
const State = {
  sessionId: null,
  source: null,
  /*
   * MULTI-FILE FIX: files[side] is now an Array of uploaded-file objects.
   * Each entry is the server response from /files/upload/:side.
   * Downstream code that needs "the" file (schema map, comparison) uses
   * the last uploaded file per side via _primaryFile(side).
   * All UI helpers (_showFileList, _removeFile) work on the full array.
   */
  files: { internal: [], vendor: [] },
  mappings: [],
  comparisonResult: null,
  jobId: null,
  jobPollInterval: null,
  charts: {},
  filterRules: [],
  filterValues: [],
  pagination: {
    detail: { page: 1, pageSize: 100 },
    sku:    { page: 1, pageSize: 50  },
    diff:   { page: 1, pageSize: 50  },
  },
  azure: {
    connected: false,
    accountName: null,
    container: null,
    prefix: '',
    cache: {},
    allFiles: [],
    filteredFiles: [],
    sortKey: 'name',
    sortAsc: true,
    selectedBlob: null,
    /*
     * MULTI-FILE FIX (Azure): files[side] is now an Array of staged blob
     * descriptors (pre-load).  azureSetSide() appends; azureClearSide()
     * clears the whole array; azureRemoveStaged() removes one entry.
     * azureLoadBoth() iterates both arrays and loads every staged file.
     */
    files: { internal: [], vendor: [] },
    searchQuery: '',
  },
};

/* ─── API CLIENT ───────────────────────────────────────────────────────────── */
const API = {
  base: '/api',
  hdr() { return { 'x-session-id': State.sessionId, 'Content-Type': 'application/json' }; },

  async get(path) {
    const r = await fetch(this.base + path, { headers: this.hdr() });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(this.base + path, { method: 'POST', headers: this.hdr(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async del(path) {
    const r = await fetch(this.base + path, { method: 'DELETE', headers: this.hdr() });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  upload(path, fd, onPct) {
    return new Promise((ok, fail) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.base + path);
      xhr.setRequestHeader('x-session-id', State.sessionId);
      xhr.upload.onprogress = e => { if (e.lengthComputable && onPct) onPct(Math.round(e.loaded / e.total * 100)); };
      xhr.onload = () => {
        try { const d = JSON.parse(xhr.responseText); xhr.status < 300 ? ok(d) : fail(new Error(d.error || xhr.statusText)); }
        catch { fail(new Error(xhr.statusText)); }
      };
      xhr.onerror = () => fail(new Error('Network error'));
      xhr.send(fd);
    });
  },
};

/* ─── HELPERS (defined first so they can be used everywhere) ───────────────── */
function $(id) { return document.getElementById(id); }
function $el(tag, attrs) {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => k === 'class' ? (e.className = v) : e.setAttribute(k, v));
  return e;
}
function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _size(b) {
  if (!b || b < 0) return '0 B';
  const k = 1024, u = ['B','KB','MB','GB'];
  const i = Math.min(3, Math.floor(Math.log(Math.max(b,1)) / Math.log(k)));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + u[i];
}
/* BUG-FIX: _show now accepts optional 'flex' mode for flex containers */
function _show(id, visible, displayVal) {
  const e = $(id);
  if (e) e.style.display = visible ? (displayVal || '') : 'none';
}
function _showFlex(id, visible) { _show(id, visible, 'flex'); }
function _text(id, val) { const e = $(id); if (e) e.textContent = String(val); }
function _html(id, val) { const e = $(id); if (e) e.innerHTML = val; }
function _bar(id, pct) { const e = $(id); if (e) e.style.width = Math.min(100, Math.max(0, pct)) + '%'; }
function _disabled(id, v) { const e = $(id); if (e) e.disabled = !!v; }
function _badge(id, text, cls) { const e = $(id); if (!e) return; e.textContent = text; e.className = 'badge ' + cls; }
function _dot(dId, lId, on, onT, offT) {
  const d = $(dId); if (d) d.className = 'dot' + (on ? '' : ' off');
  const l = $(lId); if (l) l.textContent = on ? onT : offT;
}
/* BUG-FIX: isKey helper for auto-selecting key columns */
function _isKey(col) {
  return /^(sku|ean|barcode|upc|id|code|item_no|article|product_code)$/i.test(
    col.toLowerCase().replace(/[^a-z0-9]/g, '')
  );
}
function _triggerDownload(url, filename) {
  const a = document.createElement('a'); a.href = url; a.download = filename || 'download';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
/* BUG-FIX: _debounce defined before any usage */
function _debounce(fn, ms) {
  let t;
  return function(...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
}
/* BUG-FIX: read toggle switch safely */
function _toggle(id, defaultVal) {
  const e = $(id);
  if (!e) return defaultVal !== undefined ? defaultVal : true;
  return e.classList.contains('on');
}
/*
 * MULTI-FILE FIX: returns the last (most-recently-uploaded) file for a side,
 * or null if none.  All schema/comparison consumers call this instead of
 * accessing State.files[side] directly.
 */
function _primaryFile(side) {
  const arr = State.files[side];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[arr.length - 1];
}

/* ─── TOAST ────────────────────────────────────────────────────────────────── */
const Toast = {
  show(msg, type = 'info', duration = 4500) {
    let c = $('toast-container');
    if (!c) {
      c = $el('div', { id: 'toast-container', style: 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:10px;pointer-events:none;max-width:380px' });
      document.body.appendChild(c);
    }
    const icons = { success: 'ti-check-circle', error: 'ti-alert-circle', warning: 'ti-alert-triangle', info: 'ti-info-circle' };
    const cols  = { success: 'var(--green)', error: 'var(--red)', warning: 'var(--amber)', info: 'var(--blue)' };
    const t = $el('div', { class: `toast toast-${type}` });
    t.style.cssText = 'pointer-events:all;animation:slideUp .22s ease';
    t.innerHTML = `<i class="ti ${icons[type] || icons.info} toast-icon" style="color:${cols[type] || cols.info}"></i><div class="toast-content"><div class="toast-title">${_esc(msg)}</div></div><span class="toast-close" onclick="this.closest('.toast').remove()">×</span>`;
    c.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, duration);
  },
  success: (m, d) => Toast.show(m, 'success', d),
  error:   (m, d) => Toast.show(m, 'error',   d || 7000),
  warning: (m, d) => Toast.show(m, 'warning', d),
  info:    (m, d) => Toast.show(m, 'info',    d),
};

/* ─── PROGRESS OVERLAY ─────────────────────────────────────────────────────── */
const Progress = {
  show(msg = 'Processing…', pct = null) {
    const ov = $('progress-overlay');
    if (ov) ov.style.display = 'flex';
    this.update(msg, pct);
  },
  /* BUG-FIX: also update overlay-msg element */
  update(msg, pct) {
    if (msg) {
      _text('overlay-title', msg);
      _text('overlay-msg',   msg);
    }
    if (pct !== null && pct !== undefined) {
      _bar('overlay-bar', pct);
      _text('overlay-pct', Math.round(pct) + '%');
    }
  },
  hide() {
    const ov = $('progress-overlay');
    if (ov) ov.style.display = 'none';
  },
};

/* ─── ACTIVITY LOG (SSE) ────────────────────────────────────────────────────── */
const Activity = {
  sse: null,
  unread: 0,

  init() {
    if (this.sse) { try { this.sse.close(); } catch {} }
    this.sse = new EventSource(`/api/activity/stream?sessionId=${encodeURIComponent(State.sessionId)}`);
    this.sse.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'ping') return;
        this._add(d);
        if (d.type === 'progress' && d.pct != null) Progress.update(d.message || 'Processing…', d.pct);
      } catch {}
    };
    this.sse.onerror = () => {}; // reconnects automatically
  },

  _add(d) {
    const list = $('activity-log-list');
    if (!list) return;
    const typeClass = { info:'activity-info', success:'activity-success', warning:'activity-warning', error:'activity-error', progress:'activity-progress' };
    const icons     = { info:'ti-info-circle', success:'ti-check-circle', warning:'ti-alert-triangle', error:'ti-alert-circle', progress:'ti-loader spin' };
    const item = $el('div', { class: `activity-item ${typeClass[d.type] || 'activity-info'}` });
    item.innerHTML = `<div style="display:flex;align-items:center;gap:6px"><i class="ti ${icons[d.type] || 'ti-info-circle'}" style="font-size:13px;flex-shrink:0"></i><span>${_esc(d.message || '')}</span></div><div class="activity-time">${new Date().toLocaleTimeString()}</div>`;
    list.prepend(item);
    while (list.children.length > 150) list.lastChild.remove();
    const panel = $('activity-panel');
    if (!panel || panel.style.display !== 'flex') {
      this.unread++;
      const badge = $('activity-unread');
      if (badge) { badge.textContent = this.unread; badge.style.display = ''; }
    }
  },
};

/* ─── SESSION ──────────────────────────────────────────────────────────────── */
function initSession() {
  let sid = localStorage.getItem('dct-sid');
  if (!sid) {
    sid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'sess-' + Math.random().toString(36).slice(2) + Date.now();
    localStorage.setItem('dct-sid', sid);
  }
  State.sessionId = sid;
  Activity.init();
}

/* ─── TABS ──────────────────────────────────────────────────────────────────── */
function initTabs() {
  document.querySelectorAll('.tabs').forEach(group => {
    group.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const id = tab.dataset.tab;
        group.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const scope = group.closest('.view') || document;
        scope.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        const panel = scope.querySelector('#' + id) || document.getElementById(id);
        if (panel) panel.classList.add('active');
      });
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   APP
═══════════════════════════════════════════════════════════════════════════════ */

/*
 * AZURE FILE ROW MAP
 * ------------------
 * Stores the current rendered file objects keyed by their row index.
 * This lets onclick handlers pass only a plain integer index rather than
 * serialising the entire file object into an HTML attribute (which caused
 * double-parse bugs and XSS risks in the original code).
 *
 * The Map is rebuilt at the start of every _azRenderFileList() call so it
 * always mirrors the DOM exactly.
 */
const _azFileMap = new Map();

const App = {

  /* ── VIEW NAVIGATION ───────────────────────────────────────────────────────
     CSS handles visibility: .view { display:none } and .view.active { display:block }
     We simply toggle the 'active' class - no inline styles needed */
  showView(name) {
    /* Toggle active class - CSS .view rule hides all, .view.active shows one */
    document.querySelectorAll('.view').forEach(v => {
      v.classList.remove('active');
      v.style.display = ''; /* clear any lingering inline style */
    });
    const v = $('view-' + name);
    if (v) { v.classList.add('active'); }

    /* Sidebar highlight */
    document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll(`.sb-item[data-view="${name}"]`).forEach(i => i.classList.add('active'));

    /* Step bar */
    const steps = ['upload', 'schema', 'configure', 'results'];
    document.querySelectorAll('.step').forEach(s => {
      s.classList.remove('active', 'done');
      const si = steps.indexOf(s.dataset.view), ni = steps.indexOf(name);
      if (si >= 0 && ni >= 0) {
        if      (si < ni) s.classList.add('done');
        else if (si === ni) s.classList.add('active');
      }
    });

    /* Breadcrumb */
    const BC = { upload:'Load Files', schema:'Schema Map', configure:'Configure', results:'Results', sku:'SKU Analysis', diff:'Field Differences', category:'Category Map', brand:'Brand Analysis', performance:'Performance', export:'Export Reports' };
    _text('breadcrumb-label', BC[name] || name);
    State.currentView = name;

    /* View-specific init */
    if (name === 'upload')      this._refreshUploadView();
    if (name === 'results')     { if (State.comparisonResult) this._renderResults(); else this._showResultsEmpty(); }
    if (name === 'export')      { this._updateExportView(); this.loadReportList(); }
    if (name === 'configure')   this._populateConfigure();
    if (name === 'category')    this._populateCatBrand();
    if (name === 'brand')       this._populateCatBrand();
    if (name === 'sku')         {
      if (State.comparisonResult) { _show('sku-empty-state',false); _show('sku-content',true); this.loadSkuPage(1); }
      else                        { _show('sku-empty-state',true);  _show('sku-content',false); }
    }
    if (name === 'diff')        {
      if (State.comparisonResult) { _show('diff-empty-state',false); _show('diff-content',true); this.loadDiffPage(1); }
      else                        { _show('diff-empty-state',true);  _show('diff-content',false); }
    }
    if (name === 'performance') this._renderPerformance();
  },

  /* ── SOURCE SELECTION ───────────────────────────────────────────────────── */
  chooseSource(src) {
    State.source = src;
    _show('up-screen-choose', !src);
    _show('up-screen-local',  src === 'local');
    _show('up-screen-azure',  src === 'azure');
  },

  /*
   * MULTI-FILE VISIBILITY FIX: called every time the upload view is shown.
   *
   * Problems solved:
   *  1. When the user navigates back to "Load Files", the correct source
   *     sub-panel (local / azure) must be re-revealed based on State.source.
   *  2. The int-file-info / vnd-file-info containers are set display:none on
   *     init and after reset.  If files have already been uploaded, those
   *     containers must be made visible again and their badges refreshed so
   *     the accumulated file cards are visible.
   *  3. The "Continue to Schema Map" button enable/disable state is refreshed.
   */
  _refreshUploadView() {
    /* Re-show the correct sub-panel */
    _show('up-screen-choose', !State.source);
    _show('up-screen-local',  State.source === 'local');
    _show('up-screen-azure',  State.source === 'azure');

    /* Re-sync file list panels and badges */
    ['internal', 'vendor'].forEach(side => {
      const isInt  = side === 'internal';
      const arr    = State.files[side];
      const listEl = $(isInt ? 'int-file-info' : 'vnd-file-info');
      if (arr.length > 0) {
        if (listEl) listEl.style.display = 'block';
        _badge(isInt ? 'int-badge' : 'vnd-badge',
               arr.length + ' file' + (arr.length !== 1 ? 's' : '') + ' loaded',
               isInt ? 'badge-blue' : 'badge-purple');
      } else {
        if (listEl) listEl.style.display = 'none';
        _badge(isInt ? 'int-badge' : 'vnd-badge', 'Not loaded', 'badge-gray');
      }
    });

    /* Re-sync the Continue button (no toast on re-init) */
    this._checkBoth(false);
  },


  handleDrop(e, side) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    /* MULTI-FILE FIX: upload every dropped file, not just files[0] */
    const dropped = [...(e.dataTransfer.files || [])];
    dropped.forEach(f => this._upload(f, side));
  },

  handleFileSelect(e, side) {
    /* MULTI-FILE FIX: upload every selected file, not just files[0] */
    const selected = [...(e.target.files || [])];
    selected.forEach(f => this._upload(f, side));
    e.target.value = '';
  },

  async _upload(file, side) {
    const EXTS = ['.csv','.xlsx','.xls','.xlsm','.tsv','.txt','.zip'];
    const ext  = '.' + file.name.split('.').pop().toLowerCase();
    if (!EXTS.includes(ext)) { Toast.error(`Unsupported file type: ${ext}`); return; }
    if (file.size > 500 * 1024 * 1024) { Toast.error('File too large (max 500 MB)'); return; }

    /*
     * MULTI-FILE FIX: duplicate guard — skip if this exact filename is already
     * in the list for this side so re-selecting the same file is a no-op.
     */
    if (State.files[side].some(f => f.filename === file.name || f.originalName === file.name)) {
      Toast.warning(`"${file.name}" is already in the ${side} list.`);
      return;
    }

    const isInt   = side === 'internal';
    const badgeId = isInt ? 'int-badge' : 'vnd-badge';

    /* Create a per-file in-progress row inside the file list */
    const listId  = isInt ? 'int-file-info' : 'vnd-file-info';
    const listEl  = $(listId);
    if (listEl) listEl.style.display = 'block';

    /* Unique key for this upload row */
    const rowKey  = 'upload-row-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const color   = isInt ? '#2563eb' : '#7c3aed';

    const rowHtml = `
      <div id="${rowKey}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#f0f9ff;border-radius:8px;border:1px solid #bae6fd;margin-bottom:6px">
        <div style="width:36px;height:36px;border-radius:7px;background:${color};display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="ti ti-loader spin" style="color:#fff;font-size:16px"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(file.name)}">${_esc(file.name)}</div>
          <div style="margin-top:4px;height:4px;background:#e5e7eb;border-radius:2px">
            <div id="${rowKey}-bar" style="height:4px;background:${color};border-radius:2px;width:0%;transition:width .15s"></div>
          </div>
          <div id="${rowKey}-pct" style="font-size:10px;color:#6b7280;margin-top:2px">Uploading…</div>
        </div>
      </div>`;
    if (listEl) listEl.insertAdjacentHTML('beforeend', rowHtml);

    _badge(badgeId, 'Uploading…', isInt ? 'badge-blue' : 'badge-purple');

    try {
      const fd = new FormData(); fd.append('file', file);
      const data = await API.upload(`/files/upload/${side}`, fd, pct => {
        const b = $(rowKey + '-bar'); if (b) b.style.width = pct + '%';
        const p = $(rowKey + '-pct'); if (p) p.textContent = pct + '%';
      });

      /*
       * MULTI-FILE FIX: push to the array — never overwrite the whole array.
       * Attach rowKey so we can remove this specific DOM row later.
       */
      const entry = { ...data, _rowKey: rowKey };
      State.files[side].push(entry);

      /* Replace the uploading row with the completed card */
      this._replaceUploadRow(rowKey, side, entry);

      Toast.success(`${isInt ? 'Internal' : 'Vendor'} file added: ${file.name}`);
      this._updateStatus();
      this._checkBoth();
    } catch (err) {
      /* Mark the row as failed */
      const row = $(rowKey);
      if (row) row.innerHTML = `
        <div style="width:36px;height:36px;border-radius:7px;background:#fee2e2;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="ti ti-alert-circle" style="color:#ef4444;font-size:16px"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:12px;color:#ef4444;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(file.name)}</div>
          <div style="font-size:11px;color:#ef4444">${_esc(err.message)}</div>
        </div>
        <button onclick="document.getElementById('${rowKey}').remove()" style="background:none;border:none;cursor:pointer;color:#9ca3af;padding:4px;line-height:1"><i class="ti ti-x"></i></button>`;
      if (row) { row.style.background = '#fef2f2'; row.style.borderColor = '#fecaca'; }
      Toast.error('Upload failed: ' + err.message);
    }
  },

  /*
   * MULTI-FILE FIX: replaces the uploading-progress DOM row with the
   * completed file card that includes an individual remove button.
   */
  _replaceUploadRow(rowKey, side, data) {
    const row = $(rowKey); if (!row) return;
    const isInt = side === 'internal';
    const color = isInt ? '#2563eb' : '#7c3aed';
    const rowCount = (data.rowCount || data.rows || 0).toLocaleString();
    const colCount = (data.columns || []).length;
    const keys     = data.keyColumns || [];
    const previewId = `preview-${rowKey}`;

    /* Update the overall side badge to reflect loaded count */
    const count = State.files[side].length;
    _badge(isInt ? 'int-badge' : 'vnd-badge',
           count + ' file' + (count !== 1 ? 's' : '') + ' loaded',
           isInt ? 'badge-blue' : 'badge-purple');

    row.style.background  = '#f0fdf4';
    row.style.borderColor = '#bbf7d0';
    row.style.display = 'block';
    
    // Build schema columns list
    const schemaCols = (data.schema?.columns || data.columns || []);
    const previewRows = (data.preview?.rows || []).slice(0, 10);
    
    row.innerHTML = `
      <div style="width:36px;height:36px;border-radius:7px;background:${color};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <i class="ti ti-file-check" style="color:#fff;font-size:16px"></i>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(data.filename||data.originalName||'')}">${_esc(data.filename||data.originalName||'File')}</div>
        <div style="font-size:10px;color:#6b7280;margin-top:2px">${rowCount} rows · ${colCount} cols · ${_size(data.size)}</div>
        ${keys.length ? `<div style="margin-top:4px;display:flex;gap:3px;flex-wrap:wrap">${keys.slice(0,3).map(k=>`<span style="background:#dcfce7;color:#166534;padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700">${_esc(k)}</span>`).join('')}</div>` : ''}
        <button onclick="App._togglePreview('${previewId}')" style="margin-top:6px;background:none;border:1px solid #d1d5db;cursor:pointer;color:#374151;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600"><i class="ti ti-eye" style="font-size:10px"></i> Preview Schema & Data</button>
      </div>
      <button onclick="App._removeFile('${side}','${rowKey}')" style="background:none;border:none;cursor:pointer;color:#9ca3af;padding:4px;line-height:1;flex-shrink:0" title="Remove this file"><i class="ti ti-x"></i></button>
      <div id="${previewId}" style="display:none;margin-top:12px;padding:12px;background:#f8fafc;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
        <div style="font-weight:600;font-size:11px;color:#374151;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em"><i class="ti ti-layout-columns"></i> Schema (${schemaCols.length} columns)</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;font-size:10px">
          ${schemaCols.map(c=>`<span style="background:#e5e7eb;color:#374151;padding:2px 8px;border-radius:4px">${_esc(c)}</span>`).join('')}
        </div>
        <div style="font-weight:600;font-size:11px;color:#374151;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em"><i class="ti ti-table"></i> Preview (first 10 rows)</div>
        <div style="overflow-x:auto;border:1px solid #d1d5db;border-radius:6px;background:#fff">
          <table style="width:100%;font-size:9px;border-collapse:collapse">
            <thead style="background:#f1f5f9;border-bottom:1px solid #d1d5db">
              <tr>
                ${schemaCols.slice(0,6).map(c=>`<th style="padding:6px 8px;text-align:left;font-weight:600;color:#374151;border-right:1px solid #e5e7eb;white-space:nowrap">${_esc(c)}</th>`).join('')}
                ${schemaCols.length > 6 ? `<th style="padding:6px 8px;color:#9ca3af;font-weight:600">+${schemaCols.length - 6} more</th>` : ''}
              </tr>
            </thead>
            <tbody>
              ${previewRows.map((r,i) => `<tr style="border-bottom:1px solid #e5e7eb;${i%2?'background:#f9fafb':''}">
                ${schemaCols.slice(0,6).map(c=>`<td style="padding:4px 8px;border-right:1px solid #e5e7eb;color:#6b7280;overflow:hidden;text-overflow:ellipsis;max-width:150px;white-space:nowrap" title="${_esc(String(r[c]??''))}">${_esc(String(r[c]??''))}</td>`).join('')}
                ${schemaCols.length > 6 ? `<td style="padding:4px 8px;color:#9ca3af;font-size:8px">...</td>` : ''}
              </tr>`).join('')}
              ${previewRows.length === 0 ? `<tr><td colspan="${Math.min(7,schemaCols.length+1)}" style="padding:20px;text-align:center;color:#9ca3af;font-size:10px">No data rows</td></tr>` : ''}
            </tbody>
          </table>
        </div>
      </div>`;
  },
  
  _togglePreview(previewId) {
    const el = $(previewId);
    if (el) {
      const isHidden = el.style.display === 'none';
      el.style.display = isHidden ? 'block' : 'none';
    }
  },

  /*
   * MULTI-FILE FIX: _removeFile removes one specific file from the list by
   * its _rowKey.  _clearAllFiles wipes the entire side.
   */
  _removeFile(side, rowKey) {
    State.files[side] = State.files[side].filter(f => f._rowKey !== rowKey);
    const row = $(rowKey); if (row) row.remove();

    const isInt  = side === 'internal';
    const count  = State.files[side].length;
    const listEl = $(isInt ? 'int-file-info' : 'vnd-file-info');

    if (count === 0) {
      if (listEl) { listEl.style.display = 'none'; listEl.innerHTML = ''; }
      _badge(isInt ? 'int-badge' : 'vnd-badge', 'Not loaded', 'badge-gray');
    } else {
      _badge(isInt ? 'int-badge' : 'vnd-badge',
             count + ' file' + (count !== 1 ? 's' : '') + ' loaded',
             isInt ? 'badge-blue' : 'badge-purple');
    }
    this._updateStatus();
    this._checkBoth();
  },

  _clearAllFiles(side) {
    State.files[side] = [];
    const isInt  = side === 'internal';
    const listEl = $(isInt ? 'int-file-info' : 'vnd-file-info');
    if (listEl) { listEl.style.display = 'none'; listEl.innerHTML = ''; }
    _badge(isInt ? 'int-badge' : 'vnd-badge', 'Not loaded', 'badge-gray');
    this._updateStatus();
    this._checkBoth();
  },

  /* BUG-FIX + MULTI-FILE FIX: _checkBoth now checks array lengths */
  _checkBoth(showToast = true) {
    const ok = State.files.internal.length > 0 && State.files.vendor.length > 0;
    _disabled('btn-next-schema', !ok);
    _disabled('az-next-btn', !ok);
    /* Only show the 'ready' toast when called after an actual upload, not on view re-init */
    if (ok && showToast) Toast.info('Both sides have files — click "Continue to Schema Map".');
  },

  /* ── SCHEMA MAP ─────────────────────────────────────────────────────────── */
  async goToSchema() {
    /* MULTI-FILE FIX: check arrays have entries; use _primaryFile for API calls */
    if (!_primaryFile('internal') || !_primaryFile('vendor')) { Toast.warning('Load both files first'); return; }
    Progress.show('Analysing schemas…', 30);
    try {
      /*
       * MULTI-FILE FIX: pass all uploaded filenames so the backend can
       * return a merged column list across every file on each side.
       * Falls back gracefully if the backend only supports single-file
       * schema (it will use the last-uploaded file as before).
       */
      const _fileList = side => [...State.files[side]]
        .reverse()                                     // primary (last uploaded) first
        .map(f => f.filename || f.originalName || f.name)
        .filter(Boolean);

      const [intInfo, vndInfo] = await Promise.all([
        API.post('/files/info/internal', { files: _fileList('internal') }).catch(() => API.get('/files/info/internal')),
        API.post('/files/info/vendor',   { files: _fileList('vendor')   }).catch(() => API.get('/files/info/vendor')),
      ]);
      /* Merge schema info back into the primary (last) entry of each side */
      const iArr = State.files.internal, vArr = State.files.vendor;
      iArr[iArr.length - 1] = { ...iArr[iArr.length - 1], ...intInfo };
      vArr[vArr.length - 1] = { ...vArr[vArr.length - 1], ...vndInfo };
      this._renderSchema(intInfo, vndInfo);
      Progress.hide();
      this.showView('schema');
    } catch (err) { Progress.hide(); Toast.error('Schema error: ' + err.message); }
  },

  _renderSchema(intInfo, vndInfo) {
    const iCols = intInfo.columns || [], vCols = vndInfo.columns || [];
    _text('int-col-count', iCols.length + ' cols');
    _text('vnd-col-count', vCols.length + ' cols');

    const mkList = (cols, types, color) => cols.map(c =>
      `<div style="padding:3px 6px;border-radius:4px;font-size:12px;display:flex;align-items:center;gap:6px;margin-bottom:1px">
        <code style="color:${color};font-size:11px">${_esc(c)}</code>
        <span style="font-size:10px;color:#9ca3af;margin-left:auto">${_esc((types||{})[c]||'')}</span>
      </div>`
    ).join('');

    const iList = $('int-schema-list'), vList = $('vnd-schema-list');
    if (iList) iList.innerHTML = mkList(iCols, intInfo.columnTypes, '#2563eb');
    if (vList) vList.innerHTML = mkList(vCols, vndInfo.columnTypes, '#7c3aed');

    this._buildMappingRows(iCols, vCols);
  },

  _buildMappingRows(iCols, vCols) {
    const c = $('mapping-rows'); if (!c) return;
    c.innerHTML = '';
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const used = new Set(), pairs = [];
    iCols.forEach(ic => {
      const vc = vCols.find(v => !used.has(v) && norm(v) === norm(ic));
      if (vc) { used.add(vc); pairs.push({ i: ic, v: vc }); }
    });
    if (!pairs.length && iCols.length && vCols.length) pairs.push({ i: iCols[0], v: vCols[0] });
    State.mappings = pairs.map(p => ({ internal: p.i, vendor: p.v }));
    pairs.forEach(p => this._addMapRow(p.i, p.v, iCols, vCols));
    _text('mapping-stats', pairs.length + ' mapped');
    _show('mapping-empty', !pairs.length);
  },

  _addMapRow(iv, vv, iCols, vCols) {
    /* MULTI-FILE FIX: fall back to primary file's columns */
    if (!iCols) iCols = _primaryFile('internal')?.columns || [];
    if (!vCols) vCols = _primaryFile('vendor')?.columns   || [];
    const c = $('mapping-rows'); if (!c) return;
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const conf = iv && vv ? (norm(iv) === norm(vv) ? 'Exact' : 'Fuzzy') : '—';
    const confBadge = iv && vv
      ? (conf === 'Exact' ? '<span class="badge badge-match">Exact</span>' : '<span class="badge badge-amber">Fuzzy</span>')
      : '';
    const row = $el('div', { class: 'map-row' });
    row.innerHTML = `
      <select class="map-sel-int" style="font-size:12px">
        <option value="">— Internal —</option>
        ${iCols.map(col => `<option value="${_esc(col)}"${col===iv?' selected':''}>${_esc(col)}</option>`).join('')}
      </select>
      <i class="ti ti-arrows-right-left" style="color:#9ca3af;text-align:center"></i>
      <select class="map-sel-vnd" style="font-size:12px">
        <option value="">— Vendor —</option>
        ${vCols.map(col => `<option value="${_esc(col)}"${col===vv?' selected':''}>${_esc(col)}</option>`).join('')}
      </select>
      <div style="text-align:center">${confBadge}</div>
      <button class="btn btn-sm btn-ghost" onclick="this.closest('.map-row').remove();App._syncMapStats()" title="Remove"><i class="ti ti-x"></i></button>`;
    c.appendChild(row);
  },

  _syncMapStats() { _text('mapping-stats', document.querySelectorAll('.map-row').length + ' mapped'); },

  addMappingRow() { this._addMapRow('', '', null, null); },

  async autoSuggestMappings() {
    if (!_primaryFile('internal') || !_primaryFile('vendor')) { Toast.warning('Load both files first'); return; }
    Progress.show('Auto-suggesting column mappings…', 40);
    try {
      /* MULTI-FILE FIX: pass all files so backend can suggest from merged schema */
      const _fileList = side => [...State.files[side]]
        .reverse()
        .map(f => f.filename || f.originalName || f.name)
        .filter(Boolean);

      const data = await API.post('/comparison/suggest-mappings', {
        internalFiles: _fileList('internal'),
        vendorFiles:   _fileList('vendor'),
      });
      Progress.hide();
      if (!data.mappings?.length) { Toast.warning('No strong matches found — add mappings manually.'); return; }
      const c = $('mapping-rows'); if (c) c.innerHTML = '';
      State.mappings = data.mappings;
      data.mappings.forEach(m => this._addMapRow(m.internal, m.vendor, _primaryFile('internal')?.columns, _primaryFile('vendor')?.columns));
      _text('mapping-stats', data.mappings.length + ' mapped');
      Toast.success(`${data.mappings.length} mappings suggested (avg. ${Math.round(data.avgConfidence || 0)}% confidence)`);
    } catch (err) { Progress.hide(); Toast.error('Auto-suggest failed: ' + err.message); }
  },

  saveMappingConfig() {
    State.mappings = [...document.querySelectorAll('.map-row')]
      .map(r => ({ internal: r.querySelector('.map-sel-int')?.value, vendor: r.querySelector('.map-sel-vnd')?.value }))
      .filter(m => m.internal && m.vendor);
    Toast.success(`Saved ${State.mappings.length} column mappings`);
  },

  /* ── CONFIGURE ──────────────────────────────────────────────────────────── */
  _populateConfigure() {
    /* MULTI-FILE FIX: read columns from the primary (last) file per side */
    const iCols = _primaryFile('internal')?.columns || [];
    const vCols = _primaryFile('vendor')?.columns   || [];
    const all   = [...new Set([...iCols, ...vCols])];

    const fillMulti = (id, cols, autoKey) => {
      const el = $(id); if (!el) return;
      const prev = [...el.selectedOptions].map(o => o.value);
      el.innerHTML = cols.map(c =>
        `<option value="${_esc(c)}"${(prev.includes(c) || (autoKey && !prev.length && _isKey(c))) ? ' selected' : ''}>${_esc(c)}</option>`
      ).join('');
    };
    fillMulti('int-key-select',     iCols, true);
    fillMulti('vnd-key-select',     vCols, true);
    fillMulti('ignore-cols-select', all,   false);

    const ig = $('filter-int-optgroup'), vg = $('filter-vnd-optgroup');
    /*
     * FILTER FIX: add data-source on each option so filterColChanged()
     * can determine the side even if the optgroup IDs are absent.
     */
    if (ig) ig.innerHTML = iCols.map(c => `<option value="${_esc(c)}" data-source="internal">${_esc(c)}</option>`).join('');
    if (vg) vg.innerHTML = vCols.map(c => `<option value="${_esc(c)}" data-source="vendor">${_esc(c)}</option>`).join('');
  },

  toggleFilterPanel(el) {
    el.classList.toggle('on');
    _show('filter-panel-body', el.classList.contains('on'));
  },

  async filterColChanged() {
    const sel = $('filter-col-select');
    const col = sel?.value;
    _show('filter-value-area', !!col);
    if (!col) return;

    /*
     * FILTER FIX: determine which file side owns this column.
     * Primary: check the option's own data-source attribute (set by
     * _populateConfigure).  Fallback: check the parent <optgroup> ID.
     * Final fallback: 'internal'.
     */
    const opt    = sel.options[sel.selectedIndex];
    const grp    = opt?.parentElement;
    const source = opt?.dataset?.source
                || (grp?.id === 'filter-int-optgroup' ? 'internal'
                 :  grp?.id === 'filter-vnd-optgroup' ? 'vendor'
                 :  'internal');

    /* Stash the resolved source so addFilterRule() can read it */
    sel.dataset.selectedSource = source;

    try {
      /* Pass the source so the backend reads the correct file */
      const data = await API.post('/comparison/filter-values', { column: col, source });
      State.filterValues = data.values || [];
      this._renderFilterVals(State.filterValues);
    } catch (err) { Toast.error('Failed to load values: ' + err.message); }
  },

  _renderFilterVals(vals) {
    const list = $('filter-val-list'); if (!list) return;
    list.innerHTML = vals.map(v =>
      `<label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 8px;border-bottom:1px solid #f3f4f6;cursor:pointer">
        <input type="checkbox" value="${_esc(String(v))}" checked> ${_esc(String(v))}
      </label>`
    ).join('');
    _text('filter-val-count', `(${vals.length} values)`);
  },

  filterValSearch(q)  { this._renderFilterVals(State.filterValues.filter(v => String(v).toLowerCase().includes(q.toLowerCase()))); },
  filterSelectAll()   { document.querySelectorAll('#filter-val-list input').forEach(cb => cb.checked = true); },
  filterClearAll()    { document.querySelectorAll('#filter-val-list input').forEach(cb => cb.checked = false); },

  addFilterRule() {
    const sel  = $('filter-col-select');
    const col  = sel?.value;
    const vals = [...document.querySelectorAll('#filter-val-list input:checked')].map(cb => cb.value);
    if (!col)         { Toast.warning('Select a column first'); return; }
    if (!vals.length) { Toast.warning('Select at least one value'); return; }

    /*
     * FILTER FIX: persist the source side (internal/vendor) with the rule.
     * Falls back to 'internal' so legacy behaviour is unchanged when the
     * attribute is absent.
     */
    const source = sel.dataset.selectedSource || 'internal';
    State.filterRules.push({ column: col, values: vals, source });
    this._renderFilterRules();
    Toast.success(`Filter added: ${col} (${vals.length} values, ${source})`);
  },

  _renderFilterRules() {
    const list = $('filter-rules-list');
    const wrap = $('active-filter-chips');
    const chips= $('filter-chips-container');
    if (!list) return;

    /*
     * FILTER FIX: display the source side alongside column name so the
     * user can tell which file each filter applies to.
     */
    const srcLabel = src => src === 'vendor'
      ? '<span style="background:#ede9fe;color:#5b21b6;font-size:9px;padding:1px 5px;border-radius:3px;font-weight:700;margin-left:4px">VND</span>'
      : '<span style="background:#dbeafe;color:#1e40af;font-size:9px;padding:1px 5px;border-radius:3px;font-weight:700;margin-left:4px">INT</span>';

    list.innerHTML = State.filterRules.map((r, i) =>
      `<div style="display:flex;align-items:center;gap:8px;background:#f0f9ff;padding:7px 10px;border-radius:7px;margin-bottom:4px;font-size:12px;border:1px solid #bae6fd">
        <i class="ti ti-filter" style="color:#0284c7;flex-shrink:0"></i>
        <span style="flex:1"><strong>${_esc(r.column)}</strong>${srcLabel(r.source)} ∈ [${r.values.slice(0,3).map(_esc).join(', ')}${r.values.length>3?'…':''}]</span>
        <button class="btn btn-sm btn-ghost" onclick="App._rmFilter(${i})"><i class="ti ti-x"></i></button>
      </div>`
    ).join('');
    if (wrap)  wrap.style.display  = State.filterRules.length ? '' : 'none';
    if (chips) chips.innerHTML = State.filterRules.map((r, i) =>
      `<span class="chip chip-gray" style="cursor:pointer" onclick="App._rmFilter(${i})">${_esc(r.column)}${r.source==='vendor'?' [V]':' [I]'} ×</span>`
    ).join('');
  },

  _rmFilter(i) { State.filterRules.splice(i, 1); this._renderFilterRules(); },

  /* ── RUN COMPARISON ─────────────────────────────────────────────────────── */
  async runComparison() {
    /* MULTI-FILE FIX: guard on primary file existence */
    if (!_primaryFile('internal') || !_primaryFile('vendor')) { Toast.warning('Load both files first.'); this.showView('upload'); return; }
    this.saveMappingConfig();

    /* BUG-FIX: use _toggle() to read toggle state safely (null-safe boolean) */
    const intKey = [...($('int-key-select')?.selectedOptions || [])].map(o => o.value).filter(Boolean)[0] || '';
    const vndKey = [...($('vnd-key-select')?.selectedOptions || [])].map(o => o.value).filter(Boolean)[0] || '';
    const ignore = [...($('ignore-cols-select')?.selectedOptions || [])].map(o => o.value);

    /*
     * FILTER FIX: send each filter rule with its resolved source side.
     * Rules without an explicit source default to 'internal' so that
     * legacy saved rules (no source field) still work.
     * The structure sent to the API is:
     *   { column: string, values: string[], source: 'internal'|'vendor' }
     * The backend uses `source` to decide which dataset to filter.
     */
    const filtersWithSource = State.filterRules.map(r => ({
      column: r.column,
      values: r.values,
      source: r.source || 'internal',
    }));

    /*
     * MULTI-FILE FIX: send the full list of uploaded filenames for each side
     * so the backend can read and concatenate every file, not just the last
     * one that was uploaded.  Each entry uses `filename` (server-side name)
     * or falls back to `originalName`.
     *
     * internalFiles / vendorFiles: string[] of server-side filenames.
     * The primary file (last uploaded) is always first so the backend can
     * use it for schema resolution if needed.
     */
    const _fileList = side => {
      const arr = [...State.files[side]];
      // Put the primary (last) file first so backend uses it for schema
      if (arr.length > 1) {
        const last = arr.pop();
        arr.unshift(last);
      }
      return arr.map(f => f.filename || f.originalName || f.name).filter(Boolean);
    };

    const body = {
      mappings:          State.mappings,
      keyColumnInternal: intKey,
      keyColumnVendor:   vndKey,
      /*
       * Multi-file arrays — backend should read and union all files listed.
       * Single-file sessions send a 1-element array; behaviour is identical.
       */
      internalFiles:     _fileList('internal'),
      vendorFiles:       _fileList('vendor'),
      options: {
        caseInsensitive: _toggle('opt-case',      true),
        trimWhitespace:  _toggle('opt-trim',      true),
        normalize:       _toggle('opt-normalize', false),
        ignoreColumns:   ignore,
      },
      filters: filtersWithSource,
    };

    Progress.show('Submitting comparison job…', 8);
    try {
      const { jobId } = await API.post('/comparison/run', body);
      State.jobId = jobId;
      this._pollJob(jobId);
    } catch (err) { Progress.hide(); Toast.error('Failed to start: ' + err.message); }
  },

  _pollJob(jobId) {
    if (State.jobPollInterval) clearInterval(State.jobPollInterval);
    let polls = 0;
    State.jobPollInterval = setInterval(async () => {
      polls++;
      try {
        const job = await API.get(`/comparison/job/${jobId}`);
        if (job.status === 'running' || job.status === 'pending') {
          Progress.update(job.message || 'Processing…', Math.min(92, 10 + (job.progress || 0)));
        } else if (job.status === 'complete') {
          clearInterval(State.jobPollInterval);
          Progress.update('Loading results…', 96);
          await this._fetchResults();
          Progress.hide();
          Toast.success('Comparison complete!');
          this.showView('results');
          this._updateStatus();
        } else if (job.status === 'failed') {
          clearInterval(State.jobPollInterval);
          Progress.hide();
          Toast.error('Comparison failed: ' + (job.error || 'Unknown error'));
        } else if (polls > 300) {
          clearInterval(State.jobPollInterval);
          Progress.hide();
          Toast.error('Comparison timed out after 7.5 minutes.');
        }
      } catch (err) {
        clearInterval(State.jobPollInterval);
        Progress.hide();
        Toast.error('Poll error: ' + err.message);
      }
    }, 1500);
  },

  async _fetchResults() {
    const data = await API.get('/comparison/results?section=summary');
    State.comparisonResult = data;
  },

  /* ── RESULTS VIEW ──────────────────────────────────────────────────────── */
  _showResultsEmpty() { _show('results-empty', true); _show('results-content', false); },

  _renderResults() {
    const r = State.comparisonResult;
    const s = r?.summary;
    if (!s) { this._showResultsEmpty(); return; }
    _show('results-empty',   false);
    _show('results-content', true);

    /* Metrics strip */
    const mEl = $('results-metrics');
    if (mEl) mEl.innerHTML = [
      { label:'Total Internal',  val: s.totalInternal,                        color:'var(--blue)'  },
      { label:'Matched Exact',   val: s.matchedExact || s.matched,            color:'#10b981'      },
      { label:'With Diffs',      val: s.mismatched   || s.withDifferences||0, color:'#f59e0b'      },
      { label:'Missing Vendor',  val: s.missingInVendor,                      color:'#ef4444'      },
      { label:'Extra in Vendor', val: s.extraInVendor,                        color:'#8b5cf6'      },
    ].map(m => `<div class="metric metric-top" style="border-top-color:${m.color}"><div class="metric-val" style="color:${m.color}">${(m.val||0).toLocaleString()}</div><div class="metric-lbl">${m.label}</div></div>`).join('');

    /* Match rate bar */
    const rate = s.totalInternal > 0 ? Math.round((s.matched||0) / s.totalInternal * 100) : 0;
    const bar = $('match-rate-bar'); if (bar) bar.style.width = rate + '%';
    _text('match-rate-val', rate + '%');
    const badgeEl = $('match-rate-badge');
    if (badgeEl) {
      badgeEl.textContent = rate>=90?'Excellent':rate>=70?'Good':rate>=50?'Fair':'Poor';
      badgeEl.className   = `badge badge-${rate>=90?'match':rate>=70?'warn':'diff'}`;
    }

    /* Context chips — show all loaded files, not just the primary one */
    const _fileLabel = side => {
      const arr = State.files[side];
      if (!arr || arr.length === 0) return side === 'internal' ? 'Internal' : 'Vendor';
      if (arr.length === 1) return arr[0].filename || arr[0].originalName || (side === 'internal' ? 'Internal' : 'Vendor');
      return `${arr[0].filename || arr[0].originalName || ''} +${arr.length - 1} more`;
    };
    _html('ctx-int-file', `<i class="ti ti-building"></i> ${_esc(_fileLabel('internal'))}`);
    _html('ctx-vnd-file', `<i class="ti ti-handshake"></i> ${_esc(_fileLabel('vendor'))}`);
    _text('ctx-timestamp', 'at ' + new Date().toLocaleTimeString());

    this._renderSummaryTab(s, r?.schema);
    this._renderCharts(s);
    this._renderRecommendations(s);
    this.loadDetailPage(1);
  },

  _renderSummaryTab(s, schema) {
    const tbody = $('summary-counts-tbody');
    if (tbody) tbody.innerHTML = [
      ['Total Records',   s.totalInternal,                        s.totalVendor],
      ['Matched (exact)', s.matchedExact||s.matched,              s.matchedExact||s.matched],
      ['Mismatched',      s.mismatched||s.withDifferences||0,     s.mismatched||s.withDifferences||0],
      ['Missing / Extra', s.missingInVendor,                      s.extraInVendor],
      ['Duplicates',      s.duplicatesInternal||0,                s.duplicatesVendor||0],
    ].map(([l,a,b])=>`<tr><td>${l}</td><td><strong>${(a||0).toLocaleString()}</strong></td><td><strong>${(b||0).toLocaleString()}</strong></td></tr>`).join('');

    const sg = $('schema-summary-grid');
    if (sg && s.schemaSummary) {
      sg.innerHTML = [
        { val: s.schemaSummary.common,       label:'Shared',        color:'#10b981' },
        { val: s.schemaSummary.internalOnly, label:'Internal Only', color:'#ef4444' },
        { val: s.schemaSummary.vendorOnly,   label:'Vendor Only',   color:'#f59e0b' },
      ].map(m=>`<div class="metric metric-top" style="border-top-color:${m.color}"><div class="metric-val" style="color:${m.color}">${m.val||0}</div><div class="metric-lbl">${m.label}</div></div>`).join('');
    }

    const td = $('top-diffs-tbody');
    if (td && s.topDiffColumns?.length) {
      td.innerHTML = s.topDiffColumns.map(d => {
        const pct = s.matched > 0 ? Math.round(d.count/s.matched*100) : 0;
        return `<tr><td><strong>${_esc(d.column)}</strong></td><td>${d.count.toLocaleString()}</td><td>${pct}%</td><td><div style="background:#e5e7eb;border-radius:4px;height:6px;width:120px"><div style="width:${Math.min(100,pct)}%;background:#6366f1;height:6px;border-radius:4px"></div></div></td></tr>`;
      }).join('');
    }
  },

  _renderCharts(s) {
    Object.values(State.charts).forEach(c => { try { c.destroy(); } catch {} });
    State.charts = {};
    if (typeof Chart === 'undefined') return;

    const pie = $('pie-chart');
    if (pie) {
      State.charts.pie = new Chart(pie, {
        type: 'doughnut',
        data: { labels:['Matched Exact','Mismatched','Missing','Extra'], datasets:[{ data:[s.matchedExact||s.matched, s.mismatched||s.withDifferences||0, s.missingInVendor, s.extraInVendor], backgroundColor:['#10b981','#f59e0b','#ef4444','#8b5cf6'], borderWidth:2, borderColor:'#fff' }] },
        options: { responsive:true, plugins:{ legend:{ position:'bottom', labels:{ font:{ size:11 }, padding:12 } } } },
      });
    }

    const bar = $('bar-chart');
    if (bar && s.topDiffColumns?.length) {
      State.charts.bar = new Chart(bar, {
        type: 'bar',
        data: { labels:s.topDiffColumns.map(d=>d.column), datasets:[{ label:'Diff Count', data:s.topDiffColumns.map(d=>d.count), backgroundColor:'#6366f1', borderRadius:5 }] },
        options: { responsive:true, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true } } },
      });
    }
  },

  _renderRecommendations(s) {
    const el = $('recommendations-list'); if (!el) return;
    const rate = s.totalInternal > 0 ? Math.round((s.matched||0)/s.totalInternal*100) : 0;
    const recs = [];
    if (rate < 80)              recs.push({t:'error',   m:`Low match rate (${rate}%). Verify key column in Configure.`});
    if (s.missingInVendor > 0)  recs.push({t:'warning', m:`${s.missingInVendor.toLocaleString()} internal records missing from vendor.`});
    if (s.extraInVendor > 0)    recs.push({t:'info',    m:`${s.extraInVendor.toLocaleString()} vendor records have no internal match.`});
    if ((s.mismatched||s.withDifferences||0) > 0) recs.push({t:'warning', m:`${(s.mismatched||s.withDifferences||0).toLocaleString()} matched records have field differences.`});
    if ((s.duplicatesInternal||0)+(s.duplicatesVendor||0) > 0) recs.push({t:'warning', m:`Duplicate keys: ${s.duplicatesInternal||0} internal, ${s.duplicatesVendor||0} vendor.`});
    if (!recs.length) recs.push({t:'success', m:'Excellent result — no critical issues found.'});
    const BG={error:'#fee2e2',warning:'#fef3c7',info:'#dbeafe',success:'#dcfce7'};
    const FG={error:'#991b1b',warning:'#92400e',info:'#1e40af',success:'#166534'};
    const IC={error:'ti-alert-circle',warning:'ti-alert-triangle',info:'ti-info-circle',success:'ti-check-circle'};
    el.innerHTML = recs.map(r=>`<div style="display:flex;gap:10px;padding:12px;background:${BG[r.t]};border-radius:8px;margin-bottom:8px"><i class="ti ${IC[r.t]}" style="color:${FG[r.t]};flex-shrink:0;margin-top:1px"></i><span style="color:${FG[r.t]};font-size:13px">${r.m}</span></div>`).join('');
  },

  /* ── DETAIL TABLE ───────────────────────────────────────────────────────── */
  async loadDetailPage(page) {
    if (page != null) State.pagination.detail.page = page;
    if (!State.comparisonResult) return;
    const p  = State.pagination.detail;
    const ps = parseInt($('detail-page-size')?.value || '100');
    const q  = $('detail-search')?.value || '';
    const st = $('detail-status-filter')?.value || '';
    try {
      const data = await API.get(`/comparison/results?section=detail&page=${p.page}&pageSize=${ps}${q?'&search='+encodeURIComponent(q):''}${st?'&status='+st:''}`);
      const rows = data.rows || [], total = data.total || 0, cols = data.columns || [];
      const tbody = $('detail-tbody');
      if (tbody) {
        const thead = tbody.closest('table')?.querySelector('thead tr');
        if (thead && cols.length) {
          // Group columns into internal and vendor columns for side-by-side display
          const internalCols = [];
          const vendorCols = [];
          cols.forEach(c => {
            if (!c.startsWith('_')) {
              internalCols.push(c);
              vendorCols.push(c);
            }
          });
          // Build header with side-by-side internal/vendor columns
          let headerHtml = '<th style="min-width:80px;background:#f1f5f9">Status</th><th style="min-width:100px;background:#f1f5f9">Key</th>';
          if (internalCols.length > 0 || vendorCols.length > 0) {
            // Show first 5 columns from each side
            const displayCols = 5;
            headerHtml += '<th colspan="' + (displayCols * 2 + 1) + '" style="text-align:center;background:#f1f5f9;padding:8px;font-size:11px;border-bottom:2px solid var(--border)">Comparison Data</th></tr><tr><th style="min-width:80px;background:#f1f5f9">Status</th><th style="min-width:100px;background:#f1f5f9">Key</th>';
            for (let i = 0; i < Math.max(internalCols.length, vendorCols.length); i++) {
              if (i < displayCols) {
                const intCol = internalCols[i] || '';
                const vndCol = vendorCols[i] || '';
                if (intCol) headerHtml += `<th class="tbl-internal-header" style="color:#1e40af">Internal_${_esc(intCol)}</th>`;
                if (vndCol) headerHtml += `<th class="tbl-vendor-header" style="color:#4c1d95">Vendor_${_esc(vndCol)}</th>`;
              }
            }
            if (internalCols.length > displayCols || vendorCols.length > displayCols) {
              headerHtml += '<th style="background:#f1f5f9">More</th>';
            }
          }
          thead.innerHTML = headerHtml;
        }
        if (rows.length === 0) {
          const colSpan = 2 + (Math.max(5, (cols.length || 0)) * 2) + 1;
          tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center;padding:32px;color:#6b7280;font-size:13px"><i class="ti ti-inbox" style="font-size:24px;display:block;margin-bottom:8px;opacity:.4"></i>No records match the current filter</td></tr>`;
        } else {
          const displayCols = 5;
          tbody.innerHTML = rows.map(r => {
            const st2 = r._status || 'matched';
            const statusBadge = {matched:'<span class="badge badge-match">✓ Matched</span>',mismatch:'<span class="badge badge-warn">⚠ Mismatch</span>',missing:'<span class="badge badge-diff">✗ Missing</span>',extra:'<span class="badge badge-extra">+ Extra</span>'}[st2]||'<span class="badge badge-gray">Unknown</span>';
            let rowHtml = `<tr class="row-${st2}"><td style="font-weight:600">${statusBadge}</td><td><code style="font-size:10px;background:#f3f4f6;padding:2px 6px;border-radius:4px">${_esc(String(r._key||''))}</code></td>`;
            // Show first 5 columns for each side
            for (let i = 0; i < displayCols; i++) {
              const col = cols[i] || '';
              const val = r[col] ?? '';
              rowHtml += `<td style="font-size:12px;color:#1e40af">${_esc(String(val))}</td>`;
              rowHtml += `<td style="font-size:12px;color:#4c1d95">${_esc(String(val))}</td>`;
            }
            if (cols.length > displayCols) {
              rowHtml += '<td style="color:#9ca3af;font-size:10px">+' + (cols.length - displayCols) + ' more</td>';
            }
            rowHtml += '</tr>';
            return rowHtml;
          }).join('');
        }
      }
      const pages = Math.ceil(total/(ps||100))||1;
      _text('detail-page-info', `Page ${p.page}/${pages} · ${total.toLocaleString()} records`);
      _disabled('detail-prev-btn', p.page <= 1);
      _disabled('detail-next-btn', p.page >= pages);
    } catch(err) {
      const tbody = $('detail-tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:24px;color:#ef4444;font-size:12px"><i class="ti ti-alert-circle"></i> ${_esc(err.message || 'Failed to load results')}</td></tr>`;
      console.error('[Detail] loadDetailPage error:', err);
    }
  },

  /* FILTER FIX: called from HTML onchange on detail-status-filter — resets to page 1 */
  detailStatusFilter() { this.loadDetailPage(1); },

  /* BUG-FIX: detailSearch is called with a value arg from oninput; use _debounce properly */
  detailSearch: _debounce(function(_val) { App.loadDetailPage(1); }, 400),

  detailChangePage(dir) {
    State.pagination.detail.page = Math.max(1, State.pagination.detail.page + dir);
    this.loadDetailPage();
  },

  /* ── SKU TABLE ──────────────────────────────────────────────────────────── */
  async loadSkuPage(page) {
    if (page != null) State.pagination.sku.page = page;
    if (!State.comparisonResult) return;
    const p  = State.pagination.sku;
    const q  = $('sku-search')?.value || '';
    const st = $('sku-status-filter')?.value || '';
    try {
      const data = await API.get(`/comparison/results?section=detail&page=${p.page}&pageSize=${p.pageSize}${q?'&search='+encodeURIComponent(q):''}${st?'&status='+st:''}`);
      const s  = State.comparisonResult?.summary;
      const mEl = $('sku-metrics');
      if (mEl && s) mEl.innerHTML = [
        {label:'Missing',   val:s.missingInVendor,                          color:'#ef4444'},
        {label:'Extra',     val:s.extraInVendor,                            color:'#f59e0b'},
        {label:'Mismatched',val:s.mismatched||s.withDifferences||0,         color:'#8b5cf6'},
        {label:'Dup Keys',  val:(s.duplicatesInternal||0)+(s.duplicatesVendor||0), color:'#6b7280'},
      ].map(m=>`<div class="metric metric-top" style="border-top-color:${m.color}"><div class="metric-val" style="color:${m.color}">${(m.val||0).toLocaleString()}</div><div class="metric-lbl">${m.label}</div></div>`).join('');

      const tbody = $('sku-tbody');
      if (tbody) {
        if ((data.rows||[]).length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:#6b7280;font-size:13px"><i class="ti ti-inbox" style="font-size:24px;display:block;margin-bottom:8px;opacity:.4"></i>No records match the current filter</td></tr>';
        } else {
          tbody.innerHTML = (data.rows||[]).map(r => {
            const st2 = r._status || 'matched';
            const badge={matched:'<span class="badge badge-match">Matched</span>',mismatch:'<span class="badge badge-warn">Mismatch</span>',missing:'<span class="badge badge-diff">Missing</span>',extra:'<span class="badge badge-extra">Extra</span>'}[st2]||'';
            const key = r._key || (Object.values(r).find(v => v && String(v).length < 80 && !String(v).startsWith('_'))) || '—';
            return `<tr class="row-${st2}"><td>${badge}</td><td><code style="font-size:12px">${_esc(String(key))}</code></td><td>${st2==='missing'?'Internal Only':st2==='extra'?'Vendor Only':'Both'}</td><td>${r._diffCount||''}</td></tr>`;
          }).join('');
        }
      }

      const pages = Math.ceil((data.total||0)/p.pageSize)||1;
      _text('sku-page-info', `${(data.total||0).toLocaleString()} records · Page ${p.page}/${pages}`);
      if (page === 1) this._renderDuplicates();
    } catch(err) {
      const tbody = $('sku-tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:24px;color:#ef4444;font-size:12px"><i class="ti ti-alert-circle"></i> ${_esc(err.message || 'Failed to load SKU data')}</td></tr>`;
      console.error('[SKU] loadSkuPage error:', err);
    }
  },

  async _renderDuplicates() {
    try {
      const data = await API.get('/comparison/results?section=duplicates&page=1&pageSize=50');
      const tbody = $('dup-tbody'); if (!tbody) return;
      const rows = data.rows || [];
      tbody.innerHTML = rows.length
        ? rows.map(d=>`<tr><td><span class="badge badge-${d.source==='Internal'?'blue':'purple'}">${_esc(d.source)}</span></td><td><code style="font-size:12px">${_esc(d.key)}</code></td><td><strong>${d.count}</strong></td></tr>`).join('')
        : '<tr><td colspan="3" style="text-align:center;color:#9ca3af;padding:16px">No duplicates detected</td></tr>';
    } catch {}
  },

  skuChangePage(dir) { State.pagination.sku.page = Math.max(1, State.pagination.sku.page + dir); this.loadSkuPage(); },

  /* ── DIFF TABLE ─────────────────────────────────────────────────────────── */
  async loadDiffPage(page) {
    if (page != null) State.pagination.diff.page = page;
    if (!State.comparisonResult) return;
    const p   = State.pagination.diff;
    const col = $('diff-col-filter')?.value || '';
    try {
      const data = await API.get(`/comparison/results?section=diffs&page=${p.page}&pageSize=50${col?'&col='+encodeURIComponent(col):''}`);
      const tbody = $('diff-tbody');
      if (tbody) tbody.innerHTML = (data.rows||[]).map(r=>`<tr><td><code style="font-size:12px">${_esc(String(r.key??''))}</code></td><td><code style="font-size:11px;color:#6366f1">${_esc(String(r.column??''))}</code></td><td class="diff-cell-old">${_esc(String(r.internalValue??''))}</td><td class="diff-cell-new">${_esc(String(r.vendorValue??''))}</td></tr>`).join('');

      const sel = $('diff-col-filter');
      if (sel && data.availableColumns?.length && sel.options.length <= 1) {
        data.availableColumns.forEach(c => { const o = document.createElement('option'); o.value=c; o.textContent=c; sel.appendChild(o); });
      }

      const mEl = $('diff-metrics');
      if (mEl && data.summary) {
        const ds = data.summary;
        mEl.innerHTML = [
          {label:'Total Diffs',   val:ds.total,   color:'#ef4444'},
          {label:'Cols Affected', val:ds.columns, color:'#8b5cf6'},
          {label:'Rows Affected', val:ds.records, color:'#f59e0b'},
          {label:'Diff Rate',     val:(ds.diffRate||0)+'%', color:'#6366f1'},
        ].map(m=>`<div class="metric metric-top" style="border-top-color:${m.color}"><div class="metric-val" style="color:${m.color}">${(m.val||0).toLocaleString()}</div><div class="metric-lbl">${m.label}</div></div>`).join('');
      }

      const pages = Math.ceil((data.total||0)/50)||1;
      _text('diff-page-info', `${(data.total||0).toLocaleString()} differences · Page ${p.page}/${pages}`);
    } catch(err) {
      const tbody = $('diff-tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:24px;color:#ef4444;font-size:12px"><i class="ti ti-alert-circle"></i> ${_esc(err.message || 'Failed to load diff data')}</td></tr>`;
      console.error('[Diff] loadDiffPage error:', err);
    }
  },

  diffChangePage(dir) { State.pagination.diff.page = Math.max(1, State.pagination.diff.page + dir); this.loadDiffPage(); },

  /* ── CATEGORY ANALYSIS ──────────────────────────────────────────────────── */
  /* BUG-FIX: always repopulate (removed stale-cache guard) */
  _populateCatBrand() {
    /* MULTI-FILE FIX: use primary file columns */
    const iCols = _primaryFile('internal')?.columns || [];
    const vCols = _primaryFile('vendor')?.columns   || [];
    const fillSel = (id, cols) => {
      const e = $(id); if (!e) return;
      const cur = e.value;
      e.innerHTML = '<option value="">— select —</option>' + cols.map(c=>`<option${c===cur?' selected':''}>${_esc(c)}</option>`).join('');
    };
    fillSel('cat-int-col', iCols); fillSel('cat-vnd-col', vCols);
    const fillMulti = (id, cols) => {
      const e = $(id); if (!e) return;
      const prevSel = [...e.selectedOptions].map(o => o.value);
      e.innerHTML = cols.map(c=>`<option${prevSel.includes(c)?' selected':''}>${_esc(c)}</option>`).join('');
    };
    fillMulti('brand-int-cols', iCols); fillMulti('brand-vnd-cols', vCols);
  },

  async runCategoryAnalysis() {
    const iCol = $('cat-int-col')?.value, vCol = $('cat-vnd-col')?.value;
    if (!iCol || !vCol) { Toast.warning('Select both internal and vendor columns'); return; }
    /* MULTI-FILE FIX */
    if (!_primaryFile('internal') || !_primaryFile('vendor')) { Toast.warning('Load both files first'); return; }
    Progress.show('Running category analysis…', 40);
    try {
      const data = await API.post('/comparison/brand-analysis', { column: iCol, vendorColumn: vCol, type: 'category' });
      Progress.hide();
      _show('cat-results', true);
      const tbody = $('cat-tbody');
      if (tbody) tbody.innerHTML = (data.results||[]).map(r => {
        const diff = (r.internalCount||0) - (r.vendorCount||0);
        const diffBadge = diff===0 ? '<span class="badge badge-match">Match</span>' : `<span class="badge badge-${diff>0?'diff':'extra'}">${diff>0?'+':''}${diff}</span>`;
        return `<tr><td><strong>${_esc(String(r.value||''))}</strong></td><td>${(r.internalCount||0).toLocaleString()}</td><td>${(r.vendorCount||0).toLocaleString()}</td><td>${diffBadge}</td><td><span class="badge badge-${(r.matchRate||0)>=90?'match':'warn'}">${r.matchRate||0}%</span></td></tr>`;
      }).join('');
      Toast.success(`${(data.results||[]).length} categories analysed`);
    } catch (err) { Progress.hide(); Toast.error('Category analysis failed: ' + err.message); }
  },

  exportCategoryAnalysis() { this.exportSection('diffs', 'csv'); },

  /* ── BRAND ANALYSIS ─────────────────────────────────────────────────────── */
  async runBrandAnalysis() {
    const brands = ($('brand-input')?.value||'').split('\n').map(s=>s.trim()).filter(Boolean);
    if (!brands.length) { Toast.warning('Enter at least one brand name'); return; }
    /* MULTI-FILE FIX */
    if (!_primaryFile('internal') || !_primaryFile('vendor')) { Toast.warning('Load both files first'); return; }
    const iCols = [...($('brand-int-cols')?.selectedOptions||[])].map(o=>o.value);
    const vCols = [...($('brand-vnd-cols')?.selectedOptions||[])].map(o=>o.value);
    if (!iCols.length) { Toast.warning('Select at least one internal column to search'); return; }
    Progress.show('Running brand analysis…', 40);
    try {
      const data = await API.post('/comparison/brand-analysis', { brands, internalColumns:iCols, vendorColumns:vCols, type:'brand' });
      Progress.hide();
      _show('brand-results', true);
      const tbody = $('brand-tbody');
      if (tbody) tbody.innerHTML = (data.results||[]).map(r => {
        const rate = r.matchPct||r.matchRate||0, diff=(r.internalCount||0)-(r.vendorCount||0);
        return `<tr><td><strong>${_esc(String(r.brand||r.value||''))}</strong></td><td>${(r.internalCount||0).toLocaleString()}</td><td>${(r.vendorCount||0).toLocaleString()}</td><td>${diff>=0?'+':''}<strong style="color:${diff>=0?'var(--green)':'var(--red)'}">${diff}</strong></td><td><div style="display:flex;align-items:center;gap:8px"><div style="flex:1;background:#e5e7eb;border-radius:4px;height:6px;min-width:60px"><div style="width:${Math.min(100,rate)}%;background:${rate>=90?'var(--green)':rate>=70?'var(--amber)':'var(--red)'};height:6px;border-radius:4px"></div></div><span style="font-size:11px;width:32px;text-align:right">${rate}%</span></div></td></tr>`;
      }).join('');
      Toast.success(`${brands.length} brands analysed`);
    } catch (err) { Progress.hide(); Toast.error('Brand analysis failed: ' + err.message); }
  },

  exportBrandResults() { this.exportSection('matched', 'csv'); },

  /* ── EXPORT ─────────────────────────────────────────────────────────────── */
  _updateExportView() {
    const has = !!State.comparisonResult;
    _show('export-no-results', !has);
    _show('export-ready',      has);
  },

  /*
   * EXPORT FIX: _exportPayload() builds the enriched body that every export
   * call should include so the backend can produce complete side-by-side
   * output with both Internal and Vendor columns.
   *
   * Fields added:
   *   mappings          — all column-pair relationships configured by the user
   *   keyColumnInternal — internal key column
   *   keyColumnVendor   — vendor key column
   *   internalFiles     — full list of uploaded internal filenames
   *   vendorFiles       — full list of uploaded vendor filenames
   *   internalFileName  — display name of the primary internal file
   *   vendorFileName    — display name of the primary vendor file
   *
   * The backend should use this to:
   *   1. Re-read all files for column metadata
   *   2. Include both the internal and vendor value columns for every mapping
   *   3. Label columns clearly (e.g. "INT_EcommerceRegularPrice" / "VND_Original_Price")
   */
  _exportPayload() {
    const _fileList = side => {
      const arr = [...State.files[side]];
      if (arr.length > 1) { const last = arr.pop(); arr.unshift(last); }
      return arr.map(f => f.filename || f.originalName || f.name).filter(Boolean);
    };
    const intKey = [...($('int-key-select')?.selectedOptions || [])].map(o => o.value).filter(Boolean)[0] || '';
    const vndKey = [...($('vnd-key-select')?.selectedOptions || [])].map(o => o.value).filter(Boolean)[0] || '';
    return {
      mappings:          State.mappings,
      keyColumnInternal: intKey,
      keyColumnVendor:   vndKey,
      internalFiles:     _fileList('internal'),
      vendorFiles:       _fileList('vendor'),
      internalFileName:  _primaryFile('internal')?.filename || _primaryFile('internal')?.originalName || '',
      vendorFileName:    _primaryFile('vendor')?.filename   || _primaryFile('vendor')?.originalName   || '',
    };
  },

  async exportSection(section, format) {
    if (!State.comparisonResult) { Toast.warning('Run a comparison first'); return; }
    Progress.show(`Generating ${section} ${format.toUpperCase()}…`, 50);
    try {
      /* EXPORT FIX: include mappings and file metadata so backend produces full paired output */
      const data = await API.post('/export/generate', { section, format, ...this._exportPayload() });
      Progress.hide();
      if (data.filename) { _triggerDownload(`/api/export/download/${data.filename}`, data.filename); Toast.success('Download starting…'); }
    } catch (err) { Progress.hide(); Toast.error('Export failed: ' + err.message); }
  },

  async exportFull(format) {
    if (!State.comparisonResult) { Toast.warning('Run a comparison first'); return; }
    Progress.show(`Generating ${format.toUpperCase()} report…`, 20);
    try {
      /* EXPORT FIX: include mappings and file metadata for complete paired output */
      const data = await API.post('/export/generate', { section:'all', format, ...this._exportPayload() });
      Progress.hide();
      if (data.filename) { _triggerDownload(`/api/export/download/${data.filename}`, data.filename); Toast.success('Report ready — downloading…'); this.loadReportList(); }
    } catch (err) { Progress.hide(); Toast.error('Export failed: ' + err.message); }
  },

  quickExport() {
    if (!State.comparisonResult) { Toast.warning('Run a comparison first'); return; }
    this.exportFull('excel');
  },

  async loadReportList() {
    try {
      const data = await API.get('/export/list');
      const reports = data.reports || [];
      const tbody   = $('reports-tbody');
      const emptyEl = $('reports-empty');
      if (emptyEl) emptyEl.style.display = reports.length ? 'none' : '';
      if (!tbody) return;
      tbody.innerHTML = reports.map(r => {
        const icon  = r.format==='pdf'?'ti-file-type-pdf':r.format==='csv'?'ti-file-type-csv':'ti-file-spreadsheet';
        const color = r.format==='pdf'?'var(--red)':r.format==='csv'?'var(--amber)':'var(--green)';
        const fn    = _esc(r.filename);
        return `<tr>
          <td><i class="ti ${icon}" style="color:${color}"></i> ${fn}</td>
          <td><span class="badge badge-gray">${r.type||''}</span></td>
          <td>${_size(r.size)}</td>
          <td style="font-size:12px">${new Date(r.created).toLocaleString()}</td>
          <td>
            <button class="btn btn-sm btn-primary" onclick="_triggerDownload('/api/export/download/${fn}','${fn}')" title="Download"><i class="ti ti-download"></i></button>
            <button class="btn btn-sm btn-ghost"   onclick="App._delReport('${fn}')" title="Delete"><i class="ti ti-trash" style="color:var(--red)"></i></button>
          </td>
        </tr>`;
      }).join('');
    } catch (err) { Toast.error('Failed to load reports: ' + err.message); }
  },

  async _delReport(f) {
    if (!confirm('Delete ' + f + '?')) return;
    try { await API.del('/export/' + encodeURIComponent(f)); Toast.success('Deleted'); this.loadReportList(); }
    catch (err) { Toast.error(err.message); }
  },

  /* ── PERFORMANCE ────────────────────────────────────────────────────────── */
  _renderPerformance() {
    const s = State.comparisonResult?.summary;
    const mEl = $('perf-metrics');
    if (!mEl) return;
    const dur  = s?.durationMs  ? (s.durationMs/1000).toFixed(2)+'s'      : '—';
    const rps  = s?.rowsPerSec  ? s.rowsPerSec.toLocaleString()+' r/s'    : '—';
    const rows = s?.totalInternal ? ((s.totalInternal+s.totalVendor)||0).toLocaleString() : '—';
    const chnk = s?.chunksUsed || '—';
    mEl.innerHTML = [
      {label:'Last Run Time',  val:dur,  color:'var(--blue)'  },
      {label:'Throughput',     val:rps,  color:'var(--green)' },
      {label:'Rows Processed', val:rows, color:'var(--purple)'},
      {label:'Chunks Used',    val:chnk, color:'var(--amber)' },
    ].map(m=>`<div class="metric metric-top" style="border-top-color:${m.color}"><div class="metric-val" style="color:${m.color};font-size:22px">${m.val}</div><div class="metric-lbl">${m.label}</div></div>`).join('');

    const tl = $('perf-timeline');
    if (tl && s) {
      const STEPS = ['Filtering','Indexing','Matching','Extra Detection','Analytics'];
      const PCTS  = [5, 10, 55, 10, 20];
      tl.innerHTML = STEPS.map((step, i) => {
        const ms = s.durationMs ? Math.round(s.durationMs * PCTS[i] / 100) : '—';
        return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><div style="font-size:12px;width:130px;color:#374151">${step}</div><div style="flex:1;background:#e5e7eb;border-radius:4px;height:8px"><div style="width:${PCTS[i]}%;background:var(--blue);height:8px;border-radius:4px"></div></div><div style="font-size:11px;color:#6b7280;width:60px;text-align:right">${ms}ms</div></div>`;
      }).join('');
    }
  },

  /* ── ACTIVITY LOG ───────────────────────────────────────────────────────── */
  toggleActivityLog() {
    const p = $('activity-panel');
    if (!p) return;
    const open = p.style.display === 'flex';
    p.style.display = open ? 'none' : 'flex';
    if (!open) {
      Activity.unread = 0;
      const b = $('activity-unread'); if (b) b.style.display = 'none';
    }
  },

  async clearActivityLog() {
    try { await API.del('/activity/logs'); } catch {}
    const l = $('activity-log-list'); if (l) l.innerHTML = '';
    Toast.success('Activity log cleared');
  },

  /* ── RESET SESSION ──────────────────────────────────────────────────────── */
  async resetSession() {
    if (!confirm('Reset session? All data will be cleared.')) return;
    try { await API.del('/files/session/' + State.sessionId); } catch {}

    /* MULTI-FILE FIX: reset to empty arrays */
    State.files           = { internal: [], vendor: [] };
    State.mappings        = [];
    State.filterRules     = [];
    State.comparisonResult= null;
    State.jobId           = null;
    State.azure           = { connected:false, accountName:null, container:null, prefix:'', cache:{}, allFiles:[], filteredFiles:[], sortKey:'name', sortAsc:true, selectedBlob:null, files:{internal:[],vendor:[]}, searchQuery:'' };

    if (State.jobPollInterval) clearInterval(State.jobPollInterval);
    Object.values(State.charts).forEach(c => { try { c.destroy(); } catch {} });
    State.charts = {};

    /* Clear both file list panels */
    ['int-file-info','vnd-file-info'].forEach(id => { const e=$(id); if(e){e.style.display='none';e.innerHTML='';} });
    _badge('int-badge','Not loaded','badge-gray');
    _badge('vnd-badge','Not loaded','badge-gray');
    this._updateStatus();
    this.chooseSource(null);
    this.showView('upload');
    Toast.info('Session reset — ready for a new comparison.');
  },

  /* ── SIDEBAR STATUS ─────────────────────────────────────────────────────── */
  _updateStatus() {
    /* MULTI-FILE FIX: check array length, not truthiness of single object */
    _dot('sb-azure-dot','sb-azure-status', State.azure.connected,             'Azure: Connected',   'Azure: Not Connected');
    _dot('sb-int-dot',  'sb-int-status',   State.files.internal.length > 0,  'Internal: Loaded',   'Internal: No file');
    _dot('sb-vnd-dot',  'sb-vnd-status',   State.files.vendor.length > 0,    'Vendor: Loaded',     'Vendor: No file');
    _dot('sb-cmp-dot',  'sb-cmp-status',   !!State.comparisonResult,         'Comparison: Done',   'Comparison: Pending');
  },

  /* ═══════════════════════════════════════════════════════════════════════════
     AZURE STORAGE BROWSER
  ═══════════════════════════════════════════════════════════════════════════ */

  async azureConnect() {
    const connStr = $('az-conn-str')?.value?.trim();
    const accName = $('az-account-name')?.value?.trim();
    const accKey  = $('az-account-key')?.value?.trim();

    if (!connStr && (!accName || !accKey)) {
      Toast.warning('Provide a connection string or account name + key'); return;
    }

    const btn = $('az-connect-btn');
    if (btn) { btn.disabled=true; btn.innerHTML='<i class="ti ti-loader spin"></i> Connecting…'; }
    const errEl = $('az-connect-error');
    if (errEl) errEl.style.display='none';

    try {
      const result = await API.post('/azure/connect', { connectionString:connStr, accountName:accName, accountKey:accKey });
      State.azure.connected   = true;
      State.azure.accountName = result.accountName || accName || 'Unknown';

      _show('az-creds-form', false);
      /* BUG-FIX: az-info-bar needs display:flex not '' */
      _showFlex('az-info-bar', true);
      _show('az-disconnect-btn', true);
      _show('az-browser-panel', true);
      _show('az-select-panel',  true);
      _badge('az-status-badge', 'Connected', 'badge-match');
      _text('az-info-account', State.azure.accountName);

      this._updateStatus();
      Toast.success(`Connected to Azure: ${State.azure.accountName}`);
      await this.azureRefresh();
    } catch (err) {
      if (btn) { btn.disabled=false; btn.innerHTML='<i class="ti ti-plug"></i> Connect to Azure'; }
      if (errEl) {
        errEl.style.display='block';
        errEl.innerHTML=`<span style="color:#ef4444;font-size:12px;background:#fee2e2;padding:5px 9px;border-radius:5px;display:inline-flex;gap:6px;align-items:center"><i class="ti ti-alert-circle"></i>${_esc(err.message)}</span>`;
      }
      Toast.error('Azure connection failed: ' + err.message);
    }
  },

  async azureDisconnect() {
    if (!confirm('Disconnect from Azure Storage?')) return;
    try { await API.post('/azure/disconnect', {}); } catch {}
    State.azure = { connected:false, accountName:null, container:null, prefix:'', cache:{}, allFiles:[], filteredFiles:[], sortKey:'name', sortAsc:true, selectedBlob:null, files:{internal:[],vendor:[]}, searchQuery:'' };

    _show('az-creds-form', true);
    const ib = $('az-info-bar'); if (ib) ib.style.display='none';
    const cb = $('az-connect-btn'); if(cb){cb.style.display='';cb.disabled=false;cb.innerHTML='<i class="ti ti-plug"></i> Connect to Azure';}
    _show('az-disconnect-btn', false);
    _show('az-browser-panel', false);
    _show('az-select-panel',  false);
    _badge('az-status-badge','Disconnected','badge-gray');
    const sel=$('az-container-select'); if(sel) sel.innerHTML='<option value="">— select a container —</option>';
    this._azResetTree(); this._azClearFileList(); this._azUpdateCards();
    this._updateStatus();
    Toast.info('Disconnected from Azure');
  },

  async azureRefresh() {
    try {
      const data = await API.get('/azure/containers');
      State.azure.containers = data.containers || [];
      const sel = $('az-container-select');
      if (sel) {
        sel.innerHTML = '<option value="">— select a container —</option>' +
          State.azure.containers.map(c=>`<option value="${_esc(c.name)}">${_esc(c.name)}${c.publicAccess?' ✦':''}</option>`).join('');
      }
      const cnt = State.azure.containers.length;
      Toast.info(`${cnt} container${cnt!==1?'s':''} found`);
    } catch (err) { Toast.error('Failed to list containers: ' + err.message); }
  },

  async azureSelectContainer() {
    const container = $('az-container-select')?.value;
    if (!container) return;
    State.azure.container   = container;
    State.azure.prefix      = '';
    State.azure.cache       = {};
    State.azure.searchQuery = '';
    _text('az-info-container', container);
    _text('az-info-path',      'root');
    _show('az-search-bar', false);
    this._azUpdateBreadcrumb();
    this._azResetTree();
    this._azClearFileList();
    await this._azLoadFolder('', true);
  },

  /* BUG-FIX: alias for HTML button "onclick=App.azureSearch()" */
  azureSearch()    { this.azureToggleSearch(); },
  azureListBlobs() { return this.azureSelectContainer(); },

  async _azLoadFolder(prefix, intoTree) {
    const container = State.azure.container; if (!container) return;
    if (State.azure.cache[prefix]) {
      this._azRenderFolder(prefix, State.azure.cache[prefix], intoTree);
      return;
    }
    const treeEl = $('az-folder-tree'), rowsEl = $('az-file-rows');
    if (intoTree && treeEl) treeEl.innerHTML = '<div style="padding:20px;text-align:center;color:#6b7280;font-size:12px"><i class="ti ti-loader spin"></i> Loading…</div>';
    if (rowsEl) rowsEl.innerHTML = '<div style="padding:32px;text-align:center;color:#6b7280;font-size:12px"><i class="ti ti-loader spin"></i> Loading…</div>';
    try {
      const data = await API.get(`/azure/folders/${encodeURIComponent(container)}?prefix=${encodeURIComponent(prefix)}`);
      State.azure.cache[prefix] = data;
      this._azRenderFolder(prefix, data, intoTree);
    } catch (err) {
      if (treeEl) treeEl.innerHTML = `<div style="padding:12px;color:#ef4444;font-size:12px">${_esc(err.message)}</div>`;
      Toast.error('Failed to load folder: ' + err.message);
    }
  },

  _azRenderFolder(prefix, data, intoTree) {
    const { folders=[], files=[] } = data;
    if (prefix === State.azure.prefix) {
      State.azure.allFiles      = files;
      State.azure.filteredFiles = State.azure.searchQuery
        ? files.filter(f => (f.shortName||f.name||'').toLowerCase().includes(State.azure.searchQuery.toLowerCase()))
        : [...files];
      this._azRenderFileList();
    }
    if (intoTree) this._azRenderTree(folders, prefix);
  },

  _azRenderTree(folders, prefix) {
    const treeEl = $('az-folder-tree'); if (!treeEl) return;
    const rootActive = State.azure.prefix === '' ? 'az-tree-active' : '';
    let html = `<div class="az-tree-item ${rootActive}" onclick="App._azNav('')" style="padding:7px 8px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:7px;cursor:pointer;margin-bottom:2px;font-weight:600">
      <i class="ti ti-home-2" style="color:var(--purple);font-size:13px"></i><span style="flex:1">/ root</span>
    </div>`;
    folders.forEach(f => { html += this._azFolderNodeHTML(f); });
    treeEl.innerHTML = html || '<div style="color:#9ca3af;font-size:12px;padding:16px;text-align:center">No folders found</div>';
  },

  _azFolderNodeHTML(folder) {
    const isActive = State.azure.prefix === folder.path;
    return `<div class="az-tree-folder" data-pfx="${_esc(folder.path)}" style="margin-bottom:2px">
      <div class="az-tree-item ${isActive?'az-tree-active':''}" onclick="App._azNav('${_esc(folder.path)}')" style="padding:6px 8px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:7px;cursor:pointer">
        <i class="ti ti-chevron-right" style="font-size:11px;color:#9ca3af;transition:transform .15s;flex-shrink:0"></i>
        <i class="ti ti-folder" style="color:#f59e0b;flex-shrink:0"></i>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(folder.name)}">${_esc(folder.shortName||folder.name)}</span>
      </div>
      <div class="az-tree-children" style="display:none;padding-left:14px;border-left:2px solid #e5e7eb;margin:2px 0 2px 10px"></div>
    </div>`;
  },

  async _azNav(prefix) {
    State.azure.prefix      = prefix;
    State.azure.searchQuery = '';
    const si = $('az-search-input'); if (si) si.value='';
    _show('az-search-bar', false);
    _text('az-info-path', prefix || 'root');
    this._azUpdateBreadcrumb();

    document.querySelectorAll('.az-tree-item').forEach(e => e.classList.remove('az-tree-active'));
    const activeNode = prefix === ''
      ? document.querySelector('.az-tree-item')
      : document.querySelector(`.az-tree-folder[data-pfx="${CSS.escape(prefix)}"] .az-tree-item`);
    if (activeNode) activeNode.classList.add('az-tree-active');

    if (prefix) {
      const node = document.querySelector(`.az-tree-folder[data-pfx="${CSS.escape(prefix)}"]`);
      if (node) {
        const children = node.querySelector('.az-tree-children');
        const icon     = node.querySelector('.ti-chevron-right');
        if (children) children.style.display = children.style.display === 'block' ? 'none' : 'block';
        if (icon)     icon.style.transform   = (children?.style.display === 'block') ? 'rotate(90deg)' : '';
      }
    }

    const rowsEl = $('az-file-rows');
    if (rowsEl) rowsEl.innerHTML='<div style="padding:32px;text-align:center;color:#6b7280;font-size:12px"><i class="ti ti-loader spin"></i> Loading…</div>';
    await this._azLoadFolder(prefix, false);

    if (prefix && State.azure.cache[prefix]) {
      const node      = document.querySelector(`.az-tree-folder[data-pfx="${CSS.escape(prefix)}"]`);
      const childrenEl= node?.querySelector('.az-tree-children');
      if (childrenEl && !childrenEl.innerHTML.trim()) {
        childrenEl.innerHTML = State.azure.cache[prefix].folders.map(f => this._azFolderNodeHTML(f)).join('');
      }
    }
  },

  _azUpdateBreadcrumb() {
    const el = $('az-breadcrumb'); if (!el) return;
    const prefix    = State.azure.prefix;
    const container = State.azure.container || '';
    const parts = prefix ? prefix.replace(/\/$/, '').split('/') : [];
    let built='', html=`<span onclick="App._azNav('')" style="cursor:pointer;color:var(--purple);font-weight:600"><i class="ti ti-home"></i> ${_esc(container)}</span>`;
    parts.forEach((p, i) => {
      built += (built?'/':'') + p;
      const bp = built + '/';
      html += `<i class="ti ti-chevron-right" style="color:#9ca3af;font-size:10px"></i>`;
      html += i === parts.length-1
        ? `<strong><i class="ti ti-folder-open" style="color:#f59e0b"></i> ${_esc(p)}</strong>`
        : `<span onclick="App._azNav('${_esc(bp)}')" style="cursor:pointer;color:var(--purple)">${_esc(p)}</span>`;
    });
    el.style.display='flex';
    el.innerHTML=html;
  },

  _azResetTree() {
    const t=$('az-folder-tree');
    if(t) t.innerHTML='<div style="color:#9ca3af;font-size:12px;text-align:center;padding:28px"><i class="ti ti-folder-open" style="font-size:28px;display:block;margin-bottom:8px;opacity:.3"></i>Select a container to browse</div>';
    const bc=$('az-breadcrumb'); if(bc) bc.style.display='none';
  },

  _azClearFileList() {
    const rows=$('az-file-rows'), hdr=$('az-file-header'), cnt=$('az-file-count');
    if(rows) rows.innerHTML='<div style="padding:40px;text-align:center;color:#9ca3af;font-size:12px"><i class="ti ti-folder-open" style="font-size:32px;display:block;margin-bottom:8px;opacity:.3"></i>Select a folder to view files</div>';
    if(hdr) hdr.style.display='none';
    if(cnt) cnt.textContent='No folder selected';
    _show('az-preview-bar', false);
  },

  /* ─── AZURE FILE LIST RENDERING ──────────────────────────────────────────
   *
   * FIX: Replaced the inline JSON serialisation approach with a module-level
   * Map (_azFileMap).  Each file row stores only its numeric index as a data
   * attribute; onclick/button handlers call _azSelectFile(idx) or
   * _azQuickSet(side, idx) with that integer.  This eliminates all JSON
   * double-parse bugs and HTML-attribute escaping issues.
   *
   * The Map is cleared and rebuilt at the top of every _azRenderFileList()
   * call so it always mirrors the current sorted list exactly.
   *
   * Selection highlight is re-applied after every render by comparing
   * State.azure.selectedBlob.name against each file's name.
   */
  _azRenderFileList() {
    const files  = State.azure.filteredFiles || [];
    const rowsEl = $('az-file-rows'), hdrEl=$('az-file-header'), cntEl=$('az-file-count');
    /* BUG-FIX: az-sort-bar needs display:flex */
    const sortBar = $('az-sort-bar');
    if (sortBar) sortBar.style.display = 'flex';

    const sorted = [...files].sort((a, b) => {
      const k = State.azure.sortKey;
      const va = k==='size' ? (a.size||0) : k==='date' ? new Date(a.lastModified||0).getTime() : (a.shortName||a.name||'').toLowerCase();
      const vb = k==='size' ? (b.size||0) : k==='date' ? new Date(b.lastModified||0).getTime() : (b.shortName||b.name||'').toLowerCase();
      return State.azure.sortAsc ? (va>vb?1:va<vb?-1:0) : (va<vb?1:va>vb?-1:0);
    });

    ['name','size','date'].forEach(k => { const e=$(('sort-'+k+'-icon')); if(e) e.textContent=State.azure.sortKey===k?(State.azure.sortAsc?' ↑':' ↓'):''; });

    if (hdrEl) hdrEl.style.display = sorted.length ? 'grid' : 'none';
    if (cntEl) cntEl.textContent = `${sorted.length} file${sorted.length!==1?'s':''}${State.azure.searchQuery?' (filtered)':''}`;

    if (!sorted.length) {
      if (rowsEl) rowsEl.innerHTML=`<div style="padding:32px;text-align:center;color:#9ca3af;font-size:12px"><i class="ti ti-${State.azure.searchQuery?'search-off':'inbox'}" style="font-size:28px;display:block;margin-bottom:8px;opacity:.3"></i>${State.azure.searchQuery?'No files match your search':'No files in this folder'}</div>`;
      // Clear the map when there is nothing to show
      _azFileMap.clear();
      return;
    }

    // Rebuild the index map for this render pass
    _azFileMap.clear();
    sorted.forEach((f, idx) => _azFileMap.set(idx, f));

    if (rowsEl) rowsEl.innerHTML = sorted.map((f, idx) => this._azFileRowHTML(f, idx)).join('');
  },

  /*
   * _azFileRowHTML(f, idx)
   *
   * FIX: onclick and button handlers now receive the numeric `idx` only.
   * No JSON is embedded in the HTML.  The row element carries
   * data-az-idx for reference but the actual lookup goes through _azFileMap.
   */
  _azFileRowHTML(f, idx) {
    const SUPPORTED = ['csv','xlsx','xls','xlsm','tsv','txt','zip'];
    const ext = (f.ext||'').replace('.','').toLowerCase();
    const ok  = SUPPORTED.includes(ext) || f.supported === true || (f.supported !== false && ext === '');
    const icon = ext==='zip'?'ti-file-zip':['xlsx','xls','xlsm'].includes(ext)?'ti-file-spreadsheet':['csv','tsv'].includes(ext)?'ti-file-type-csv':'ti-file-text';

    /* MULTI-FILE FIX (Azure): check array membership */
    const isInt = (State.azure.files?.internal || []).some(s => s.name === f.name);
    const isVnd = (State.azure.files?.vendor   || []).some(s => s.name === f.name);
    const isSel = State.azure.selectedBlob?.name    === f.name;
    const mod   = f.lastModified ? new Date(f.lastModified).toLocaleDateString() : '—';

    const selectedStyle = isSel ? 'background:#eff6ff;border-left:3px solid var(--blue);' : '';
    const selectedClass = isSel ? ' az-row-selected' : '';

    return `<div class="az-file-row${selectedClass}" data-az-idx="${idx}" data-name="${_esc(f.name)}"
      onclick="App._azSelectFile(${idx})"
      style="display:grid;grid-template-columns:1fr 80px 110px 90px;gap:8px;padding:7px 12px;border-bottom:1px solid #f3f4f6;cursor:${ok?'pointer':'default'};opacity:${ok?1:0.5};${selectedStyle}align-items:center;transition:background .1s">
      <div style="display:flex;align-items:center;gap:8px;overflow:hidden">
        <i class="ti ${icon}" style="color:${ok?'#6366f1':'#9ca3af'};font-size:15px;flex-shrink:0"></i>
        <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:${ok?'500':'400'}" title="${_esc(f.name)}">${_esc(f.shortName||f.name)}</span>
        ${isInt?'<span style="background:#dbeafe;color:#1e40af;font-size:9px;padding:1px 5px;border-radius:99px;white-space:nowrap;flex-shrink:0">INT</span>':''}
        ${isVnd?'<span style="background:#ede9fe;color:#4c1d95;font-size:9px;padding:1px 5px;border-radius:99px;white-space:nowrap;flex-shrink:0">VND</span>':''}
        ${!ok?'<span style="background:#f3f4f6;color:#9ca3af;font-size:9px;padding:1px 5px;border-radius:99px;white-space:nowrap;flex-shrink:0">unsupported</span>':''}
      </div>
      <div style="font-size:11px;color:#6b7280;text-align:right">${_size(f.size)}</div>
      <div style="font-size:11px;color:#6b7280">${mod}</div>
      <div style="display:flex;gap:4px">
        ${ok?`
          <button onclick="event.stopPropagation();App._azQuickSet('internal',${idx})" title="Set as Internal" style="background:#1d4ed8;color:#fff;border:none;border-radius:4px;padding:2px 6px;font-size:10px;cursor:pointer;font-weight:700">INT</button>
          <button onclick="event.stopPropagation();App._azQuickSet('vendor',${idx})"   title="Set as Vendor"   style="background:#7c3aed;color:#fff;border:none;border-radius:4px;padding:2px 6px;font-size:10px;cursor:pointer;font-weight:700">VND</button>
        `:''}
      </div>
    </div>`;
  },

  /*
   * _azSelectFile(idx)
   *
   * FIX: Receives a plain integer index.  Looks up the file object from
   * _azFileMap — no JSON parsing required.  Updates DOM highlight directly
   * on the clicked row element using data-az-idx, then stores the object in
   * State.azure.selectedBlob and shows the preview bar.
   */
  _azSelectFile(idx) {
    const f = _azFileMap.get(idx);
    if (!f) {
      console.warn('[Azure] _azSelectFile: no file at index', idx);
      return;
    }

    // Update highlight: clear all rows, apply to this one
    document.querySelectorAll('.az-file-row').forEach(r => {
      r.style.background  = '';
      r.style.borderLeft  = '';
      r.classList.remove('az-row-selected');
    });
    const el = document.querySelector(`.az-file-row[data-az-idx="${idx}"]`);
    if (el) {
      el.style.background = '#eff6ff';
      el.style.borderLeft = '3px solid var(--blue)';
      el.classList.add('az-row-selected');
    }

    State.azure.selectedBlob = f;
    console.log('[Azure] Selected blob:', f.name, f);
    this._azShowPreview(f);
  },

  _azShowPreview(f) {
    _show('az-preview-bar', true);
    _text('az-preview-name',     f.shortName || f.name || '');
    _text('az-preview-path',     f.name || '');
    _text('az-preview-size',     _size(f.size));
    _text('az-preview-modified', f.lastModified ? new Date(f.lastModified).toLocaleString() : '—');
  },

  /*
   * _azQuickSet(side, idx)
   *
   * FIX: Receives a plain integer index instead of a JSON string.  Resolves
   * the file object from _azFileMap, updates selectedBlob, shows the preview,
   * then calls azureSetSide(side, f) passing the resolved object directly so
   * that the function does not depend on selectedBlob being set first.
   */
  _azQuickSet(side, idx) {
    const f = _azFileMap.get(idx);
    if (!f) {
      console.warn('[Azure] _azQuickSet: no file at index', idx);
      Toast.error('Could not identify file — please try again.');
      return;
    }
    console.log('[Azure] Quick set', side, f.name, f);
    State.azure.selectedBlob = f;
    this._azShowPreview(f);
    this.azureSetSide(side, f);
  },

  /*
   * azureSetSide(side, fileOverride?)
   *
   * MULTI-FILE FIX (Azure): appends the file to State.azure.files[side]
   * array instead of overwriting.  Duplicate blobs (same .name) are
   * skipped.  _azUpdateCards() now renders the full list per side.
   */
  azureSetSide(side, fileOverride) {
    const f = fileOverride || State.azure.selectedBlob;
    if (!f) { Toast.warning('Select a file first'); return; }

    const SUPPORTED = ['csv','xlsx','xls','xlsm','tsv','txt','zip'];
    const ext = (f.ext || '').replace(/^\.+/, '').toLowerCase();

    if (f.supported === false || (ext !== '' && !SUPPORTED.includes(ext))) {
      Toast.error(`Unsupported file type: .${ext}`);
      return;
    }

    const entry = { ...f, container: f.container || State.azure.container || '' };

    /* Duplicate guard — skip if the same blob name is already staged */
    if (State.azure.files[side].some(s => s.name === entry.name)) {
      Toast.warning(`"${entry.shortName || entry.name}" is already staged as ${side}.`);
      return;
    }

    State.azure.files[side].push(entry);
    console.log('[Azure] Staged', side, '→', entry.name, '(total:', State.azure.files[side].length, ')');

    this._azUpdateCards();
    Toast.success(`${side === 'internal' ? 'Internal' : 'Vendor'} added: ${f.shortName || f.name}`);
    this._azRenderFileList();
  },

  /*
   * azureRemoveStaged(side, blobName) — remove one staged entry by name.
   * Called from the × button inside each staged-file chip in the card.
   */
  azureRemoveStaged(side, blobName) {
    State.azure.files[side] = State.azure.files[side].filter(f => f.name !== blobName);
    this._azUpdateCards();
    this._azRenderFileList();
  },

  azureClearSide(side) {
    /* MULTI-FILE FIX (Azure): reset to empty array */
    State.azure.files[side] = [];
    this._azUpdateCards();
    this._azRenderFileList();
    _disabled('az-load-btn', true);
    _disabled('az-next-btn', true);
  },

  _azUpdateCards() {
    /*
     * MULTI-FILE FIX (Azure): State.azure.files[side] is now an array.
     * Render each staged file as a removable chip inside the card panel.
     * The "empty" placeholder shows only when the array has 0 entries.
     */
    ['internal','vendor'].forEach(side => {
      const isInt    = side === 'internal';
      const arr      = State.azure.files[side];          // array
      const hasFiles = arr.length > 0;
      const color    = isInt ? '#2563eb' : '#7c3aed';

      _show(isInt ? 'az-int-card-empty'  : 'az-vnd-card-empty',  !hasFiles);
      _show(isInt ? 'az-int-card-filled' : 'az-vnd-card-filled',  hasFiles);
      _badge(isInt ? 'az-int-badge' : 'az-vnd-badge',
             hasFiles ? arr.length + ' file' + (arr.length !== 1 ? 's' : '') + ' staged' : 'Not set',
             hasFiles ? (isInt ? 'badge-blue' : 'badge-purple') : 'badge-gray');

      /* Render each staged file as a small chip row */
      const filledEl = $(isInt ? 'az-int-card-filled' : 'az-vnd-card-filled');
      if (filledEl && hasFiles) {
        filledEl.innerHTML = arr.map(f => {
          const safeName = _esc(f.name || '');
          const displayName = _esc(f.shortName || f.name || '');
          const meta = `${_size(f.size)} · ${(f.ext||'').replace(/^\.+/,'').toUpperCase()||'XLSX'}${f.lastModified ? ' · ' + new Date(f.lastModified).toLocaleDateString() : ''}`;
          const path = `${f.container||State.azure.container||''}/${f.name}`;
          return `
            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#f0fdf4;border-radius:7px;border:1px solid #bbf7d0;margin-bottom:5px">
              <div style="width:30px;height:30px;border-radius:6px;background:${color};display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="ti ti-file-check" style="color:#fff;font-size:13px"></i>
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:700;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${safeName}">${displayName}</div>
                <div style="font-size:10px;color:#6b7280;margin-top:1px">${_esc(meta)}</div>
                <div style="font-size:9px;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(path)}">${_esc(path)}</div>
              </div>
              <button onclick="App.azureRemoveStaged('${side}','${safeName}')" style="background:none;border:none;cursor:pointer;color:#9ca3af;padding:4px;line-height:1;flex-shrink:0" title="Remove"><i class="ti ti-x"></i></button>
            </div>`;
        }).join('');
      }
    });

    /* Enable Load/Next only when both sides have ≥1 staged file */
    const bothSet = State.azure.files.internal.length > 0 && State.azure.files.vendor.length > 0;
    _disabled('az-load-btn', !bothSet);
    _disabled('az-next-btn', !bothSet);
  },

  async azureLoadBoth() {
    const intStaged = State.azure.files.internal;
    const vndStaged = State.azure.files.vendor;
    if (!intStaged.length || !vndStaged.length) {
      Toast.warning('Stage at least one Internal and one Vendor file first'); return;
    }
    const prog = $('az-load-progress'), btn = $('az-load-btn');
    if (btn) btn.disabled = true;
    if (prog) { prog.style.display = 'block'; prog.innerHTML = '<i class="ti ti-loader spin"></i> Loading files from Azure…'; }

    /*
     * MULTI-FILE FIX (Azure): load every staged file sequentially.
     * Each successfully loaded file is appended to State.files[side]
     * (the main workflow array) via _renderAzureCard, exactly as before,
     * but now we loop over all staged entries rather than loading just one.
     */
    const _renderAzureCard = (side, raw) => {
      const entry = { ...raw, filename: raw.filename || raw.originalName, _rowKey: 'az-' + side + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) };
      /* Duplicate guard against the main workflow array */
      if (State.files[side].some(f => (f.filename || f.originalName) === entry.filename)) return;
      State.files[side].push(entry);
      const isInt  = side === 'internal';
      const listId = isInt ? 'int-file-info' : 'vnd-file-info';
      const listEl = $(listId);
      if (!listEl) return;
      listEl.style.display = 'block';
      const color    = isInt ? '#2563eb' : '#7c3aed';
      const rowCount = (entry.rowCount || entry.rows || 0).toLocaleString();
      const colCount = (entry.columns || []).length;
      const keys     = entry.keyColumns || [];
      const count    = State.files[side].length;
      _badge(isInt ? 'int-badge' : 'vnd-badge',
             count + ' file' + (count !== 1 ? 's' : '') + ' loaded',
             isInt ? 'badge-blue' : 'badge-purple');
      const card = document.createElement('div');
      card.id = entry._rowKey;
      card.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;margin-bottom:6px';
      card.innerHTML = `
        <div style="width:36px;height:36px;border-radius:7px;background:${color};display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="ti ti-file-check" style="color:#fff;font-size:16px"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(entry.filename||'')}">${_esc(entry.filename||'File')}</div>
          <div style="font-size:10px;color:#6b7280;margin-top:2px">${rowCount} rows · ${colCount} cols · ${_size(entry.size)}</div>
          ${keys.length ? `<div style="margin-top:4px;display:flex;gap:3px;flex-wrap:wrap">${keys.slice(0,3).map(k=>`<span style="background:#dcfce7;color:#166534;padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700">${_esc(k)}</span>`).join('')}</div>` : ''}
        </div>
        <button onclick="App._removeFile('${side}','${entry._rowKey}')" style="background:none;border:none;cursor:pointer;color:#9ca3af;padding:4px;line-height:1;flex-shrink:0" title="Remove this file"><i class="ti ti-x"></i></button>`;
      listEl.appendChild(card);
    };

    try {
      /* Load all staged internal files */
      for (const staged of intStaged) {
        if (prog) prog.innerHTML = `<i class="ti ti-loader spin"></i> Loading ${_esc(staged.shortName || staged.name)}…`;
        const data = await API.post('/azure/load', { container: staged.container, blob: staged.name, side: 'internal' });
        _renderAzureCard('internal', data);
      }
      /* Load all staged vendor files */
      for (const staged of vndStaged) {
        if (prog) prog.innerHTML = `<i class="ti ti-loader spin"></i> Loading ${_esc(staged.shortName || staged.name)}…`;
        const data = await API.post('/azure/load', { container: staged.container, blob: staged.name, side: 'vendor' });
        _renderAzureCard('vendor', data);
      }

      if (prog) prog.style.display = 'none';
      if (btn) btn.disabled = false;
      Toast.success(`${intStaged.length + vndStaged.length} Azure file(s) loaded — ready to map schema`);
      this._updateStatus();
      this._checkBoth();
    } catch (err) {
      if (btn) btn.disabled = false;
      if (prog) { prog.style.display = 'block'; prog.innerHTML = `<span style="color:#ef4444"><i class="ti ti-alert-circle"></i> ${_esc(err.message)}</span>`; }
      Toast.error('Azure load failed: ' + err.message);
    }
  },

  /* Azure search/sort/refresh */
  azureToggleSearch() {
    const bar=$('az-search-bar'); if(!bar) return;
    const showing = bar.style.display !== 'none' && bar.style.display !== '';
    if (showing) {
      bar.style.display='none';
      State.azure.searchQuery='';
      State.azure.filteredFiles=[...State.azure.allFiles];
      this._azRenderFileList();
    } else {
      bar.style.display='';
      $('az-search-input')?.focus();
    }
  },

  azureFilterFiles(q) {
    State.azure.searchQuery = q;
    const lo = q.toLowerCase();
    State.azure.filteredFiles = q ? State.azure.allFiles.filter(f=>(f.shortName||f.name||'').toLowerCase().includes(lo)) : [...State.azure.allFiles];
    this._azRenderFileList();
  },

  azureClearSearch() {
    const i=$('az-search-input'); if(i) i.value='';
    State.azure.searchQuery='';
    this.azureFilterFiles('');
    _show('az-search-bar', false);
  },

  azureSortFiles(key) {
    if (State.azure.sortKey === key) State.azure.sortAsc = !State.azure.sortAsc;
    else { State.azure.sortKey = key; State.azure.sortAsc = true; }
    this._azRenderFileList();
  },

  azureSort() { const s=$('az-sort-select'); if(s) this.azureSortFiles(s.value); },

  async azureRefreshFolder() {
    if (!State.azure.container) { await this.azureRefresh(); return; }
    delete State.azure.cache[State.azure.prefix];
    await this._azLoadFolder(State.azure.prefix, State.azure.prefix === '');
    Toast.info('Refreshed');
  },

}; /* end App */

/* ═══════════════════════════════════════════════════════════════════════════════
   DOM READY
═══════════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initSession();
  initTabs();

  /* Sidebar navigation */
  document.querySelectorAll('.sb-item[data-view]').forEach(item => {
    item.addEventListener('click', () => App.showView(item.dataset.view));
  });

  /* Step bar navigation */
  document.querySelectorAll('.step[data-view]').forEach(step => {
    step.addEventListener('click', () => App.showView(step.dataset.view));
  });

  /* view-upload already has class="view active" in HTML — App.showView cleans up on nav */
  App._updateStatus();

  /* Azure panels: start hidden */
  _show('az-browser-panel', false);
  _show('az-select-panel',  false);
  _show('az-disconnect-btn',false);
  _show('az-preview-bar',   false);
  const ib = $('az-info-bar');    if (ib) ib.style.display = 'none';
  const ap = $('activity-panel'); if (ap) ap.style.display = 'none';

  /* Chunk size slider label */
  const slider = $('chunk-size-slider');
  if (slider) {
    slider.addEventListener('input', () => {
      const v = $('chunk-val');
      if (v) v.textContent = Number(slider.value).toLocaleString() + ' rows';
    });
  }
});