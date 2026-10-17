// =============================================================================
//  decisionMaker.js - port of runDecisionMakerFilter / countDecisionMakerLeads /
//  matchesSubDepartment (Code.gs)
//
//  AI Prioritizer (optional, filters.aiPrioritize): scores every matched job
//  title 1-100 for decision-making authority with the same CHATGPT_API_KEY the
//  Company Name Cleaner uses, then keeps the highest-scoring people per company
//  (verification status still wins first). Scores are cached in dm_title_scores.
// =============================================================================
const { db } = require('../db');
const lists = require('./lists');
const activity = require('./activityLog');
const openai = require('./openai');

const DEFAULT_KEYWORDS = [
  'Chief', 'President', 'VP', 'Vice president', 'SVP', 'Head', 'Director',
  'Founder', 'Co-Founder', 'Owner', 'Co-Owner', 'CEO', 'Executive Director (ED)', 'COO',
  'CFO', 'CDO', 'CPO', 'CSO', 'CMO', 'CIO', 'Chief Advocacy Officer (CAO)',
  'Chief Impact Officer (CIO)', 'Chairperson of the Board', 'Vice Chairperson', 'Treasurer',
  'Secretary', 'Board Member', 'Program Director', 'Program Manager'
];

const TITLE_HEADERS    = ['Title', 'Job Title'];
const COMPANY_HEADERS  = ['Company', 'Company Name'];
const STATUS_HEADERS   = ['Status', 'Verification Status'];
const INDUSTRY_HEADERS = ['Industry', 'Sector'];
const COUNTRY_HEADERS  = ['Country', 'Location', 'Nation'];
const STATUS_PRIORITY  = ['safe', 'role_account', 'catch_all', 'disposable'];
const AI_SCORE_HEADER  = 'AI Priority Score';
const AI_BATCH_SIZE    = 100;
const AI_CONCURRENCY   = 4;

function matchesSubDepartment(title, subDept) {
  const t = title.toLowerCase();
  const s = subDept.toLowerCase();
  if (s === 'software development') {
    return t.indexOf('software') !== -1 || t.indexOf('developer') !== -1 || t.indexOf('programmer') !== -1 || t.indexOf('engineer') !== -1;
  }
  if (s === 'c-suite' || s === 'executive') {
    return t.indexOf('chief') !== -1 || t.indexOf('c-suite') !== -1 || t.indexOf('executive') !== -1 || t.indexOf('ceo') !== -1 ||
      t.indexOf('cto') !== -1 || t.indexOf('cfo') !== -1 || t.indexOf('coo') !== -1;
  }
  const words = s.split(/\s+/);
  for (const w of words) {
    if (w.length > 3 && t.indexOf(w) !== -1) return true;
  }
  return t.indexOf(s) !== -1;
}

function lowerAll(arr) { return (arr || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean); }

function findCols(columns) {
  return {
    titleCol: lists.findHeader(columns, TITLE_HEADERS),
    companyCol: lists.findHeader(columns, COMPANY_HEADERS),
    statusCol: lists.findHeader(columns, STATUS_HEADERS),
    industryCol: lists.findHeader(columns, INDUSTRY_HEADERS),
    countryCol: lists.findHeader(columns, COUNTRY_HEADERS)
  };
}

/** Same verification-status rule as the run: keep deliverable/blank statuses only. */
function statusOk(row, cols) {
  if (cols.statusCol === -1) return true;
  const status = row[cols.statusCol] ? String(row[cols.statusCol]).trim().toLowerCase() : '';
  return status === '' || STATUS_PRIORITY.indexOf(status) !== -1;
}

/** Returns true if the row passes all filters (industry, country, keyword, seniority, department). */
function rowMatches(row, cols, f) {
  const rowTitle = row[cols.titleCol] ? String(row[cols.titleCol]).toLowerCase().trim() : '';

  if (f.industries.length) {
    if (cols.industryCol === -1) return false;
    const v = row[cols.industryCol] ? String(row[cols.industryCol]).toLowerCase().trim() : '';
    if (!f.industries.some((ind) => v === ind || v.indexOf(ind) !== -1)) return false;
  }
  if (f.countries.length) {
    if (cols.countryCol === -1) return false;
    const v = row[cols.countryCol] ? String(row[cols.countryCol]).toLowerCase().trim() : '';
    if (!f.countries.some((c) => v === c || v.indexOf(c) !== -1)) return false;
  }
  if (f.keywords.length) {
    if (!f.keywords.some((k) => rowTitle.indexOf(k) !== -1)) return false;
  }
  if (f.seniority.length) {
    const ok = f.seniority.some((s) => {
      if (s === 'c-suite') {
        return rowTitle.indexOf('chief') !== -1 || rowTitle.indexOf('ceo') !== -1 || rowTitle.indexOf('cto') !== -1 ||
          rowTitle.indexOf('cfo') !== -1 || rowTitle.indexOf('coo') !== -1;
      }
      return rowTitle.indexOf(s) !== -1;
    });
    if (!ok) return false;
  }
  if (f.departments.length) {
    if (!f.departments.some((d) => matchesSubDepartment(rowTitle, d))) return false;
  }
  return true;
}

function normalizeFilters(filters) {
  filters = filters || {};
  let keywords = Array.isArray(filters.keywords) ? filters.keywords.filter(Boolean) : [];
  if (!keywords.length) keywords = DEFAULT_KEYWORDS;
  return {
    keywords: lowerAll(keywords),
    seniority: lowerAll(filters.seniority),
    departments: lowerAll(filters.departments),
    industries: lowerAll(filters.industry),
    countries: lowerAll(filters.country),
    perCompany: Math.max(1, parseInt(filters.perCompany, 10) || 1),
    aiPrioritize: !!filters.aiPrioritize
  };
}

// ── AI Prioritizer ───────────────────────────────────────────────────────────
function titleKey(title) { return String(title || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function buildScorePrompt(lines) {
  return `
Rate each job title below by how much buying / decision-making authority that person has in their organization.
Use a score from 1 to 100:
- 95-100: Owner, Founder, Co-Founder, CEO, President, Managing Partner, Executive Director
- 85-94: other C-suite (COO, CFO, CTO, CMO, CIO, Chief ... Officer)
- 70-84: EVP, SVP, VP, Partner, General Manager
- 55-69: Head of ..., Director
- 35-54: Manager, Program Manager, Lead
- 15-34: senior individual contributors, specialists, coordinators
- 1-14: assistants, interns, students, volunteers
Board, advisory and honorary roles (Board Member, Treasurer, Secretary, Advisor) score lower than operating executives with a similar title.
If a title combines roles, score the most senior one.
Return ONLY the scores with line numbers, in this exact format:
1) 87
2) 45
...
No extra words, no explanation.
${lines.join('\n')}
`;
}

/** Scores titles (already titleKey()'d) 1-100. Cached titles are not sent to GPT again. */
async function scoreTitles(titles, apiKey, model) {
  const scores = new Map();
  const sel = db.prepare('SELECT score FROM dm_title_scores WHERE title = ?');
  const missing = [];
  titles = titles.filter(Boolean);
  titles.forEach((t) => {
    const hit = sel.get(t);
    if (hit) scores.set(t, hit.score); else missing.push(t);
  });

  const batches = [];
  for (let i = 0; i < missing.length; i += AI_BATCH_SIZE) batches.push(missing.slice(i, i + AI_BATCH_SIZE));

  const save = db.prepare(`INSERT INTO dm_title_scores (title, score, model) VALUES (?, ?, ?)
                           ON CONFLICT(title) DO UPDATE SET score = excluded.score, model = excluded.model, created_at = datetime('now')`);
  let scored = 0;
  async function runBatch(batch) {
    const response = await openai.chat(
      'You are an assistant that strictly rates job titles by decision-making authority as per instructions.',
      buildScorePrompt(batch.map((t, k) => `${k + 1}) ${t}`)), apiKey, model);
    if (!response) throw new Error('Empty response from GPT API.');
    response.split('\n').map((l) => l.trim()).forEach((line) => {
      const m = line.match(/^(\d+)\)\s*(\d{1,3})\b/);
      if (!m) return;
      const t = batch[parseInt(m[1], 10) - 1];
      if (t === undefined || scores.has(t)) return;
      const score = Math.min(100, Math.max(1, parseInt(m[2], 10)));
      scores.set(t, score);
      save.run(t, score, model);
      scored++;
    });
  }

  // A few batches in parallel, so big lists finish well within the request timeout
  let next = 0;
  async function worker() { while (next < batches.length) await runBatch(batches[next++]); }
  await Promise.all(Array.from({ length: Math.min(AI_CONCURRENCY, batches.length) }, worker));

  return { scores, cached: titles.length - missing.length, scored };
}

function countLeads(listId, filters) {
  const list = lists.getList(listId);
  const cols = findCols(list.columns);
  if (cols.titleCol === -1 || cols.companyCol === -1) return 0;
  const f = normalizeFilters(filters);
  let count = 0;
  for (const r of lists.getRows(listId)) {
    const company = r.data[cols.companyCol] ? String(r.data[cols.companyCol]).trim() : '';
    if (!company) continue;
    if (rowMatches(r.data, cols, f) && statusOk(r.data, cols)) count++;
  }
  return count;
}

async function runFilter(user, listId, filters) {
  const list = lists.getList(listId);
  const cols = findCols(list.columns);
  if (cols.titleCol === -1 || cols.companyCol === -1) {
    throw new Error('Required columns (Title/Job Title, Company/Company Name) not found.');
  }
  if (filters && filters.industry && filters.industry.length && cols.industryCol === -1) {
    throw new Error('An Industry filter was selected, but no "Industry" or "Sector" column was found in the sheet.');
  }
  if (filters && filters.country && filters.country.length && cols.countryCol === -1) {
    throw new Error('A Country filter was selected, but no "Country" or "Location" column was found in the sheet.');
  }
  const f = normalizeFilters(filters);
  const hasStatus = cols.statusCol !== -1;

  const companyMap = {};
  let totalScanned = 0, totalMatched = 0;
  const rows = lists.getRows(listId);
  rows.forEach((r, idx) => {
    const row = r.data;
    const company = row[cols.companyCol] ? String(row[cols.companyCol]).trim() : '';
    if (!company) return;
    totalScanned++;
    if (!rowMatches(row, cols, f)) return;

    const status = hasStatus && row[cols.statusCol] ? String(row[cols.statusCol]).trim().toLowerCase() : '';
    const matchesStatus = !hasStatus || STATUS_PRIORITY.indexOf(status) !== -1 || status === '';
    if (matchesStatus) {
      totalMatched++;
      if (!companyMap[company]) companyMap[company] = [];
      let rank = hasStatus ? STATUS_PRIORITY.indexOf(status) : 0;
      if (rank === -1) rank = 999;
      companyMap[company].push({ row, statusRank: rank, index: idx });
    }
  });

  // AI Prioritizer: score every matched title (unscored titles rank last)
  let ai = null;
  let columns = list.columns;
  let scoreCol = -1;
  if (f.aiPrioritize) {
    const { apiKey, model } = openai.getCredentials();
    if (!apiKey) throw new Error(openai.NO_KEY_MESSAGE);
    const titles = new Set();
    Object.keys(companyMap).forEach((c) => companyMap[c].forEach((e) => titles.add(titleKey(e.row[cols.titleCol]))));
    ai = await scoreTitles(Array.from(titles), apiKey, model);
    ai.model = model;
    Object.keys(companyMap).forEach((c) => companyMap[c].forEach((e) => {
      const s = ai.scores.get(titleKey(e.row[cols.titleCol]));
      e.aiScore = s === undefined ? null : s;
    }));
    if (!lists.getList(listId)) throw new Error('The sheet was deleted while AI prioritizing was running.');
    scoreCol = lists.findHeader(columns, [AI_SCORE_HEADER]);
    if (scoreCol === -1) { columns = columns.concat([AI_SCORE_HEADER]); scoreCol = columns.length - 1; }
  }

  const cleanedRows = [];
  let totalKept = 0;
  Object.keys(companyMap).forEach((company) => {
    companyMap[company].sort((a, b) => {
      if (a.statusRank !== b.statusRank) return a.statusRank - b.statusRank;
      if (ai && a.aiScore !== b.aiScore) return (b.aiScore || 0) - (a.aiScore || 0);
      return a.index - b.index;
    });
    const limit = Math.min(companyMap[company].length, f.perCompany);
    for (let i = 0; i < limit; i++) {
      const e = companyMap[company][i];
      let row = e.row;
      if (ai) {
        row = row.slice();
        while (row.length < columns.length) row.push('');
        row[scoreCol] = e.aiScore === null ? '' : e.aiScore;
      }
      cleanedRows.push(row);
      totalKept++;
    }
  });

  // Write to new list "Cleaned - <name>" (replace if exists, like clearing the sheet)
  const cleanedName = 'Cleaned - ' + list.name;
  const existing = lists.getListByName(user.id, cleanedName);
  if (existing) { lists.assertNoPendingTasks(existing.id); lists.deleteList(existing.id); }
  const newId = lists.createList({
    userId: user.id, name: cleanedName, originalName: list.original_name, kind: 'decision_makers',
    sourceListId: list.id, columns, rows: cleanedRows
  });

  activity.logActivity({ user, fn: 'Decision Maker Filter', list, taskName: 'Decision Maker - ' + list.name, status: 'completed', total: totalKept });

  const summary = [
    'Clean Decision Makers - Completed',
    '══════════════════════════════════════',
    `Scanned    : ${totalScanned} row(s)`,
    `Matched    : ${totalMatched} decision maker(s)`,
    `Final Kept : ${totalKept} row(s) (max ${f.perCompany} per company)`,
    `  Output Tab : "${cleanedName}"`,
    `Status Col : ${hasStatus ? 'Active (' + list.columns[cols.statusCol] + ')' : 'Not Found (Skipped)'}`,
    `AI Priority: ${ai ? `On (${ai.model}) - ${ai.scored} title(s) scored, ${ai.cached} from cache` : 'Off'}`
  ].join('\n');

  return { ok: true, message: summary, listId: newId, listName: cleanedName, scanned: totalScanned, matched: totalMatched, kept: totalKept };
}

module.exports = { countLeads, runFilter, scoreTitles, DEFAULT_KEYWORDS, matchesSubDepartment };
