// Re-check the account at most once a minute so that deactivation or role
// changes apply to people who are already logged in.
const RECHECK_MS = 60 * 1000;
async function requireAuth(req, res, next) {
  const u = req.session && req.session.user;
  if (!u) return res.redirect('/login');
  if (u.checkedAt && Date.now() - u.checkedAt < RECHECK_MS) return next();
  try {
    const { query } = require('../config/db');
    const r = await query('SELECT id, email, name, role, is_active FROM users WHERE id=$1', [u.id]);
    const row = r.rows[0];
    if (!row || row.is_active === false) {
      return req.session.destroy(() => res.redirect('/login?error=' + encodeURIComponent('Your account is no longer active.')));
    }
    u.role = row.role; u.email = row.email; u.name = row.name; u.checkedAt = Date.now();
  } catch (e) {
    console.error('[auth] account re-check failed:', e.message);   // fail open: keep the session
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'Admin') return next();
  return res.status(403).render('error', { title: 'Forbidden', message: 'Admins only.' });
}

// Redirect users who must change their password to /profile before anything else.
// Exempt: /profile itself, /logout
function requirePasswordChange(req, res, next) {
  const user = req.session && req.session.user;
  if (!user || !user.mustChangePassword) return next();
  const exemptPaths = ['/profile', '/logout'];
  if (exemptPaths.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  return res.redirect('/profile?must_change=1');
}

module.exports = { requireAuth, requireAdmin, requirePasswordChange };
