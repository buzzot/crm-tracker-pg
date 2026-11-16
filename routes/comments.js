'use strict';
// Single-message actions used from conversation threads:
//   POST /comments/:id/edit     Admin only — correct text / sender / date / channel
//   POST /comments/:id/delete   Admin only
//   POST /comments/:id/format   AI clean reading view of one message (stored; JSON)
//   POST /comments/:id/summary  same, kept for older pages
//   POST /ai/read-images        Preview: read screenshots BEFORE saving (nothing is stored)
const express = require('express');
const multer = require('multer');
const router = express.Router();
const crm = require('../services/crm');
const ai = require('../services/ai');
const { autoClean, cleanNow } = require('../services/autoclean');

const ENTITY_PATH = { project: '/projects/', task: '/tasks/', activity: '/activities/', deal: '/deals/', contact: '/contacts/', product: '/products/' };
const backTo = (c) => (c && ENTITY_PATH[c.entityType] ? ENTITY_PATH[c.entityType] + c.entityId + '#comments' : '/');
const previewUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
const isAdmin = (req) => !!(req.session.user && req.session.user.role === 'Admin');

router.post('/comments/:id/edit', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'Only admins can edit messages.' });
    const c = await crm.getComment(req.params.id);
    if (!c) return res.status(404).render('error', { title: 'Not found', message: 'Message not found.' });
    const { content, from, to, subject, sentAtIso, channel, direction } = req.body;
    try {
      await crm.updateComment(c.id, {
        content, from, to, subject, sentAt: sentAtIso, channel, direction,
        editedById: req.session.user.id, editedByName: req.session.user.name || req.session.user.email,
      });
    } catch (validation) {
      const base = backTo(c).replace('#comments', '');
      return res.redirect(base + '?msgError=' + encodeURIComponent(validation.message) + '#comments');
    }
    autoClean(c.id);   // text may have changed: refresh the clean view in the background
    res.redirect(backTo(c));
  } catch (err) { next(err); }
});

router.post('/comments/:id/delete', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'Only admins can delete messages.' });
    const c = await crm.getComment(req.params.id);
    if (!c) return res.redirect('/');
    await crm.deleteComment(c.id);
    res.redirect(backTo(c));
  } catch (err) { next(err); }
});

async function formatHandler(req, res) {
  try {
    const result = await cleanNow(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.code === 'AI_NOT_CONFIGURED' ? 503 : err.message === 'Message not found.' ? 404 : err.code === 'NOT_EXTERNAL' ? 400 : 502;
    if (!err.code && status === 502) console.error('[ai] message format failed:', err.message);
    res.status(status).json({ ok: false, error: (err.code || status !== 502) ? err.message : 'Could not clean up this message.' });
  }
}
router.post('/comments/:id/format', formatHandler);
router.post('/comments/:id/summary', formatHandler);

router.post('/ai/read-images', previewUpload.array('images', 10), async (req, res) => {
  try {
    const { text, channel, direction, from } = req.body;
    const result = await ai.readImages(req.files || [], { text, channel, direction, from });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.code === 'AI_NOT_CONFIGURED' ? 503 : err.code === 'AI_NO_IMAGES' ? 400 : 502;
    if (!err.code) console.error('[ai] read-images failed:', err.message);
    res.status(status).json({ ok: false, code: err.code || null, error: err.code ? err.message : 'Could not read the screenshots.' });
  }
});

module.exports = router;
