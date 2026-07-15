'use strict';
const { query, transaction } = require('../config/db');

// ─── Access control helpers ──────────────────────────────────────────────────
// All list functions accept a `user` object { id, role, groupIds[] }.
// Admin sees everything. Others see records they own or whose group_id matches
// one of their groups.

function accessFilter(user, alias = '') {
  // If no user supplied (or admin), return unfiltered.
  if (!user || user.role === 'Admin') return { where: '1=1', params: [] };
  const p = alias ? alias + '.' : '';
  const ids = [user.id, ...(user.groupIds || [])];
  // owner OR group member
  return {
    where: `(${p}owner_id = $1 OR ${p}group_id = ANY($2::uuid[]))`,
    params: [user.id, ids]
  };
}

// ─── User & group helpers ────────────────────────────────────────────────────

async function getUserById(id) {
  const r = await query('SELECT id, email, name, role FROM users WHERE id=$1 AND is_active=true', [id]);
  return r.rows[0] || null;
}

async function getUserByEmail(email) {
  const r = await query('SELECT * FROM users WHERE email=$1 AND is_active=true', [email]);
  return r.rows[0] || null;
}

async function getUserGroupIds(userId) {
  const r = await query('SELECT group_id FROM group_members WHERE user_id=$1', [userId]);
  return r.rows.map(row => row.group_id);
}

async function listTeamUsers() {
  const r = await query('SELECT id, email, name, role, is_active, created_at FROM users ORDER BY name');
  return r.rows;
}

async function createUser({ email, name, role, passwordHash }) {
  const r = await query(
    'INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role',
    [email, name, role || 'Sales', passwordHash]
  );
  return r.rows[0];
}

async function updateUser(id, { name, role, isActive }) {
  const r = await query(
    'UPDATE users SET name=COALESCE($2,name), role=COALESCE($3,role), is_active=COALESCE($4,is_active) WHERE id=$1 RETURNING id, email, name, role, is_active',
    [id, name, role, isActive]
  );
  return r.rows[0];
}

async function listGroups() {
  const r = await query(`
    SELECT g.id, g.name, g.description, g.created_at,
           COUNT(gm.user_id)::int AS member_count
    FROM groups g
    LEFT JOIN group_members gm ON gm.group_id = g.id
    GROUP BY g.id ORDER BY g.name
  `);
  return r.rows;
}

async function createGroup({ name, description }) {
  const r = await query(
    'INSERT INTO groups (name, description) VALUES ($1,$2) RETURNING *',
    [name, description]
  );
  return r.rows[0];
}

async function listGroupMembers(groupId) {
  const r = await query(`
    SELECT u.id, u.email, u.name, u.role, gm.role AS group_role, gm.joined_at
    FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = $1 ORDER BY u.name
  `, [groupId]);
  return r.rows;
}

async function addGroupMember(groupId, userId, role = 'member') {
  await query(
    'INSERT INTO group_members (group_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [groupId, userId, role]
  );
}

async function removeGroupMember(groupId, userId) {
  await query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [groupId, userId]);
}

// ─── Companies ───────────────────────────────────────────────────────────────

async function listCompanies(user) {
  const { where, params } = accessFilter(user);
  const r = await query(
    `SELECT c.*, u.name AS owner_name, g.name AS group_name
     FROM companies c
     LEFT JOIN users u ON u.id = c.owner_id
     LEFT JOIN groups g ON g.id = c.group_id
     WHERE ${where}
     ORDER BY c.name`,
    params
  );
  return r.rows.map(mapCompany);
}

async function getCompany(id) {
  const r = await query(
    `SELECT c.*, u.name AS owner_name, g.name AS group_name
     FROM companies c
     LEFT JOIN users u ON u.id = c.owner_id
     LEFT JOIN groups g ON g.id = c.group_id
     WHERE c.id = $1`,
    [id]
  );
  return r.rows[0] ? mapCompany(r.rows[0]) : null;
}

async function createCompany({ name, industry, status, website, notes, billingAddress, ownerId, groupId }) {
  const r = await query(
    `INSERT INTO companies (name, industry, status, website, notes, billing_address, owner_id, group_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [name, industry, status, website, notes, billingAddress, ownerId, groupId]
  );
  return getCompany(r.rows[0].id);
}

async function updateCompany(id, fields) {
  const { name, industry, status, website, notes, billingAddress, groupId } = fields;
  await query(
    `UPDATE companies SET
       name=COALESCE($2,name), industry=$3, status=$4, website=$5,
       notes=$6, billing_address=$7, group_id=COALESCE($8,group_id),
       updated_at=NOW()
     WHERE id=$1`,
    [id, name, industry, status, website, notes, billingAddress, groupId]
  );
  return getCompany(id);
}

function mapCompany(row) {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry || null,
    status: row.status || null,
    web: row.website || null,
    billingAddress: row.billing_address || null,
    notes: row.notes || null,
    logo: row.logo_url || null,
    ownerId: row.owner_id || null,
    ownerName: row.owner_name || null,
    groupId: row.group_id || null,
    groupName: row.group_name || null,
    createdAt: row.created_at
  };
}

// ─── Contacts ────────────────────────────────────────────────────────────────

async function listContacts(user) {
  const { where, params } = accessFilter(user);
  const r = await query(
    `SELECT ct.*, c.name AS company_name
     FROM contacts ct
     LEFT JOIN companies c ON c.id = ct.company_id
     WHERE ${where.replace(/owner_id/g, 'ct.owner_id').replace(/group_id/g, 'ct.group_id')}
     ORDER BY ct.full_name`,
    params
  );
  return r.rows.map(mapContact);
}

async function getContact(id) {
  const r = await query(
    `SELECT ct.*, c.name AS company_name
     FROM contacts ct LEFT JOIN companies c ON c.id = ct.company_id
     WHERE ct.id=$1`,
    [id]
  );
  return r.rows[0] ? mapContact(r.rows[0]) : null;
}

async function createContact({ fullName, email, phone, title, companyId, ownerId, groupId }) {
  const r = await query(
    `INSERT INTO contacts (full_name, email, phone, title, company_id, owner_id, group_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [fullName, email, phone, title, companyId, ownerId, groupId]
  );
  return getContact(r.rows[0].id);
}

async function updateContact(id, { fullName, email, phone, title, companyId }) {
  await query(
    `UPDATE contacts SET full_name=COALESCE($2,full_name), email=$3, phone=$4, title=$5,
       company_id=$6, updated_at=NOW() WHERE id=$1`,
    [id, fullName, email, phone, title, companyId]
  );
  return getContact(id);
}

function mapContact(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email || null,
    phone: row.phone || null,
    title: row.title || null,
    companyId: row.company_id || null,
    companyIds: row.company_id ? [row.company_id] : [],
    companyName: row.company_name || null,
    ownerId: row.owner_id || null,
    groupId: row.group_id || null,
    createdAt: row.created_at
  };
}

// ─── Activities ──────────────────────────────────────────────────────────────

async function listActivities(user) {
  const { where, params } = accessFilter(user, 'a');
  const r = await query(
    `SELECT a.*,
            u.name AS owner_name,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', c.contact_id, 'name', co.full_name))
                FILTER (WHERE c.contact_id IS NOT NULL), '[]'
            ) AS attendees,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', ap.project_id, 'name', p.name))
                FILTER (WHERE ap.project_id IS NOT NULL), '[]'
            ) AS projects_linked
     FROM activities a
     LEFT JOIN users u ON u.id = a.owner_id
     LEFT JOIN activity_contacts c ON c.activity_id = a.id
     LEFT JOIN contacts co ON co.id = c.contact_id
     LEFT JOIN activity_projects ap ON ap.activity_id = a.id
     LEFT JOIN projects p ON p.id = ap.project_id
     WHERE ${where}
     GROUP BY a.id, u.name
     ORDER BY COALESCE(a.status_date, a.date) DESC NULLS LAST`,
    params
  );
  return r.rows.map(mapActivity);
}

async function getActivity(id) {
  const r = await query(
    `SELECT a.*, u.name AS owner_name,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', c.contact_id, 'name', co.full_name))
                FILTER (WHERE c.contact_id IS NOT NULL), '[]'
            ) AS attendees,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', ap.project_id, 'name', p.name))
                FILTER (WHERE ap.project_id IS NOT NULL), '[]'
            ) AS projects_linked,
            comp.id AS company_id_val, comp.name AS company_name_val
     FROM activities a
     LEFT JOIN users u ON u.id = a.owner_id
     LEFT JOIN activity_contacts c ON c.activity_id = a.id
     LEFT JOIN contacts co ON co.id = c.contact_id
     LEFT JOIN activity_projects ap ON ap.activity_id = a.id
     LEFT JOIN projects p ON p.id = ap.project_id
     LEFT JOIN companies comp ON comp.id = a.company_id
     WHERE a.id=$1
     GROUP BY a.id, u.name, comp.id, comp.name`,
    [id]
  );
  return r.rows[0] ? mapActivity(r.rows[0]) : null;
}

async function createActivity({ name, type, date, dueDate, details, companyId, ownerId, groupId }) {
  const r = await query(
    `INSERT INTO activities (name, type, date, due_date, details, company_id, owner_id, group_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [name, type, date, dueDate, details, companyId, ownerId, groupId]
  );
  return getActivity(r.rows[0].id);
}

async function updateActivity(id, { name, type, dueDate, details, regarding, result, attendeeIds, projectIds }) {
  await transaction(async (client) => {
    await client.query(
      `UPDATE activities SET name=COALESCE($2,name), type=$3, due_date=$4, details=$5,
         regarding=$6, result=$7, status_date=NOW(), updated_at=NOW() WHERE id=$1`,
      [id, name, type, dueDate, details, regarding, result]
    );
    await client.query('DELETE FROM activity_contacts WHERE activity_id=$1', [id]);
    if (attendeeIds && attendeeIds.length) {
      for (const cid of attendeeIds) {
        await client.query(
          'INSERT INTO activity_contacts (activity_id, contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, cid]
        );
      }
    }
    await client.query('DELETE FROM activity_projects WHERE activity_id=$1', [id]);
    if (projectIds && projectIds.length) {
      for (const pid of projectIds) {
        await client.query(
          'INSERT INTO activity_projects (activity_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, pid]
        );
      }
    }
  });
  return getActivity(id);
}

function mapActivity(row) {
  const attendees = Array.isArray(row.attendees) ? row.attendees : [];
  const projectsLinked = Array.isArray(row.projects_linked) ? row.projects_linked : [];
  return {
    id: row.id,
    name: row.name,
    type: row.type || null,
    date: row.date ? String(row.date).slice(0, 10) : null,
    dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
    statusDate: row.status_date ? String(row.status_date).slice(0, 10) : null,
    result: row.result || null,
    details: row.details || null,
    regarding: row.regarding || null,
    companyId: row.company_id || row.company_id_val || null,
    companyIds: row.company_id ? [row.company_id] : (row.company_id_val ? [row.company_id_val] : []),
    companyNames: row.company_name_val ? [row.company_name_val] : [],
    attendeeIds: attendees.filter(a => a.id).map(a => a.id),
    projectIds: projectsLinked.filter(p => p.id).map(p => p.id),
    projectNames: projectsLinked.filter(p => p.name).map(p => p.name),
    ownerId: row.owner_id || null,
    ownerName: row.owner_name || null,
    groupId: row.group_id || null,
    createdAt: row.created_at
  };
}

// Alias for detail page (same as getActivity but returns comments too)
async function getActivityDetail(id) {
  const [activity, comments] = await Promise.all([
    getActivity(id),
    listCommentsByEntity('activity', id)
  ]);
  if (!activity) return { name: null };
  return { ...activity, comments };
}

// ─── Deals ───────────────────────────────────────────────────────────────────

async function listDeals(user) {
  const { where, params } = accessFilter(user, 'd');
  const r = await query(
    `SELECT d.*, c.name AS company_name, u.name AS owner_name, g.name AS group_name
     FROM deals d
     LEFT JOIN companies c ON c.id = d.company_id
     LEFT JOIN users u ON u.id = d.owner_id
     LEFT JOIN groups g ON g.id = d.group_id
     WHERE ${where}
     ORDER BY d.updated_at DESC`,
    params
  );
  return r.rows.map(mapDeal);
}

async function getDeal(id) {
  const r = await query(
    `SELECT d.*, c.name AS company_name, u.name AS owner_name
     FROM deals d
     LEFT JOIN companies c ON c.id = d.company_id
     LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.id=$1`,
    [id]
  );
  return r.rows[0] ? mapDeal(r.rows[0]) : null;
}

async function getDealDetail(id) {
  const [deal, comments] = await Promise.all([
    getDeal(id),
    listCommentsByEntity('deal', id)
  ]);
  if (!deal) return { name: null };
  return { ...deal, comments };
}

async function createDeal({ name, stage, amount, companyId, contactId, ownerId, groupId }) {
  const r = await query(
    `INSERT INTO deals (name, stage, amount, company_id, contact_id, owner_id, group_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [name, stage, amount || 0, companyId, contactId, ownerId, groupId]
  );
  return getDeal(r.rows[0].id);
}

async function updateDeal(id, { name, stage, amount, companyId, contactId }) {
  await query(
    `UPDATE deals SET name=COALESCE($2,name), stage=$3, amount=$4,
       company_id=$5, contact_id=$6, updated_at=NOW() WHERE id=$1`,
    [id, name, stage, amount, companyId, contactId]
  );
  return getDeal(id);
}

async function updateDealStage(id, stage) {
  await query('UPDATE deals SET stage=$2, updated_at=NOW() WHERE id=$1', [id, stage]);
}

function mapDeal(row) {
  return {
    id: row.id,
    name: row.name,
    stage: row.stage || null,
    amount: parseFloat(row.amount) || 0,
    companyId: row.company_id || null,
    companyIds: row.company_id ? [row.company_id] : [],
    companyName: row.company_name || null,
    companyNames: row.company_name ? [row.company_name] : [],
    contactId: row.contact_id || null,
    ownerId: row.owner_id || null,
    ownerName: row.owner_name || null,
    groupId: row.group_id || null,
    groupName: row.group_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ─── Pipeline board ──────────────────────────────────────────────────────────

const PIPELINE_STAGES = [
  'Prospecting', 'Qualification', 'Needs Analysis',
  'Proposal / Price Quote', 'Negotiation',
  'Closed Won', 'Closed Lost'
];

async function getPipelineBoard(user) {
  const deals = await listDeals(user);
  const board = PIPELINE_STAGES.map(stage => ({
    stage,
    deals: deals.filter(d => d.stage === stage),
    total: deals.filter(d => d.stage === stage).reduce((s, d) => s + d.amount, 0)
  }));
  return { board };
}

// ─── Projects ────────────────────────────────────────────────────────────────

async function listProjects(user) {
  const { where, params } = accessFilter(user, 'p');
  const r = await query(
    `SELECT p.*, c.name AS company_name, u.name AS owner_name, g.name AS group_name
     FROM projects p
     LEFT JOIN companies c ON c.id = p.company_id
     LEFT JOIN users u ON u.id = p.owner_id
     LEFT JOIN groups g ON g.id = p.group_id
     WHERE ${where}
     ORDER BY p.updated_at DESC`,
    params
  );
  return r.rows.map(mapProject);
}

async function getProject(id) {
  const r = await query(
    `SELECT p.*, c.name AS company_name, u.name AS owner_name, g.name AS group_name
     FROM projects p
     LEFT JOIN companies c ON c.id = p.company_id
     LEFT JOIN users u ON u.id = p.owner_id
     LEFT JOIN groups g ON g.id = p.group_id
     WHERE p.id=$1`,
    [id]
  );
  return r.rows[0] ? mapProject(r.rows[0]) : null;
}

async function createProject({ name, status, details, companyId, dealId, ownerId, groupId }) {
  const r = await query(
    `INSERT INTO projects (name, status, details, company_id, deal_id, owner_id, group_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [name, status, details, companyId, dealId, ownerId, groupId]
  );
  return getProject(r.rows[0].id);
}

async function updateProject(id, { name, status, details, companyId }) {
  await query(
    `UPDATE projects SET name=COALESCE($2,name), status=$3, details=$4,
       company_id=COALESCE($5,company_id), updated_at=NOW() WHERE id=$1`,
    [id, name, status, details, companyId]
  );
  return getProject(id);
}

async function getProjectDetail(id) {
  const [project, tasks, comments] = await Promise.all([
    getProject(id),
    listTasks({ projectId: id }),
    listCommentsByEntity('project', id)
  ]);
  if (!project) return { name: null };
  return { ...project, tasks, comments };
}

function mapProject(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status || null,
    details: row.details || null,
    companyId: row.company_id || null,
    companyIds: row.company_id ? [row.company_id] : [],
    companyName: row.company_name || null,
    dealId: row.deal_id || null,
    ownerId: row.owner_id || null,
    ownerName: row.owner_name || null,
    groupId: row.group_id || null,
    groupName: row.group_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

async function listTasks({ projectId, user } = {}) {
  const conditions = [];
  const params = [];
  if (projectId) { conditions.push(`t.project_id=$${params.push(projectId)}`); }
  if (user && user.role !== 'Admin') {
    conditions.push(`(t.owner_id=$${params.push(user.id)} OR EXISTS (
      SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.user_id=$${params.push(user.id)}
    ) OR t.group_id=ANY($${params.push(user.groupIds || [])}::uuid[]))`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const r = await query(
    `SELECT t.*, p.name AS project_name, u.name AS owner_name,
            COALESCE(json_agg(DISTINCT jsonb_build_object('id', ta.user_id, 'name', au.name))
              FILTER (WHERE ta.user_id IS NOT NULL), '[]') AS assignees
     FROM tasks t
     LEFT JOIN projects p ON p.id = t.project_id
     LEFT JOIN users u ON u.id = t.owner_id
     LEFT JOIN task_assignees ta ON ta.task_id = t.id
     LEFT JOIN users au ON au.id = ta.user_id
     ${where}
     GROUP BY t.id, p.name, u.name
     ORDER BY t.created_at DESC`,
    params
  );
  return r.rows.map(mapTask);
}

async function getTask(id) {
  const r = await query(
    `SELECT t.*, p.name AS project_name, u.name AS owner_name,
            COALESCE(json_agg(DISTINCT jsonb_build_object('id', ta.user_id, 'name', au.name))
              FILTER (WHERE ta.user_id IS NOT NULL), '[]') AS assignees
     FROM tasks t
     LEFT JOIN projects p ON p.id = t.project_id
     LEFT JOIN users u ON u.id = t.owner_id
     LEFT JOIN task_assignees ta ON ta.task_id = t.id
     LEFT JOIN users au ON au.id = ta.user_id
     WHERE t.id=$1
     GROUP BY t.id, p.name, u.name`,
    [id]
  );
  return r.rows[0] ? mapTask(r.rows[0]) : null;
}

async function getTaskDetail(id) {
  const [task, comments, logs] = await Promise.all([
    getTask(id),
    listCommentsByEntity('task', id),
    listTaskLogs(id)
  ]);
  if (!task) return { name: null };
  return { ...task, comments, activityRecords: logs, records: logs };
}

async function createTask({ name, projectId, type, date, deadline, status, details, ownerId }) {
  const r = await query(
    `INSERT INTO tasks (name, project_id, type, date, deadline, status, details, owner_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [name, projectId, type, date, deadline, status || 'To Do', details, ownerId]
  );
  return getTask(r.rows[0].id);
}

async function updateTaskDetails(id, { name, type, date, deadline, status, details }) {
  await query(
    `UPDATE tasks SET name=COALESCE($2,name), type=$3, date=$4, deadline=$5,
       status=COALESCE($6,status), details=$7, updated_at=NOW() WHERE id=$1`,
    [id, name, type, date, deadline, status, details]
  );
  return getTask(id);
}

async function completeTask(id) {
  await query(
    `UPDATE tasks SET status='Completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [id]
  );
}

async function setTaskAssignees(taskId, userIds) {
  await transaction(async (client) => {
    await client.query('DELETE FROM task_assignees WHERE task_id=$1', [taskId]);
    for (const uid of (userIds || [])) {
      await client.query(
        'INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [taskId, uid]
      );
    }
  });
}

async function linkTaskToProject(taskId, projectId) {
  await query('UPDATE tasks SET project_id=$2 WHERE id=$1', [projectId, taskId]);
}

function mapTask(row) {
  const assignees = Array.isArray(row.assignees) ? row.assignees.filter(a => a.id) : [];
  return {
    id: row.id,
    name: row.name,
    type: row.type || null,
    date: row.date ? String(row.date).slice(0, 10) : null,
    deadline: row.deadline ? String(row.deadline).slice(0, 10) : null,
    status: row.status || 'To Do',
    details: row.details || null,
    projectId: row.project_id || null,
    projectIds: row.project_id ? [row.project_id] : [],
    projectName: row.project_name || null,
    ownerId: row.owner_id || null,
    ownerName: row.owner_name || null,
    assignees,
    assigneeIds: assignees.map(a => a.id),
    completedAt: row.completed_at || null,
    createdAt: row.created_at
  };
}

// ─── Task logs (activity records) ────────────────────────────────────────────

async function listTaskLogs(taskId) {
  const r = await query(
    `SELECT tl.*, u.name AS logged_by_name_resolved
     FROM task_logs tl
     LEFT JOIN users u ON u.id = tl.logged_by_id
     WHERE tl.task_id=$1 ORDER BY tl.created_at DESC`,
    [taskId]
  );
  return r.rows.map(row => ({
    id: row.id,
    taskId: row.task_id,
    name: row.name,
    details: row.details,
    category: row.category,
    loggedByName: row.logged_by_name_resolved || row.logged_by_name,
    createdAt: row.created_at
  }));
}

async function addTaskLog({ taskId, name, details, category, loggedById, loggedByName }) {
  const r = await query(
    `INSERT INTO task_logs (task_id, name, details, category, logged_by_id, logged_by_name)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [taskId, name || details?.slice(0, 60) || 'Update', details, category, loggedById, loggedByName]
  );
  return r.rows[0];
}

// ─── Products ────────────────────────────────────────────────────────────────

async function listProducts() {
  const r = await query('SELECT * FROM products ORDER BY name');
  return r.rows.map(mapProduct);
}

async function getProduct(id) {
  const r = await query(
    `SELECT pr.*, COALESCE(
       json_agg(DISTINCT jsonb_build_object('id', p.id, 'name', p.name))
       FILTER (WHERE p.id IS NOT NULL), '[]'
     ) AS projects_linked
     FROM products pr
     LEFT JOIN product_projects pp ON pp.product_id = pr.id
     LEFT JOIN projects p ON p.id = pp.project_id
     WHERE pr.id=$1
     GROUP BY pr.id`,
    [id]
  );
  return r.rows[0] ? mapProduct(r.rows[0]) : null;
}

async function createProduct({ name, notes, category, phase, inputVoltage, boardSize, horsePower, maxInputPower, maxInputCurrent, maxOutputCurrent }) {
  const r = await query(
    `INSERT INTO products (name, notes, category, phase, input_voltage, board_size, horse_power, max_input_power, max_input_current, max_output_current)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [name, notes, category, phase, inputVoltage, boardSize, horsePower, maxInputPower, maxInputCurrent, maxOutputCurrent]
  );
  return getProduct(r.rows[0].id);
}

async function getProductDetail(id) {
  const [product, comments] = await Promise.all([
    getProduct(id),
    listCommentsByEntity('product', id)
  ]);
  if (!product) return { name: null };
  return { ...product, comments };
}

async function updateProduct(id, fields) {
  const { name, notes, category, phase, inputVoltage, boardSize, horsePower, maxInputPower, maxInputCurrent, maxOutputCurrent } = fields;
  await query(
    `UPDATE products SET name=COALESCE($2,name), notes=$3, category=$4, phase=$5,
       input_voltage=$6, board_size=$7, horse_power=$8, max_input_power=$9,
       max_input_current=$10, max_output_current=$11, updated_at=NOW() WHERE id=$1`,
    [id, name, notes, category, phase, inputVoltage, boardSize, horsePower, maxInputPower, maxInputCurrent, maxOutputCurrent]
  );
  return getProduct(id);
}

function mapProduct(row) {
  const projects = Array.isArray(row.projects_linked) ? row.projects_linked.filter(p => p.id) : [];
  return {
    id: row.id,
    name: row.name,
    notes: row.notes || null,
    category: row.category || null,
    phase: row.phase || null,
    inputVoltage: row.input_voltage || null,
    boardSize: row.board_size || null,
    horsePower: row.horse_power || null,
    maxInputPower: row.max_input_power || null,
    maxInputCurrent: row.max_input_current || null,
    maxOutputCurrent: row.max_output_current || null,
    image: row.image_url ? [{ url: row.image_url }] : [],
    projectIds: projects.map(p => p.id),
    projectNames: projects.map(p => p.name),
    createdAt: row.created_at
  };
}

// ─── Comments (unified) ──────────────────────────────────────────────────────

async function listCommentsByEntity(entityType, entityId) {
  const r = await query(
    `SELECT cm.*, u.name AS user_name
     FROM comments cm
     LEFT JOIN users u ON u.id = cm.author_id
     WHERE cm.entity_type=$1 AND cm.entity_id=$2
     ORDER BY cm.created_at ASC`,
    [entityType, entityId]
  );
  return r.rows.map(mapComment);
}

async function addComment({ entityType, entityId, content, authorId, authorName, type, emailSubject, link }) {
  if (!content || !content.trim()) throw new Error('Comment text is required.');
  const r = await query(
    `INSERT INTO comments (entity_type, entity_id, content, author_id, author_name, type, email_subject, link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [entityType, entityId, content.trim(), authorId, authorName, type || 'comment', emailSubject, link]
  );
  return r.rows[0];
}

async function listAllComments(limit = 10) {
  const r = await query(
    `SELECT cm.*, u.name AS user_name FROM comments cm
     LEFT JOIN users u ON u.id = cm.author_id
     ORDER BY cm.created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows.map(mapComment);
}

function mapComment(row) {
  const isEmail = row.type === 'email';
  return {
    id: row.id,
    comment: row.content,
    author: row.user_name || row.author_name || 'Unknown',
    authorId: row.author_id,
    type: row.type || 'comment',
    emailSubject: row.email_subject || null,
    link: isEmail ? null : (row.link || null),
    entityType: row.entity_type,
    entityId: row.entity_id,
    // Map to old field names so routes work unchanged
    taskIds: row.entity_type === 'task' ? [row.entity_id] : [],
    activityIds: row.entity_type === 'activity' ? [row.entity_id] : [],
    projectIds: row.entity_type === 'project' ? [row.entity_id] : [],
    dealIds: row.entity_type === 'deal' ? [row.entity_id] : [],
    contactIds: row.entity_type === 'contact' ? [row.entity_id] : [],
    postedAt: row.created_at
  };
}

// Shim functions matching old Airtable crm.js signatures used by routes
async function addTaskComment({ taskId, author, comment, link, files }) {
  return addComment({ entityType: 'task', entityId: taskId, content: comment, authorName: author, link });
}
async function addActivityComment({ activityId, author, comment, link, files }) {
  return addComment({ entityType: 'activity', entityId: activityId, content: comment, authorName: author, link });
}
async function addProjectComment({ projectId, author, comment, link, files }) {
  return addComment({ entityType: 'project', entityId: projectId, content: comment, authorName: author, link });
}
async function addDealComment({ dealId, author, comment, link }) {
  return addComment({ entityType: 'deal', entityId: dealId, content: comment, authorName: author, link });
}
async function addContactComment({ contactId, author, comment, link }) {
  return addComment({ entityType: 'contact', entityId: contactId, content: comment, authorName: author, link });
}
async function listTaskComments(taskId) { return listCommentsByEntity('task', taskId); }
async function listActivityComments(activityId) { return listCommentsByEntity('activity', activityId); }
async function listProjectComments(projectId) { return listCommentsByEntity('project', projectId); }
async function listDealComments(dealId) { return listCommentsByEntity('deal', dealId); }
async function listContactComments(contactId) { return listCommentsByEntity('contact', contactId); }

// ─── Attachments ─────────────────────────────────────────────────────────────
// Supabase Storage: upload via Supabase JS client in a separate helper.
// These functions record the metadata after upload.

async function addAttachment({ entityType, entityId, filename, contentType, storageUrl, sizeBytes, uploadedById }) {
  await query(
    `INSERT INTO attachments (entity_type, entity_id, filename, content_type, storage_path, public_url, size_bytes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7)`,
    [entityType, entityId, filename, contentType, storageUrl, sizeBytes, uploadedById]
  );
}

async function listAttachments(entityType, entityId) {
  const r = await query(
    'SELECT * FROM attachments WHERE entity_type=$1 AND entity_id=$2 ORDER BY created_at DESC',
    [entityType, entityId]
  );
  return r.rows.map(row => ({
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    url: row.public_url,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at
  }));
}

// ─── Webhook / email inbound ─────────────────────────────────────────────────

async function handleInboundEmail({ recipient, sender, subject, bodyText }) {
  // recipient format: task-{id}@domain or activity-{id}@domain or project-{id}@domain
  const match = (recipient || '').match(/^(task|activity|project|deal)-([a-f0-9-]{36})/i);
  if (!match) return;
  const [, entityType, entityId] = match;
  await addComment({
    entityType,
    entityId,
    content: bodyText || subject,
    authorName: sender,
    type: 'email',
    emailSubject: subject,
    link: `EMAILSUBJ:${subject}`
  });
}

// ─── Company detail (used by company-detail route) ───────────────────────────

async function getCompanyDetail(id, user) {
  const company = await getCompany(id);
  if (!company) return null;
  const [contacts, activities, deals, projects] = await Promise.all([
    query('SELECT * FROM contacts WHERE company_id=$1 ORDER BY full_name', [id]).then(r => r.rows.map(mapContact)),
    query(`SELECT * FROM activities WHERE company_id=$1 ORDER BY COALESCE(status_date,date) DESC`, [id]).then(r => r.rows.map(mapActivity)),
    query('SELECT * FROM deals WHERE company_id=$1 ORDER BY updated_at DESC', [id]).then(r => r.rows.map(mapDeal)),
    query('SELECT * FROM projects WHERE company_id=$1 ORDER BY updated_at DESC', [id]).then(r => r.rows.map(mapProject))
  ]);
  return { ...company, contacts, activities, deals, projects };
}

// ─── Contact detail ──────────────────────────────────────────────────────────

async function getContactDetail(id) {
  const contact = await getContact(id);
  if (!contact) return null;
  const comments = await listCommentsByEntity('contact', id);
  return { ...contact, comments };
}

// ─── Schema stub (for views that reference crm.schema) ───────────────────────

const schema = {
  tables: {
    company: {
      statusChoices: ['Active', 'Inactive', 'Prospect', 'Partner'],
      industryChoices: ['Technology', 'Manufacturing', 'Healthcare', 'Finance', 'Retail', 'Education', 'Other']
    },
    contacts: {
      statusChoices: ['Active', 'Inactive']
    },
    activities: {
      typeChoices: ['Call', 'Email', 'LinkedIn', 'Meeting', 'Demo', 'Other'],
      resultChoices: ['No answer', 'Left voicemail', 'Replied', 'Meeting booked', 'Not interested', 'Completed']
    },
    deals: {
      stageChoices: ['Prospecting', 'Qualification', 'Needs Analysis', 'Proposal / Price Quote', 'Negotiation', 'Closed Won', 'Closed Lost']
    },
    projects: {
      statusChoices: ['Active', 'On Hold', 'Completed', 'Cancelled'],
      categoryChoices: ['Implementation', 'Support', 'Consulting', 'Development', 'Other']
    },
    tasks: {
      statusChoices: ['To Do', 'In Progress', 'Blocked', 'Completed'],
      typeChoices: ['Design', 'Development', 'Testing', 'Meeting', 'Review', 'Other']
    },
    products: {
      categoryChoices: ['Hardware', 'Software', 'Service', 'Subscription', 'Other'],
      phaseChoices: ['Concept', 'Development', 'Testing', 'Released', 'Discontinued']
    }
  }
};

// ─── Scoping helper (used by routes that check role) ─────────────────────────

function scopeToOwner(records, email) {
  // Legacy shim — routes pass email; filter by ownerEmail if present
  return records.filter(r => !r.ownerEmail || r.ownerEmail === email || !r.ownerId);
}

// ─── listProjectActivities alias (tasks route uses this name) ────────────────
async function listProjectActivities(user) { return listTasks({ user }); }
async function getProjectActivity(id) { return getTask(id); }
async function createProjectActivity(args) { return createTask(args); }
async function addProjectActivityRecord(args) { return addTaskLog(args); }
async function listProjectActivityRecords(taskId) { return listTaskLogs(taskId); }
async function listProjectsWithSubtasks(user) {
  const projects = await listProjects(user);
  return Promise.all(projects.map(async p => ({
    ...p,
    tasks: await listTasks({ projectId: p.id })
  })));
}
async function listProductsWithProjects() {
  const products = await listProducts();
  return products;
}

// Stubs for attachment upload — will integrate Supabase Storage in next session
async function addActivityAttachments() {}
async function addProjectAttachments() {}
async function addTaskAttachments() {}
async function replaceProductImage() {}
async function assignTask(taskId, userId) { return setTaskAssignees(taskId, [userId]); }
async function createProjectFromDeal(dealId, user) {
  const deal = await getDeal(dealId);
  if (!deal) throw new Error('Deal not found');
  return createProject({ name: deal.name, companyId: deal.companyId, dealId, ownerId: user.id, groupId: user.groupIds?.[0] });
}
async function updateDealLinks() {}

module.exports = {
  schema,
  scopeToOwner,
  // Users & groups
  getUserById,
  getUserByEmail,
  getUserGroupIds,
  listTeamUsers,
  createUser,
  updateUser,
  listGroups,
  createGroup,
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
  // Companies
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  getCompanyDetail,
  // Contacts
  listContacts,
  getContact,
  createContact,
  updateContact,
  getContactDetail,
  listContactComments,
  addContactComment,
  // Activities
  listActivities,
  getActivity,
  createActivity,
  updateActivity,
  getActivityDetail,
  listActivityComments,
  addActivityComment,
  addActivityAttachments,
  // Deals
  listDeals,
  getDeal,
  createDeal,
  updateDeal,
  updateDealStage,
  updateDealLinks,
  createProjectFromDeal,
  getDealDetail,
  listDealComments,
  addDealComment,
  getPipelineBoard,
  // Projects
  listProjects,
  getProject,
  createProject,
  updateProject,
  getProjectDetail,
  addProjectAttachments,
  listProjectComments,
  addProjectComment,
  listProjectsWithSubtasks,
  // Tasks (project activities)
  listProjectActivities,
  getProjectActivity,
  createProjectActivity,
  getTaskDetail,
  updateTaskDetails,
  completeTask,
  assignTask,
  setTaskAssignees,
  linkTaskToProject,
  addTaskAttachments,
  listTaskComments,
  addTaskComment,
  listProjectActivityRecords,
  addProjectActivityRecord,
  // Products
  listProducts,
  listProductsWithProjects,
  getProduct: async (id) => getProduct(id),
  getProductDetail,
  createProduct,
  updateProduct,
  replaceProductImage,
  // Comments
  listAllComments,
  addComment,
  listAttachments,
  addAttachment,
  // Webhook
  handleInboundEmail
};
