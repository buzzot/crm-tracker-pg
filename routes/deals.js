const express = require('express');
const router = express.Router();
const crm = require('../services/crm');

async function loadDealPageData(deal) {
  const [allProjects, allProducts] = await Promise.all([crm.listProjects(), crm.listProducts()]);
  const companyId = (deal.companyIds || [])[0];
  const companyProjects = companyId ? allProjects.filter((p) => p.companyIds.includes(companyId)) : allProjects;
  return { allProjects: companyProjects, allProducts };
}

router.get('/deals/:id', async (req, res, next) => {
  try {
    const deal = await crm.getDealDetail(req.params.id);
    if (!deal.name) return res.status(404).render('error', { title: 'Not found', message: 'Deal not found.' });
    const { allProjects, allProducts } = await loadDealPageData(deal);
    res.render('deal-detail', {
      title: deal.name,
      deal,
      persons: deal.persons || [],
      allProjects,
      allProducts,
      stageChoices: crm.schema.tables.deals.stageChoices,
      statusChoices: crm.schema.tables.projects.statusChoices,
      categoryChoices: crm.schema.tables.projects.categoryChoices,
      activityTypeChoices: crm.schema.tables.activities.typeChoices,
      error: null
    });
  } catch (err) {
    next(err);
  }
});

// Update the deal's core fields (name, stage, amount, probability, close date,
// primary contact). Posted from the inline edit form in the sidebar.
router.post('/deals/:id/details', async (req, res, next) => {
  try {
    const { name, stage, amount, probability, closeDate, primaryContactId } = req.body;
    if (!name || !name.trim()) throw new Error('Deal name is required.');
    await crm.updateDeal(req.params.id, { name, stage, amount, probability, closeDate, primaryContactId });
    res.redirect(`/deals/${req.params.id}`);
  } catch (err) {
    try {
      const deal = await crm.getDealDetail(req.params.id);
      const { allProjects, allProducts } = await loadDealPageData(deal);
      return res.status(400).render('deal-detail', {
        title: deal.name,
        deal,
        persons: deal.persons || [],
        allProjects,
        allProducts,
        stageChoices: crm.schema.tables.deals.stageChoices,
        statusChoices: crm.schema.tables.projects.statusChoices,
        categoryChoices: crm.schema.tables.projects.categoryChoices,
        activityTypeChoices: crm.schema.tables.activities.typeChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

// Update which Projects and/or Products are linked to this deal.
router.post('/deals/:id/links', async (req, res, next) => {
  try {
    let projectIds = req.body.projectIds;
    if (!projectIds) projectIds = [];
    if (!Array.isArray(projectIds)) projectIds = [projectIds];
    let productIds = req.body.productIds;
    if (!productIds) productIds = [];
    if (!Array.isArray(productIds)) productIds = [productIds];

    await crm.updateDealLinks(req.params.id, { projectIds, productIds });
    res.redirect(`/deals/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Create a brand-new Project directly from this deal (inherits the deal's
// company, and is immediately linked back onto the deal).
router.post('/deals/:id/projects', async (req, res, next) => {
  try {
    const { name, status, category, description, startDate, endDate } = req.body;
    let productIds = req.body.productIds;
    if (!productIds) productIds = [];
    if (!Array.isArray(productIds)) productIds = [productIds];

    await crm.createProjectFromDeal({ dealId: req.params.id, name, productIds, status, category, description, startDate, endDate });
    res.redirect(`/deals/${req.params.id}`);
  } catch (err) {
    try {
      const deal = await crm.getDealDetail(req.params.id);
      const { allProjects, allProducts } = await loadDealPageData(deal);
      return res.status(400).render('deal-detail', {
        title: deal.name,
        deal,
        persons: deal.persons || [],
        allProjects,
        allProducts,
        stageChoices: crm.schema.tables.deals.stageChoices,
        statusChoices: crm.schema.tables.projects.statusChoices,
        categoryChoices: crm.schema.tables.projects.categoryChoices,
        activityTypeChoices: crm.schema.tables.activities.typeChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

// Log a new activity (call/email/meeting/document, etc.) against this deal —
// reuses the existing Activities feature, scoped to the deal via its new
// "Deal" link field.
router.post('/deals/:id/activities', async (req, res, next) => {
  try {
    const { name, type, date, details, regarding, result } = req.body;
    const deal = await crm.getDeal(req.params.id);
    const companyId = (deal.companyIds || [])[0] || null;
    await crm.createActivity({ name, companyId, dealId: req.params.id, type, date, details, regarding, result });
    res.redirect(`/deals/${req.params.id}`);
  } catch (err) {
    try {
      const deal = await crm.getDealDetail(req.params.id);
      const { allProjects, allProducts } = await loadDealPageData(deal);
      return res.status(400).render('deal-detail', {
        title: deal.name,
        deal,
        persons: deal.persons || [],
        allProjects,
        allProducts,
        stageChoices: crm.schema.tables.deals.stageChoices,
        statusChoices: crm.schema.tables.projects.statusChoices,
        categoryChoices: crm.schema.tables.projects.categoryChoices,
        activityTypeChoices: crm.schema.tables.activities.typeChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

// Post a note/comment on this deal, attributed to the logged-in user.
router.post('/deals/:id/comments', async (req, res, next) => {
  try {
    const { comment, link } = req.body;
    const author = (req.session.user && req.session.user.name) || 'Someone';
    await crm.addDealComment({ dealId: req.params.id, author, comment, link });
    res.redirect(`/deals/${req.params.id}`);
  } catch (err) {
    try {
      const deal = await crm.getDealDetail(req.params.id);
      const { allProjects, allProducts } = await loadDealPageData(deal);
      return res.status(400).render('deal-detail', {
        title: deal.name,
        deal,
        persons: deal.persons || [],
        allProjects,
        allProducts,
        stageChoices: crm.schema.tables.deals.stageChoices,
        statusChoices: crm.schema.tables.projects.statusChoices,
        categoryChoices: crm.schema.tables.projects.categoryChoices,
        activityTypeChoices: crm.schema.tables.activities.typeChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

module.exports = router;
