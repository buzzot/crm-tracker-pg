const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const crm = require('../services/crm');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: req.query.error || null, layout: false });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.render('login', { error: 'Email and password are required.', layout: false });
  }
  try {
    const user = await crm.getUserByEmail(email.toLowerCase().trim());
    if (!user) {
      return res.render('login', { error: 'Invalid email or password.', layout: false });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.render('login', { error: 'Invalid email or password.', layout: false });
    }
    // Load group memberships
    const groupIds = await crm.getUserGroupIds(user.id);
    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      groupIds
    };
    res.redirect('/');
  } catch (err) {
    console.error('[login error]', err.message, err.stack);
    res.render('login', { error: 'Login failed: ' + err.message, layout: false });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
