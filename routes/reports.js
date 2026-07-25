'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');

// ─── Helper ───────────────────────────────────────────────────────────────────

function since30() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
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
    const from = since30();
    const today = new Date().toISOString().slice(0, 10);
    const fromLabel = fmtDate(from);
    const toLabel   = fmtDate(today);

    // ── 1. All active companies ───────────────────────────────────────────────
    const companiesR = await query(
      `SELECT id, name, industry, status, created_at FROM companies ORDER BY name ASC`
    );
    const allCompanies = companiesR.rows;

    // ── 2. Companies created in last 30 days (new customers) ─────────────────
    const newCompaniesR = await query(
      `SELECT c.id, c.name, c.industry, c.status, c.created_at,
              u.name AS created_by_name
       FROM companies c
       LEFT JOIN users u ON u.id = c.created_by
       WHERE c.created_at >= $1
       ORDER BY c.created_at DESC`,
      [from]
    );
    const newCompanies = newCompaniesR.rows;

    // ── 3. New contacts in last 30 days ──────────────────────────────────────
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

    // ── 4. Activities in last 30 days ─────────────────────────────────────────
    const activitiesR = await query(
      `SELECT a.id, a.name, a.type, a.result, a.details, a.due_date, a.status_date,
              a.created_at,
              u.name AS owner_name,
              STRING_AGG(DISTINCT c.name, ', ') AS company_names
       FROM activities a
       LEFT JOIN users u ON u.id = a.owner_id
       LEFT JOIN companies c ON c.id = a.company_id
       WHERE a.created_at >= $1 OR a.status_date >= $1
       GROUP BY a.id, u.name, c.name
       ORDER BY COALESCE(a.status_date, a.created_at) DESC`,
      [from]
    );
    const activities = activitiesR.rows;

    const completedActivities = activities.filter(a =>
      (a.result || '').toLowerCase() === 'completed' ||
      (a.result || '').toLowerCase().includes('done') ||
      (a.result || '').toLowerCase().includes('success')
    );

    // ── 5. Deals / pipeline ───────────────────────────────────────────────────
    const dealsR = await query(
      `SELECT d.id, d.name, d.stage, d.amount,
              d.created_at, d.updated_at,
              c.name AS company_name,
              u.name AS owner_name
       FROM deals d
       LEFT JOIN companies c ON c.id = d.company_id
       LEFT JOIN users u ON u.id = d.owner_id
       ORDER BY d.amount DESC NULLS LAST`
    );
    const deals = dealsR.rows;

    const openDeals   = deals.filter(d => !d.stage.startsWith('Closed'));
    const wonDeals    = deals.filter(d => d.stage === 'Closed Won');
    const lostDeals   = deals.filter(d => d.stage === 'Closed Lost');
    const newDeals    = deals.filter(d => d.created_at >= from);

    const totalPipeline = openDeals.reduce((s, d) => s + (Number(d.amount) || 0), 0);
    const totalWon      = wonDeals.reduce((s, d) => s + (Number(d.amount) || 0), 0);

    // Deals by stage for pipeline summary
    const stageMap = {};
    openDeals.forEach(d => {
      if (!stageMap[d.stage]) stageMap[d.stage] = { count: 0, amount: 0 };
      stageMap[d.stage].count++;
      stageMap[d.stage].amount += Number(d.amount) || 0;
    });

    // ── 6. Tasks ──────────────────────────────────────────────────────────────
    const tasksR = await query(
      `SELECT t.id, t.name, t.status, t.priority, t.deadline, t.created_at,
              u.name AS owner_name,
              p.name AS project_name
       FROM tasks t
       LEFT JOIN users u ON u.id = t.owner_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.created_at >= $1 OR t.updated_at >= $1
       ORDER BY t.deadline ASC NULLS LAST`,
      [from]
    );
    const tasks = tasksR.rows;

    const completedTasks = tasks.filter(t => t.status === 'Completed');
    const openTasks      = tasks.filter(t => t.status !== 'Completed');
    const overdueTasks   = openTasks.filter(t =>
      t.deadline && new Date(t.deadline) < new Date()
    );

    // ── 7. Projects ───────────────────────────────────────────────────────────
    const projectsR = await query(
      `SELECT p.id, p.name, p.status, p.category, p.start_date, p.end_date,
              p.created_at, p.updated_at,
              c.name AS company_name,
              u.name AS owner_name
       FROM projects p
       LEFT JOIN companies c ON c.id = p.company_id
       LEFT JOIN users u ON u.id = p.owner_id
       WHERE p.updated_at >= $1 OR p.created_at >= $1
       ORDER BY p.updated_at DESC NULLS LAST`,
      [from]
    );
    const projects = projectsR.rows;

    // ── 8. Products ───────────────────────────────────────────────────────────
    const productsR = await query(
      `SELECT id, name, category, model, brand, created_at FROM products ORDER BY category, name`
    );
    const products = productsR.rows;

    // ── 9. Users / team ───────────────────────────────────────────────────────
    const usersR = await query(
      `SELECT id, name, title, role FROM users WHERE is_active = true ORDER BY name`
    );
    const users = usersR.rows;

    // ── 10. Activity type breakdown ────────────────────────────────────────────
    const actTypeMap = {};
    activities.forEach(a => {
      const t = a.type || 'Other';
      if (!actTypeMap[t]) actTypeMap[t] = 0;
      actTypeMap[t]++;
    });

    // ── Render ─────────────────────────────────────────────────────────────────
    res.render('report-monthly', {
      title: 'Monthly Business Report',
      layout: false,   // no nav layout — print-clean page
      reportPeriod: `${fromLabel} – ${toLabel}`,
      generatedAt: new Date().toLocaleString('en-GB'),

      // Section data
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

      // helpers passed to template
      fmtDate,
      fmtMoney
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
