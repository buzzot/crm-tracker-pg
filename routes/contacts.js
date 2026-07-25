const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const crm     = require('../services/crm');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.get('/contacts/:id', async (req, res, next) => {
  try {
    const contact = await crm.getContactDetail(req.params.id);
    if (!contact.firstName) return res.status(404).render('error', { title: 'Not found', message: 'Contact not found.' });
    res.render('contact-detail', {
      title: contact.fullName || 'Contact',
      contact,
      statusChoices: crm.schema.tables.contacts.statusChoices,
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post('/contacts/:id/details', async (req, res, next) => {
  try {
    const { title, email, phone, notes, status, companyId } = req.body;
    await crm.updateContact(req.params.id, { title, email, phone, notes, status, companyId: companyId || null });
    res.redirect(`/contacts/${req.params.id}`);
  } catch (err) {
    try {
      const contact = await crm.getContactDetail(req.params.id);
      return res.status(400).render('contact-detail', {
        title: contact.fullName || 'Contact',
        contact,
        statusChoices: crm.schema.tables.contacts.statusChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

router.post('/contacts/:id/comments', upload.array('attachment', 5), async (req, res, next) => {
  try {
    const { comment } = req.body;
    const author = (req.session.user && req.session.user.name) || 'Someone';
    const authorId = req.session.user ? req.session.user.id : null;
    await crm.addContactComment({ contactId: req.params.id, author, authorId, comment, files: req.files });
    res.redirect(`/contacts/${req.params.id}`);
  } catch (err) {
    try {
      const contact = await crm.getContactDetail(req.params.id);
      return res.status(400).render('contact-detail', {
        title: contact.fullName || 'Contact',
        contact,
        statusChoices: crm.schema.tables.contacts.statusChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

module.exports = router;
