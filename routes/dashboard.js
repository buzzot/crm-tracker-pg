const express = require('express');
const router = express.Router();
const crm = require('../services/crm');

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

router.get('/', async (req, res, next) => {
  try {
    const user = req.session.user;
    const { role, email } = user;
    const isRdUser = crm.isRdRole(role);

    // ── R&D dashboard ─────────────────────────────────────────────────────────
    if (isRdUser) {
      const [rdTasks, projects, activities, rawComments] = await Promise.all([
        crm.listRdIssues(user),
        crm.listProjects(user),
        crm.listActivities(user),
        crm.listAllComments(50, null),
      ]);

      const projectById  = new Map(projects.map((p) => [p.id, p]));
      const taskById     = new Map(rdTasks.map((t) => [t.id, t]));
      const activityById = new Map(activities.map((a) => [a.id, a]));

      // Combine open tasks + non-closed projects + non-completed activities
      const openTasks = rdTasks.map(t => ({ ...t, _type: 'task' }));
      const openProjects = projects
        .filter(p => !['Completed', 'Closed'].includes(p.status))
        .map(p => ({
          _type: 'project', id: p.id, name: p.name,
          status: p.status || 'Active', deadline: p.endDate,
          projectName: null, assignees: []
        }));
      const openActivities = activities
        .filter(a => a.result !== 'Completed')
        .map(a => ({
          _type: 'activity', id: a.id, name: a.name,
          status: a.result || 'Open', deadline: a.dueDate,
          projectName: a.projectNames?.[0] || null, assignees: []
        }));

      const rdIssues = [...openTasks, ...openProjects, ...openActivities]
        .sort((a, b) => {
          if (!a.deadline && !b.deadline) return 0;
          if (!a.deadline) return 1;
          if (!b.deadline) return -1;
          return new Date(a.deadline) - new Date(b.deadline);
        });

      const recentComments = rawComments
        .filter((c) => {
          if (c.taskIds     && c.taskIds[0])     return taskById.has(c.taskIds[0]);
          if (c.projectIds  && c.projectIds[0])  return projectById.has(c.projectIds[0]);
          if (c.activityIds && c.activityIds[0]) return activityById.has(c.activityIds[0]);
          return false;
        })
        .slice(0, 10)
        .map((c) => {
          let contextLabel = null, contextLink = null, contextType = null;
          if (c.taskIds && c.taskIds[0]) {
            const t = taskById.get(c.taskIds[0]);
            contextLabel = t ? t.name : 'Task';
            contextLink = `/tasks/${c.taskIds[0]}`;
            contextType = 'task';
          } else if (c.projectIds && c.projectIds[0]) {
            const p = projectById.get(c.projectIds[0]);
            contextLabel = p ? p.name : 'Project';
            contextLink = `/projects/${c.projectIds[0]}`;
            contextType = 'project';
          } else if (c.activityIds && c.activityIds[0]) {
            const a = activityById.get(c.activityIds[0]);
            contextLabel = a ? a.name : 'Activity';
            contextLink = `/activities/${c.activityIds[0]}`;
            contextType = 'activity';
          }
          return { ...c, contextLabel, contextLink, contextType, timeAgo: timeAgo(c.postedAt) };
        });

      return res.render('dashboard', {
        title: 'Dashboard',
        isRdUser: true,
        rdIssues,
        recentComments,
        stats: { companyCount: 0, openDealCount: 0, openPipelineTotal: 0, wonTotal: 0 },
        board: [],
        allActivities: [],
      });
    }

    // ── Sales / Admin dashboard ───────────────────────────────────────────────
    const [{ board: fullBoard }, allCompanies, allActivities, projects, tasks, rawComments] = await Promise.all([
      crm.getPipelineBoard(user),
      crm.listCompanies(user),
      crm.listActivities(user),
      crm.listProjects(user),
      crm.listProjectActivities(user),
      crm.listAllComments(10, role === 'Staff' ? user.id : null)
    ]);

    const scoped = (records) => (role === 'Sales' ? crm.scopeToOwner(records, email) : records);
    const companies = scoped(allCompanies);
    const activities = scoped(allActivities);
    const board = fullBoard.map((b) => ({ ...b, deals: scoped(b.deals) }))
      .map((b) => ({ ...b, total: b.deals.reduce((sum, d) => sum + (d.amount || 0), 0) }));

    const openStages = board.filter((b) => !b.stage.startsWith('Closed'));
    const openPipelineTotal = openStages.reduce((sum, b) => sum + b.total, 0);
    const openDealCount = openStages.reduce((sum, b) => sum + b.deals.length, 0);
    const wonTotal = board.find((b) => b.stage === 'Closed Won')?.total || 0;

    const companyById = new Map(companies.map((c) => [c.id, c]));
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const activityById = new Map(activities.map((a) => [a.id, a]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));

    const allMappedActivities = activities.map((a) => ({
      ...a,
      companyNames: a.companyIds.map((id) => companyById.get(id)?.name).filter(Boolean),
      projectNames: a.projectIds.map((id) => projectById.get(id)?.name).filter(Boolean)
    }));

    const recentComments = rawComments.map((c) => {
      let contextLabel = null, contextLink = null, contextType = null;
      if (c.activityIds && c.activityIds[0]) {
        const a = activityById.get(c.activityIds[0]);
        contextLabel = a ? a.name : 'Activity';
        contextLink = `/activities/${c.activityIds[0]}`;
        contextType = 'activity';
      } else if (c.taskIds && c.taskIds[0]) {
        const t = taskById.get(c.taskIds[0]);
        contextLabel = t ? t.name : 'Task';
        contextLink = `/tasks/${c.taskIds[0]}`;
        contextType = 'task';
      } else if (c.projectIds && c.projectIds[0]) {
        const p = projectById.get(c.projectIds[0]);
        contextLabel = p ? p.name : 'Project';
        contextLink = `/projects/${c.projectIds[0]}`;
        contextType = 'project';
      } else if (c.dealIds && c.dealIds[0]) {
        contextLabel = 'Deal';
        contextLink = `/deals/${c.dealIds[0]}`;
        contextType = 'deal';
      }
      return { ...c, contextLabel, contextLink, contextType, timeAgo: timeAgo(c.postedAt) };
    });

    res.render('dashboard', {
      title: 'Dashboard',
      isRdUser: false,
      rdIssues: [],
      stats: { companyCount: companies.length, openDealCount, openPipelineTotal, wonTotal },
      board,
      allActivities: allMappedActivities,
      recentComments
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
