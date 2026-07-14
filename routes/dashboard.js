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
    const { role, email } = req.session.user;
    const [{ board: fullBoard }, allCompanies, allActivities, projects, tasks, rawComments] = await Promise.all([
      crm.getPipelineBoard(),
      crm.listCompanies(),
      crm.listActivities(),
      crm.listProjects(),
      crm.listProjectActivities(),
      crm.listAllComments(10)
    ]);

    // Sales only sees what they own; Admin/Manager see everything.
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

    const allMappedActivities = activities
      .map((a) => ({
        ...a,
        companyNames: a.companyIds.map((id) => companyById.get(id)?.name).filter(Boolean),
        projectNames: a.projectIds.map((id) => projectById.get(id)?.name).filter(Boolean)
      }));

    // Enrich comments with context label + link
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
      stats: {
        companyCount: companies.length,
        openDealCount,
        openPipelineTotal,
        wonTotal
      },
      board,
      allActivities: allMappedActivities,
      recentComments
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
