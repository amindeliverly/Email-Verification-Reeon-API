// =============================================================================
//  auth.js - cookie sessions, login rate limiting, role guards
// =============================================================================
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { db } = require('./db');

const session = cookieSession({
  name: 'evd.sid',
  keys: [config.sessionSecret],
  maxAge: 12 * 60 * 60 * 1000, // 12 hours
  httpOnly: true,
  sameSite: 'lax'
});

const SESSION_TTL = 12 * 60 * 60 * 1000;
function loadUser(req, res, next) {
  req.user = null;
  if (req.session && req.session.uid) {
    const fresh = req.session.t && (Date.now() - req.session.t) < SESSION_TTL;
    const u = fresh ? db.prepare('SELECT id, email, name, role, active, created_at, last_login_at, session_version FROM users WHERE id = ?').get(req.session.uid) : null;
    // A password change bumps session_version, which logs out every other session
    if (u && u.active && (u.session_version || 0) === (req.session.v || 0)) { delete u.session_version; req.user = u; }
    else req.session = null;
  }
  next();
}
function startSession(req, user) {
  req.session = { uid: user.id, t: Date.now(), v: user.session_version || 0 };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access Denied - this option is available to admins only.' });
  }
  next();
}

// ── Simple in-memory login limiter (15 min window) ───────────────────────────
//  • 10 attempts per IP+email - an attacker elsewhere cannot lock a real user out
//  • 30 attempts per IP across all emails - stops password spraying
// req.ip only honours X-Forwarded-For when TRUST_PROXY=1, so it cannot be spoofed.
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const LIMIT_PER_ACCOUNT = 10;
const LIMIT_PER_IP = 30;
function prune(now) {
  if (attempts.size < 500) return;
  for (const [k, v] of attempts) if (now - v.t > WINDOW) attempts.delete(k);
}
function record(key, now) {
  const rec = attempts.get(key) || { n: 0, t: now };
  if (now - rec.t > WINDOW) { rec.n = 0; rec.t = now; }
  attempts.set(key, rec);
  return rec;
}
function loginKey(ip, email) { return 'acct:' + ip + '|' + email; }
function loginAllowed(ip, email) {
  const now = Date.now();
  prune(now);
  const acct = record(loginKey(ip, email), now);
  const byIp = record('ip:' + ip, now);
  if (acct.n >= LIMIT_PER_ACCOUNT || byIp.n >= LIMIT_PER_IP) return false;
  acct.n++;
  byIp.n++;
  return true;
}
function loginSucceeded(ip, email) { attempts.delete(loginKey(ip, email)); }

function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}
function hashPassword(password) { return bcrypt.hashSync(password, 10); }

module.exports = { session, loadUser, startSession, requireAuth, requireAdmin, loginAllowed, loginSucceeded, verifyPassword, hashPassword };
