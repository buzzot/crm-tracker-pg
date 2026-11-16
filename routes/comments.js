'use strict';
// Single-message actions used from conversation threads:
//   POST /comments/:id/edit     Admin only — correct text / sender / date / channel
//   POST /comments/:id/delete   Admin only
//   POST /comments/:id/summary  AI TL;DR of one long message (JSON)
const express = require('express');
const router = express.Router();
const crm = require('../services/crm');
const ai = require('../services/ai');

const ENTITY_PATH = { project: '/projects/', task: '/tasks/', activity: '/activities/', deal: '/deals/', contact: '/contacts/', product: '/products/' };
const backTo = (c) => (c && ENTITY_PATH[c.entityType] ? ENTITY_PATH[c.entityType] + c.entityId + '#comments' : '/');
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

router.post('/comments/:id/summary', async (req, res) => {
  try {
    const c = await crm.getComment(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Message not found.' });
    const result = await ai.summarizeMessage(c);
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.code === 'AI_NOT_CONFIGURED' ? 503 : 502;
    if (!err.code) console.error('[ai] message summary failed:', err.message);
    res.status(status).json({ ok: false, error: err.code ? err.message : 'Could not summarise this message.' });
  }
});

module.exports = router;
