'use strict';
// Login protection helpers.

// The seed admin in schema.sql ships with a publicly known password hash.
// Anyone who has seen the repo knows it, so any account still using it must change it.
const SEED_HASHES = new Set([
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
]);
const SEED_EMAILS = new Set(['admin@example.com']);
const usesSeedPassword = (row) => !!(row && SEED_HASHES.has(row.password_hash));
const isSeedEmail = (email) => SEED_EMAILS.has(String(email || '').toLowerCase());

// ── Failed-login limiter (in memory; resets on restart) ─────────────────────
// 5 failures per email+IP in 15 minutes → locked for 15 minutes.
// 20 failures per IP in 15 minutes (any email) → locked, to slow password spraying.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_ACCOUNT = 5;
const MAX_PER_IP = 20;
const fails = new Map();   // key -> { count, first, lockedUntil }

function bucket(key) {
  const now = Date.now();
  let b = fails.get(key);
  if (!b || (now - b.first > WINDOW_MS && (!b.lockedUntil || b.lockedUntil < now))) { b = { count: 0, first: now, lockedUntil: 0 }; fails.set(key, b); }
  return b;
}
function keys(email, ip) { return ['acct:' + String(email || '').toLowerCase() + '|' + ip, 'ip:' + ip]; }

function lockedFor(email, ip) {
  const now = Date.now();
  let wait = 0;
  for (const k of keys(email, ip)) { const b = fails.get(k); if (b && b.lockedUntil > now) wait = Math.max(wait, b.lockedUntil - now); }
  return wait;   // ms remaining, 0 if not locked
}
function recordFailure(email, ip) {
  const [acct, ipk] = keys(email, ip);
  const a = bucket(acct), i = bucket(ipk);
  a.count++; i.count++;
  if (a.count >= MAX_PER_ACCOUNT) a.lockedUntil = Date.now() + WINDOW_MS;
  if (i.count >= MAX_PER_IP) i.lockedUntil = Date.now() + WINDOW_MS;
}
function recordSuccess(email, ip) { fails.delete(keys(email, ip)[0]); }

// Housekeeping so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of fails) if (now - b.first > WINDOW_MS && (!b.lockedUntil || b.lockedUntil < now)) fails.delete(k);
}, 10 * 60 * 1000).unref();

// ── Password rules (same as the profile page) ───────────────────────────────
function passwordProblems(pwd) {
  const p = String(pwd || '');
  const rules = [
    [p.length >= 8, 'at least 8 characters'],
    [/[A-Z]/.test(p), 'an uppercase letter'],
    [/[a-z]/.test(p), 'a lowercase letter'],
    [/[0-9]/.test(p), 'a number'],
    [/[^A-Za-z0-9]/.test(p), 'a special character'],
  ];
  const missing = rules.filter((r) => !r[0]).map((r) => r[1]);
  return missing.length > 1 ? missing : [];   // allow 4 of 5, like the profile page
}

module.exports = { usesSeedPassword, isSeedEmail, lockedFor, recordFailure, recordSuccess, passwordProblems, _fails: fails };
