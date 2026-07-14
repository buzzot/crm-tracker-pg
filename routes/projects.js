const express = require('express');
const multer = require('multer');
const router = express.Router();
const crm = require('../services/crm');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

router.get('/projects', async (req, res, next) => {
  try {
    const projects = await crm.listProjectsWithSubtasks();
    res.render('projects', { title: 'Projects', projects });
  } catch (err) {
    next(err);
  }
});

router.get('/projects/new', async (req, res, next) => {
  try {
    const [companies, products] = await Promise.all([crm.listCompanies(), crm.listProducts()]);
    res.render('project-new', {
      title: 'Create Project',
      company: null,
      companies,
      products,
      statusChoices: crm.schema.tables.projects.statusChoices,
      categoryChoices: crm.schema.tables.projects.categoryChoices,
      productCategoryChoices: crm.schema.tables.products.categoryChoices,
      error: null,
      values: {}
    });
  } catch (err) {
    next(err);
  }
});

router.post('/projects', upload.array('attachments', 10), async (req, res, next) => {
  try {
    const { name, companyId, status, category, description, startDate, endDate } = req.body;
    let productIds = req.body.productIds;
    if (!productIds) productIds = [];
    if (!Array.isArray(productIds)) productIds = [productIds];
    const project = await crm.createProject({ name, companyId: companyId || null, productIds, status, category, description, startDate, endDate });
    if (req.files && req.files.length) {
      await crm.addProjectAttachments(project.id, req.files);
    }
    res.redirect(`/projects/${project.id}`);
  } catch (err) {
    try {
      const [companies, products] = await Promise.all([crm.listCompanies(), crm.listProducts()]);
      return res.status(400).render('project-new', {
        title: 'Create Project',
        company: null,
        companies,
        products,
        statusChoices: crm.schema.tables.projects.statusChoices,
        categoryChoices: crm.schema.tables.projects.categoryChoices,
        productCategoryChoices: crm.schema.tables.products.categoryChoices,
        error: err.message,
        values: req.body
      });
    } catch (err2) {
      next(err2);
    }
  }
});

router.get('/projects/:id', async (req, res, next) => {
  try {
    const [project, allTasks] = await Promise.all([
      crm.getProjectDetail(req.params.id),
      crm.listProjectActivities()
    ]);
    if (!project.name) return res.status(404).render('error', { title: 'Not found', message: 'Project not found.' });
    res.render('project-detail', { title: project.name, project, allTasks });
  } catch (err) {
    next(err);
  }
});

router.get('/projects/:id/edit', async (req, res, next) => {
  try {
    const [project, companies, products] = await Promise.all([
      crm.getProjectDetail(req.params.id),
      crm.listCompanies(),
      crm.listProducts()
    ]);
    if (!project.name) return res.status(404).render('error', { title: 'Not found', message: 'Project not found.' });
    res.render('project-edit', {
      title: `Edit ${project.name}`,
      project,
      companies,
      products,
      statusChoices: crm.schema.tables.projects.statusChoices,
      categoryChoices: crm.schema.tables.projects.categoryChoices,
      productCategoryChoices: crm.schema.tables.products.categoryChoices,
      error: null,
      values: {
        name: project.name,
        companyId: project.companies[0] ? project.companies[0].id : '',
        status: project.status,
        category: project.category,
        description: project.description,
        startDate: project.startDate,
        endDate: project.endDate,
        productIds: project.products.map((p) => p.id)
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/edit', async (req, res, next) => {
  try {
    const { name, companyId, status, category, description, startDate, endDate } = req.body;
    let productIds = req.body.productIds;
    if (!productIds) productIds = [];
    if (!Array.isArray(productIds)) productIds = [productIds];
    await crm.updateProject(req.params.id, {
      name,
      companyId: companyId || null,
      productIds,
      status,
      category,
      description,
      startDate,
      endDate
    });
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) {
    try {
      const [project, companies, products] = await Promise.all([
        crm.getProjectDetail(req.params.id),
        crm.listCompanies(),
        crm.listProducts()
      ]);
      let productIds = req.body.productIds;
      if (!productIds) productIds = [];
      if (!Array.isArray(productIds)) productIds = [productIds];
      return res.status(400).render('project-edit', {
        title: `Edit ${project.name}`,
        project,
        companies,
        products,
        statusChoices: crm.schema.tables.projects.statusChoices,
        categoryChoices: crm.schema.tables.projects.categoryChoices,
        productCategoryChoices: crm.schema.tables.products.categoryChoices,
        error: err.message,
        values: { ...req.body, productIds }
      });
    } catch (err2) {
      next(err2);
    }
  }
});

router.post('/projects/:id/attachments', upload.array('attachments', 10), async (req, res, next) => {
  try {
    if (req.files && req.files.length) {
      await crm.addProjectAttachments(req.params.id, req.files);
    }
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Post a note/comment on this project, attributed to the logged-in user.
router.post('/projects/:id/comments', upload.array('attachment', 5), async (req, res, next) => {
  try {
    const { comment, link } = req.body;
    const author = (req.session.user && req.session.user.name) || 'Someone';
    await crm.addProjectComment({ projectId: req.params.id, author, comment, link, files: req.files });
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) {
    try {
      const [project, allTasks] = await Promise.all([
        crm.getProjectDetail(req.params.id),
        crm.listProjectActivities()
      ]);
      return res.status(400).render('project-detail', {
        title: project.name,
        project,
        allTasks,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

// Link an already-existing task to this project (the task keeps any other
// project links it already has).
router.post('/projects/:id/tasks/link', async (req, res, next) => {
  try {
    const { taskId } = req.body;
    if (taskId) {
      await crm.linkTaskToProject({ taskId, projectId: req.params.id });
    }
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/projects/:id/tasks/new', async (req, res, next) => {
  try {
    const project = await crm.getProjectDetail(req.params.id);
    if (!project.name) return res.status(404).render('error', { title: 'Not found', message: 'Project not found.' });
    res.render('project-task-new', {
      title: 'New Task',
      project,
      typeChoices: crm.schema.tables.projectActivities.typeChoices,
      statusChoices: crm.schema.tables.projectActivities.statusChoices,
      error: null,
      values: {}
    });
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/tasks', async (req, res, next) => {
  try {
    const { name, type, date, deadline, status, details } = req.body;
    const createdByEmail = (req.session.user && req.session.user.email) || null;
    const createdByName = (req.session.user && req.session.user.name) || null;
    await crm.createProjectActivity({ name, projectId: req.params.id, type, date, deadline, status, details, createdByEmail, createdByName });
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) {
    try {
      const project = await crm.getProjectDetail(req.params.id);
      return res.status(400).render('project-task-new', {
        title: 'New Task',
        project,
        typeChoices: crm.schema.tables.projectActivities.typeChoices,
        statusChoices: crm.schema.tables.projectActivities.statusChoices,
        error: err.message,
        values: req.body
      });
    } catch (err2) {
      next(err2);
    }
  }
});

module.exports = router;
