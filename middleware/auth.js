function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
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
