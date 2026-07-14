function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'Admin') return next();
  return res.status(403).render('error', { title: 'Forbidden', message: 'Admins only.' });
}

module.exports = { requireAuth, requireAdmin };
