const express = require('express');
const multer = require('multer');
const router = express.Router();
const crm = require('../services/crm');
const { sendActivityConfirmationEmails } = require('../services/email');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

async function loadFormData(activity, user) {
  const companyId = (activity.companyIds || [])[0];
  const [contacts, projects, teamUsers] = await Promise.all([
    crm.listContacts(user),
    crm.listProjects(user),
    crm.listTeamUsers(),
  ]);
  const persons = companyId ? contacts.filter((c) => c.companyIds.includes(companyId)) : contacts;
  const companyProjects = companyId ? projects.filter((p) => p.companyIds.includes(companyId)) : projects;
  return { persons, projects: companyProjects, teamUsers };
}

router.get('/activities', async (req, res, next) => {
  try {
    const user = req.session.user;
    const [activities, allCompanies, projects] = await Promise.all([
      crm.listActivities(user),
      crm.listCompanies(user),
      crm.listProjects(user)
    ]);
    const companyById = new Map(allCompanies.map((c) => [c.id, c]));
    const projectById = new Map(projects.map((p) => [p.id, p]));

    const sorted = activities
      .slice()
      .sort((a, b) => new Date(b.statusDate || b.date || 0) - new Date(a.statusDate || a.date || 0))
      .map((a) => ({
        ...a,
        companyNames: a.companyIds.map((id) => companyById.get(id)?.name).filter(Boolean),
        projectNames: a.projectIds.map((id) => projectById.get(id)?.name).filter(Boolean)
      }));

    res.render('activities', { title: 'Activity', activities: sorted });
  } catch (err) {
    next(err);
  }
});

router.get('/activities/:id', async (req, res, next) => {
  try {
    const user = req.session.user;
    const activity = await crm.getActivityDetail(req.params.id);
    if (!activity.name) return res.status(404).render('error', { title: 'Not found', message: 'Activity not found.' });
    const { persons, projects, teamUsers } = await loadFormData(activity, user);
    activity.regardingInput = activity.regarding ? String(activity.regarding).slice(0, 16) : '';
    res.render('activity-detail', {
      title: activity.name,
      activity,
      persons,
      projects,
      teamUsers,
      typeChoices: crm.schema.tables.activities.typeChoices,
      resultChoices: crm.schema.tables.activities.resultChoices,
      editMode: req.query.edit === '1',
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post('/activities/:id', async (req, res, next) => {
  try {
    const { name, type, dueDate, details, regarding, result } = req.body;
    let attendeeIds = req.body.attendeeIds;
    if (!attendeeIds) attendeeIds = [];
    if (!Array.isArray(attendeeIds)) attendeeIds = [attendeeIds];
    let projectIds = req.body.projectIds;
    if (!projectIds) projectIds = [];
    if (!Array.isArray(projectIds)) projectIds = [projectIds];
    let participantIds = req.body.participantIds;
    if (!participantIds) participantIds = [];
    if (!Array.isArray(participantIds)) participantIds = [participantIds];

    // Fetch previous result to detect change to "Confirmed" / "Completed"
    const prevActivity = await crm.getActivityDetail(req.params.id);
    const prevResult = prevActivity.result || '';

    await crm.updateActivity(req.params.id, { name, type, dueDate, details, regarding, result, attendeeIds, projectIds, participantIds });

    // Send confirmation emails when result first becomes "Completed" (or "Confirmed" if you add it)
    const CONFIRM_RESULTS = new Set(['Completed', 'Confirmed']);
    if (CONFIRM_RESULTS.has(result) && !CONFIRM_RESULTS.has(prevResult) && participantIds.length) {
      try {
        const participants = await crm.listActivityParticipants(req.params.id);
        if (participants.length) {
          const updatedActivity = await crm.getActivityDetail(req.params.id);
          await sendActivityConfirmationEmails({ activity: updatedActivity, participants });
        }
      } catch (emailErr) {
        console.error('[activities] Email send error:', emailErr.message);
        // Non-fatal — don't abort the save
      }
    }

    res.redirect(`/activities/${req.params.id}`);
  } catch (err) {
    try {
      const user = req.session.user;
      const activity = await crm.getActivityDetail(req.params.id);
      const { persons, projects, teamUsers } = await loadFormData(activity, user);
      return res.status(400).render('activity-detail', {
        title: activity.name,
        activity: {
          ...activity,
          ...req.body,
          attendeeIds: [].concat(req.body.attendeeIds || activity.attendeeIds || []),
          projectIds: [].concat(req.body.projectIds || activity.projectIds || []),
          participants: activity.participants || [],
        },
        persons,
        projects,
        teamUsers,
        typeChoices: crm.schema.tables.activities.typeChoices,
        resultChoices: crm.schema.tables.activities.resultChoices,
        editMode: true,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

router.post('/activities/:id/delete', async (req, res, next) => {
  try {
    const user = req.session.user;
    if (!user || user.role !== 'Admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Only Admins can delete activities.' });
    await crm.deleteActivity(req.params.id);
    res.redirect('/activities');
  } catch (err) { next(err); }
});

router.post('/activities/:id/comments', upload.array('attachment', 5), async (req, res, next) => {
  try {
    const { comment, link } = req.body;
    const author = (req.session.user && req.session.user.name) || 'Someone';
    const authorId = req.session.user ? req.session.user.id : null;
    await crm.addActivityComment({ activityId: req.params.id, author, authorId, comment, link, files: req.files });
    res.redirect(`/activities/${req.params.id}`);
  } catch (err) {
    try {
      const user = req.session.user;
      const activity = await crm.getActivityDetail(req.params.id);
      const { persons, projects, teamUsers } = await loadFormData(activity, user);
      return res.status(400).render('activity-detail', {
        title: activity.name,
        activity,
        persons,
        projects,
        teamUsers,
        typeChoices: crm.schema.tables.activities.typeChoices,
        resultChoices: crm.schema.tables.activities.resultChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

router.post('/activities/:id/files', upload.any(), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (files.length) {
      await crm.addActivityAttachments(req.params.id, files);
    }
    res.redirect(`/activities/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
