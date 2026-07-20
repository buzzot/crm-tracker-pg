'use strict';

const express = require('express');
const crypto  = require('crypto');
const multer  = require('multer');
const crm     = require('../services/crm');

const router = express.Router();

// Mailgun inbound posts as multipart/form-data and may include file attachments.
// upload.any() accepts all fields and files without restrictions.
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Verify a Mailgun webhook signature.
 * Mailgun signs each request as:
 *   HMAC-SHA256(signingKey, timestamp + token) === signature
 */
function verifyMailgun(timestamp, token, signature) {
  const key = process.env.MAILGUN_WEBHOOK_KEY;
  if (!key) {
    console.warn('[webhook/email] MAILGUN_WEBHOOK_KEY not set — skipping signature verification');
    return true;
  }
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(timestamp + token);
  const expected = hmac.digest('hex');
  return expected === signature;
}

/**
 * Determine entity type and record ID from recipient address.
 * Formats:
 *   project-recXXXXXXXXXXXXXX@mg.samyoucrm.com   → { type: 'project', id }
 *   task-recXXXXXXXXXXXXXX@mg.samyoucrm.com       → { type: 'task', id }
 *   activity-recXXXXXXXXXXXXXX@mg.samyoucrm.com   → { type: 'activity', id }
 */
function parseRecipient(recipient) {
  if (!recipient) return null;
  // Match UUID format: project-<uuid>@domain or task-<uuid>@domain
  const m = recipient.match(/^(project|task|activity)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i);
  if (!m) return null;
  return { type: m[1].toLowerCase(), id: m[2].toLowerCase() };
}

/**
 * POST /webhooks/email
 * Mailgun inbound route — receives client email replies and saves them
 * to the project's comment thread in Airtable.
 *
 * This route must be registered BEFORE the requireAuth middleware
 * because Mailgun calls it without a session cookie.
 */
router.post('/webhooks/email', upload.any(), async (req, res) => {
  // Respond 200 immediately — Mailgun retries on anything else.
  res.status(200).send('OK');

  const {
    recipient,
    sender,
    from,
    subject,
    timestamp,
    token,
    signature
  } = req.body;

  // Body: prefer stripped-text (no quoted history) then plain
  const body = (req.body['stripped-text'] || req.body['body-plain'] || '').trim();

  // Verify authenticity
  if (!verifyMailgun(timestamp || '', token || '', signature || '')) {
    console.warn('[webhook/email] Signature mismatch — request ignored');
    return;
  }

  // Locate the target entity (project or task)
  const target = parseRecipient(recipient);
  if (!target) {
    console.warn('[webhook/email] Could not parse entity from recipient:', recipient);
    return;
  }

  const emailSubject = (subject || '(no subject)').trim();
  const emailFrom    = sender || from || 'unknown@email.com';
  const emailBody    = body || '(no content)';

  // Collect email attachments (multer stores them in req.files)
  const attachments = (req.files || []).filter(f => f.fieldname.startsWith('attachment'));

  const commentPayload = {
    author:       emailFrom,
    comment:      emailBody,
    type:         'email',
    emailSubject: emailSubject,
    link:         `EMAILSUBJ:${emailSubject}`,
    files:        attachments.length ? attachments : undefined
  };

  try {
    if (target.type === 'task') {
      await crm.addTaskComment({ taskId: target.id, ...commentPayload });
    } else if (target.type === 'activity') {
      await crm.addActivityComment({ activityId: target.id, ...commentPayload });
    } else {
      await crm.addProjectComment({ projectId: target.id, ...commentPayload });
    }
    console.log(`[webhook/email] Saved email from ${emailFrom} → ${target.type} ${target.id} | subject: ${emailSubject} | attachments: ${attachments.length}`);
  } catch (err) {
    console.error('[webhook/email] Failed to save email to database:', err.message || err);
  }
});

module.exports = router;
