'use strict';
const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const crm     = require('../services/crm');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ─── Task list ────────────────────────────────────────────────────────────────

router.get('/tasks', async (req, res, next) => {
  try {
    const user     = req.session.user;
    const filter   = req.query.status || 'active'; // 'active' | 'completed' | 'all'
    const userId   = req.query.userId || '';        // Admin-only user filter
    const isAdmin  = user && user.role === 'Admin';

    const [tasks, projects, teamUsers, onboardingTasks] = await Promise.all([
      crm.listTasks({ user }),
      crm.listProjects(user),
      isAdmin ? crm.listTeamUsers() : Promise.resolve([]),
      isAdmin ? crm.listOnboardingTasks() : Promise.resolve([]),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const dayMs = 86400000;
    const weekEnd = new Date(Date.now() + (7 - ((new Date().getDay() + 6) % 7)) * dayMs).toISOString().slice(0, 10); // through Sunday
    const projById = {}; projects.forEach((p) => { projById[p.id] = p; });
    const decorate = (t) => {
      const done = t.status === 'Completed';
      const dueDays = t.deadline ? Math.round((new Date(t.deadline + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / dayMs) : null;
      let bucket = 'none';
      if (done) bucket = 'done';
      else if (dueDays !== null) bucket = dueDays < 0 ? 'overdue' : dueDays === 0 ? 'today' : t.deadline <= weekEnd ? 'week' : 'later';
      const proj = t.projectId ? projById[t.projectId] : null;
      const people = (t.assignees && t.assignees.length) ? t.assignees : (t.ownerId ? [{ id: t.ownerId, name: t.ownerName }] : []);
      const mine = !!user && (t.ownerId === user.id || (t.assigneeIds || []).includes(user.id) || t.auditorId === user.id);
      return { ...t, done, dueDays, bucket, people, mine,
        companyId: proj ? proj.companyId : null, companyName: proj ? proj.companyName : null };
    };
    const rows = tasks.map(decorate);
    const peopleMap = {};
    rows.forEach((t) => t.people.forEach((p) => { if (p.id) peopleMap[p.id] = p.name; }));
    teamUsers.forEach((u) => { if (u.isActive !== false) peopleMap[u.id] = u.name; });
    const people = Object.keys(peopleMap).map((id) => ({ id, name: peopleMap[id] || 'Unknown' })).sort((a, b) => a.name.localeCompare(b.name));

    res.render('tasks', {
      title: 'Tasks',
      tasks: rows,
      filter,
      filterUserId: userId,
      people,
      onboardingTasks: onboardingTasks.map(decorate),
      statusChoices: crm.schema.tables.tasks.statusChoices,
    });
  } catch (err) { next(err); }
});

// ─── Create task ──────────────────────────────────────────────────────────────

async function renderNewTask(req, res, { values = {}, error = null, status = 200 } = {}) {
  const user = req.session.user;
  const [projects, teamUsers] = await Promise.all([crm.listProjects(user), crm.listTeamUsers()]);
  const presetProject = values.projectId || req.query.project || '';
  res.status(status).render('task-new', {
    title: 'New task',
    projects: projects.filter((p) => !['Completed', 'Cancelled'].includes(p.status) || p.id === presetProject)
      .map((p) => ({ id: p.id, name: p.name, company: p.companyName || null })),
    teamUsers: teamUsers.filter((u) => u.isActive !== false).map((u) => ({ id: u.id, name: u.name, title: u.title, role: u.role })),
    statusChoices: crm.schema.tables.tasks.statusChoices,
    presetProject, values, error, created: req.query.created || null,
  });
}

router.get('/tasks/new', async (req, res, next) => {
  try { await renderNewTask(req, res); } catch (err) { next(err); }
});

router.post('/tasks/new', upload.array('attachments', 10), async (req, res, next) => {
  const b = req.body || {};
  try {
    const user = req.session.user;
    const name = String(b.name || '').trim();
    if (!name) throw new Error('Give the task a name.');
    if (b.startDate && b.deadline && b.startDate > b.deadline) throw new Error('The due date is before the start date.');
    const task = await crm.createTask({
      name, description: b.description, projectId: b.projectId || null,
      startDate: b.startDate || null, deadline: b.deadline || null, status: b.status || 'To Do',
      auditorId: b.auditorId || null, ownerId: user ? user.id : null,
    });
    const ids = [].concat(b.assigneeIds || []).filter(Boolean);
    if (ids.length) await crm.setTaskAssignees({ taskId: task.id, userIds: ids });
    if (req.files && req.files.length) await crm.addTaskAttachments(task.id, req.files, user ? user.id : null);
    if (b.another === '1') {
      return res.redirect('/tasks/new?created=' + encodeURIComponent(task.id) + (b.projectId ? '&project=' + encodeURIComponent(b.projectId) : ''));
    }
    res.redirect(b.projectId && b.returnTo === 'project' ? `/projects/${b.projectId}` : `/tasks/${task.id}`);
  } catch (err) {
    try { await renderNewTask(req, res, { values: b, error: err.message, status: 400 }); } catch (e2) { next(e2); }
  }
});

// ─── Task detail ──────────────────────────────────────────────────────────────

router.get('/tasks/:id', async (req, res, next) => {
  try {
    const user = req.session.user;
    const task = await crm.getTaskDetail(req.params.id);
    if (!task || !task.name) return res.status(404).render('error', { title: 'Not found', message: 'Task not found.' });
    // Archived tasks: only Admins may view; everyone else gets 404
    if (task.isArchived && (!user || user.role !== 'Admin')) {
      return res.status(404).render('error', { title: 'Not found', message: 'Task not found.' });
    }
    res.render('task-detail', {
      title: task.name,
      task,
      statusChoices: crm.schema.tables.tasks.statusChoices,
      recordCategoryChoices: [],
      error: null,
    });
  } catch (err) { next(err); }
});

// ─── Update details + deadline (logs deadline changes) ───────────────────────

router.post('/tasks/:id/details', async (req, res, next) => {
  try {
    const user   = req.session.user;
    const { name, startDate, deadline, description, status, deadlineReason } = req.body;
    await crm.updateTaskDetails(req.params.id, {
      name, startDate, deadline, description,
      status,
      deadlineReason: deadlineReason || null,
      changedById:    user ? user.id   : null,
      changedByName:  user ? user.name : null,
    });
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    try {
      const task = await crm.getTaskDetail(req.params.id);
      res.status(400).render('task-detail', { title: task.name, task, statusChoices: crm.schema.tables.tasks.statusChoices, recordCategoryChoices: [], error: err.message });
    } catch (e2) { next(e2); }
  }
});

// ─── Set auditor ─────────────────────────────────────────────────────────────

router.post('/tasks/:id/auditor', async (req, res, next) => {
  try {
    await crm.setTaskAuditor(req.params.id, req.body.auditorId || null);
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) { next(err); }
});

// ─── Set owner ───────────────────────────────────────────────────────────────

router.post('/tasks/:id/owner', async (req, res, next) => {
  try {
    await crm.setTaskOwner(req.params.id, req.body.ownerId || null);
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) { next(err); }
});

// ─── Assignees (by user IDs) ──────────────────────────────────────────────────

router.post('/tasks/:id/assignees', async (req, res, next) => {
  try {
    let userIds = req.body.userIds || [];
    if (!Array.isArray(userIds)) userIds = [userIds];
    await crm.setTaskAssignees({ taskId: req.params.id, userIds: userIds.filter(Boolean) });
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    try {
      const task = await crm.getTaskDetail(req.params.id);
      res.status(400).render('task-detail', { title: task.name, task, statusChoices: crm.schema.tables.tasks.statusChoices, recordCategoryChoices: [], error: err.message });
    } catch (e2) { next(e2); }
  }
});

// ─── Attachments ──────────────────────────────────────────────────────────────

router.post('/tasks/:id/attachments', upload.array('attachments', 10), async (req, res, next) => {
  try {
    if (req.files && req.files.length) {
      const user = req.session.user;
      await crm.addTaskAttachments(req.params.id, req.files, user ? user.id : null);
    }
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) { next(err); }
});

// ─── Comments ─────────────────────────────────────────────────────────────────

router.post('/tasks/:id/comments', upload.array('attachment', 5), async (req, res, next) => {
  try {
    const { comment, link } = req.body;
    const author = req.session.user ? req.session.user.name : 'Someone';
    const authorId = req.session.user ? req.session.user.id : null;
    await crm.addTaskComment({ taskId: req.params.id, author, authorId, comment, link, files: req.files });
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    try {
      const task = await crm.getTaskDetail(req.params.id);
      res.status(400).render('task-detail', { title: task.name, task, statusChoices: crm.schema.tables.tasks.statusChoices, recordCategoryChoices: [], error: err.message });
    } catch (e2) { next(e2); }
  }
});

// ─── Sub-task logs ────────────────────────────────────────────────────────────

router.post('/tasks/:id/records', upload.array('attachment', 5), async (req, res, next) => {
  try {
    const { name, details, category } = req.body;
    const user = req.session.user;
    await crm.addProjectActivityRecord({
      taskId: req.params.id,
      name,
      details,
      category,
      loggedById:   user ? user.id   : null,
      loggedByName: user ? user.name : null,
      files: req.files,
    });
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    try {
      const task = await crm.getTaskDetail(req.params.id);
      res.status(400).render('task-detail', { title: task.name, task, statusChoices: crm.schema.tables.tasks.statusChoices, recordCategoryChoices: [], error: err.message });
    } catch (e2) { next(e2); }
  }
});

// ─── Complete task ────────────────────────────────────────────────────────────

const wantsJson = (req) => (req.get('accept') || '').includes('application/json');

router.post('/tasks/:id/complete', async (req, res, next) => {
  try {
    await crm.completeTask(req.params.id);
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) { if (wantsJson(req)) return res.status(500).json({ ok: false, error: 'Could not complete the task.' }); next(err); }
});

router.post('/tasks/:id/status', async (req, res) => {
  try {
    const status = String((req.body && req.body.status) || '');
    if (!crm.schema.tables.tasks.statusChoices.includes(status)) return res.status(400).json({ ok: false, error: 'Unknown status.' });
    await crm.setTaskStatus(req.params.id, status);
    res.json({ ok: true, status });
  } catch (err) { res.status(500).json({ ok: false, error: 'Could not update the status.' }); }
});

router.post('/tasks/:id/reopen', async (req, res, next) => {
  try {
    await crm.reopenTask(req.params.id, req.body && req.body.status);
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) { if (wantsJson(req)) return res.status(500).json({ ok: false, error: 'Could not reopen the task.' }); next(err); }
});

// ─── Archive task (Admin only) ────────────────────────────────────────────────

router.post('/tasks/:id/archive', async (req, res, next) => {
  try {
    const user = req.session.user;
    if (!user || user.role !== 'Admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Only Admins can archive tasks.' });
    await crm.archiveTask(req.params.id, user.id);
    res.redirect('/admin/archived-tasks');
  } catch (err) { next(err); }
});

// ─── Unarchive task (Admin only) ─────────────────────────────────────────────

router.post('/tasks/:id/unarchive', async (req, res, next) => {
  try {
    const user = req.session.user;
    if (!user || user.role !== 'Admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Only Admins can restore tasks.' });
    await crm.unarchiveTask(req.params.id);
    res.redirect('/admin/archived-tasks');
  } catch (err) { next(err); }
});

module.exports = router;
