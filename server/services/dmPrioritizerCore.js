// =============================================================================
//  dmPrioritizerCore.js - port of rd-decision-maker-prioritizer/scripts/process.py
//  (locked v1.0). Pure functions only: no database, no network, no model calls.
//
//  domain()   → PSL-aware registrable domain (offline, bundled suffix list)
//  prepare()  → validate headers, group rows by company, list model jobs
//  finalize() → apply selections, sort rows, append Domain + Priority
//  judge()    → preservation judge on the rows actually written back
// =============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { domainToASCII } = require('url');

const VERSION = '1.0.0';
const MAX_RANK = 10;
const LETTERS = 'ABCDEFGHIJ';
// Fields the ranking policy reads (sent to the model only when non-empty)
const MODEL_FIELDS = ['Title', 'Seniority', 'Departments', 'Sub Departments', '# Employees', 'Headline', 'Industry', 'Keywords',
  'Email Status', 'Company Country', 'Country', 'Subsidiary of'];

const str = (v) => (v === null || v === undefined ? '' : String(v));
const digest = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');

// ── Public suffix list ───────────────────────────────────────────────────────
let RULES = null;
function rules() {
  if (RULES) return RULES;
  RULES = new Set();
  const text = fs.readFileSync(path.join(__dirname, '..', 'assets', 'public_suffix_list.dat'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('//')) continue;
    const labels = s.split('.').map((x) => {
      if (x === '*') return x;
      const bang = x.startsWith('!') ? '!' : '';
      return bang + (domainToASCII(x.slice(bang.length)) || x.slice(bang.length));
    });
    RULES.add(labels.join('.'));
  }
  return RULES;
}

/** Website cell → registrable domain ('' when missing, invalid, IP or unsupported). */
function domain(value) {
  let s = str(value).trim();
  if (!s) return '';
  s = s.replace(/^https?s?:\/*/i, '//');
  if (s.includes('://') && !/^https?:\/\//i.test(s)) return '';
  let host;
  try { host = new URL('http:' + (s.startsWith('//') ? s : '//' + s)).hostname; } catch (e) { return ''; }
  host = host.replace(/\.$/, '').toLowerCase();
  if (!host || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return '';
  const labels = host.split('.');
  if (host.length > 253 || labels.some((x) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))) return '';
  const R = rules();
  let matched = 0; let exception = null;
  for (let i = 0; i < labels.length; i++) {
    const tail = labels.slice(i).join('.'); const n = labels.length - i;
    if (R.has('!' + tail)) { exception = n - 1; break; }
    if (R.has(tail)) matched = Math.max(matched, n);
    if (i > 0 && R.has('*.' + tail)) matched = Math.max(matched, n + 1);
  }
  const n = exception !== null ? exception : matched;
  return n && labels.length > n ? labels.slice(-n - 1).join('.') : '';
}

const normName = (v) => str(v).split(/\s+/).filter(Boolean).join(' ').toLowerCase();

/** Header contract: exact Title + Website / Company Name for Emails, no Domain/Priority. Throws on violation. */
function validateHeaders(headers) {
  const h = headers.map(str);
  if (!h.length) throw new Error('The sheet has no header row.');
  if (new Set(h).size !== h.length) throw new Error('Duplicate column headers - rename them first (nothing was guessed).');
  if (h.indexOf('Title') === -1 || (h.indexOf('Website') === -1 && h.indexOf('Company Name for Emails') === -1)) {
    throw new Error('Required columns missing: an exact "Title" column plus "Website" and/or "Company Name for Emails" (Apollo export headers).');
  }
  if (h.indexOf('Domain') !== -1 || h.indexOf('Priority') !== -1) throw new Error('The sheet already has a "Domain" or "Priority" column. Use the original export.');
}

/**
 * columns: header array, rows: array of cell arrays (original values, any type).
 * Returns { state, jobs, summary }. state is the immutable snapshot used by finalize/judge.
 */
function prepare(columns, rows) {
  validateHeaders(columns);
  const h = columns.map(str);
  if (!rows.length) throw new Error('The sheet has no data rows.');
  rows.forEach((r, i) => { if (r.length !== h.length) throw new Error(`Row ${i + 2} has ${r.length} cells but the header has ${h.length}. No automatic repair.`); });
  const col = (k) => h.indexOf(k);
  const get = (r, k) => (col(k) === -1 ? '' : str(r[col(k)]));

  const domains = rows.map((r) => domain(get(r, 'Website')));
  const names = rows.map((r) => normName(get(r, 'Company Name for Emails')));
  const links = new Map(); // name → Set(domains)
  domains.forEach((d, i) => { const n = names[i]; if (d && n) { if (!links.has(n)) links.set(n, new Set()); links.get(n).add(d); } });

  const keys = []; const duplicates = []; const groups = {}; const seen = new Set();
  rows.forEach((r, i) => {
    const d = domains[i]; const n = names[i];
    const key = d ? 'd:' + d
      : n && links.has(n) && links.get(n).size === 1 ? 'd:' + [...links.get(n)][0]
      : n ? 'n:' + n : 'u:' + i;
    keys.push(key);
    const identity = JSON.stringify([key, r.map(str)]);
    const dup = seen.has(identity); duplicates.push(dup); seen.add(identity);
    if (!dup && !key.startsWith('u:')) (groups[key] = groups[key] || []).push(i);
  });

  const automatic = {}; const jobs = [];
  for (const [k, ids] of Object.entries(groups)) {
    if (ids.length === 1) automatic[k] = ids;
    else {
      jobs.push({
        group: k,
        candidates: ids.map((i) => {
          const c = { id: i };
          MODEL_FIELDS.forEach((f) => { const v = get(rows[i], f); if (v) c[f] = v; });
          return c;
        })
      });
    }
  }
  const state = { version: VERSION, headers: h, rows, domains, keys, duplicates, groups, automatic };
  state.fingerprint = digest(state);
  const summary = {
    rows: rows.length, groups: Object.keys(groups).length, automatic_groups: Object.keys(automatic).length,
    model_groups: jobs.length, model_candidates: jobs.reduce((a, j) => a + j.candidates.length, 0),
    unresolved_rows: keys.filter((k) => k.startsWith('u:')).length, duplicate_copies: duplicates.filter(Boolean).length
  };
  return { state, jobs, summary };
}

/** One model answer for one group → null when valid, else the reason. */
function selectionError(state, group, ids) {
  const allowed = state.groups[group];
  if (!allowed) return 'unexpected group';
  if (!Array.isArray(ids) || ids.some((i) => !Number.isInteger(i))) return 'ids must be integers';
  if (ids.length !== Math.min(MAX_RANK, allowed.length)) return `expected ${Math.min(MAX_RANK, allowed.length)} ids, got ${ids.length}`;
  if (new Set(ids).size !== ids.length) return 'duplicate ids';
  const set = new Set(allowed);
  if (ids.some((i) => !set.has(i))) return 'id outside this group';
  return null;
}

function sortKey(state, i, rank) {
  const k = state.keys[i];
  return [{ d: 0, n: 1, u: 2 }[k[0]], k.startsWith('u:') ? '' : k.slice(2), rank || 'Z', i];
}
function cmp(a, b) {
  for (let x = 0; x < a.length; x++) { if (a[x] < b[x]) return -1; if (a[x] > b[x]) return 1; }
  return 0;
}

/**
 * decisions: { group key: [ids] } for every multi-contact group.
 * Returns { order, ranks, columns, rows } - rows are original cells + Domain + Priority.
 */
function finalize(state, decisions) {
  const selection = Object.assign({}, state.automatic);
  for (const [k, ids] of Object.entries(decisions || {})) {
    if (k in state.automatic) throw new Error('Duplicate or unexpected group: ' + k);
    const err = selectionError(state, k, ids);
    if (err) throw new Error(`Invalid selection for ${k}: ${err}`);
    selection[k] = ids;
  }
  const missing = Object.keys(state.groups).filter((k) => !(k in selection));
  if (missing.length) throw new Error(`Incomplete ranking: ${missing.length} company group(s) missing.`);
  const ranks = {};
  Object.values(selection).forEach((ids) => ids.forEach((i, j) => { ranks[i] = LETTERS[j]; }));
  const order = state.rows.map((_, i) => i).sort((a, b) => cmp(sortKey(state, a, ranks[a]), sortKey(state, b, ranks[b])));
  return {
    order, ranks,
    columns: state.headers.concat(['Domain', 'Priority']),
    rows: order.map((i) => state.rows[i].concat([state.domains[i], ranks[i] || '']))
  };
}

/** Preservation judge: compares the rows actually stored against the snapshot. Throws on any failure. */
function judge(state, order, columns, actual) {
  const n = state.headers.length;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(columns, state.headers.concat(['Domain', 'Priority'])) || actual.length !== state.rows.length) throw new Error('Judge: shape/header failure');
  const count = new Map();
  state.rows.forEach((r) => { const k = JSON.stringify(r); count.set(k, (count.get(k) || 0) + 1); });
  actual.forEach((r) => { const k = JSON.stringify(r.slice(0, n)); count.set(k, (count.get(k) || 0) - 1); });
  if ([...count.values()].some((v) => v !== 0)) throw new Error('Judge: original values/duplicates changed');
  const grouped = {};
  actual.forEach((r, x) => {
    const i = order[x];
    if (r.length !== n + 2 || !same(r.slice(0, n), state.rows[i]) || r[n] !== state.domains[i]) throw new Error('Judge: cell association/domain failure');
    const p = r[n + 1];
    if (p && (p.length !== 1 || LETTERS.indexOf(p) === -1 || state.duplicates[i] || state.keys[i].startsWith('u:'))) throw new Error('Judge: invalid priority');
    if (p) (grouped[state.keys[i]] = grouped[state.keys[i]] || []).push(p);
  });
  for (const [k, ids] of Object.entries(state.groups)) {
    if ((grouped[k] || []).join('') !== LETTERS.slice(0, Math.min(MAX_RANK, ids.length))) throw new Error('Judge: priority coverage/order failure');
  }
  const keys = actual.map((r, x) => sortKey(state, order[x], r[n + 1]));
  for (let x = 1; x < keys.length; x++) if (cmp(keys[x - 1], keys[x]) > 0) throw new Error('Judge: sorting failure');
}

/** Counts reported after a PASS (same fields as judge.json in the skill). */
function report(state, ranks) {
  const nameDomains = new Map();
  const col = state.headers.indexOf('Company Name for Emails');
  if (col !== -1) {
    state.rows.forEach((r, i) => {
      const d = state.domains[i]; if (!d) return;
      const nm = normName(r[col]); if (!nameDomains.has(nm)) nameDomains.set(nm, new Set()); nameDomains.get(nm).add(d);
    });
  }
  const groups = Object.entries(state.groups);
  return {
    status: 'PASS', original_cells_changed: 0, rows: state.rows.length, groups: groups.length,
    prioritized: Object.keys(ranks).length,
    beyond_top_ten: groups.reduce((a, [, ids]) => a + Math.max(0, ids.length - MAX_RANK), 0),
    duplicate_copies: state.duplicates.filter(Boolean).length,
    missing_invalid_websites: state.domains.filter((d) => !d).length,
    ambiguous_fallback_groups: groups.filter(([k]) => k.startsWith('n:') && (nameDomains.get(k.slice(2)) || new Set()).size > 1).length,
    unresolved_rows: state.keys.filter((k) => k.startsWith('u:')).length
  };
}

module.exports = { VERSION, MAX_RANK, MODEL_FIELDS, domain, validateHeaders, prepare, selectionError, finalize, judge, report, digest };
