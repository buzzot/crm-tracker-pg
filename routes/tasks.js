const express = require('express');
const multer = require('multer');
const router = express.Router();
const crm = require('../services/crm');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

router.get('/tasks/:id', async (req, res, next) => {
  try {
    const task = await crm.getTaskDetail(req.params.id);
    if (!task.name) return res.status(404).render('error', { title: 'Not found', message: 'Task not found.' });
    res.render('task-detail', {
      title: task.name,
      task,
      statusChoices: crm.schema.tables.projectActivities.statusChoices,
      recordCategoryChoices: crm.schema.tables.projectActivityRecords.categoryChoices,
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post('/tasks/:id/comments', upload.array('attachment', 5), async (req, res, next) => {
  try {
    const { comment, link } = req.body;
    const author = (req.session.user && req.session.user.name) || 'Someone';
    await crm.addTaskComment({ taskId: req.params.id, author, comment, link, files: req.files });
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    try {
      const task = await crm.getTaskDetail(req.params.id);
      return res.status(400).render('task-detail', {
        title: task.name,
        task,
        statusChoices: crm.schema.tables.projectActivities.statusChoices,
        recordCategoryChoices: crm.schema.tables.projectActivityRecords.categoryChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

router.post('/tasks/:id/details', async (req, res, next) => {
  try {
    const { date, deadline, details } = req.body;
    await crm.updateTaskDetails({ taskId: req.params.id, date, deadline, details });
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    try {
      const task = await crm.getTaskDetail(req.params.id);
      return res.status(400).render('task-detail', {
        title: task.name,
        task,
        statusChoices: crm.schema.tables.projectActivities.statusChoices,
        recordCategoryChoices: crm.schema.tables.projectActivityRecords.categoryChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

// NOTE: Owner is set once, at task creation, to whoever created the task
// (see crm.createProjectActivity) and is intentionally not editable from the
// UI afterward — there is no /tasks/:id/assign route. Use the route below to
// manage the separate, changeable list of assigned helpers instead.

router.post('/tasks/:id/assignees', async (req, res, next) => {
  try {
    let emails = req.body.emails || [];
    if (!Array.isArray(emails)) emails = [emails];
    await crm.setTaskAssignees({ taskId: req.params.id, emails: emails.filter(Boolean) });
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    try {
      const task = await crm.getTaskDetail(req.params.id);
      return res.status(400).render('task-detail', {
        title: task.name,
        task,
        statusChoices: crm.schema.tables.projectActivities.statusChoices,
        recordCategoryChoices: crm.schema.tables.projectActivityRecords.categoryChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

router.post('/tasks/:id/attachments', upload.array('attachments', 10), async (req, res, next) => {
  try {
    if (req.files && req.files.length) {
      await crm.addTaskAttachments(req.params.id, req.files);
    }
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/tasks/:id/records', upload.array('attachment', 5), async (req, res, next) => {
  try {
    const { name, details, category } = req.body;
    const recordedByEmail = (req.session.user && req.session.user.email) || null;
    const recordedByName = (req.session.user && req.session.user.name) || null;
    await crm.addProjectActivityRecord({
      taskId: req.params.id,
      name,
      details,
      category,
      recordedByEmail,
      recordedByName,
      files: req.files
    });
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    try {
      const task = await crm.getTaskDetail(req.params.id);
      return res.status(400).render('task-detail', {
        title: task.name,
        task,
        statusChoices: crm.schema.tables.projectActivities.statusChoices,
        recordCategoryChoices: crm.schema.tables.projectActivityRecords.categoryChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

router.post('/tasks/:id/complete', async (req, res, next) => {
  try {
    await crm.completeTask(req.params.id);
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
