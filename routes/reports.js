'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY = 86400000;
const STAGE_PROB = { 'Prospecting': 0.1, 'Qualification': 0.2, 'Needs Analysis': 0.4, 'Proposal / Price Quote': 0.6, 'Negotiation': 0.8 };
const STAGES = ['Prospecting', 'Qualification', 'Needs Analysis', 'Proposal / Price Quote', 'Negotiation'];
const OUTREACH = ['Call', 'Email', 'LinkedIn', 'Meeting', 'Demo'];

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(String(d).length === 10 ? d + 'T00:00:00' : d);
  return isNaN(dt) ? '—' : dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtMoney(n) {
  if (!n) return '—';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

// Report window. period: 7 | 30 | 60 | 90 | month | lastmonth. Returns [from, to) plus the previous window of equal length.
function windowFor(period) {
  const now = new Date();
  let from, to, label;
  if (period === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    label = from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  } else if (period === 'lastmonth') {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    to = new Date(now.getFullYear(), now.getMonth(), 1);
    label = from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  } else {
    const days = [7, 30, 60, 90].includes(Number(period)) ? Number(period) : 30;
    to = new Date(startOfDay(now).getTime() + DAY);
    from = new Date(to.getTime() - days * DAY);
    label = 'Last ' + days + ' days';
  }
  const len = to - from;
  const prevFrom = period === 'month' || period === 'lastmonth' ? new Date(from.getFullYear(), from.getMonth() - 1, 1) : new Date(from.getTime() - len);
  const lastDay = new Date(to.getTime() - DAY);
  return { from, to, prevFrom, prevTo: from, label, range: `${fmtDate(from)} – ${fmtDate(lastDay > now ? now : lastDay)}` };
}

const inRange = (d, a, b) => d && new Date(d) >= a && new Date(d) < b;
async function safe(sql, params) { try { return (await query(sql, params)).rows; } catch (_) { return []; } }

// ─── Route ────────────────────────────────────────────────────────────────────

router.get('/reports/monthly', async (req, res, next) => {
  try {
    const me = req.session.user;
    const canSeeTeam = ['Admin', 'Manager'].includes(me.role);
    const period = String(req.query.period || req.query.days || '30');
    // Non-managers can only see their own report
    const filterUid = canSeeTeam ? (req.query.userId || '') : me.id;
    if (filterUid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filterUid)) return res.redirect('/reports/monthly');
    const W = windowFor(period);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const users = (await query(`SELECT id, name, title, role FROM users WHERE is_active = true ORDER BY name`)).rows;
    const selectedUser = filterUid ? users.find((u) => u.id === filterUid) || { id: filterUid, name: me.name } : null;
    const own = (alias, col = 'owner_id') => (filterUid ? ` AND ${alias}.${col} = '${filterUid.replace(/[^0-9a-f-]/gi, '')}'` : '');
    const taskScope = filterUid
      ? ` AND (t.owner_id = '${filterUid.replace(/[^0-9a-f-]/gi, '')}' OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = '${filterUid.replace(/[^0-9a-f-]/gi, '')}'))`
      : '';

    const [companies, contacts, activities, deals, tasks, projects, messages, sentEmails, research, productLinks, dealProducts] = await Promise.all([
      safe(`SELECT c.id, c.name, c.industry, c.status, c.owner_id, c.created_at, u.name AS owner_name
            FROM companies c LEFT JOIN users u ON u.id = c.owner_id WHERE 1=1${own('c')} ORDER BY c.name`),
      safe(`SELECT cn.id, cn.full_name, cn.title, cn.email, cn.created_at, cn.company_id, c.name AS company_name
            FROM contacts cn LEFT JOIN companies c ON c.id = cn.company_id
            WHERE cn.created_at >= $1 AND cn.created_at < $2${own('cn')} ORDER BY c.name NULLS LAST, cn.full_name`, [W.prevFrom, W.to]),
      safe(`SELECT a.id, a.name, a.type, a.result, a.status_date, a.due_date, a.created_at, a.owner_id, a.company_id,
                   u.name AS owner_name, c.name AS company_name
            FROM activities a LEFT JOIN users u ON u.id = a.owner_id LEFT JOIN companies c ON c.id = a.company_id
            WHERE (a.created_at >= $1 OR a.status_date >= $1::date)${own('a')}
            ORDER BY COALESCE(a.status_date::timestamptz, a.created_at) DESC`, [W.prevFrom]),
      safe(`SELECT d.id, d.name, d.stage, d.amount, d.created_at, d.updated_at, d.owner_id, d.company_id,
                   c.name AS company_name, u.name AS owner_name
            FROM deals d LEFT JOIN companies c ON c.id = d.company_id LEFT JOIN users u ON u.id = d.owner_id
            WHERE 1=1${own('d')} ORDER BY d.amount DESC NULLS LAST`),
      safe(`SELECT t.id, t.name, t.status, t.deadline, t.created_at, t.updated_at, t.completed_at, t.owner_id, t.project_id,
                   u.name AS owner_name, p.name AS project_name,
                   (SELECT string_agg(au.name, ', ') FROM task_assignees ta2 JOIN users au ON au.id = ta2.user_id WHERE ta2.task_id = t.id) AS assignee_names
            FROM tasks t LEFT JOIN users u ON u.id = t.owner_id LEFT JOIN projects p ON p.id = t.project_id
            WHERE (t.is_archived IS NOT TRUE) AND (t.is_onboarding IS NOT TRUE)${taskScope}
            ORDER BY t.deadline ASC NULLS LAST`),
      safe(`SELECT p.id, p.name, p.status, p.category, p.created_at, p.updated_at, p.owner_id, p.company_id,
                   c.name AS company_name, u.name AS owner_name
            FROM projects p LEFT JOIN companies c ON c.id = p.company_id LEFT JOIN users u ON u.id = p.owner_id
            ORDER BY p.updated_at DESC NULLS LAST`),
      safe(`SELECT cm.id, cm.type, cm.link, cm.entity_type, cm.entity_id, cm.created_at, cm.author_id
            FROM comments cm WHERE cm.created_at >= $1 AND cm.created_at < $2${own('cm', 'author_id')}`, [W.prevFrom, W.to]),
      safe(`SELECT e.id, e.company_id, e.user_id, e.sent_at FROM email_messages e
            WHERE e.status = 'sent' AND e.sent_at >= $1 AND e.sent_at < $2${own('e', 'user_id')}`, [W.prevFrom, W.to]),
      safe(`SELECT r.company_id, r.created_at, c.name AS company_name FROM company_research r JOIN companies c ON c.id = r.company_id
            WHERE r.created_at >= $1 AND r.created_at < $2`, [W.from, W.to]),
      safe(`SELECT pp.project_id, pr.id, pr.name, pr.category FROM product_projects pp JOIN products pr ON pr.id = pp.product_id`),
      safe(`SELECT dp.deal_id, pr.id, pr.name, pr.category FROM deal_products dp JOIN products pr ON pr.id = dp.product_id`),
    ]);

    // ── Period slices ─────────────────────────────────────────────────────────
    const cur = (d) => inRange(d, W.from, W.to);
    const prev = (d) => inRange(d, W.prevFrom, W.prevTo);
    const isDoneAct = (a) => /^(completed|done)/i.test(a.result || '');
    const actDate = (a) => (isDoneAct(a) && a.status_date) || a.created_at;

    const actsCur = activities.filter((a) => cur(actDate(a)));
    const actsDone = actsCur.filter(isDoneAct);
    const actsPrevDone = activities.filter((a) => isDoneAct(a) && prev(actDate(a)));
    const newCompanies = companies.filter((c) => cur(c.created_at));
    const newContactsAll = contacts.filter((c) => cur(c.created_at));
    const seen = new Set();
    const newContacts = newContactsAll.filter((c) => { const k = (c.full_name || '').toLowerCase() + '|' + c.company_id; if (seen.has(k)) return false; seen.add(k); return true; });
    const prevContacts = contacts.filter((c) => prev(c.created_at));

    const tasksDone = tasks.filter((t) => t.status === 'Completed' && cur(t.completed_at || t.updated_at));
    const tasksPrevDone = tasks.filter((t) => t.status === 'Completed' && prev(t.completed_at || t.updated_at));
    const openTasks = tasks.filter((t) => t.status !== 'Completed');
    const overdue = openTasks.filter((t) => t.deadline && String(t.deadline instanceof Date ? t.deadline.toISOString() : t.deadline).slice(0, 10) < today);
    const dueSoon = openTasks.filter((t) => { if (!t.deadline) return false; const d = new Date(t.deadline); return d >= startOfDay(now) && d < new Date(startOfDay(now).getTime() + 14 * DAY); });

    const msgChannel = (m) => { let ch = m.type || 'comment'; if (String(m.link || '').startsWith('MANUAL:')) { try { ch = JSON.parse(m.link.slice(7)).ch || ch; } catch (_) { /* ignore */ } } return ch; };
    const msgsCur = messages.filter((m) => cur(m.created_at));
    const msgsPrev = messages.filter((m) => prev(m.created_at));
    const extCur = msgsCur.filter((m) => ['email', 'wechat'].includes(msgChannel(m)));
    const extPrev = msgsPrev.filter((m) => ['email', 'wechat'].includes(msgChannel(m)));
    const sentCur = sentEmails.filter((e) => cur(e.sent_at));

    // ── Deals ────────────────────────────────────────────────────────────────
    const openDeals = deals.filter((d) => !String(d.stage || '').startsWith('Closed'));
    const amt = (d) => Number(d.amount) || 0;
    const pipeline = STAGES.map((s) => { const list = openDeals.filter((d) => (STAGES.includes(d.stage) ? d.stage : 'Prospecting') === s); return { stage: s, count: list.length, amount: list.reduce((x, d) => x + amt(d), 0), prob: STAGE_PROB[s] }; });
    const pipelineValue = openDeals.reduce((x, d) => x + amt(d), 0);
    const weighted = Math.round(pipeline.reduce((x, s) => x + s.amount * s.prob, 0));
    const wonCur = deals.filter((d) => d.stage === 'Closed Won' && cur(d.updated_at));
    const lostCur = deals.filter((d) => d.stage === 'Closed Lost' && cur(d.updated_at));
    const newDeals = deals.filter((d) => cur(d.created_at));
    const prevNewDeals = deals.filter((d) => prev(d.created_at));
    const stalledDeals = openDeals.filter((d) => (now - new Date(d.updated_at)) / DAY >= 21);
    const dealsNoAmount = openDeals.filter((d) => !amt(d)).length;

    // ── Projects: what was worked on ─────────────────────────────────────────
    const tasksByProject = {}; tasks.forEach((t) => { if (t.project_id) (tasksByProject[t.project_id] = tasksByProject[t.project_id] || []).push(t); });
    const msgsByProject = {}; msgsCur.filter((m) => m.entity_type === 'project').forEach((m) => { (msgsByProject[m.entity_id] = msgsByProject[m.entity_id] || []).push(m); });
    const lastMsg = {}; messages.filter((m) => m.entity_type === 'project').forEach((m) => { if (!lastMsg[m.entity_id] || new Date(m.created_at) > new Date(lastMsg[m.entity_id])) lastMsg[m.entity_id] = m.created_at; });
    const projRows = projects
      .filter((p) => !filterUid || p.owner_id === filterUid || (tasksByProject[p.id] || []).length || (msgsByProject[p.id] || []).length)
      .map((p) => {
        const pt = tasksByProject[p.id] || [];
        const done = pt.filter((t) => t.status === 'Completed' && cur(t.completed_at || t.updated_at)).length;
        const open = pt.filter((t) => t.status !== 'Completed').length;
        const late = pt.filter((t) => overdue.includes(t)).length;
        const msgs = (msgsByProject[p.id] || []).length;
        const stamps = [p.updated_at, lastMsg[p.id]].concat(pt.map((t) => t.updated_at)).filter(Boolean).map((d) => new Date(d).getTime());
        const last = stamps.length ? new Date(Math.max.apply(null, stamps)) : null;
        const status = p.status || 'Active';
        return { ...p, status, done, open, late, msgs, last, touched: !!last && cur(last), quiet: status === 'Active' && (!last || (now - last) / DAY >= 14) };
      });
    const projTouched = projRows.filter((p) => p.touched).sort((a, b) => (b.msgs + b.done) - (a.msgs + a.done) || b.last - a.last);
    const projActive = projRows.filter((p) => p.status === 'Active');
    const projQuiet = projActive.filter((p) => p.quiet).sort((a, b) => (a.last || 0) - (b.last || 0));
    const projCompleted = projRows.filter((p) => p.status === 'Completed' && cur(p.updated_at));

    // ── Customers: who we engaged with ───────────────────────────────────────
    const projCompany = {}; projects.forEach((p) => { projCompany[p.id] = p.company_id; });
    const engage = {};
    const bump = (cid, k) => { if (!cid) return; engage[cid] = engage[cid] || { acts: 0, msgs: 0, emails: 0 }; engage[cid][k]++; };
    actsCur.forEach((a) => bump(a.company_id, 'acts'));
    msgsCur.forEach((m) => bump(m.entity_type === 'project' ? projCompany[m.entity_id] : m.entity_type === 'company' ? m.entity_id : null, 'msgs'));
    sentCur.forEach((e) => bump(e.company_id, 'emails'));
    const companyName = {}; companies.forEach((c) => { companyName[c.id] = c.name; });
    if (filterUid) { const all = await safe('SELECT id, name FROM companies'); all.forEach((c) => { companyName[c.id] = c.name; }); }
    const engaged = Object.keys(engage).map((id) => ({ id, name: companyName[id] || 'Unknown', ...engage[id], total: engage[id].acts + engage[id].msgs + engage[id].emails }))
      .sort((a, b) => b.total - a.total);
    const statusCount = {}; companies.forEach((c) => { const s = c.status || 'No status'; statusCount[s] = (statusCount[s] || 0) + 1; });
    const industryCount = {}; companies.forEach((c) => { const s = c.industry || 'Not set'; industryCount[s] = (industryCount[s] || 0) + 1; });

    // ── Products in play ──────────────────────────────────────────────────────
    const activeProjIds = new Set(projActive.map((p) => p.id));
    const openDealIds = new Set(openDeals.map((d) => d.id));
    const prodMap = {};
    productLinks.forEach((l) => { if (!activeProjIds.has(l.project_id)) return; const p = (prodMap[l.id] = prodMap[l.id] || { name: l.name, category: l.category, projects: 0, deals: 0 }); p.projects++; });
    dealProducts.forEach((l) => { if (!openDealIds.has(l.deal_id)) return; const p = (prodMap[l.id] = prodMap[l.id] || { name: l.name, category: l.category, projects: 0, deals: 0 }); p.deals++; });
    const productsInPlay = Object.values(prodMap).sort((a, b) => (b.projects + b.deals) - (a.projects + a.deals));

    // ── Activity mix ──────────────────────────────────────────────────────────
    const actTypes = {}; actsCur.forEach((a) => { const t = a.type || 'Other'; actTypes[t] = (actTypes[t] || 0) + 1; });
    const outreach = actsCur.filter((a) => OUTREACH.includes(a.type));
    const channelCount = { email: 0, wechat: 0, message: 0, comment: 0 }; msgsCur.forEach((m) => { const c = msgChannel(m); channelCount[c] = (channelCount[c] || 0) + 1; });

    // ── People ────────────────────────────────────────────────────────────────
    const people = (filterUid ? users.filter((u) => u.id === filterUid) : users).map((u) => {
      const assigned = (t) => t.owner_id === u.id || String(t.assignee_names || '').split(', ').includes(u.name);
      return {
        ...u,
        actsDone: actsDone.filter((a) => a.owner_id === u.id).length,
        acts: actsCur.filter((a) => a.owner_id === u.id).length,
        tasksDone: tasksDone.filter(assigned).length,
        open: openTasks.filter(assigned).length,
        late: overdue.filter(assigned).length,
        msgs: msgsCur.filter((m) => m.author_id === u.id).length + sentCur.filter((e) => e.user_id === u.id).length,
        deals: newDeals.filter((d) => d.owner_id === u.id).length,
      };
    }).filter((p) => filterUid || p.acts || p.tasksDone || p.open || p.msgs || p.deals)
      .sort((a, b) => (b.tasksDone + b.actsDone + b.msgs) - (a.tasksDone + a.actsDone + a.msgs));

    const delta = (a, b) => ({ now: a, prev: b, diff: a - b });
    const kpis = {
      tasksDone: delta(tasksDone.length, tasksPrevDone.length),
      actsDone: delta(actsDone.length, actsPrevDone.length),
      conversations: delta(extCur.length + sentCur.length, extPrev.length + sentEmails.filter((e) => prev(e.sent_at)).length),
      newContacts: delta(newContacts.length, prevContacts.length),
      newDeals: delta(newDeals.length, prevNewDeals.length),
      overdue: overdue.length,
    };

    res.render('report-monthly', {
      title: 'Monthly Business Report',
      layout: false,
      W, period, filterUserId: filterUid, selectedUser, canSeeTeam, users,
      generatedAt: now.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }),
      kpis, companies, statusCount, industryCount, engaged,
      actsCur, actsDone, actTypes, outreach, channelCount, research,
      newCompanies, newContacts,
      tasksDone, openTasks, overdue, dueSoon,
      openDeals, pipeline, pipelineValue, weighted, wonCur, lostCur, newDeals, stalledDeals, dealsNoAmount,
      projTouched, projActive, projQuiet, projCompleted, productsInPlay,
      extCur, sentCur, people,
      fmtDate, fmtMoney, today,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
