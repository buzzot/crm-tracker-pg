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
      // Fetch a wider window so updates can be grouped per account without repeats
      crm.listAllComments(60, role === 'Staff' ? user.id : null)
    ]);

    const scoped = (records) => (role === 'Sales' ? crm.scopeToOwner(records, email) : records);
    const companies = scoped(allCompanies);
    const activities = scoped(allActivities);
    const board = fullBoard.map((b) => ({ ...b, deals: scoped(b.deals) }));

    const companyById  = new Map(companies.map((c) => [c.id, c]));
    const projectById  = new Map(projects.map((p) => [p.id, p]));
    const activityById = new Map(activities.map((a) => [a.id, a]));
    const taskById     = new Map(tasks.map((t) => [t.id, t]));
    const dealById     = new Map(board.flatMap((b) => b.deals).map((d) => [d.id, d]));

    const companyOfProject = (pid) => {
      const p = pid && projectById.get(pid);
      return p && p.companyId ? { id: p.companyId, name: p.companyName || companyById.get(p.companyId)?.name || null } : null;
    };
    const companyOfActivity = (a) => {
      const cid = a.companyIds && a.companyIds[0];
      if (cid) return { id: cid, name: companyById.get(cid)?.name || (a.companyNames && a.companyNames[0]) || null };
      return companyOfProject(a.projectIds && a.projectIds[0]);
    };

    // ── Pipeline summary (open stages + closed outcomes) ─────────────────────
    const stageSummary = board.map((b) => {
      const withValue = b.deals.filter((d) => d.amountSet);
      return {
        stage: b.stage,
        closed: b.stage.startsWith('Closed'),
        count: b.deals.length,
        total: withValue.reduce((s, d) => s + d.amount, 0),
        noValue: b.deals.filter((d) => !d.amountSet).length,
        zeroValue: withValue.filter((d) => d.amount === 0).length,
      };
    });
    const openStages = stageSummary.filter((s) => !s.closed);
    const won  = stageSummary.find((s) => s.stage === 'Closed Won')  || { count: 0, total: 0 };
    const lost = stageSummary.find((s) => s.stage === 'Closed Lost') || { count: 0, total: 0 };

    const stats = {
      openPipelineTotal: openStages.reduce((s, b) => s + b.total, 0),
      openDealCount:     openStages.reduce((s, b) => s + b.count, 0),
      openNoValueCount:  openStages.reduce((s, b) => s + b.noValue, 0),
      wonTotal: won.total, wonCount: won.count, lostCount: lost.count,
      companyCount:  companies.length,
      clientCount:   companies.filter((c) => c.status === 'Client').length,
      prospectCount: companies.filter((c) => c.status === 'Prospect').length,
    };

    // ── Needs attention: open tasks + open activity follow-ups with a due date ─
    // Sent unfiltered by date; the browser decides overdue/upcoming in the user's
    // own timezone and limits the visible list.
    const isMine = (ownerId, assigneeIds = []) => ownerId === user.id || assigneeIds.includes(user.id);
    const attention = [
      ...tasks
        .filter((t) => t.deadline && t.status !== 'Completed')
        .map((t) => {
          const co = companyOfProject(t.projectId);
          return {
            kind: 'task', id: t.id, title: t.name, due: t.deadline,
            status: t.status || 'To Do',
            companyId: co?.id || null, companyName: co?.name || null,
            context: t.projectName || null,
            link: `/tasks/${t.id}`,
            mine: isMine(t.ownerId, t.assigneeIds),
          };
        }),
      ...activities
        .filter((a) => a.dueDate && a.result !== 'Completed')
        .map((a) => {
          const co = companyOfActivity(a);
          return {
            kind: 'activity', id: a.id, title: a.name, due: a.dueDate,
            status: a.result || null, // last outcome, not a completion state
            companyId: co?.id || null, companyName: co?.name || null,
            context: a.type || null,
            link: `/activities/${a.id}`,
            mine: isMine(a.ownerId),
          };
        }),
    ].sort((x, y) => (x.due < y.due ? -1 : x.due > y.due ? 1 : 0));

    // ── Recent activity: what actually happened, newest first ─────────────────
    const occurred = (a) => a.statusDate || a.date || (a.createdAt ? new Date(a.createdAt).toISOString().slice(0, 10) : '');
    const recentActivities = activities
      .map((a) => {
        const co = companyOfActivity(a);
        return {
          id: a.id, title: a.name, type: a.type || null, result: a.result || null,
          occurred: occurred(a),
          companyId: co?.id || null, companyName: co?.name || null,
          mine: isMine(a.ownerId),
        };
      })
      .filter((a) => a.occurred)
      .sort((x, y) => (x.occurred < y.occurred ? 1 : x.occurred > y.occurred ? -1 : 0))
      .slice(0, 40);

    // ── Latest account updates: grouped by company, one line per conversation ─
    const resolveEntity = (c) => {
      if (c.activityIds[0]) {
        const a = activityById.get(c.activityIds[0]);
        return a && { key: `activity:${a.id}`, label: a.name, link: `/activities/${a.id}`, kind: 'activity', company: companyOfActivity(a) };
      }
      if (c.taskIds[0]) {
        const t = taskById.get(c.taskIds[0]);
        return t && { key: `task:${t.id}`, label: t.name, link: `/tasks/${t.id}`, kind: 'task', company: companyOfProject(t.projectId), project: t.projectId ? { id: t.projectId, name: t.projectName } : null };
      }
      if (c.projectIds[0]) {
        const p = projectById.get(c.projectIds[0]);
        return p && { key: `project:${p.id}`, label: p.name, link: `/projects/${p.id}`, kind: 'project', company: companyOfProject(p.id), project: { id: p.id, name: p.name } };
      }
      if (c.dealIds[0]) {
        const d = dealById.get(c.dealIds[0]);
        return d && { key: `deal:${d.id}`, label: d.name, link: `/deals/${d.id}`, kind: 'deal', company: d.companyId ? { id: d.companyId, name: d.companyName } : null };
      }
      return null; // contact comments or entities the user cannot access are skipped
    };

    const groups = new Map();
    for (const c of rawComments) {             // already newest-first
      const ent = resolveEntity(c);
      if (!ent) continue;
      // Group by company; fall back to the related project, then the record itself
      const g = ent.company?.id
        ? { key: `co:${ent.company.id}`, title: ent.company.name || 'Company', link: `/companies/${ent.company.id}`, icon: 'bi-building' }
        : ent.project?.id
          ? { key: `pr:${ent.project.id}`, title: ent.project.name || 'Project', link: `/projects/${ent.project.id}`, icon: 'bi-folder2' }
          : { key: ent.key, title: ent.label, link: ent.link, icon: 'bi-chat-left-text' };
      if (!groups.has(g.key)) groups.set(g.key, { ...g, latestAt: c.postedAt, total: 0, threads: new Map() });
      const grp = groups.get(g.key);
      grp.total += 1;
      if (!grp.threads.has(ent.key)) {
        grp.threads.set(ent.key, {
          label: ent.label, link: ent.link, kind: ent.kind,
          type: c.type === 'email' ? 'email' : 'comment',
          author: c.author,
          text: (c.type === 'email' && c.emailSubject) ? c.emailSubject : (c.comment || ''),
          postedAt: c.postedAt, timeAgo: timeAgo(c.postedAt),
          more: 0,
        });
      } else {
        grp.threads.get(ent.key).more += 1;   // older message in the same conversation
      }
    }
    const accountUpdates = [...groups.values()].slice(0, 5).map((g) => ({
      key: g.key, title: g.title, link: g.link, icon: g.icon,
      total: g.total, timeAgo: timeAgo(g.latestAt),
      threads: [...g.threads.values()].slice(0, 2),
      hiddenThreads: Math.max(0, g.threads.size - 2),
    }));

    res.render('dashboard', {
      title: 'Dashboard',
      isRdUser: false,
      rdIssues: [],
      canToggleScope: ['Admin', 'Manager'].includes(role),
      stats,
      openStages,
      won, lost,
      attention,
      recentActivities,
      accountUpdates,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
