const express = require('express');
const multer = require('multer');
const router = express.Router();
const crm = require('../services/crm');
const ai = require('../services/ai');
const { autoClean } = require('../services/autoclean');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// ── Projects list: derived signals for following a project ──────────────────
const QUIET_DAYS = 14;
const DAY = 86400000;
function ymd(d) { return d.toISOString().slice(0, 10); }
function relDays(iso, today) {
  if (!iso) return null;
  return Math.round((new Date(iso + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / DAY);
}
function projectHealth(p, user) {
  const today = ymd(new Date());
  const status = p.status || 'Active';
  const tasks = p.tasks || [];
  const done = tasks.filter((t) => t.status === 'Completed');
  const open = tasks.filter((t) => t.status !== 'Completed');
  const overdue = open.filter((t) => t.deadline && t.deadline < today);
  const blocked = open.filter((t) => t.status === 'Blocked');
  const nextTask = open.filter((t) => t.deadline).sort((a, b) => a.deadline.localeCompare(b.deadline))[0] || null;
  const stamps = [p.updatedAt, p.lastMessage && p.lastMessage.at].concat(tasks.map((t) => t.updatedAt)).filter(Boolean).map((d) => new Date(d).getTime());
  const lastAt = stamps.length ? new Date(Math.max.apply(null, stamps)) : null;
  const idleDays = lastAt ? Math.floor((Date.now() - lastAt.getTime()) / DAY) : null;
  const live = status === 'Active';
  const flags = [];
  if (live && overdue.length) flags.push('overdue');
  if (live && blocked.length) flags.push('blocked');
  if (live && idleDays !== null && idleDays >= QUIET_DAYS) flags.push('quiet');
  const me = user && user.id;
  const mine = !!me && (p.ownerId === me || tasks.some((t) => t.ownerId === me || (t.assigneeIds || []).includes(me)));
  return {
    ...p,
    statusLabel: status,
    taskTotal: tasks.length, taskDone: done.length, openTasks: open,
    overdueCount: overdue.length, blockedCount: blocked.length,
    nextTask, nextDueDays: nextTask ? relDays(nextTask.deadline, today) : null,
    lastAt: lastAt ? lastAt.toISOString() : null, idleDays, flags, mine,
  };
}

router.get('/projects', async (req, res, next) => {
  try {
    const user = req.session.user;
    const projects = (await crm.listProjectsOverview(user)).map((p) => projectHealth(p, user));
    res.render('projects', { title: 'Projects', projects });
  } catch (err) {
    next(err);
  }
});

router.get('/projects/new', async (req, res, next) => {
  try {
    const user = req.session.user;
    const [companies, products] = await Promise.all([crm.listCompanies(user), crm.listProducts()]);
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
    const project = await crm.createProject({ name, companyId: companyId || null, productIds, status, category, description, startDate, endDate, createdById: req.session.user?.id });
    if (req.files && req.files.length) {
      await crm.addProjectAttachments(project.id, req.files);
    }
    res.redirect(`/projects/${project.id}`);
  } catch (err) {
    try {
      const user = req.session.user;
      const [companies, products] = await Promise.all([crm.listCompanies(user), crm.listProducts()]);
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

    // People for the "Log email or WeChat" From/To pickers: the project company's
    // contacts (same access rules as the Contacts list) plus active team members.
    let messagePeople = { companyName: project.companyName || null, contacts: [], team: [] };
    try {
      const companyId = project.companyId || (project.companyIds || [])[0] || null;
      const [contacts, team] = await Promise.all([
        companyId ? crm.listContacts(req.session.user) : Promise.resolve([]),
        crm.listTeamUsers(),
      ]);
      messagePeople.contacts = contacts
        .filter((c) => (c.companyIds || []).includes(companyId) && c.status !== 'Left')
        .map((c) => ({ name: c.fullName || '', email: c.email || '', title: c.title || '' }))
        .filter((c) => c.name || c.email);
      messagePeople.team = team
        .filter((u) => u.isActive !== false)
        .map((u) => ({ name: u.name || '', email: u.email || '', title: u.title || '' }));
    } catch (e) {
      console.error('[projects] message people lookup failed:', e.message);   // pickers are optional
    }

    res.render('project-detail', {
      title: project.name, project, allTasks, messagePeople, aiEnabled: ai.isConfigured(),
      msgError: req.query.msgError ? String(req.query.msgError).slice(0, 200) : null,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/projects/:id/edit', async (req, res, next) => {
  try {
    const user = req.session.user;
    const [project, companies, products] = await Promise.all([
      crm.getProjectDetail(req.params.id),
      crm.listCompanies(user),
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
        productIds: project.products.map((p) => p.id),
        isRdIssue: project.isRdIssue || false,
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/edit', async (req, res, next) => {
  try {
    const { name, companyId, status, category, description, startDate, endDate } = req.body;
    const isRdIssue = req.body.isRdIssue === '1';
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
      endDate,
      isRdIssue,
    }, req.session.user?.id);
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) {
    try {
      const [project, companies, products] = await Promise.all([
        crm.getProjectDetail(req.params.id),
        crm.listCompanies(req.session.user),
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

router.post('/projects/:id/owner', async (req, res, next) => {
  try {
    const user = req.session.user;
    if (!user || !['Admin', 'Manager', 'Head R&D Controllers', 'Head R&D VFD'].includes(user.role)) {
      return res.status(403).send('Forbidden');
    }
    await crm.setProjectOwner(req.params.id, req.body.ownerId || null, user.id);
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/projects/:id/auditor', async (req, res, next) => {
  try {
    const user = req.session.user;
    if (!user || !['Admin', 'Manager', 'Head R&D Controllers', 'Head R&D VFD'].includes(user.role)) {
      return res.status(403).send('Forbidden');
    }
    await crm.setProjectAuditor(req.params.id, req.body.auditorId || null, user.id);
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/projects/:id/assignees', async (req, res, next) => {
  try {
    const user = req.session.user;
    if (!user || !['Admin', 'Manager', 'Head R&D Controllers', 'Head R&D VFD'].includes(user.role)) {
      return res.status(403).send('Forbidden');
    }
    let userIds = req.body.userIds || [];
    if (!Array.isArray(userIds)) userIds = [userIds];
    await crm.setProjectAssignees(req.params.id, userIds);
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/projects/:id/toggle-rd', async (req, res, next) => {
  try {
    const user = req.session.user;
    if (!user || !['Admin', 'Head R&D Controllers', 'Head R&D VFD'].includes(user.role)) {
      return res.status(403).send('Forbidden');
    }
    const project = await crm.getProject(req.params.id);
    if (!project) return res.status(404).send('Not found');
    await crm.setProjectRdIssue(req.params.id, !project.isRdIssue, user.id);
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) {
    next(err);
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

// AI summary of the whole conversation (comments + logged/inbound messages)
router.post('/projects/:id/summary', async (req, res) => {
  try {
    const project = await crm.getProjectDetail(req.params.id);
    if (!project || !project.name) return res.status(404).json({ ok: false, error: 'Project not found.' });
    const result = await ai.summarizeThread({ project, comments: project.comments, tasks: project.subtasks });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.code === 'AI_NOT_CONFIGURED' ? 503 : err.code === 'AI_EMPTY' ? 400 : 502;
    if (!err.code) console.error('[ai] project summary failed:', err.message);
    res.status(status).json({ ok: false, error: err.code ? err.message : 'Could not create a summary. Try again.' });
  }
});

// Log an email / WeChat message by hand (pasted from the mail client or WeChat).
router.post('/projects/:id/messages', upload.array('attachment', 10), async (req, res, next) => {
  const back = `/projects/${req.params.id}`;
  try {
    const project = await crm.getProject(req.params.id);
    if (!project) return res.status(404).render('error', { title: 'Not found', message: 'Project not found.' });
    const user = req.session.user || {};
    const { channel, direction, from, to, subject, body, sentAtIso } = req.body;
    const saved = await crm.addManualMessage({
      entityType: 'project', entityId: req.params.id,
      channel, direction, from, to, subject, body, sentAt: sentAtIso,
      loggedById: user.id || null, loggedByName: user.name || user.email || null,
      files: req.files,
    });
    if (req.body.aiReviewed !== '1') autoClean(saved && saved.id);   // AI clean view in the background, unless the user already reviewed the AI text
    res.redirect(back + '#comments');
  } catch (err) {
    // Validation problems come back to the page as a short message
    res.redirect(back + '?msgError=' + encodeURIComponent(err.message) + '#comments');
  }
});

// Post a note/comment on this project, attributed to the logged-in user.
router.post('/projects/:id/comments', upload.array('attachment', 10), async (req, res, next) => {
  try {
    const { link } = req.body;
    let comment = req.body.comment;
    if ((!comment || !String(comment).trim()) && req.files && req.files.length) comment = '(screenshot attached)';
    const author = (req.session.user && req.session.user.name) || 'Someone';
    const authorId = req.session.user ? req.session.user.id : null;
    await crm.addProjectComment({ projectId: req.params.id, author, authorId, comment, link, files: req.files });
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
      typeChoices: crm.schema.tables.tasks.typeChoices,
      statusChoices: crm.schema.tables.tasks.statusChoices,
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
        typeChoices: crm.schema.tables.tasks.typeChoices,
        statusChoices: crm.schema.tables.tasks.statusChoices,
        error: err.message,
        values: req.body
      });
    } catch (err2) {
      next(err2);
    }
  }
});

module.exports = router;
