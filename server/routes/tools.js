// Decision Maker filter + Company Name Cleaner + Sheet Cleaner + DM Prioritizer + Activity log
const express = require('express');
const auth = require('../auth');
const lists = require('../services/lists');
const decisionMaker = require('../services/decisionMaker');
const companyCleaner = require('../services/companyCleaner');
const activity = require('../services/activityLog');
const sheetCleaner = require('../services/sheetCleaner');
const dmPrioritizer = require('../services/dmPrioritizer');

const router = express.Router();
router.use(auth.requireAuth);

function ownedList(req, res) {
  const list = lists.getList(Number(req.body.listId));
  if (!lists.canAccess(req.user, list)) { res.status(404).json({ error: 'List not found.' }); return null; }
  return list;
}

// ── Decision makers ──
router.post('/decision-makers/count', (req, res) => {
  const list = ownedList(req, res); if (!list) return;
  try { res.json({ count: decisionMaker.countLeads(list.id, req.body.filters) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/decision-makers/run', async (req, res) => {
  const list = ownedList(req, res); if (!list) return;
  try { res.json(await decisionMaker.runFilter(req.user, list.id, req.body.filters)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Company name cleaner ──
router.post('/company-cleaner/start', (req, res) => {
  const list = ownedList(req, res); if (!list) return;
  try { res.json(companyCleaner.startCleaning(req.user, list.id, !!req.body.overwrite)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/company-cleaner/progress', (req, res) => {
  res.json(companyCleaner.getProgress(req.user));
});
router.post('/company-cleaner/reset', (req, res) => {
  res.json(companyCleaner.reset(req.user));
});

// ── Sheet cleaner (columns / blank-email rows) ──
router.post('/sheet-cleaner/preview', (req, res) => {
  const list = ownedList(req, res); if (!list) return;
  try { res.json(sheetCleaner.preview(list.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/sheet-cleaner/run', (req, res) => {
  const list = ownedList(req, res); if (!list) return;
  try { res.json(sheetCleaner.run(req.user, list.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── DM Prioritizer (A-J) ──
router.post('/prioritizer/preview', (req, res) => {
  const list = ownedList(req, res); if (!list) return;
  try { res.json(dmPrioritizer.preview(list.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/prioritizer/start', async (req, res) => {
  const list = ownedList(req, res); if (!list) return;
  try { res.json(dmPrioritizer.startJob(req.user, list.id, !!req.body.overwrite)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/prioritizer/progress', (req, res) => {
  res.json(dmPrioritizer.getProgress(req.user));
});
router.post('/prioritizer/reset', (req, res) => {
  res.json(dmPrioritizer.reset(req.user));
});

// ── Activity log ("info" tab) - admin sees everyone, users see their own ──
router.get('/activity', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  res.json(activity.list(req.user, { limit, offset, fn: req.query.fn || undefined, q: req.query.q || undefined }));
});

module.exports = router;
