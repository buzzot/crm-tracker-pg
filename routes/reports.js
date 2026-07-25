'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sinceNDays(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtMoney(n) {
  if (!n) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0 });
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.get('/reports/monthly', async (req, res, next) => {
  try {
    // ── Filters ───────────────────────────────────────────────────────────────
    const days      = parseInt(req.query.days, 10) || 30;
    const filterUid = req.query.userId || '';          // '' = all users
    const from      = sinceNDays(days);
    const today     = new Date().toISOString().slice(0, 10);

    // ── All users for dropdown ────────────────────────────────────────────────
    const usersR = await query(
      `SELECT id, name, title, role FROM users WHERE is_active = true ORDER BY name`
    );
    const users = usersR.rows;

    // Resolve selected user name for report header
    const selectedUser = filterUid
      ? users.find(u => u.id === filterUid) || null
      : null;

    // Helper: add owner filter to a params array, return placeholder string
    function ownerFilter(params, alias = '') {
      if (!filterUid) return '';
      const col = alias ? `${alias}.owner_id` : 'owner_id';
      return ` AND ${col} = $${params.push(filterUid)}`;
    }

    // ── 1. All active companies ───────────────────────────────────────────────
    const companiesR = await query(
      `SELECT id, name, industry, status, created_at FROM companies ORDER BY name ASC`
    );
    const allCompanies = companiesR.rows;

    // ── 2. New companies in period ────────────────────────────────────────────
    const ncParams = [from];
    const ncOwner  = ownerFilter(ncParams, 'c');
    const newCompaniesR = await query(
      `SELECT c.id, c.name, c.industry, c.status, c.created_at,
              u.name AS created_by_name
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
       WHERE c.created_at >= $1${ncOwner}
       ORDER BY c.created_at DESC`,
      ncParams
    );
    const newCompanies = newCompaniesR.rows;

    // ── 3. New contacts in period ─────────────────────────────────────────────
    // contacts may have owner_id but it's not guaranteed; filter by company owner as fallback
    const newContactsR = await query(
      `SELECT cn.id, cn.full_name, cn.title, cn.email, cn.created_at,
              c.name AS company_name
       FROM contacts cn
       LEFT JOIN companies c ON c.id = cn.company_id
       WHERE cn.created_at >= $1
       ORDER BY cn.created_at DESC`,
      [from]
    );
    const newContacts = newContactsR.rows;

    // ── 4. Activities in period ───────────────────────────────────────────────
    const actParams = [from];
    const actOwner  = ownerFilter(actParams, 'a');
    const activitiesR = await query(
      `SELECT a.id, a.name, a.type, a.result, a.details, a.due_date, a.status_date,
              a.created_at, a.owner_id,
              u.name AS owner_name,
              STRING_AGG(DISTINCT c.name, ', ') AS company_names
       FROM activities a
       LEFT JOIN users u ON u.id = a.owner_id
       LEFT JOIN companies c ON c.id = a.company_id
       WHERE (a.created_at >= $1 OR a.status_date >= $1)${actOwner}
       GROUP BY a.id, u.name, c.name
       ORDER BY COALESCE(a.status_date, a.created_at) DESC`,
      actParams
    );
    const activities = activitiesR.rows;

    const completedActivities = activities.filter(a =>
      (a.result || '').toLowerCase() === 'completed' ||
      (a.result || '').toLowerCase().includes('done') ||
      (a.result || '').toLowerCase().includes('success')
    );

    // ── 5. Deals / pipeline ───────────────────────────────────────────────────
    const dealParams = [];
    const dealOwner  = ownerFilter(dealParams, 'd');
    const dealWhere  = dealOwner ? `WHERE 1=1${dealOwner}` : '';
    const dealsR = await query(
      `SELECT d.id, d.name, d.stage, d.amount,
              d.created_at, d.updated_at, d.owner_id,
              c.name AS company_name,
              u.name AS owner_name
       FROM deals d
       LEFT JOIN companies c ON c.id = d.company_id
       LEFT JOIN users u ON u.id = d.owner_id
       ${dealWhere}
       ORDER BY d.amount DESC NULLS LAST`,
      dealParams
    );
    const deals = dealsR.rows;

    const openDeals      = deals.filter(d => d.stage && !d.stage.startsWith('Closed'));
    const wonDeals       = deals.filter(d => d.stage === 'Closed Won');
    const lostDeals      = deals.filter(d => d.stage === 'Closed Lost');
    const newDeals       = deals.filter(d => d.created_at >= from);
    const totalPipeline  = openDeals.reduce((s, d) => s + (Number(d.amount) || 0), 0);
    const totalWon       = wonDeals.reduce((s, d) => s + (Number(d.amount) || 0), 0);

    const stageMap = {};
    openDeals.forEach(d => {
      if (!stageMap[d.stage]) stageMap[d.stage] = { count: 0, amount: 0 };
      stageMap[d.stage].count++;
      stageMap[d.stage].amount += Number(d.amount) || 0;
    });

    // ── 6. Tasks ──────────────────────────────────────────────────────────────
    const taskParams = [from];
    const taskOwner  = ownerFilter(taskParams, 't');
    const tasksR = await query(
      `SELECT t.id, t.name, t.status, t.deadline, t.created_at, t.owner_id,
              u.name AS owner_name,
              p.name AS project_name
       FROM tasks t
       LEFT JOIN users u ON u.id = t.owner_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE (t.created_at >= $1 OR t.updated_at >= $1)${taskOwner}
       ORDER BY t.deadline ASC NULLS LAST`,
      taskParams
    );
    const tasks = tasksR.rows;

    const completedTasks = tasks.filter(t => t.status === 'Completed');
    const openTasks      = tasks.filter(t => t.status !== 'Completed');
    const overdueTasks   = openTasks.filter(t =>
      t.deadline && new Date(t.deadline) < new Date()
    );

    // ── 7. Projects ───────────────────────────────────────────────────────────
    const projParams = [from];
    const projOwner  = ownerFilter(projParams, 'p');
    const projectsR = await query(
      `SELECT p.id, p.name, p.status,
              p.created_at, p.updated_at, p.owner_id,
              c.name AS company_name,
              u.name AS owner_name
       FROM projects p
       LEFT JOIN companies c ON c.id = p.company_id
       LEFT JOIN users u ON u.id = p.owner_id
       WHERE (p.updated_at >= $1 OR p.created_at >= $1)${projOwner}
       ORDER BY p.updated_at DESC NULLS LAST`,
      projParams
    );
    const projects = projectsR.rows;

    // ── 8. Products (always all — not user-scoped) ────────────────────────────
    const productsR = await query(
      `SELECT id, name, category, phase, horse_power, created_at FROM products ORDER BY category, name`
    );
    const products = productsR.rows;

    // ── 9. Activity type breakdown ─────────────────────────────────────────────
    const actTypeMap = {};
    activities.forEach(a => {
      const t = a.type || 'Other';
      if (!actTypeMap[t]) actTypeMap[t] = 0;
      actTypeMap[t]++;
    });

    // ── Render ─────────────────────────────────────────────────────────────────
    res.render('report-monthly', {
      title: 'Monthly Business Report',
      layout: false,
      reportPeriod: `${fmtDate(from)} – ${fmtDate(today)}`,
      generatedAt: new Date().toLocaleString('en-GB'),
      filterDays: days,
      filterUserId: filterUid,
      selectedUser,
      allCompanies,
      newCompanies,
      newContacts,
      activities,
      completedActivities,
      actTypeMap,
      deals,
      openDeals,
      wonDeals,
      lostDeals,
      newDeals,
      totalPipeline,
      totalWon,
      stageMap,
      tasks,
      completedTasks,
      openTasks,
      overdueTasks,
      projects,
      products,
      users,
      fmtDate,
      fmtMoney
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
