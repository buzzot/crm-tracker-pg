const express = require('express');
const router = express.Router();
const crm = require('../services/crm');

router.get('/contacts/:id', async (req, res, next) => {
  try {
    const contact = await crm.getContactDetail(req.params.id);
    if (!contact.firstName) return res.status(404).render('error', { title: 'Not found', message: 'Contact not found.' });
    res.render('contact-detail', {
      title: contact.fullName || 'Contact',
      contact,
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post('/contacts/:id/details', async (req, res, next) => {
  try {
    const { title, email, phone } = req.body;
    await crm.updateContact(req.params.id, { title, email, phone });
    res.redirect(`/contacts/${req.params.id}`);
  } catch (err) {
    try {
      const contact = await crm.getContactDetail(req.params.id);
      return res.status(400).render('contact-detail', {
        title: contact.fullName || 'Contact',
        contact,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

router.post('/contacts/:id/comments', async (req, res, next) => {
  try {
    const { comment, link } = req.body;
    const author = (req.session.user && req.session.user.name) || 'Someone';
    await crm.addContactComment({ contactId: req.params.id, author, comment, link });
    res.redirect(`/contacts/${req.params.id}`);
  } catch (err) {
    try {
      const contact = await crm.getContactDetail(req.params.id);
      return res.status(400).render('contact-detail', {
        title: contact.fullName || 'Contact',
        contact,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

module.exports = router;
