const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const crm = require('../services/crm');
const security = require('../services/security');
// Valid-format hash used when the email doesn't exist (keeps timing similar)
const DUMMY_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8.6YyY9V1zj0C0w6f6v5f3s8m8h1a2';

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: req.query.error || null, layout: false });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const fail = (msg) => res.status(401).render('login', { error: msg, layout: false });
  if (!email || !password) {
    return res.render('login', { error: 'Email and password are required.', layout: false });
  }
  const wait = security.lockedFor(email, ip);
  if (wait) {
    return fail(`Too many failed attempts. Try again in ${Math.ceil(wait / 60000)} minute${wait > 60000 ? 's' : ''}.`);
  }
  try {
    const user = await crm.getUserByEmail(email);
    // Compare even when the user doesn't exist, so response time doesn't reveal valid emails
    const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !valid) {
      security.recordFailure(email, ip);
      return fail('Invalid email or password.');
    }
    security.recordSuccess(email, ip);
    const groupIds = await crm.getUserGroupIds(user.id);
    // New session id on login (prevents session fixation)
    req.session.regenerate((err) => {
      if (err) { console.error('[login] session regenerate failed:', err.message); return fail('Login failed. Please try again.'); }
      req.session.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        groupIds,
        // The public seed password must always be changed before using the app
        mustChangePassword: !!user.must_change_password || security.usesSeedPassword(user),
        avatarColor: user.avatar_color || null,
        checkedAt: Date.now(),
      };
      req.session.save(() => res.redirect('/'));
    });
  } catch (err) {
    console.error('[login error]', err.message);
    fail('Login failed. Please try again.');
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
