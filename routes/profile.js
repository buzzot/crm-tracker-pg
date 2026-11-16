'use strict';
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const crm     = require('../services/crm');
const storage = require('../services/storage');
const mail    = require('../services/mail');
const smtp    = require('../services/smtp');
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
    let mailbox = null, mailboxError = null;
    try { mailbox = await mail.getSettings(req.session.user.id); }
    catch (e) { mailboxError = 'Email setup is unavailable right now.'; console.error('[profile] mailbox load:', e.message); }
    res.render('profile', {
      title: 'My Profile',
      profileUser: user,
      mailbox, mailboxError, providers: mail.PROVIDERS, trackingDomain: mail.trackingDomain(),
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

// ── Email (send from your own mailbox) ──────────────────────────────────────
// GET /profile/email/detect?email= → suggested SMTP settings from the domain's MX records
router.get('/profile/email/detect', async (req, res) => {
  try { res.json({ ok: true, ...(await mail.detectProvider(req.query.email)) }); }
  catch (e) { res.json({ ok: true, key: 'other', ...mail.PROVIDERS.other }); }
});

// POST /profile/email — save settings (password only replaced when a new one is typed)
router.post('/profile/email', async (req, res) => {
  const wantsJson = (req.get('accept') || '').includes('application/json');
  try {
    const { email, displayName, provider, host, port, secure, user, password, signature } = req.body;
    const saved = await mail.saveSettings(req.session.user.id, { email, displayName, provider, host, port, secure, user, password, signature });
    if (wantsJson) return res.json({ ok: true, mailbox: saved });
    req.session.flash = { type: 'success', message: 'Email settings saved. Send a test email to confirm they work.' };
    res.redirect('/profile#email');
  } catch (e) {
    if (wantsJson) return res.status(400).json({ ok: false, error: e.message });
    req.session.flash = { type: 'error', message: e.message };
    res.redirect('/profile#email');
  }
});

// POST /profile/email/test — send a test email to yourself
router.post('/profile/email/test', async (req, res) => {
  const userId = req.session.user.id;
  try {
    const { settings, conn } = await mail.smtpConfig(userId);
    const from = { name: settings.displayName || req.session.user.name || '', email: settings.email };
    const text = `This is a test email from Samyou CRM.\n\nYour mailbox ${settings.email} is connected: emails you send from the CRM will come from this address.`;
    await smtp.sendMail(conn, { from, to: [from], subject: 'Samyou CRM: your email is connected', text, html: '<p>' + text.replace(/\n\n/g, '</p><p>') + '</p>' });
    await mail.markVerified(userId, null);
    res.json({ ok: true, message: `Test email sent to ${settings.email}. Check your inbox.` });
  } catch (e) {
    let provider = null;
    try { provider = (await mail.getSettings(userId) || {}).provider; } catch (_) { /* ignore */ }
    const msg = e.code === 'NO_MAILBOX' ? e.message : smtp.friendlyError(e, provider);
    try { await mail.markVerified(userId, msg); } catch (_) { /* ignore */ }
    res.status(400).json({ ok: false, error: msg });
  }
});

// POST /profile/email/remove — disconnect
router.post('/profile/email/remove', async (req, res, next) => {
  try {
    await mail.removeSettings(req.session.user.id);
    req.session.flash = { type: 'success', message: 'Email disconnected.' };
    res.redirect('/profile#email');
  } catch (e) { next(e); }
});

module.exports = router;
