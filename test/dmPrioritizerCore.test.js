// Port of rd-decision-maker-prioritizer/scripts/test_process.py (node --test)
const test = require('node:test');
const assert = require('node:assert');
const core = require('../server/services/dmPrioritizerCore');

const H = ['Title', 'Website', 'Company Name for Emails', 'Phone'];

test('domains', () => {
  for (const [x, y] of [['site.reachoutly.com', 'reachoutly.com'], ['https://app.example.co.uk/a', 'example.co.uk'],
    ['httpss:reachoutly.com', 'reachoutly.com'], ['http://www.REACHOUTLY.com:80/a', 'reachoutly.com'],
    ['alice.github.io', 'alice.github.io'], ['a.city.kawasaki.jp', 'city.kawasaki.jp'], ['a.b.ck', 'a.b.ck'],
    ['', ''], ['https://127.0.0.1', ''], ['bad input', ''], ['ftp://example.com', '']]) {
    assert.strictEqual(core.domain(x), y, x);
  }
});

test('pipeline, invalid selections and tamper', () => {
  const rows = [['CEO', 'site.reachoutly.com', 'Reachoutly', '+001'], ['CFO', '', ' Reachoutly ', '001'],
    ['CTO', '', 'Other', 'a,\nb'], ['CTO', '', 'Other', 'a,\nb'], ['', '', '', '']];
  const { state, jobs } = core.prepare(H, rows);
  assert.deepStrictEqual(state.keys.slice(0, 2), ['d:reachoutly.com', 'd:reachoutly.com']);
  assert.strictEqual(jobs.length, 1);
  assert.deepStrictEqual(state.duplicates, [false, false, false, true, false]);
  assert.throws(() => core.finalize(state, {}), /Incomplete/);
  assert.throws(() => core.finalize(state, { 'd:reachoutly.com': [1, 999] }), /Invalid/);
  assert.throws(() => core.finalize(state, { 'd:reachoutly.com': [1, 1] }), /Invalid/);
  const out = core.finalize(state, { 'd:reachoutly.com': [1, 0] });
  assert.deepStrictEqual(out.order, [1, 0, 2, 3, 4]);
  assert.deepStrictEqual(out.rows.map((r) => r.slice(-2)), [['', 'A'], ['reachoutly.com', 'B'], ['', 'A'], ['', ''], ['', '']]);
  assert.strictEqual(out.rows[0][3], '001');
  core.judge(state, out.order, out.columns, out.rows);
  const tampered = out.rows.map((r) => r.slice()); tampered[0][3] = '1';
  assert.throws(() => core.judge(state, out.order, out.columns, tampered), /Judge/);
  const badRank = out.rows.map((r) => r.slice()); badRank[3][5] = 'B';
  assert.throws(() => core.judge(state, out.order, out.columns, badRank), /Judge/);
  // same source → same fingerprint (resumable); changed source → different
  assert.strictEqual(core.prepare(H, rows).state.fingerprint, state.fingerprint);
  const changed = rows.map((r) => r.slice()); changed[0][0] = 'Changed';
  assert.notStrictEqual(core.prepare(H, changed).state.fingerprint, state.fingerprint);
  const rep = core.report(state, out.ranks);
  assert.strictEqual(rep.prioritized, 3); assert.strictEqual(rep.unresolved_rows, 1); assert.strictEqual(rep.duplicate_copies, 1);
});

test('5000 rows, >10 candidates, last candidate first', () => {
  const rows = []; for (let i = 0; i < 5000; i++) rows.push([i % 25 === 24 ? 'CFO' : 'Engineer', `https://sub.company${Math.floor(i / 25)}.com`, `Company${Math.floor(i / 25)}`, `00${i}`]);
  const { state, jobs } = core.prepare(H, rows);
  const decisions = {};
  jobs.forEach((j) => { const ids = j.candidates.map((c) => c.id); decisions[j.group] = ids.slice(-1).concat(ids.slice(0, 9)); });
  const out = core.finalize(state, decisions);
  core.judge(state, out.order, out.columns, out.rows);
  const rep = core.report(state, out.ranks);
  assert.strictEqual(rep.rows, 5000); assert.strictEqual(rep.prioritized, 2000); assert.strictEqual(rep.beyond_top_ten, 3000);
});

test('header conflicts and non-string cells', () => {
  assert.throws(() => core.prepare(['Title', 'Website', 'Domain'], [['a', 'b', 'c']]), /Domain/);
  assert.throws(() => core.prepare(['Title', 'Website', 'Title'], [['a', 'b', 'c']]), /Duplicate/);
  assert.throws(() => core.prepare(['Job Title', 'Website'], [['a', 'b']]), /Required/);
  const { state } = core.prepare(['Title', 'Website', 'Zip'], [['CEO', 'x.com', 1234], ['CFO', 'x.com', 99]]);
  const out = core.finalize(state, { 'd:x.com': [1, 0] });
  assert.strictEqual(out.rows[0][2], 99); // original typed values kept
  core.judge(state, out.order, out.columns, out.rows);
});
