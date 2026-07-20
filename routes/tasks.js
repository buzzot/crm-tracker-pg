'use strict';
const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const crm     = require('../services/crm');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ─── Task list ────────────────────────────────────────────────────────────────

router.get('/tasks', async (req, res, next) => {
  try {
    const user   = req.session.user;
    const filter = req.query.status || 'active'; // 'active' | 'completed' | 'all'
    const tasks  = await crm.listTasks({ user });
    const projects = await crm.listProjects(user);
    res.render('tasks', {
      title: 'Tasks',
      tasks,
      projects,
      filter,
      statusChoices: crm.schema.tables.tasks.statusChoices,
    });
  } catch (err) { next(err); }
});

// ─── Create task ──────────────────────────────────────────────────────────────

router.get('/tasks/new', async (req, res, next) => {
  try {
    const user     = req.session.user;
    const projects = await crm.listProjects(user);
    const teamUsers = await crm.listTeamUsers();
    res.render('task-new', {
      title: 'New Task',
      projects,
      teamUsers,
      prefillProjectId: req.query.project || null,
      statusChoices: crm.schema.tables.tasks.statusChoices,
    });
  } catch (err) { next(err); }
});

router.post('/tasks/new', async (req, res, next) => {
  try {
    const user = req.session.user;
    const { name, description, projectId, deadline, status, auditorId, assigneeIds } = req.body;
    if (!name) return res.redirect('/tasks/new?error=name+required');

    const task = await crm.createTask({
      name,
      description,
      projectId:  projectId  || null,
      deadline:   deadline   || null,
      status:     status     || 'To Do',
      auditorId:  auditorId  || null,
      ownerId:    user ? user.id : null,
    });

    // Set assignees
    const ids = [].concat(assigneeIds || []).filter(Boolean);
    if (ids.length) {
      await crm.setTaskAssignees({ taskId: task.id, userIds: ids });
    }

    res.redirect(`/tasks/${task.id}`);
  } catch (err) { next(err); }
});

// ─── Task detail ──────────────────────────────────────────────────────────────

router.get('/tasks/:id', async (req, res, next) => {
  try {
    const task = await crm.getTaskDetail(req.params.id);
    if (!task || !task.name) return res.status(404).render('error', { title: 'Not found', message: 'Task not found.' });
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
    const { name, date, deadline, description, status, deadlineReason } = req.body;
    await crm.updateTaskDetails(req.params.id, {
      name, date, deadline, description,
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
    await crm.addTaskComment({ taskId: req.params.id, author, comment, link, files: req.files });
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
      recordedByEmail: user ? user.email : null,
      recordedByName:  user ? user.name  : null,
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

router.post('/tasks/:id/complete', async (req, res, next) => {
  try {
    await crm.completeTask(req.params.id);
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) { next(err); }
});

module.exports = router;
