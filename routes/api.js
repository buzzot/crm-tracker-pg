const express = require('express');
const router = express.Router();
const crm = require('../services/crm');
const email = require('../services/email');

// Click-to-expand detail for an Activity (used on the company page).
router.get('/api/activities/:id', async (req, res) => {
  try {
    const activity = await crm.getActivity(req.params.id);
    res.json({ ok: true, activity });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

// Click-to-expand detail for a Project Activity (used on the company page).
router.get('/api/project-activities/:id', async (req, res) => {
  try {
    const activity = await crm.getProjectActivity(req.params.id);
    res.json({ ok: true, activity });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

// IMAP candidate search for an Activity ("Find related emails" button).
router.get('/api/activities/:id/email-candidates', async (req, res) => {
  try {
    if (!email.isConfigured()) {
      return res.status(400).json({ ok: false, error: 'IMAP is not configured in .env yet.' });
    }
    const activity = await crm.getActivity(req.params.id);
    const candidates = await email.findCandidates({ subjectHint: activity.name, date: activity.date });
    res.json({ ok: true, candidates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Link a chosen email to an Activity.
router.post('/api/activities/:id/link-email', async (req, res) => {
  try {
    const { subject, date, messageId } = req.body;
    const activity = await crm.linkActivityEmail(req.params.id, { subject, date, messageId });
    res.json({ ok: true, activity });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// IMAP candidate search for a Project Activity.
router.get('/api/project-activities/:id/email-candidates', async (req, res) => {
  try {
    if (!email.isConfigured()) {
      return res.status(400).json({ ok: false, error: 'IMAP is not configured in .env yet.' });
    }
    const activity = await crm.getProjectActivity(req.params.id);
    const candidates = await email.findCandidates({ subjectHint: activity.name, date: activity.date });
    res.json({ ok: true, candidates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Link a chosen email to a Project Activity.
router.post('/api/project-activities/:id/link-email', async (req, res) => {
  try {
    const { subject, date, messageId } = req.body;
    const activity = await crm.linkProjectActivityEmail(req.params.id, { subject, date, messageId });
    res.json({ ok: true, activity });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Live, read-only preview of the linked email's Subject/Body for an Activity.
// Fetched fresh over IMAP every time — never written to Airtable or cached.
router.get('/api/activities/:id/email-preview', async (req, res) => {
  try {
    const activity = await crm.getActivity(req.params.id);
    if (!activity.emailMessageId) {
      return res.status(400).json({ ok: false, error: 'No email linked to this activity yet.' });
    }
    const message = await email.getMessageByMessageId(activity.emailMessageId);
    res.json({ ok: true, email: message });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Same preview, for a Project Activity.
router.get('/api/project-activities/:id/email-preview', async (req, res) => {
  try {
    const activity = await crm.getProjectActivity(req.params.id);
    if (!activity.emailMessageId) {
      return res.status(400).json({ ok: false, error: 'No email linked to this activity yet.' });
    }
    const message = await email.getMessageByMessageId(activity.emailMessageId);
    res.json({ ok: true, email: message });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Inline product creation — used by the "+ New product" action on the
// project create/edit forms so a brand-new product can be added without
// losing the in-progress project form.
router.post('/api/products', async (req, res) => {
  try {
    const { name, category } = req.body;
    const product = await crm.createProduct({ name, category });
    res.json({ ok: true, product });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
