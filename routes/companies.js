'use strict';
const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const crm     = require('../services/crm');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ─── List ─────────────────────────────────────────────────────────────────────

router.get('/companies', async (req, res, next) => {
  try {
    const user = req.session.user;
    const companies = await crm.listCompanies(user);
    res.render('companies', { title: 'Companies', companies });
  } catch (err) { next(err); }
});

// ─── New ──────────────────────────────────────────────────────────────────────

router.get('/companies/new', (req, res) => {
  res.render('company-new', {
    title: 'Add Company',
    statusChoices: crm.schema.tables.company.statusChoices,
    industryChoices: crm.schema.tables.company.industryChoices,
    error: null, values: {}
  });
});

router.post('/companies', upload.array('attachments', 20), async (req, res, next) => {
  try {
    const { name, industry, status, web, billingAddress, notes } = req.body;
    const user = req.session.user;
    const company = await crm.createCompany({
      name, industry, status, web, billingAddress, notes,
      ownerId: user ? user.id : null,
      createdById: user ? user.id : null,
    });
    if (req.files && req.files.length) {
      await crm.addCompanyAttachments(company.id, req.files, user?.id);
    }
    res.redirect(`/companies/${company.id}`);
  } catch (err) {
    res.status(400).render('company-new', {
      title: 'Add Company',
      statusChoices: crm.schema.tables.company.statusChoices,
      industryChoices: crm.schema.tables.company.industryChoices,
      error: err.message, values: req.body
    });
  }
});

router.post('/companies/:id/attachments', upload.array('attachments', 20), async (req, res, next) => {
  try {
    if (req.files && req.files.length) {
      await crm.addCompanyAttachments(req.params.id, req.files, req.session.user?.id);
    }
    res.redirect(`/companies/${req.params.id}`);
  } catch (err) { next(err); }
});

// ─── Edit ─────────────────────────────────────────────────────────────────────

router.get('/companies/:id/edit', async (req, res, next) => {
  try {
    const company = await crm.getCompany(req.params.id);
    if (!company) return res.status(404).render('error', { title: 'Not found', message: 'Company not found.' });
    res.render('company-edit', {
      title: `Edit ${company.name}`, company,
      statusChoices: crm.schema.tables.company.statusChoices,
      industryChoices: crm.schema.tables.company.industryChoices,
      error: null
    });
  } catch (err) { next(err); }
});

router.post('/companies/:id', async (req, res, next) => {
  try {
    const { name, industry, status, web, billingAddress, notes } = req.body;
    await crm.updateCompany(req.params.id, { name, industry, status, web, billingAddress, notes }, req.session.user?.id);
    res.redirect(`/companies/${req.params.id}`);
  } catch (err) {
    try {
      const company = await crm.getCompany(req.params.id);
      res.status(400).render('company-edit', {
        title: `Edit ${company.name}`,
        company: { ...company, ...req.body },
        statusChoices: crm.schema.tables.company.statusChoices,
        industryChoices: crm.schema.tables.company.industryChoices,
        error: err.message
      });
    } catch (e) { next(e); }
  }
});

// ─── Detail ───────────────────────────────────────────────────────────────────

router.get('/companies/:id', async (req, res, next) => {
  try {
    const user = req.session.user;
    const detail = await crm.getCompanyDetail(req.params.id);
    if (!detail.company) return res.status(404).render('error', { title: 'Not found', message: 'Company not found.' });
    // Staff access check: must be owner/created_by or assigned
    if (user && user.role === 'Staff') {
      const c = detail.company;
      const isOwner = c.ownerId === user.id || c.createdBy === user.id;
      if (!isOwner) {
        // Check user_assignments
        const assignments = await crm.listAssignments('company', req.params.id);
        const isAssigned = assignments.some(a => a.userId === user.id);
        if (!isAssigned) {
          return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have access to this company.' });
        }
      }
    }
    res.render('company-detail', { title: detail.company.name, ...detail });
  } catch (err) { next(err); }
});

// ─── Sub-resource new forms ───────────────────────────────────────────────────

router.get('/companies/:id/contacts/new', async (req, res, next) => {
  try {
    const company = await crm.getCompany(req.params.id);
    if (!company) return res.status(404).render('error', { title: 'Not found', message: 'Company not found.' });
    res.render('contact-new', {
      title: 'Add Contact', company,
      statusChoices: crm.schema.tables.contacts.statusChoices,
      error: null, values: {}
    });
  } catch (err) { next(err); }
});

router.post('/companies/:id/contacts', async (req, res, next) => {
  try {
    const { firstName, lastName, title, phone, email, status, notes } = req.body;
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || null;
    await crm.createContact({ fullName, companyId: req.params.id, title, phone, email, status, notes });
    res.redirect(`/companies/${req.params.id}`);
  } catch (err) {
    try {
      const company = await crm.getCompany(req.params.id);
      res.status(400).render('contact-new', {
        title: 'Add Contact', company,
        statusChoices: crm.schema.tables.contacts.statusChoices,
        error: err.message, values: req.body
      });
    } catch (err2) { next(err2); }
  }
});

router.get('/companies/:id/deals/new', async (req, res, next) => {
  try {
    const user = req.session.user;
    const company = await crm.getCompany(req.params.id);
    if (!company) return res.status(404).render('error', { title: 'Not found', message: 'Company not found.' });
    const contacts = await crm.listContacts(user);
    const persons = contacts.filter(c => c.companyIds.includes(req.params.id));
    res.render('deal-new', {
      title: 'Create Deal', company, persons,
      stageChoices: crm.schema.tables.deals.stageChoices,
      error: null, values: {}
    });
  } catch (err) { next(err); }
});

router.post('/companies/:id/deals', async (req, res, next) => {
  try {
    const { name, primaryContactId, stage, amount, probability, closeDate } = req.body;
    await crm.createDeal({ name, companyId: req.params.id, primaryContactId, stage, amount, probability, closeDate });
    res.redirect(`/companies/${req.params.id}`);
  } catch (err) {
    try {
      const user = req.session.user;
      const company = await crm.getCompany(req.params.id);
      const contacts = await crm.listContacts(user);
      const persons = contacts.filter(c => c.companyIds.includes(req.params.id));
      res.status(400).render('deal-new', {
        title: 'Create Deal', company, persons,
        stageChoices: crm.schema.tables.deals.stageChoices,
        error: err.message, values: req.body
      });
    } catch (err2) { next(err2); }
  }
});

router.get('/companies/:id/projects/new', async (req, res, next) => {
  try {
    const company = await crm.getCompany(req.params.id);
    if (!company) return res.status(404).render('error', { title: 'Not found', message: 'Company not found.' });
    const products = await crm.listProducts();
    res.render('project-new', {
      title: 'Create Project', company, products,
      statusChoices: crm.schema.tables.projects.statusChoices,
      categoryChoices: crm.schema.tables.projects.categoryChoices,
      productCategoryChoices: crm.schema.tables.products.categoryChoices,
      error: null, values: {}
    });
  } catch (err) { next(err); }
});

router.post('/companies/:id/projects', upload.array('attachments', 10), async (req, res, next) => {
  try {
    const { name, status, category, description, startDate, endDate } = req.body;
    let productIds = req.body.productIds || [];
    if (!Array.isArray(productIds)) productIds = [productIds];
    const user = req.session.user;
    const project = await crm.createProject({
      name, companyId: req.params.id, productIds, status, category, description, startDate, endDate,
      ownerId: user ? user.id : null,
    });
    if (req.files && req.files.length) await crm.addProjectAttachments(project.id, req.files);
    res.redirect(`/companies/${req.params.id}`);
  } catch (err) {
    try {
      const company = await crm.getCompany(req.params.id);
      const products = await crm.listProducts();
      res.status(400).render('project-new', {
        title: 'Create Project', company, products,
        statusChoices: crm.schema.tables.projects.statusChoices,
        categoryChoices: crm.schema.tables.projects.categoryChoices,
        productCategoryChoices: crm.schema.tables.products.categoryChoices,
        error: err.message, values: req.body
      });
    } catch (err2) { next(err2); }
  }
});

router.get('/companies/:id/activities/new', async (req, res, next) => {
  try {
    const user = req.session.user;
    const company = await crm.getCompany(req.params.id);
    if (!company) return res.status(404).render('error', { title: 'Not found', message: 'Company not found.' });
    const [contacts, projects] = await Promise.all([
      crm.listContacts(user),
      crm.listProjects(user),
    ]);
    const persons = contacts.filter(c => c.companyIds.includes(req.params.id));
    const companyProjects = projects.filter(p => p.companyIds.includes(req.params.id));
    res.render('activity-new', {
      title: 'New Activity', company, persons, projects: companyProjects,
      typeChoices: crm.schema.tables.activities.typeChoices,
      resultChoices: crm.schema.tables.activities.resultChoices,
      error: null, values: {}
    });
  } catch (err) { next(err); }
});

router.post('/companies/:id/activities', async (req, res, next) => {
  try {
    const { name, type, dueDate, details, regarding, result } = req.body;
    let attendeeIds = req.body.attendeeIds || [];
    if (!Array.isArray(attendeeIds)) attendeeIds = [attendeeIds];
    let projectIds = req.body.projectIds || [];
    if (!Array.isArray(projectIds)) projectIds = [projectIds];
    await crm.createActivity({ name, companyId: req.params.id, type, dueDate, details, regarding, result, attendeeIds, projectIds });
    res.redirect(`/companies/${req.params.id}`);
  } catch (err) {
    try {
      const user = req.session.user;
      const company = await crm.getCompany(req.params.id);
      const [contacts, projects] = await Promise.all([crm.listContacts(user), crm.listProjects(user)]);
      const persons = contacts.filter(c => c.companyIds.includes(req.params.id));
      const companyProjects = projects.filter(p => p.companyIds.includes(req.params.id));
      res.status(400).render('activity-new', {
        title: 'New Activity', company, persons, projects: companyProjects,
        typeChoices: crm.schema.tables.activities.typeChoices,
        resultChoices: crm.schema.tables.activities.resultChoices,
        error: err.message, values: req.body
      });
    } catch (err2) { next(err2); }
  }
});

router.post('/companies/:id/logo', upload.single('logo'), async (req, res, next) => {
  try {
    if (req.file) await crm.updateCompanyLogo(req.params.id, req.file);
    res.redirect(`/companies/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
