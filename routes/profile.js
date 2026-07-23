'use strict';
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const crm     = require('../services/crm');
const storage = require('../services/storage');
const multer  = require('multer');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

// Password strength checker (must match client-side rules)
function checkPasswordStrength(pwd) {
  const rules = [
    { label: 'At least 8 characters',      ok: pwd.length >= 8 },
    { label: 'Uppercase letter (A–Z)',      ok: /[A-Z]/.test(pwd) },
    { label: 'Lowercase letter (a–z)',      ok: /[a-z]/.test(pwd) },
    { label: 'Number (0–9)',                ok: /[0-9]/.test(pwd) },
    { label: 'Special character (!@#$…)',   ok: /[^A-Za-z0-9]/.test(pwd) },
  ];
  const passed = rules.filter(r => r.ok).length;
  return { rules, passed, strong: passed >= 4 };
}

// GET /profile
router.get('/profile', async (req, res, next) => {
  try {
    const user = await crm.getUserById(req.session.user.id);
    res.render('profile', {
      title: 'My Profile',
      profileUser: user,
      ROLE_TITLES: crm.ROLE_TITLES,
      flash: req.session.flash || null,
      mustChange: req.query.must_change === '1' || (user && user.mustChangePassword),
    });
    delete req.session.flash;
  } catch (err) { next(err); }
});

// POST /profile — update name, title, phone, avatar color
router.post('/profile', async (req, res, next) => {
  try {
    const { name, title, phone, avatarColor } = req.body;
    const updated = await crm.updateUserProfile(req.session.user.id, { name, title, phone, avatarColor });
    // Refresh session
    req.session.user = {
      ...req.session.user,
      name: updated.name,
      avatarColor: updated.avatarColor,
    };
    req.session.flash = { type: 'success', message: 'Profile updated.' };
    res.redirect('/profile');
  } catch (err) { next(err); }
});

// POST /profile/avatar — upload avatar image
router.post('/profile/avatar', upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) { return res.redirect('/profile'); }
    const { path: storagePath } = await storage.uploadMulterFile({
      entityType: 'avatars', entityId: req.session.user.id, file: req.file
    });
    await crm.updateUserProfile(req.session.user.id, { avatarUrl: storagePath });
    req.session.flash = { type: 'success', message: 'Avatar updated.' };
    res.redirect('/profile');
  } catch (err) { next(err); }
});

// POST /profile/password — change password
router.post('/profile/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const userId = req.session.user.id;

    // Fetch raw user for password_hash check
    const rawUser = await crm.getUserByEmail(req.session.user.email);

    // Verify current password
    if (!rawUser || !(await bcrypt.compare(currentPassword || '', rawUser.password_hash))) {
      req.session.flash = { type: 'error', message: 'Current password is incorrect.' };
      return res.redirect('/profile');
    }

    // Match
    if (newPassword !== confirmPassword) {
      req.session.flash = { type: 'error', message: 'Passwords do not match.' };
      return res.redirect('/profile');
    }

    // Strength
    const strength = checkPasswordStrength(newPassword || '');
    if (!strength.strong) {
      const failed = strength.rules.filter(r => !r.ok).map(r => r.label).join('; ');
      req.session.flash = { type: 'error', message: `Password too weak: ${failed}.` };
      return res.redirect('/profile');
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await crm.updateUserPassword(userId, hash);

    // Clear must_change_password from session
    req.session.user = { ...req.session.user, mustChangePassword: false };
    req.session.flash = { type: 'success', message: 'Password changed successfully.' };
    res.redirect('/profile');
  } catch (err) { next(err); }
});

module.exports = router;
