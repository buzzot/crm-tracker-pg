'use strict';
const { query, transaction } = require('../config/db');
const storage = require('./storage');

// Convert a storage path or old URL to a direct Supabase public URL.
// The crm-files bucket is public — no proxy or signing needed.
function toMediaUrl(urlOrPath) {
  if (!urlOrPath) return null;
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const BUCKET = process.env.SUPABASE_BUCKET || 'crm-files';
  if (!SUPABASE_URL) return urlOrPath;
  // Already a full URL for this Supabase project — return as-is
  if (urlOrPath.startsWith(SUPABASE_URL)) return urlOrPath;
  // Bare storage path (e.g. "companies/uuid/file.png") → direct public URL
  if (!urlOrPath.startsWith('http')) {
    const path = urlOrPath.replace(/^\/+/, '');
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  }
  // External or unknown URL — return as-is (likely expired Airtable CDN)
  return urlOrPath;
}

// Convert a pg DATE/TIMESTAMP value (JS Date object) or string to "YYYY-MM-DD"
function toDateStr(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

// ─── Access control helpers ──────────────────────────────────────────────────
// Role hierarchy (3 tiers):
//   Admin   — sees everything
//   Manager — sees all records in their groups
//   Staff   — per-entity rules:
//     companies / projects / deals : created (owner_id OR created_by) OR assigned via user_assignments
//     activities                   : only their own (owner_id)
//     tasks                        : owner OR assignee OR auditor (handled in listTasks directly)
//     products                     : everyone sees all (no filter)

function accessFilter(user, alias = '', entityType = null) {
  if (!user || user.role === 'Admin') return { where: '1=1', params: [] };

  const p = alias ? alias + '.' : '';

  // R&D Heads behave like Managers for general data access
  if (user.role === 'Manager' || isRdHead(user.role)) {
    const groupIds = user.groupIds || [];
    const participantSubq = entityType === 'activity'
      ? ` OR EXISTS (SELECT 1 FROM activity_participants ap2 WHERE ap2.activity_id = ${p}id AND ap2.user_id = $1)`
      : '';
    // R&D Heads also see R&D projects explicitly
    const rdProjectSubq = (entityType === 'project' && isRdHead(user.role))
      ? ` OR ${p}is_rd_issue = TRUE`
      : '';
    // All users see Client companies
    const clientSubq = entityType === 'company' ? ` OR ${p}status = 'Client'` : '';
    return {
      where: `(${p}owner_id = $1 OR ${p}group_id = ANY($2::uuid[])${participantSubq}${rdProjectSubq}${clientSubq})`,
      params: [user.id, groupIds]
    };
  }

  // Engineering (R&D Staff) — same as Staff
  const effectiveRole = user.role === 'Engineering' ? 'Staff' : user.role;

  // Staff / Engineering — entity-specific rules
  if (entityType === 'activity') {
    return {
      where: `(${p}owner_id = $1 OR EXISTS (
        SELECT 1 FROM activity_participants ap2
        WHERE ap2.activity_id = ${p}id AND ap2.user_id = $1
      ))`,
      params: [user.id]
    };
  }

  if (entityType === 'company' || entityType === 'project' || entityType === 'deal') {
    // All users see Client companies regardless of ownership/assignment
    const clientSubq = entityType === 'company' ? ` OR ${p}status = 'Client'` : '';
    // Project assignees get access
    const projAssigneeSubq = entityType === 'project'
      ? ` OR EXISTS (SELECT 1 FROM project_assignees pa WHERE pa.project_id = ${p}id AND pa.user_id = $1)`
      : '';
    // Engineering role can also see R&D projects they have an assigned task in
    const rdEngSubq = (entityType === 'project' && user.role === 'Engineering')
      ? ` OR (${p}is_rd_issue = TRUE AND EXISTS (
          SELECT 1 FROM tasks t
          JOIN task_assignees ta ON ta.task_id = t.id
          WHERE t.project_id = ${p}id AND ta.user_id = $1
        ))`
      : '';
    return {
      where: `(${p}owner_id = $1 OR ${p}created_by = $1 OR EXISTS (
        SELECT 1 FROM user_assignments ua
        WHERE ua.entity_id = ${p}id
          AND ua.entity_type = $2
          AND ua.user_id = $1
      )${projAssigneeSubq}${clientSubq}${rdEngSubq})`,
      params: [user.id, entityType]
    };
  }

  // Fallback: owner only
  return {
    where: `${p}owner_id = $1`,
    params: [user.id]
  };
}

// ─── User & group helpers ────────────────────────────────────────────────────

// Role → allowed titles mapping (for UI dropdowns)
const ROLE_TITLES = {
  Admin:                  ['CEO', 'President', 'VP Sales', 'VP Operations', 'Director of Sales', 'Director'],
  Manager:                ['Sales Manager', 'Account Manager', 'Project Manager', 'Regional Manager', 'Team Lead'],
  Staff:                  ['Sales Rep', 'Account Executive', 'Business Development Rep', 'Sales Associate', 'Coordinator'],
  'Head R&D Controllers': ['Head of R&D (Controllers)', 'R&D Manager'],
  'Head R&D VFD':         ['Head of R&D (VFD)', 'R&D Manager'],
  Engineering:            ['Engineer', 'R&D Engineer', 'Test Engineer', 'Field Engineer'],
};
const ALL_ROLES   = Object.keys(ROLE_TITLES);
const ALL_TITLES  = Object.values(ROLE_TITLES).flat();

// R&D role helpers
const RD_ROLES      = new Set(['Head R&D Controllers', 'Head R&D VFD', 'Engineering']);
const RD_HEAD_ROLES = new Set(['Head R&D Controllers', 'Head R&D VFD']);
function isRdRole(role) { return RD_ROLES.has(role); }
function isRdHead(role) { return RD_HEAD_ROLES.has(role); }

function mapUser(row) {
  return {
    id:                 row.id,
    email:              row.email,
    name:               row.name,
    role:               row.role,
    title:              row.title  || null,
    phone:              row.phone  || null,
    avatarUrl:          row.avatar_url  || null,
    avatarColor:        row.avatar_color || null,
    isActive:           row.is_active,
    mustChangePassword: row.must_change_password || false,
    createdAt:          row.created_at,
  };
}

async function getUserById(id) {
  const r = await query(
    'SELECT id, email, name, role, title, phone, avatar_url, avatar_color, is_active, must_change_password, created_at FROM users WHERE id=$1',
    [id]
  );
  return r.rows[0] ? mapUser(r.rows[0]) : null;
}

async function getUserByEmail(email) {
  // Return raw row so auth middleware can access password_hash
  const r = await query('SELECT * FROM users WHERE email=$1 AND is_active=true', [email]);
  return r.rows[0] || null;
}

async function getUserGroupIds(userId) {
  const r = await query('SELECT group_id FROM group_members WHERE user_id=$1', [userId]);
  return r.rows.map(row => row.group_id);
}

async function listTeamUsers() {
  const r = await query(
    'SELECT id, email, name, role, title, phone, avatar_color, is_active, must_change_password, created_at FROM users ORDER BY name'
  );
  return r.rows.map(mapUser);
}

async function createUser({ email, name, role, title, phone, passwordHash }) {
  const r = await query(
    `INSERT INTO users (email, name, role, title, phone, password_hash, must_change_password)
     VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id, email, name, role, title, phone, avatar_color, is_active, must_change_password, created_at`,
    [email, name, role || 'Staff', title || null, phone || null, passwordHash]
  );
  return mapUser(r.rows[0]);
}

async function updateUserProfile(id, { name, title, phone, avatarColor, avatarUrl }) {
  if (avatarUrl !== undefined) {
    await query(
      `UPDATE users SET avatar_url=$2, updated_at=NOW() WHERE id=$1`,
      [id, avatarUrl]
    );
  } else {
    await query(
      `UPDATE users SET name=COALESCE($2,name), title=$3, phone=$4, avatar_color=$5, updated_at=NOW() WHERE id=$1`,
      [id, name || null, title || null, phone || null, avatarColor || null]
    );
  }
  return getUserById(id);
}

async function updateUserPassword(id, passwordHash) {
  await query(
    `UPDATE users SET password_hash=$2, must_change_password=false, updated_at=NOW() WHERE id=$1`,
    [id, passwordHash]
  );
}

async function updateUser(id, { name, email, role, title, phone, isActive }) {
  const r = await query(
    `UPDATE users
     SET name=COALESCE($2,name), email=COALESCE($3,email),
         role=COALESCE($4,role), title=COALESCE($5,title),
         phone=COALESCE($6,phone),
         is_active=COALESCE($7,is_active)
     WHERE id=$1
     RETURNING id, email, name, role, title, phone, is_active, created_at`,
    [id, name, email, role, title, phone, isActive]
  );
  return r.rows[0] ? mapUser(r.rows[0]) : null;
}

// ─── Assignment helpers ───────────────────────────────────────────────────────

async function assignUser({ entityType, entityId, userId, assignedBy }) {
  await query(
    `INSERT INTO user_assignments (user_id, entity_type, entity_id, assigned_by)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [userId, entityType, entityId, assignedBy]
  );
}

async function unassignUser({ entityType, entityId, userId }) {
  await query(
    `DELETE FROM user_assignments WHERE user_id=$1 AND entity_type=$2 AND entity_id=$3`,
    [userId, entityType, entityId]
  );
}

async function listAssignments(entityType, entityId) {
  const r = await query(
    `SELECT ua.user_id, ua.assigned_at, u.name, u.email, u.title, u.role
     FROM user_assignments ua
     JOIN users u ON u.id = ua.user_id
     WHERE ua.entity_type=$1 AND ua.entity_id=$2
     ORDER BY u.name`,
    [entityType, entityId]
  );
  return r.rows.map(row => ({
    userId: row.user_id, name: row.name, email: row.email,
    title: row.title, role: row.role, assignedAt: row.assigned_at
  }));
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
  const { where, params } = accessFilter(user, 'c', 'company');
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
    `SELECT c.*, u.name AS owner_name, g.name AS group_name,
            uc.name AS created_by_name, uu.name AS updated_by_name
     FROM companies c
     LEFT JOIN users u  ON u.id  = c.owner_id
     LEFT JOIN groups g ON g.id  = c.group_id
     LEFT JOIN users uc ON uc.id = c.created_by
     LEFT JOIN users uu ON uu.id = c.updated_by
     WHERE c.id = $1`,
    [id]
  );
  return r.rows[0] ? mapCompany(r.rows[0]) : null;
}

async function createCompany({ name, industry, status, website, notes, billingAddress, ownerId, groupId, createdById }) {
  const r = await query(
    `INSERT INTO companies (name, industry, status, website, notes, billing_address, owner_id, group_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [name, industry, status, website, notes, billingAddress, ownerId, groupId, createdById || null]
  );
  return getCompany(r.rows[0].id);
}

async function updateCompany(id, fields, updatedById) {
  const { name, industry, status, website, web, notes, billingAddress, groupId } = fields;
  await query(
    `UPDATE companies SET
       name=COALESCE($2,name), industry=$3, status=$4, website=$5,
       notes=$6, billing_address=$7, group_id=COALESCE($8,group_id),
       updated_by=$9, updated_at=NOW()
     WHERE id=$1`,
    [id, name, industry, status, website || web || null, notes, billingAddress, groupId, updatedById || null]
  );
  return getCompany(id);
}

async function updateCompanyLogo(companyId, file) {
  const { path: storagePath } = await storage.uploadMulterFile({
    entityType: 'company',
    entityId: companyId,
    file
  });
  await query('UPDATE companies SET logo_url=$1, updated_at=NOW() WHERE id=$2', [storagePath, companyId]);
  return toMediaUrl(storagePath);
}

function mapCompany(row) {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry || null,
    status: row.status || null,
    web: row.website || null,
    website: row.website || null,
    billingAddress: row.billing_address || null,
    notes: row.notes || null,
    logo: toMediaUrl(row.logo_url),
    logoUrl: toMediaUrl(row.logo_url),
    ownerId: row.owner_id || null,
    ownerName: row.owner_name || null,
    ownerEmails: [],   // PG uses id-based ownership, not email arrays
    groupId: row.group_id || null,
    groupName: row.group_name || null,
    personIds: [],
    activityIds: [],
    dealIds: [],
    projectIds: [],
    createdAt: row.created_at,
    createdByName: row.created_by_name || null,
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name || null,
  };
}

// ─── Contacts ────────────────────────────────────────────────────────────────

async function listContacts(user) {
  const { where, params } = accessFilter(user, 'ct', 'contact');
  const r = await query(
    `SELECT ct.*, c.name AS company_name
     FROM contacts ct
     LEFT JOIN companies c ON c.id = ct.company_id
     WHERE ${where}
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

async function createContact({ fullName, email, phone, title, status, companyId, ownerId, groupId }) {
  const r = await query(
    `INSERT INTO contacts (full_name, email, phone, title, status, company_id, owner_id, group_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [fullName, email, phone, title, status || 'Active', companyId, ownerId, groupId]
  );
  return getContact(r.rows[0].id);
}

async function updateContact(id, { fullName, email, phone, title, notes, status, companyId }) {
  await query(
    `UPDATE contacts SET full_name=COALESCE($2,full_name), email=$3, phone=$4, title=$5,
       notes=$6, status=$7, company_id=COALESCE($8,company_id), updated_at=NOW() WHERE id=$1`,
    [id, fullName, email, phone, title, notes ?? null, status || null, companyId]
  );
  return getContact(id);
}

function mapContact(row) {
  const nameParts = (row.full_name || '').split(' ');
  return {
    id: row.id,
    fullName: row.full_name,
    firstName: nameParts[0] || null,
    lastName: nameParts.slice(1).join(' ') || null,
    email: row.email || null,
    phone: row.phone || null,
    title: row.title || null,
    notes: row.notes || null,
    status: row.status || 'Active',
    companyId: row.company_id || null,
    companyIds: row.company_id ? [row.company_id] : [],
    companyName: row.company_name || null,
    company: row.company_id ? { id: row.company_id, name: row.company_name } : null,
    ownerId: row.owner_id || null,
    groupId: row.group_id || null,
    createdAt: row.created_at
  };
}

// ─── Activities ──────────────────────────────────────────────────────────────

async function listActivities(user) {
  const { where, params } = accessFilter(user, 'a', 'activity');
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
    [name, type || null, date || null, dueDate || null, details || null, companyId, ownerId, groupId]
  );
  return getActivity(r.rows[0].id);
}

async function updateActivity(id, { name, type, dueDate, details, regarding, result, attendeeIds, projectIds, participantIds }) {
  await transaction(async (client) => {
    await client.query(
      `UPDATE activities SET name=COALESCE($2,name), type=$3, due_date=$4, details=$5,
         regarding=$6, result=$7, status_date=NOW(), updated_at=NOW() WHERE id=$1`,
      [id, name, type || null, dueDate || null, details || null, regarding || null, result || null]
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
    await setActivityParticipants(id, participantIds || [], client);
  });
  return getActivity(id);
}

async function deleteActivity(id) {
  await query('DELETE FROM activities WHERE id=$1', [id]);
}

function mapActivity(row) {
  const attendees = Array.isArray(row.attendees) ? row.attendees : [];
  const projectsLinked = Array.isArray(row.projects_linked) ? row.projects_linked : [];
  return {
    id: row.id,
    name: row.name,
    type: row.type || null,
    date: toDateStr(row.date),
    dueDate: toDateStr(row.due_date),
    statusDate: toDateStr(row.status_date),
    result: row.result || null,
    details: row.details || null,
    regarding: row.regarding || null,
    companyId: row.company_id || row.company_id_val || null,
    companyIds: row.company_id ? [row.company_id] : (row.company_id_val ? [row.company_id_val] : []),
    companyNames: row.company_name_val ? [row.company_name_val] : [],
    attendeeIds: attendees.filter(a => a.id).map(a => a.id),
    attendees: attendees.filter(a => a.id).map(a => ({ id: a.id, name: a.name || null })),
    projectIds: projectsLinked.filter(p => p.id).map(p => p.id),
    projectNames: projectsLinked.filter(p => p.name).map(p => p.name),
    ownerId: row.owner_id || null,
    ownerName: row.owner_name || null,
    groupId: row.group_id || null,
    createdAt: row.created_at
  };
}

async function listActivityParticipants(activityId) {
  const r = await query(
    `SELECT u.id, u.name, u.email, u.title
     FROM activity_participants ap
     JOIN users u ON u.id = ap.user_id
     WHERE ap.activity_id = $1
     ORDER BY u.name`,
    [activityId]
  );
  return r.rows.map(u => ({ id: u.id, name: u.name, email: u.email, title: u.title }));
}

async function setActivityParticipants(activityId, userIds, client) {
  const exec = client ? (q, p) => client.query(q, p) : query;
  await exec('DELETE FROM activity_participants WHERE activity_id=$1', [activityId]);
  for (const uid of (userIds || [])) {
    await exec(
      'INSERT INTO activity_participants (activity_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [activityId, uid]
    );
  }
}

// Link a project to an activity (idempotent)
async function addActivityProject(activityId, projectId) {
  await query(
    'INSERT INTO activity_projects (activity_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [activityId, projectId]
  );
}

// List activities linked to a project (for "created from" display on project detail)
async function listProjectLinkedActivities(projectId) {
  const r = await query(
    `SELECT a.id, a.name, a.type, a.result, a.date
     FROM activity_projects ap
     JOIN activities a ON a.id = ap.activity_id
     WHERE ap.project_id = $1
     ORDER BY a.date DESC NULLS LAST`,
    [projectId]
  );
  return r.rows.map(row => ({
    id: row.id,
    name: row.name,
    type: row.type || null,
    result: row.result || null,
    date: toDateStr(row.date),
  }));
}

// Alias for detail page (same as getActivity but returns comments, files, and participants)
async function getActivityDetail(id) {
  const [activity, comments, files, participants] = await Promise.all([
    getActivity(id),
    listCommentsByEntity('activity', id),
    listAttachments('activity', id),
    listActivityParticipants(id),
  ]);
  if (!activity) return { name: null };
  return { ...activity, comments, files, participants };
}

// ─── Deals ───────────────────────────────────────────────────────────────────

async function listDeals(user) {
  const { where, params } = accessFilter(user, 'd', 'deal');
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
    `SELECT d.*, c.name AS company_name, u.name AS owner_name,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', p.id, 'name', p.name))
              FILTER (WHERE p.id IS NOT NULL), '[]'
            ) AS projects_linked,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', pr.id, 'name', pr.name))
              FILTER (WHERE pr.id IS NOT NULL), '[]'
            ) AS products_linked
     FROM deals d
     LEFT JOIN companies c ON c.id = d.company_id
     LEFT JOIN users u ON u.id = d.owner_id
     LEFT JOIN projects p ON p.company_id = d.company_id
     LEFT JOIN product_projects pp ON pp.project_id = p.id
     LEFT JOIN products pr ON pr.id = pp.product_id
     WHERE d.id=$1
     GROUP BY d.id, c.name, u.name`,
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
  return { ...deal, comments, activities: deal.activities || [] };
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
    projects: Array.isArray(row.projects_linked) ? row.projects_linked.filter(p => p.id) : [],
    products: Array.isArray(row.products_linked) ? row.products_linked.filter(p => p.id) : [],
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
  const { where, params } = accessFilter(user, 'p', 'project');
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
    `SELECT p.*, c.name AS company_name, u.name AS owner_name, g.name AS group_name,
            uc.name AS created_by_name, uu.name AS updated_by_name,
            ua.name AS auditor_name,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', pr.id, 'name', pr.name))
              FILTER (WHERE pr.id IS NOT NULL), '[]'
            ) AS products_linked
     FROM projects p
     LEFT JOIN companies c  ON c.id  = p.company_id
     LEFT JOIN users u      ON u.id  = p.owner_id
     LEFT JOIN groups g     ON g.id  = p.group_id
     LEFT JOIN users uc     ON uc.id = p.created_by
     LEFT JOIN users uu     ON uu.id = p.updated_by
     LEFT JOIN users ua     ON ua.id = p.auditor_id
     LEFT JOIN product_projects pp ON pp.project_id = p.id
     LEFT JOIN products pr  ON pr.id = pp.product_id
     WHERE p.id=$1
     GROUP BY p.id, c.name, u.name, g.name, uc.name, uu.name, ua.name`,
    [id]
  );
  return r.rows[0] ? mapProject(r.rows[0]) : null;
}

async function listProjectAssignees(projectId) {
  const r = await query(
    `SELECT u.id, u.name, u.title, u.role
     FROM project_assignees pa
     JOIN users u ON u.id = pa.user_id
     WHERE pa.project_id = $1
     ORDER BY u.name`,
    [projectId]
  );
  return r.rows.map(row => ({ id: row.id, name: row.name, title: row.title, role: row.role }));
}

async function setProjectOwner(id, ownerId, updatedById) {
  await query(
    'UPDATE projects SET owner_id=$2, updated_by=$3, updated_at=NOW() WHERE id=$1',
    [id, ownerId || null, updatedById || null]
  );
}

async function setProjectAuditor(id, auditorId, updatedById) {
  await query(
    'UPDATE projects SET auditor_id=$2, updated_by=$3, updated_at=NOW() WHERE id=$1',
    [id, auditorId || null, updatedById || null]
  );
}

async function setProjectAssignees(projectId, userIds) {
  await transaction(async (client) => {
    await client.query('DELETE FROM project_assignees WHERE project_id=$1', [projectId]);
    for (const uid of (userIds || [])) {
      await client.query(
        'INSERT INTO project_assignees (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [projectId, uid]
      );
    }
  });
}

async function createProject({ name, status, details, companyId, dealId, ownerId, groupId, createdById }) {
  // Default owner to the creator if not explicitly set
  const effectiveOwner = ownerId || createdById || null;
  const r = await query(
    `INSERT INTO projects (name, status, details, company_id, deal_id, owner_id, group_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [name, status, details, companyId, dealId, effectiveOwner, groupId, createdById || null]
  );
  return getProject(r.rows[0].id);
}

async function updateProject(id, { name, status, category, description, companyId, startDate, endDate, productIds, isRdIssue }, updatedById) {
  await transaction(async (client) => {
    await client.query(
      `UPDATE projects SET
         name=COALESCE($2,name), status=$3, category=$4, details=$5,
         company_id=COALESCE($6,company_id),
         start_date=$7, end_date=$8,
         is_rd_issue=COALESCE($9,is_rd_issue),
         updated_by=$10, updated_at=NOW()
       WHERE id=$1`,
      [id, name, status, category || null, description || null, companyId,
       startDate || null, endDate || null,
       isRdIssue !== undefined ? isRdIssue : null,
       updatedById || null]
    );
    if (Array.isArray(productIds)) {
      await client.query('DELETE FROM product_projects WHERE project_id=$1', [id]);
      for (const pid of productIds) {
        await client.query(
          'INSERT INTO product_projects (product_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [pid, id]
        );
      }
    }
  });
  return getProject(id);
}

async function setProjectRdIssue(id, value, updatedById) {
  await query(
    'UPDATE projects SET is_rd_issue=$2, updated_by=$3, updated_at=NOW() WHERE id=$1',
    [id, !!value, updatedById || null]
  );
}

async function getProjectDetail(id) {
  const [project, tasks, comments, attachments, assignees, teamUsers, linkedActivities] = await Promise.all([
    getProject(id),
    listTasks({ projectId: id }),
    listCommentsByEntity('project', id),
    listAttachments('project', id),
    listProjectAssignees(id),
    listTeamUsers(),
    listProjectLinkedActivities(id),
  ]);
  if (!project) return { name: null };
  return {
    ...project,
    tasks,
    subtasks: tasks,
    comments,
    attachments,
    assignees,
    assigneeIds: assignees.map(a => a.id),
    teamUsers,
    linkedActivities,
  };
}

function mapProject(row) {
  const products = Array.isArray(row.products_linked) ? row.products_linked.filter(p => p.id) : [];
  return {
    id: row.id,
    name: row.name,
    status: row.status || null,
    details: row.details || null,
    description: row.details || null,
    category: row.category || null,
    startDate: toDateStr(row.start_date),
    endDate: toDateStr(row.end_date),
    companyId: row.company_id || null,
    companyIds: row.company_id ? [row.company_id] : [],
    companyName: row.company_name || null,
    companies: row.company_id ? [{ id: row.company_id, name: row.company_name }] : [],
    dealId: row.deal_id || null,
    deals: [],
    ownerId: row.owner_id || null,
    ownerName: row.owner_name || null,
    auditorId: row.auditor_id || null,
    auditorName: row.auditor_name || null,
    groupId: row.group_id || null,
    groupName: row.group_name || null,
    products,
    isRdIssue: row.is_rd_issue || false,
    attachments: [],
    assignees: [],
    assigneeIds: [],
    createdAt: row.created_at,
    createdByName: row.created_by_name || null,
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name || null,
  };
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

// ─── Task query builder (shared by listTasks + getTask) ──────────────────────

const TASK_SELECT = `
  SELECT t.*,
    p.name  AS project_name, p.id AS project_id_val,
    u.name  AS owner_name,
    au2.name AS auditor_name,
    ab.name  AS archived_by_name,
    COALESCE(json_agg(DISTINCT jsonb_build_object('id', ta.user_id, 'name', asgn.name))
      FILTER (WHERE ta.user_id IS NOT NULL), '[]') AS assignees
  FROM tasks t
  LEFT JOIN projects p  ON p.id  = t.project_id
  LEFT JOIN users u     ON u.id  = t.owner_id
  LEFT JOIN users au2   ON au2.id = t.auditor_id
  LEFT JOIN users ab    ON ab.id  = t.archived_by
  LEFT JOIN task_assignees ta ON ta.task_id = t.id
  LEFT JOIN users asgn ON asgn.id = ta.user_id`;

function mapTask(row) {
  const assignees = Array.isArray(row.assignees) ? row.assignees.filter(a => a.id) : [];
  return {
    id:           row.id,
    name:         row.name,
    type:         row.type || null,
    description:  row.details || null,   // alias
    details:      row.details || null,
    startDate:    toDateStr(row.start_date) || toDateStr(row.created_at),
    date:         toDateStr(row.date),
    deadline:     toDateStr(row.deadline),
    status:       row.status || 'To Do',
    projectId:    row.project_id || null,
    projectIds:   row.project_id ? [row.project_id] : [],
    projectName:  row.project_name || null,
    ownerId:      row.owner_id || null,
    ownerName:    row.owner_name || null,
    auditorId:    row.auditor_id || null,
    auditorName:  row.auditor_name || null,
    assignees,
    assigneeIds:  assignees.map(a => a.id),
    completedAt:  row.completed_at || null,
    isArchived:   row.is_archived || false,
    archivedAt:   row.archived_at || null,
    archivedById: row.archived_by || null,
    archivedByName: row.archived_by_name || null,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

async function listTasks({ projectId, user } = {}) {
  const conditions = [];
  const params = [];
  if (projectId) {
    conditions.push(`t.project_id=$${params.push(projectId)}`);
  }
  if (user && (user.role === 'Staff' || user.role === 'Engineering')) {
    // Staff / Engineering see tasks they own OR are assigned to OR are auditing
    conditions.push(`(
      t.owner_id=$${params.push(user.id)}
      OR t.auditor_id=$${params.push(user.id)}
      OR EXISTS (SELECT 1 FROM task_assignees ta2 WHERE ta2.task_id=t.id AND ta2.user_id=$${params.push(user.id)})
    )`);
  } else if (user && user.role === 'Manager') {
    // Managers see tasks they own, are assigned to, are auditing, or are in their groups' projects
    const groupIds = user.groupIds || [];
    conditions.push(`(
      t.owner_id=$${params.push(user.id)}
      OR t.auditor_id=$${params.push(user.id)}
      OR EXISTS (SELECT 1 FROM task_assignees ta2 WHERE ta2.task_id=t.id AND ta2.user_id=$${params.push(user.id)})
      OR EXISTS (SELECT 1 FROM projects gp WHERE gp.id=t.project_id AND gp.group_id=ANY($${params.push(groupIds)}::uuid[]))
    )`);
  } else if (user && isRdHead(user.role)) {
    // R&D Heads see all tasks in R&D projects + tasks they own/are assigned to
    const groupIds = user.groupIds || [];
    conditions.push(`(
      t.owner_id=$${params.push(user.id)}
      OR t.auditor_id=$${params.push(user.id)}
      OR EXISTS (SELECT 1 FROM task_assignees ta2 WHERE ta2.task_id=t.id AND ta2.user_id=$${params.push(user.id)})
      OR EXISTS (SELECT 1 FROM projects rp WHERE rp.id=t.project_id AND rp.is_rd_issue=TRUE)
      OR EXISTS (SELECT 1 FROM projects gp WHERE gp.id=t.project_id AND gp.group_id=ANY($${params.push(groupIds)}::uuid[]))
    )`);
  }
  // Always hide archived tasks from normal lists
  conditions.push('(t.is_archived = FALSE OR t.is_archived IS NULL)');
  const where = 'WHERE ' + conditions.join(' AND ');
  const r = await query(
    `${TASK_SELECT} ${where} GROUP BY t.id, p.name, p.id, u.name, au2.name, ab.name ORDER BY t.created_at DESC`,
    params
  );
  return r.rows.map(mapTask);
}

async function getTask(id) {
  const r = await query(
    `${TASK_SELECT} WHERE t.id=$1 GROUP BY t.id, p.name, p.id, u.name, au2.name, ab.name`,
    [id]
  );
  return r.rows[0] ? mapTask(r.rows[0]) : null;
}

async function archiveTask(id, archivedById) {
  await query(
    `UPDATE tasks SET is_archived=TRUE, archived_at=NOW(), archived_by=$2, updated_at=NOW() WHERE id=$1`,
    [id, archivedById || null]
  );
}

async function unarchiveTask(id) {
  await query(
    `UPDATE tasks SET is_archived=FALSE, archived_at=NULL, archived_by=NULL, updated_at=NOW() WHERE id=$1`,
    [id]
  );
}

async function listArchivedTasks() {
  const r = await query(
    `${TASK_SELECT} WHERE t.is_archived=TRUE
     GROUP BY t.id, p.name, p.id, u.name, au2.name, ab.name
     ORDER BY t.archived_at DESC NULLS LAST`,
    []
  );
  return r.rows.map(mapTask);
}

async function getTaskDeadlineHistory(taskId) {
  const r = await query(
    `SELECT tdh.*, u.name AS changer_name
     FROM task_deadline_history tdh
     LEFT JOIN users u ON u.id = tdh.changed_by_id
     WHERE tdh.task_id=$1 ORDER BY tdh.changed_at DESC`,
    [taskId]
  );
  return r.rows.map(row => ({
    id:           row.id,
    oldDeadline:  toDateStr(row.old_deadline),
    newDeadline:  toDateStr(row.new_deadline),
    reason:       row.reason || null,
    changedByName: row.changer_name || row.changed_by_name || 'Unknown',
    changedAt:    row.changed_at,
  }));
}

async function getTaskDetail(id) {
  const [task, comments, logs, attachments, deadlineHistory, teamUsers] = await Promise.all([
    getTask(id),
    listCommentsByEntity('task', id),
    listTaskLogs(id),
    listAttachments('task', id),
    getTaskDeadlineHistory(id),
    listTeamUsers(),
  ]);
  if (!task) return { name: null };
  const owners = task.ownerId ? [{ id: task.ownerId, name: task.ownerName }] : [];
  const project = task.projectId ? { id: task.projectId, name: task.projectName } : null;
  return {
    ...task,
    comments,
    activityRecords: logs,
    records: logs,
    attachments,
    deadlineHistory,
    owners,
    project,
    teamUsers,
    assigneeIds: task.assigneeIds || [],
  };
}

async function createTask({ name, projectId, type, date, deadline, status, details, description, ownerId, auditorId }) {
  const desc = description || details || null;
  const r = await query(
    `INSERT INTO tasks (name, project_id, type, date, start_date, deadline, status, details, owner_id, auditor_id)
     VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,$9) RETURNING id`,
    [name, projectId || null, type || null, date || null, deadline || null, status || 'To Do', desc, ownerId || null, auditorId || null]
  );
  return getTask(r.rows[0].id);
}

async function updateTaskDetails(id, { name, type, date, deadline, status, details, description, changedById, changedByName, deadlineReason }) {
  // Detect deadline change and log it
  const existing = await getTask(id);
  const desc = description || details || null;
  if (existing && deadline !== undefined) {
    const oldDl = existing.deadline || null;
    const newDl = deadline || null;
    if (oldDl !== newDl) {
      await query(
        `INSERT INTO task_deadline_history (task_id, old_deadline, new_deadline, reason, changed_by_id, changed_by_name)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, oldDl || null, newDl || null, deadlineReason || null, changedById || null, changedByName || null]
      );
    }
  }
  await query(
    `UPDATE tasks SET name=COALESCE($2,name), type=$3, date=$4, deadline=$5,
       status=COALESCE($6,status), details=COALESCE($7,details), updated_at=NOW() WHERE id=$1`,
    [id, name || null, type || null, date || null, deadline !== undefined ? (deadline || null) : existing?.deadline || null, status || null, desc]
  );
  return getTask(id);
}

async function completeTask(id) {
  await query(
    `UPDATE tasks SET status='Completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [id]
  );
}

async function setTaskAuditor(taskId, auditorId) {
  await query('UPDATE tasks SET auditor_id=$2, updated_at=NOW() WHERE id=$1', [taskId, auditorId || null]);
  return getTask(taskId);
}

async function setTaskOwner(taskId, ownerId) {
  await query('UPDATE tasks SET owner_id=$2, updated_at=NOW() WHERE id=$1', [taskId, ownerId || null]);
  return getTask(taskId);
}

async function setTaskAssignees({ taskId, userIds }) {
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
  await query('UPDATE tasks SET project_id=$2 WHERE id=$1', [taskId, projectId]);
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
    `SELECT pr.*,
       uc.name AS created_by_name,
       uu.name AS updated_by_name,
       COALESCE(
         json_agg(DISTINCT jsonb_build_object('id', p.id, 'name', p.name))
         FILTER (WHERE p.id IS NOT NULL), '[]'
       ) AS projects_linked
     FROM products pr
     LEFT JOIN users uc ON uc.id = pr.created_by
     LEFT JOIN users uu ON uu.id = pr.updated_by
     LEFT JOIN product_projects pp ON pp.product_id = pr.id
     LEFT JOIN projects p ON p.id = pp.project_id
     WHERE pr.id=$1
     GROUP BY pr.id, uc.name, uu.name`,
    [id]
  );
  return r.rows[0] ? mapProduct(r.rows[0]) : null;
}

async function createProduct({ name, notes, category, phase, inputVoltage, boardSize, horsePower, maxInputPower, maxInputCurrent, maxOutputCurrent, createdById }) {
  const r = await query(
    `INSERT INTO products (name, notes, category, phase, input_voltage, board_size, horse_power, max_input_power, max_input_current, max_output_current, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [name, notes, category, phase, inputVoltage, boardSize, horsePower, maxInputPower, maxInputCurrent, maxOutputCurrent, createdById || null]
  );
  return getProduct(r.rows[0].id);
}

async function getProductDetail(id) {
  const [product, comments, datasheetFiles] = await Promise.all([
    getProduct(id),
    listCommentsByEntity('product', id),
    listAttachments('product', id)
  ]);
  if (!product) return { name: null };
  return { ...product, comments, datasheet: datasheetFiles };
}

async function deleteProductAttachment(attachmentId) {
  await query('DELETE FROM attachments WHERE id=$1', [attachmentId]);
}

async function updateProduct(id, fields, updatedById) {
  const { name, notes, category, phase, inputVoltage, boardSize, horsePower, maxInputPower, maxInputCurrent, maxOutputCurrent } = fields;
  await query(
    `UPDATE products SET name=COALESCE($2,name), notes=$3, category=$4, phase=$5,
       input_voltage=$6, board_size=$7, horse_power=$8, max_input_power=$9,
       max_input_current=$10, max_output_current=$11,
       updated_by=$12, updated_at=NOW() WHERE id=$1`,
    [id, name, notes, category, phase, inputVoltage, boardSize, horsePower, maxInputPower, maxInputCurrent, maxOutputCurrent, updatedById || null]
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
    image: row.image_url ? [{ url: toMediaUrl(row.image_url) }] : [],
    projects,
    projectIds: projects.map(p => p.id),
    projectNames: projects.map(p => p.name),
    createdAt: row.created_at,
    createdByName: row.created_by_name || null,
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name || null,
  };
}

// ─── Comments (unified) ──────────────────────────────────────────────────────

async function listCommentsByEntity(entityType, entityId) {
  const r = await query(
    `SELECT cm.*, u.name AS user_name,
       COALESCE(
         json_agg(json_build_object(
           'id', a.id,
           'filename', a.filename,
           'url', a.public_url,
           'contentType', a.content_type,
           'sizeBytes', a.size_bytes
         )) FILTER (WHERE a.id IS NOT NULL),
         '[]'::json
       ) AS attachments
     FROM comments cm
     LEFT JOIN users u ON u.id = cm.author_id
     LEFT JOIN attachments a ON a.entity_type = 'comment' AND a.entity_id = cm.id
     WHERE cm.entity_type=$1 AND cm.entity_id=$2
     GROUP BY cm.id, u.name
     ORDER BY cm.created_at ASC`,
    [entityType, entityId]
  );
  return r.rows.map(mapComment);
}

async function addComment({ entityType, entityId, content, authorId, authorName, type, emailSubject, link, files, uploadedById }) {
  if (!content || !content.trim()) throw new Error('Comment text is required.');
  const r = await query(
    `INSERT INTO comments (entity_type, entity_id, content, author_id, author_name, type, email_subject, link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [entityType, entityId, content.trim(), authorId, authorName, type || 'comment', emailSubject, link]
  );
  const commentRow = r.rows[0];
  if (files && files.length) {
    await _uploadFiles('comment', commentRow.id, files, uploadedById || authorId);
  }
  return commentRow;
}

async function listAllComments(limit = 10, userId = null) {
  const r = userId
    ? await query(
        `SELECT cm.*, u.name AS user_name FROM comments cm
         LEFT JOIN users u ON u.id = cm.author_id
         WHERE cm.author_id = $2
         ORDER BY cm.created_at DESC LIMIT $1`,
        [limit, userId]
      )
    : await query(
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
    postedAt: row.created_at,
    attachments: Array.isArray(row.attachments) ? row.attachments : []
  };
}

// Shim functions matching old Airtable crm.js signatures used by routes
async function addTaskComment({ taskId, author, comment, link, files, type, emailSubject, authorId }) {
  return addComment({ entityType: 'task', entityId: taskId, content: comment, authorName: author, link, type, emailSubject, files, uploadedById: authorId });
}
async function addActivityComment({ activityId, author, comment, link, files, type, emailSubject, authorId }) {
  return addComment({ entityType: 'activity', entityId: activityId, content: comment, authorName: author, link, type, emailSubject, files, uploadedById: authorId });
}
async function addProjectComment({ projectId, author, comment, link, files, type, emailSubject, authorId }) {
  return addComment({ entityType: 'project', entityId: projectId, content: comment, authorName: author, link, type, emailSubject, files, uploadedById: authorId });
}
async function addDealComment({ dealId, author, comment, link }) {
  return addComment({ entityType: 'deal', entityId: dealId, content: comment, authorName: author, link });
}
async function addContactComment({ contactId, author, authorId, comment, link, files }) {
  return addComment({ entityType: 'contact', entityId: contactId, content: comment, authorName: author, link, files, uploadedById: authorId });
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
    url: toMediaUrl(row.storage_path) || toMediaUrl(row.public_url),
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
  if (!company) return { company: null };
  const [contacts, activities, deals, projects, attachments] = await Promise.all([
    query('SELECT ct.*, c.name AS company_name FROM contacts ct LEFT JOIN companies c ON c.id=ct.company_id WHERE ct.company_id=$1 ORDER BY ct.full_name', [id]).then(r => r.rows.map(mapContact)),
    query(`SELECT * FROM activities WHERE company_id=$1 ORDER BY COALESCE(status_date,date) DESC`, [id]).then(r => r.rows.map(mapActivity)),
    query('SELECT * FROM deals WHERE company_id=$1 ORDER BY updated_at DESC', [id]).then(r => r.rows.map(mapDeal)),
    query('SELECT * FROM projects WHERE company_id=$1 ORDER BY updated_at DESC', [id]).then(r => r.rows.map(mapProject)),
    listAttachments('company', id)
  ]);
  return { company, contacts, activities, deals, projects, attachments };
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
      statusChoices: ['Active', 'Inactive', 'Prospect', 'Partner', 'Client'],
      industryChoices: ['Technology', 'Manufacturing', 'Healthcare', 'Finance', 'Retail', 'Education', 'Other']
    },
    contacts: {
      statusChoices: ['Active', 'Not Active', 'Left']
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
      categoryChoices: ['Controls', 'Drives', 'Residential AC', 'Commercial AC', 'Industrial Solutions', 'Special Products'],
      phaseChoices: ['Single Phase', '3 Phase']
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

// R&D open issues: tasks from projects marked as R&D issues, filtered by role
async function listRdIssues(user) {
  const params = [];
  let userCondition = '';

  if (user && user.role === 'Engineering') {
    // Engineers only see tasks they're assigned to or own
    userCondition = `AND (
      t.owner_id=$${params.push(user.id)}
      OR EXISTS (SELECT 1 FROM task_assignees ta2 WHERE ta2.task_id=t.id AND ta2.user_id=$${params.push(user.id)})
    )`;
  }
  // R&D Heads and Admins see all R&D tasks (no extra filter)

  const r = await query(
    `${TASK_SELECT}
     JOIN projects rdp ON rdp.id = t.project_id AND rdp.is_rd_issue = TRUE
     WHERE t.status != 'Completed' ${userCondition}
     GROUP BY t.id, p.name, p.id, u.name, au2.name
     ORDER BY t.deadline ASC NULLS LAST, t.created_at DESC`,
    params
  );
  return r.rows.map(mapTask);
}
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

// ─── Attachment uploads (Supabase Storage) ───────────────────────────────────

async function _uploadFiles(entityType, entityId, files, uploadedById = null) {
  if (!files || !files.length) return [];
  const inserted = [];
  for (const file of files) {
    const { path: storagePath, publicUrl, filename, contentType, sizeBytes } =
      await storage.uploadMulterFile({ entityType, entityId, file });
    const r = await query(
      `INSERT INTO attachments (filename, content_type, storage_path, public_url, size_bytes, entity_type, entity_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [filename, contentType, storagePath, publicUrl, sizeBytes, entityType, entityId, uploadedById]
    );
    inserted.push(r.rows[0]);
  }
  return inserted;
}

async function addCompanyAttachments(companyId, files, uploadedById) {
  return _uploadFiles('company', companyId, files, uploadedById);
}

async function addActivityAttachments(activityId, files, uploadedById) {
  return _uploadFiles('activity', activityId, files, uploadedById);
}

async function addProjectAttachments(projectId, files, uploadedById) {
  return _uploadFiles('project', projectId, files, uploadedById);
}

async function addTaskAttachments(taskId, files, uploadedById) {
  return _uploadFiles('task', taskId, files, uploadedById);
}

async function replaceProductImage(productId, file, uploadedById) {
  const [result] = await _uploadFiles('products', productId, [file], uploadedById);
  if (result) {
    // Store the bare storage path so toMediaUrl() always generates a fresh public URL.
    // Consistent with how logo_url works for companies.
    await query('UPDATE products SET image_url=$1 WHERE id=$2', [result.storage_path, productId]);
  }
  return getProduct(productId);
}
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
  ROLE_TITLES,
  ALL_ROLES,
  ALL_TITLES,
  RD_ROLES,
  RD_HEAD_ROLES,
  isRdRole,
  isRdHead,
  getUserById,
  getUserByEmail,
  getUserGroupIds,
  listTeamUsers,
  createUser,
  updateUser,
  updateUserProfile,
  updateUserPassword,
  assignUser,
  unassignUser,
  listAssignments,
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
  updateCompanyLogo,
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
  deleteActivity,
  getActivityDetail,
  listActivityParticipants,
  setActivityParticipants,
  addActivityProject,
  listProjectLinkedActivities,
  listActivityComments,
  addActivityComment,
  addActivityAttachments,
  addCompanyAttachments,
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
  setProjectRdIssue,
  setProjectOwner,
  setProjectAuditor,
  setProjectAssignees,
  listProjectAssignees,
  getProjectDetail,
  addProjectAttachments,
  listProjectComments,
  addProjectComment,
  listProjectsWithSubtasks,
  // Tasks
  listTasks,
  getTask,
  archiveTask,
  unarchiveTask,
  listArchivedTasks,
  createTask,
  getTaskDetail,
  updateTaskDetails,
  completeTask,
  setTaskAuditor,
  setTaskOwner,
  setTaskAssignees,
  linkTaskToProject,
  getTaskDeadlineHistory,
  addTaskAttachments,
  _uploadFiles,
  listTaskComments,
  addTaskComment,
  // Legacy project-activity aliases
  listProjectActivities,
  listRdIssues,
  getProjectActivity,
  createProjectActivity,
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
  deleteProductAttachment,
  // Comments
  listAllComments,
  addComment,
  listAttachments,
  addAttachment,
  // Webhook
  handleInboundEmail
};
