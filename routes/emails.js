'use strict';
// Company emails: AI drafting, research, drafts, sending from the user's mailbox, threads.
const express = require('express');
const router = express.Router();
const crm = require('../services/crm');
const ai = require('../services/ai');
const mail = require('../services/mail');
const smtp = require('../services/smtp');

const json = (res, status, body) => res.status(status).json(body);
const fail = (res, e, fallback) => {
  const status = e.status || (e.code === 'AI_NOT_CONFIGURED' || e.code === 'NO_MAILBOX' ? 400 : 502);
  if (!e.code && !e.status) console.error('[emails]', fallback, e.message);
  return json(res, status, { ok: false, code: e.code || null, error: (e.code || e.status) ? e.message : fallback });
};

// Same access rule as the Companies list
async function companyFor(req, id) {
  const visible = await crm.listCompanies(req.session.user);
  const c = visible.find((x) => x.id === id);
  if (!c) { const e = new Error('Company not found.'); e.status = 404; throw e; }
  return c;
}

function htmlBody(text, signature) {
  const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const paras = String(text || '').trim().split(/\n{2,}/).map((p) => '<p style="margin:0 0 12px">' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
  const sig = signature ? '<p style="margin:16px 0 0;color:#555">' + esc(signature).replace(/\n/g, '<br>') + '</p>' : '';
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">${paras}${sig}</div>`;
}

// ── Context for the composer (stage hint, recipients, CC address, mailbox) ──
router.get('/companies/:id/email-context', async (req, res) => {
  try {
    const company = await companyFor(req, req.params.id);
    const [detail, settings, address, threads] = await Promise.all([
      crm.getCompanyDetail(company.id), mail.getSettings(req.session.user.id), mail.companyAddress(company), mail.companyThreads(company.id),
    ]);
    const research = await mail.getResearch(company.id);
    json(res, 200, {
      ok: true, aiEnabled: ai.isConfigured(), trackingAddress: address,
      mailbox: settings ? { email: settings.email, name: settings.displayName, verified: !!settings.verifiedAt, signature: settings.signature } : null,
      contacts: (detail.contacts || []).filter((c) => c.status !== 'Left').map((c) => ({ id: c.id, name: c.fullName, email: c.email, title: c.title })),
      projects: (detail.projects || []).map((p) => ({ id: p.id, name: p.name, status: p.status })),
      hasHistory: threads.some((t) => t.count > 0),
      research: research ? { items: research.items, createdAt: research.createdAt } : null,
    });
  } catch (e) { fail(res, e, 'Could not load email details.'); }
});

// ── Research (web) — cached per company for 30 days ─────────────────────────
router.post('/companies/:id/email-research', async (req, res) => {
  try {
    const company = await companyFor(req, req.params.id);
    if (!req.body.refresh) {
      const cached = await mail.getResearch(company.id);
      if (cached) return json(res, 200, { ok: true, items: cached.items, createdAt: cached.createdAt, cached: true });
    }
    const full = await crm.getCompany(company.id);
    const items = await ai.researchCompany(full || company);
    await mail.saveResearch(company.id, items);
    json(res, 200, { ok: true, items, createdAt: new Date().toISOString() });
  } catch (e) { fail(res, e, 'Research is not available right now.'); }
});

// ── AI draft ────────────────────────────────────────────────────────────────
router.post('/companies/:id/email-draft-ai', async (req, res) => {
  try {
    const company = await companyFor(req, req.params.id);
    const b = req.body || {};
    const [detail, settings, threads, research] = await Promise.all([
      crm.getCompanyDetail(company.id), mail.getSettings(req.session.user.id), mail.companyThreads(company.id), mail.getResearch(company.id),
    ]);
    const recipients = smtp.parseAddressList(b.to).map((a) => {
      const c = (detail.contacts || []).find((x) => (x.email || '').toLowerCase() === a.email.toLowerCase());
      return { name: (c && c.fullName) || a.name, email: a.email, title: c && c.title };
    });
    // History: the thread being replied to, else everything with these recipients, else the whole company
    let history = [];
    const all = threads.flatMap((t) => t.messages).filter((m) => m.status !== 'draft');
    if (b.threadKey) history = (threads.find((t) => t.key === b.threadKey) || { messages: [] }).messages.filter((m) => m.status !== 'draft');
    else {
      const emails = recipients.map((r) => r.email.toLowerCase());
      const withThem = all.filter((m) => emails.some((e) => (m.from + ' ' + m.to + ' ' + m.cc).toLowerCase().includes(e)));
      history = withThem.length ? withThem : all;
    }
    history.sort((x, y) => new Date(x.sentAt || x.createdAt) - new Date(y.sentAt || y.createdAt));
    const picked = new Set((Array.isArray(b.researchIds) ? b.researchIds : String(b.researchIds || '').split(',')).map(Number).filter(Boolean));
    const projProducts = (detail.projects || []).map((p) => ({ ...p, products: p.products || [] }));
    const result = await ai.draftEmail({
      goal: b.goal, tone: b.tone, language: b.language, instructions: b.instructions, currentDraft: b.revise ? b.body : '',
      sender: { name: (settings && settings.displayName) || req.session.user.name, email: (settings && settings.email) || req.session.user.email, title: req.session.user.title },
      recipients, company: detail.company || company,
      deals: (detail.deals || []).filter((d) => !String(d.stage || '').startsWith('Closed')),
      projects: projProducts.filter((p) => !['Completed', 'Cancelled'].includes(p.status)),
      activities: (detail.activities || []).slice().sort((x, y) => String(y.statusDate || y.date || '').localeCompare(String(x.statusDate || x.date || ''))),
      history, replyTo: !!b.threadKey,
      research: research ? research.items.filter((r) => picked.has(r.id)) : [],
    });
    json(res, 200, { ok: true, ...result, historyCount: history.length });
  } catch (e) { fail(res, e, 'Could not write a draft. Try again.'); }
});

// ── Drafts ──────────────────────────────────────────────────────────────────
function readForm(b) {
  return {
    to: smtp.parseAddressList(b.to).map(smtp.formatAddress).join(', '),
    cc: smtp.parseAddressList(b.cc).map(smtp.formatAddress).join(', '),
    subject: String(b.subject || '').trim().slice(0, 500),
    body: String(b.body || '').replace(/\r/g, '').slice(0, 50000),
    projectId: b.projectId || null, inReplyTo: b.inReplyTo || null,
  };
}

router.post('/companies/:id/emails/draft', async (req, res) => {
  try {
    const company = await companyFor(req, req.params.id);
    const f = readForm(req.body);
    const settings = await mail.getSettings(req.session.user.id);
    const from = settings ? smtp.formatAddress({ name: settings.displayName || '', email: settings.email }) : req.session.user.email;
    const id = await mail.saveDraft({ id: req.body.id || null, companyId: company.id, userId: req.session.user.id, from, ...f, ai: req.body.aiMeta || null });
    json(res, 200, { ok: true, id });
  } catch (e) { fail(res, e, 'Could not save the draft.'); }
});

router.post('/emails/:id/delete', async (req, res) => {
  try { await mail.deleteDraft(req.params.id, req.session.user.id); json(res, 200, { ok: true }); }
  catch (e) { fail(res, e, 'Could not delete the draft.'); }
});

router.get('/emails/:id', async (req, res) => {
  try {
    const m = await mail.getMessage(req.params.id);
    if (!m || !m.companyId) return json(res, 404, { ok: false, error: 'Email not found.' });
    await companyFor(req, m.companyId);
    json(res, 200, { ok: true, message: m });
  } catch (e) { fail(res, e, 'Could not load the email.'); }
});

// ── Send ────────────────────────────────────────────────────────────────────
router.post('/companies/:id/emails/send', async (req, res) => {
  const userId = req.session.user.id;
  let draftId = req.body.id || null;
  try {
    const company = await companyFor(req, req.params.id);
    const f = readForm(req.body);
    if (!smtp.parseAddressList(f.to).length) return json(res, 400, { ok: false, error: 'Add at least one recipient.' });
    if (!f.subject) return json(res, 400, { ok: false, error: 'Add a subject.' });
    if (!f.body.trim()) return json(res, 400, { ok: false, error: 'The email is empty.' });
    if (/\[[^\]\n]{1,80}\]/.test(f.body) && req.body.confirmGaps !== '1') {
      return json(res, 409, { ok: false, code: 'GAPS', error: 'The email still has [placeholders] to fill in. Send anyway?' });
    }
    const settings = await mail.getSettings(userId);
    if (!settings) return json(res, 400, { ok: false, code: 'NO_MAILBOX', error: 'Set up your email in My Profile first.' });
    const fromAddr = { name: settings.displayName || req.session.user.name || '', email: settings.email };
    // The company's tracking address is always in Cc, so replies are logged
    const tracking = await mail.companyAddress(company);
    const cc = smtp.parseAddressList(f.cc).filter((a) => a.email.toLowerCase() !== tracking.toLowerCase());
    cc.push({ name: '', email: tracking });
    const ccStr = cc.map(smtp.formatAddress).join(', ');

    draftId = await mail.saveDraft({ id: draftId, companyId: company.id, userId, from: smtp.formatAddress(fromAddr), ...f, cc: ccStr, ai: req.body.aiMeta || null });
    let references = null;
    if (f.inReplyTo) references = f.inReplyTo;
    try {
      const sent = await mail.sendAs(userId, {
        to: smtp.parseAddressList(f.to), cc, subject: f.subject,
        text: f.body.trim() + (settings.signature ? '\n\n' + settings.signature : ''), html: htmlBody(f.body, settings.signature),
        inReplyTo: f.inReplyTo || null, references,
      }, { fallbackName: req.session.user.name });
      await mail.markSent(draftId, { messageId: sent.messageId });
      if (!settings.verifiedAt) await mail.markVerified(userId, null);
      json(res, 200, { ok: true, id: draftId, accepted: sent.accepted });
    } catch (sendErr) {
      const msg = mail.sendError(sendErr, settings);
      await mail.markFailed(draftId, msg);
      json(res, 502, { ok: false, id: draftId, error: 'Not sent: ' + msg + ' Your email is saved as a draft.' });
    }
  } catch (e) { fail(res, e, 'Could not send the email.'); }
});

// ── Thread (for the drawer) ─────────────────────────────────────────────────
router.get('/companies/:id/email-thread', async (req, res) => {
  try {
    const company = await companyFor(req, req.params.id);
    const threads = await mail.companyThreads(company.id);
    const t = threads.find((x) => x.key === req.query.key);
    if (!t) return json(res, 404, { ok: false, error: 'Conversation not found.' });
    json(res, 200, { ok: true, thread: { key: t.key, subject: t.subject, state: t.state, projectName: t.projectName, messages: t.messages } });
  } catch (e) { fail(res, e, 'Could not load the conversation.'); }
});

module.exports = router;
