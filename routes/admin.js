'use strict';
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcrypt');
const crm      = require('../services/crm');
const db       = require('../config/db');
const { sendInviteEmail } = require('../services/email');
const { createOnboardingTasks } = require('../services/onboarding');

// GET /admin — users list
router.get('/', async (req, res, next) => {
  try {
    const users = await crm.listTeamUsers();
    res.render('admin', {
      title: 'Admin · Users',
      users,
      ROLE_TITLES: crm.ROLE_TITLES,
      ALL_ROLES:   crm.ALL_ROLES,
      flash: req.session.flash || null,
    });
    delete req.session.flash;
  } catch (err) { next(err); }
});

// GET /admin/users/new
router.get('/users/new', (req, res) => {
  res.render('admin-user-edit', {
    title: 'New User',
    editUser: null,
    ROLE_TITLES: crm.ROLE_TITLES,
    ALL_ROLES:   crm.ALL_ROLES,
    flash: null,
  });
});

// POST /admin/users/new
router.post('/users/new', async (req, res, next) => {
  try {
    const { name, email, role, title, phone, password } = req.body;
    if (!name || !email || !password) {
      return res.render('admin-user-edit', {
        title: 'New User',
        editUser: { name, email, role, title, phone },
        ROLE_TITLES: crm.ROLE_TITLES,
        ALL_ROLES:   crm.ALL_ROLES,
        flash: { type: 'error', message: 'Name, email and password are required.' },
      });
    }
    const { assignOnboarding } = req.body;
    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = await crm.createUser({ email, name, role, title, phone, passwordHash, mustChangePassword: true });

    // Create onboarding tasks if requested
    if (assignOnboarding === '1' && newUser && newUser.id) {
      const adminId = req.session.user?.id;
      createOnboardingTasks(crm, adminId, newUser.id).catch(err => {
        console.error('[onboarding] Failed to create tasks for', email, err.message);
      });
    }

    // Send invitation email (non-blocking — don't fail user creation if email fails)
    sendInviteEmail({ to: email, name, tempPassword: password }).catch(err => {
      console.error('[email] Failed to send invite to', email, err.message);
    });

    req.session.flash = { type: 'success', message: `User "${name}" created. Invitation email sent to ${email}.` };
    res.redirect('/admin');
  } catch (err) { next(err); }
});

// GET /admin/users/:id/edit
router.get('/users/:id/edit', async (req, res, next) => {
  try {
    const editUser = await crm.getUserById(req.params.id);
    if (!editUser) return res.status(404).render('error', { title: 'Not found', message: 'User not found.' });
    res.render('admin-user-edit', {
      title: `Edit · ${editUser.name}`,
      editUser,
      ROLE_TITLES: crm.ROLE_TITLES,
      ALL_ROLES:   crm.ALL_ROLES,
      flash: req.session.flash || null,
    });
    delete req.session.flash;
  } catch (err) { next(err); }
});

// POST /admin/users/:id/edit
router.post('/users/:id/edit', async (req, res, next) => {
  try {
    const { name, email, role, title, phone, password, isActive } = req.body;
    if (!name || !email) {
      req.session.flash = { type: 'error', message: 'Name and email are required.' };
      return res.redirect(`/admin/users/${req.params.id}/edit`);
    }
    await crm.updateUser(req.params.id, {
      name, email, role, title, phone,
      isActive: isActive === '1',
    });
    if (password && password.trim()) {
      const hash = await bcrypt.hash(password.trim(), 10);
      await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.params.id, hash]);
    }
    req.session.flash = { type: 'success', message: 'User updated.' };
    res.redirect('/admin');
  } catch (err) { next(err); }
});

// POST /admin/users/:id/deactivate
router.post('/users/:id/deactivate', async (req, res, next) => {
  try {
    if (req.session.user && req.session.user.id === req.params.id) {
      req.session.flash = { type: 'error', message: 'You cannot deactivate your own account.' };
      return res.redirect('/admin');
    }
    const editUser = await crm.getUserById(req.params.id);
    if (!editUser) return res.status(404).render('error', { title: 'Not found', message: 'User not found.' });
    await crm.updateUser(req.params.id, { isActive: !editUser.isActive });
    req.session.flash = {
      type: 'success',
      message: `${editUser.name} ${editUser.isActive ? 'deactivated' : 'reactivated'}.`,
    };
    res.redirect('/admin');
  } catch (err) { next(err); }
});

module.exports = router;
