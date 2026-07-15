'use strict';
/**
 * migrate-from-airtable.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulls all data from the Airtable CRM base and inserts it into the
 * Supabase/PostgreSQL database.
 *
 * Run from the crm-tracker-pg/ directory:
 *
 *   node scripts/migrate-from-airtable.js
 *
 * It loads env vars from:
 *   ../crm-tracker/.env  → AIRTABLE_TOKEN, AIRTABLE_BASE_ID
 *   .env                 → DATABASE_URL
 *
 * Or set them directly in the shell before running.
 *
 * What it does:
 *   1. Clears all CRM data tables (keeps the users table intact)
 *   2. Fetches every table from Airtable
 *   3. Builds an Airtable-id → new-UUID map
 *   4. Inserts in dependency order so FKs resolve
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
// Load env — crm-tracker first (Airtable creds), then pg app (.env overrides DATABASE_URL)
try { require('dotenv').config({ path: path.join(__dirname, '../../crm-tracker/.env') }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '../.env') }); } catch {}

const { Pool } = require('pg');
const { randomUUID } = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────

const AIRTABLE_TOKEN   = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const DATABASE_URL     = process.env.DATABASE_URL;

if (!AIRTABLE_TOKEN)   { console.error('Missing AIRTABLE_TOKEN'); process.exit(1); }
if (!AIRTABLE_BASE_ID) { console.error('Missing AIRTABLE_BASE_ID'); process.exit(1); }
if (!DATABASE_URL)     { console.error('Missing DATABASE_URL'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── Airtable table + field IDs (from config/schema.js) ──────────────────────

const AT = {
  company: {
    tableId: 'tblavQufWZinzQRWy',
    f: {
      name: 'fldGzTLuTR3mYVpGa', logo: 'fldazo71UrxYwexRc',
      billingAddress: 'fldR7sWSAU7ZyMjfk', industry: 'fldLa39Bn78lorYcD',
      status: 'fld4nkOPfgMwAj3YV', web: 'fldCK5iBcsXcXeTVf',
      notes: 'fldlScEcMVM3KsuG2',
    }
  },
  contacts: {
    tableId: 'tblWbRlEAFBc41RlK',
    f: {
      firstName: 'fldA0kWZUaLYvQX6Y', lastName: 'fld5qgZrvmZnWOt1P',
      company: 'fldzo5Wgzte4uSFYd', title: 'fldhabWeDUFtQzm3O',
      phone: 'fldPWqLOKpdxjftRD', email: 'fld3KrGu8jkXPKKyQ',
    }
  },
  activities: {
    tableId: 'tblSN6XimwDVwEfO6',
    f: {
      name: 'fldxJTnYvbfQfVZLH', date: 'fldfZCZfC92rRisOY',
      type: 'fld3u8ayKYMcd1P1q', details: 'fldyo0CWMlfmxStw1',
      result: 'fld3M9u0m81wiy3CB', company: 'fldxDBSuK2LaRo9Jg',
      attendee: 'fldyer8lg164gj4jM', project: 'fldh4U0wV2Q3Nx6wU',
      dueDate: 'fldvro1mPJvMqK8TX', statusDate: 'fldZBqfdGjpvPS2mS',
    }
  },
  deals: {
    tableId: 'tblACVaQVN4orI0ml',
    f: {
      name: 'fldgtbW6m6jn5WsbX', company: 'fldXHQkcbAV0gxZv1',
      primaryContact: 'fldHkejpCHDPoleIZ', stage: 'fldgndBq6TPkw4b0q',
      amount: 'fldlCKaH88OwCkkNN',
    }
  },
  projects: {
    tableId: 'tblYTrkR4AeyhWWWl',
    f: {
      name: 'fldP0a6rCzy1fkDcn', status: 'fld0ERl7v2yTm4rzi',
      description: 'fldgNlYU6r0prKogV', relatedCompany: 'fldpZpaKkEV9X40Fu',
      relatedProduct: 'fld9C85quzOFlpf1y',
    }
  },
  products: {
    tableId: 'tblC0Hd2nTaduzcJb',
    f: {
      name: 'fldfHBPsNacbafNVy', notes: 'fldP30xMA5n1RvvbZ',
      phase: 'fldCrpstD42UpURpi', category: 'fldWZWS4qvpYH3f2K',
      image: 'fldFxp2EX1XvzDkYp', inputVoltage: 'fldPP4brKY61UwgiG',
      boardSize: 'fld5QdheyAvJ65xNx', horsePower: 'flduPBallFkQDvujT',
      maxInputPower: 'fldAk8llEdSBNq45I', maxInputCurrent: 'fldx4yKvffbmORsyW',
      maxOutputCurrent: 'fldxRUTRIC75c9seD',
    }
  },
  projectActivities: {
    tableId: 'tblQEEpGJO4j9jY1V',
    f: {
      name: 'fldR1Ei1ojunNolLH', project: 'fldMkvde5GrFeb7yf',
      date: 'fldPxekKpsyf5kJQF', type: 'flduX3l5ffkh0lill',
      details: 'fldi92Ej71f2fFjoo', deadline: 'fldL05rBnrEE4j2Xh',
      status: 'fldZKUabHXFvPi4J8',
    }
  },
  projectActivityRecords: {
    tableId: 'tbltLdQsWxlWrYou7',
    f: {
      name: 'fldUCs9pWajVFyqxM', projectActivity: 'fldsCB9AAxk5gx7X0',
      details: 'fldigLoAmWWF8wv0P', category: 'fld9Y7uAcESsCUejk',
      recordedBy: 'fldNsaok73UutgrjK',
    }
  },
  taskComments: {
    tableId: 'tblh9Li0zakzMEVLM',
    f: {
      comment: 'fldwh0iNRxhXe1rEK', author: 'fldODHUooeS3d1VDq',
      link: 'fldz7NW9cKSSI8pJJ', task: 'fldTgIhS4uGf0blMd',
      activity: 'fldUu5YRaFLwbM3HI', deal: 'fldJfipTntKurG3J7',
      contact: 'fldToadgNohFbScz7', project: 'fldunRVicUBJE5WbS',
      postedAt: 'fldm9TvJ0IXEZgedq',
    }
  },
};

// ─── Airtable fetch helper ────────────────────────────────────────────────────

async function fetchAll(tableId) {
  const records = [];
  let offset;
  const BASE = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}`;
  const headers = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };

  do {
    const params = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' });
    if (offset) params.set('offset', offset);
    const res = await fetch(`${BASE}?${params}`, { headers });
    if (!res.ok) throw new Error(`Airtable ${tableId} (${res.status}): ${await res.text()}`);
    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fld(rec, fieldId) {
  return rec.fields[fieldId] ?? null;
}

function linkedFirst(rec, fieldId) {
  const v = fld(rec, fieldId);
  return Array.isArray(v) && v.length ? v[0] : null;
}

function linkedAll(rec, fieldId) {
  const v = fld(rec, fieldId);
  return Array.isArray(v) ? v : [];
}

function attachmentUrl(rec, fieldId) {
  const v = fld(rec, fieldId);
  return Array.isArray(v) && v.length ? v[0].url : null;
}

function safeDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Airtable status maps → PG-friendly equivalents
const STATUS_MAP = {
  // companies
  'Planned': 'Prospect', 'Lead': 'Prospect', 'Client': 'Active',
  // projects
  'In Progress': 'Active', 'Completed': 'Completed', 'On Hold': 'On Hold',
  'Cancelled': 'Cancelled',
  // tasks
  'Not Started': 'To Do', 'Overdue': 'In Progress',
};
function mapStatus(val) {
  return STATUS_MAP[val] || val || null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = await pool.connect();

  try {
    console.log('Fetching all Airtable records…');
    const [
      atCompanies,
      atContacts,
      atActivities,
      atDeals,
      atProjects,
      atProducts,
      atTasks,
      atTaskLogs,
      atComments,
    ] = await Promise.all([
      fetchAll(AT.company.tableId),
      fetchAll(AT.contacts.tableId),
      fetchAll(AT.activities.tableId),
      fetchAll(AT.deals.tableId),
      fetchAll(AT.projects.tableId),
      fetchAll(AT.products.tableId),
      fetchAll(AT.projectActivities.tableId),
      fetchAll(AT.projectActivityRecords.tableId),
      fetchAll(AT.taskComments.tableId),
    ]);

    console.log(`Fetched: ${atCompanies.length} companies, ${atContacts.length} contacts, ` +
      `${atActivities.length} activities, ${atDeals.length} deals, ` +
      `${atProjects.length} projects, ${atProducts.length} products, ` +
      `${atTasks.length} tasks, ${atTaskLogs.length} task logs, ${atComments.length} comments`);

    // ── ID map: Airtable record ID → new PG UUID ──────────────────────────
    const idMap = new Map(); // atId → pgUUID
    function uuid(atId) {
      if (!idMap.has(atId)) idMap.set(atId, randomUUID());
      return idMap.get(atId);
    }
    function pgId(atId) {
      return atId ? (idMap.get(atId) || null) : null;
    }

    // Pre-assign UUIDs for all records
    for (const r of [...atCompanies, ...atContacts, ...atActivities, ...atDeals,
                      ...atProjects, ...atProducts, ...atTasks, ...atTaskLogs, ...atComments]) {
      uuid(r.id);
    }

    // ── Clear existing CRM data (keep users / groups) ─────────────────────
    console.log('\nClearing existing CRM data…');
    await client.query(`
      DELETE FROM comments;
      DELETE FROM task_logs;
      DELETE FROM task_assignees;
      DELETE FROM attachments;
      DELETE FROM tasks;
      DELETE FROM activity_contacts;
      DELETE FROM activity_projects;
      DELETE FROM product_projects;
      DELETE FROM activities;
      DELETE FROM projects;
      DELETE FROM deals;
      DELETE FROM contacts;
      DELETE FROM products;
      DELETE FROM companies;
    `);

    // ── 1. Companies ──────────────────────────────────────────────────────
    console.log(`\nInserting ${atCompanies.length} companies…`);
    for (const r of atCompanies) {
      const f = AT.company.f;
      await client.query(
        `INSERT INTO companies (id, name, industry, status, website, billing_address, notes, logo_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          uuid(r.id),
          fld(r, f.name) || '(no name)',
          fld(r, f.industry),
          mapStatus(fld(r, f.status)),
          fld(r, f.web),
          fld(r, f.billingAddress),
          fld(r, f.notes),
          attachmentUrl(r, f.logo),
        ]
      );
    }

    // ── 2. Products (no deps) ─────────────────────────────────────────────
    console.log(`Inserting ${atProducts.length} products…`);
    for (const r of atProducts) {
      const f = AT.products.f;
      await client.query(
        `INSERT INTO products (id, name, notes, category, phase,
            input_voltage, board_size, horse_power,
            max_input_power, max_input_current, max_output_current, image_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          uuid(r.id),
          fld(r, f.name) || '(no name)',
          fld(r, f.notes),
          fld(r, f.category),
          fld(r, f.phase),
          fld(r, f.inputVoltage),
          fld(r, f.boardSize),
          fld(r, f.horsePower),
          fld(r, f.maxInputPower),
          fld(r, f.maxInputCurrent),
          fld(r, f.maxOutputCurrent),
          attachmentUrl(r, f.image),
        ]
      );
    }

    // ── 3. Contacts (dep: companies) ──────────────────────────────────────
    console.log(`Inserting ${atContacts.length} contacts…`);
    for (const r of atContacts) {
      const f = AT.contacts.f;
      const firstName = fld(r, f.firstName) || '';
      const lastName  = fld(r, f.lastName)  || '';
      const fullName  = [firstName, lastName].filter(Boolean).join(' ') || '(no name)';
      const companyAtId = linkedFirst(r, f.company);
      await client.query(
        `INSERT INTO contacts (id, full_name, email, phone, title, company_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          uuid(r.id), fullName,
          fld(r, f.email), fld(r, f.phone), fld(r, f.title),
          pgId(companyAtId),
        ]
      );
    }

    // ── 4. Deals (dep: companies, contacts) ───────────────────────────────
    console.log(`Inserting ${atDeals.length} deals…`);
    for (const r of atDeals) {
      const f = AT.deals.f;
      await client.query(
        `INSERT INTO deals (id, name, stage, amount, company_id, contact_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          uuid(r.id),
          fld(r, f.name) || '(no name)',
          fld(r, f.stage),
          parseFloat(fld(r, f.amount)) || 0,
          pgId(linkedFirst(r, f.company)),
          pgId(linkedFirst(r, f.primaryContact)),
        ]
      );
    }

    // ── 5. Projects (dep: companies) ──────────────────────────────────────
    console.log(`Inserting ${atProjects.length} projects…`);
    for (const r of atProjects) {
      const f = AT.projects.f;
      await client.query(
        `INSERT INTO projects (id, name, status, details, company_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          uuid(r.id),
          fld(r, f.name) || '(no name)',
          mapStatus(fld(r, f.status)),
          fld(r, f.description),
          pgId(linkedFirst(r, f.relatedCompany)),
        ]
      );
    }

    // ── 5b. product_projects (dep: products, projects) ────────────────────
    console.log('Inserting product↔project links…');
    for (const r of atProjects) {
      const f = AT.projects.f;
      for (const prodAtId of linkedAll(r, f.relatedProduct)) {
        const productId = pgId(prodAtId);
        const projectId = uuid(r.id);
        if (!productId) continue;
        await client.query(
          `INSERT INTO product_projects (product_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [productId, projectId]
        ).catch(() => {}); // ignore if product not in map
      }
    }

    // ── 6. Activities (dep: companies) ────────────────────────────────────
    console.log(`Inserting ${atActivities.length} activities…`);
    for (const r of atActivities) {
      const f = AT.activities.f;
      await client.query(
        `INSERT INTO activities (id, name, type, date, due_date, status_date, result, details, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          uuid(r.id),
          fld(r, f.name) || '(no name)',
          fld(r, f.type),
          safeDate(fld(r, f.date)),
          safeDate(fld(r, f.dueDate)),
          safeDate(fld(r, f.statusDate)),
          fld(r, f.result),
          fld(r, f.details),
          pgId(linkedFirst(r, f.company)),
        ]
      );
    }

    // ── 6b. activity_contacts + activity_projects ─────────────────────────
    console.log('Inserting activity↔contact and activity↔project links…');
    for (const r of atActivities) {
      const f = AT.activities.f;
      const activityId = uuid(r.id);
      for (const cAtId of linkedAll(r, f.attendee)) {
        const contactId = pgId(cAtId);
        if (!contactId) continue;
        await client.query(
          `INSERT INTO activity_contacts (activity_id, contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [activityId, contactId]
        );
      }
      for (const pAtId of linkedAll(r, f.project)) {
        const projectId = pgId(pAtId);
        if (!projectId) continue;
        await client.query(
          `INSERT INTO activity_projects (activity_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [activityId, projectId]
        );
      }
    }

    // ── 7. Tasks / projectActivities (dep: projects) ──────────────────────
    console.log(`Inserting ${atTasks.length} tasks…`);
    for (const r of atTasks) {
      const f = AT.projectActivities.f;
      const rawStatus = fld(r, f.status);
      let status = mapStatus(rawStatus) || 'To Do';
      // Keep valid PG choices only
      if (!['To Do', 'In Progress', 'Blocked', 'Completed'].includes(status)) status = 'To Do';
      await client.query(
        `INSERT INTO tasks (id, name, project_id, type, date, deadline, status, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          uuid(r.id),
          fld(r, f.name) || '(no name)',
          pgId(linkedFirst(r, f.project)),
          fld(r, f.type),
          safeDate(fld(r, f.date)),
          safeDate(fld(r, f.deadline)),
          status,
          fld(r, f.details),
        ]
      );
    }

    // ── 8. Task logs / projectActivityRecords (dep: tasks) ────────────────
    console.log(`Inserting ${atTaskLogs.length} task logs…`);
    for (const r of atTaskLogs) {
      const f = AT.projectActivityRecords.f;
      const taskAtId = linkedFirst(r, f.projectActivity);
      const taskId = pgId(taskAtId);
      if (!taskId) continue;
      const recordedByVal = fld(r, f.recordedBy);
      const loggedByName = Array.isArray(recordedByVal)
        ? (recordedByVal[0]?.name || null)
        : (typeof recordedByVal === 'string' ? recordedByVal : null);
      await client.query(
        `INSERT INTO task_logs (id, task_id, name, details, category, logged_by_name)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          uuid(r.id), taskId,
          fld(r, f.name),
          fld(r, f.details),
          fld(r, f.category),
          loggedByName,
        ]
      );
    }

    // ── 9. Comments / taskComments (dep: all entities) ────────────────────
    console.log(`Inserting ${atComments.length} comments…`);
    for (const r of atComments) {
      const f = AT.taskComments.f;
      // Determine entity — a comment may link to multiple, insert once per link
      const links = [
        { type: 'task',     atId: linkedFirst(r, f.task) },
        { type: 'activity', atId: linkedFirst(r, f.activity) },
        { type: 'deal',     atId: linkedFirst(r, f.deal) },
        { type: 'contact',  atId: linkedFirst(r, f.contact) },
        { type: 'project',  atId: linkedFirst(r, f.project) },
      ].filter(l => l.atId && pgId(l.atId));

      if (!links.length) continue;

      const content    = fld(r, f.comment);
      const authorName = fld(r, f.author);
      const link       = fld(r, f.link);
      const postedAt   = fld(r, f.postedAt);

      for (const l of links) {
        await client.query(
          `INSERT INTO comments (id, content, author_name, link, type, entity_type, entity_id, created_at)
           VALUES ($1,$2,$3,$4,'comment',$5,$6,$7)`,
          [
            randomUUID(),
            content,
            authorName,
            link,
            l.type,
            pgId(l.atId),
            postedAt ? new Date(postedAt).toISOString() : new Date().toISOString(),
          ]
        );
      }
    }

    // ── Summary ───────────────────────────────────────────────────────────
    const counts = await client.query(`
      SELECT
        (SELECT count(*) FROM companies)  AS companies,
        (SELECT count(*) FROM contacts)   AS contacts,
        (SELECT count(*) FROM activities) AS activities,
        (SELECT count(*) FROM deals)      AS deals,
        (SELECT count(*) FROM projects)   AS projects,
        (SELECT count(*) FROM products)   AS products,
        (SELECT count(*) FROM tasks)      AS tasks,
        (SELECT count(*) FROM task_logs)  AS task_logs,
        (SELECT count(*) FROM comments)   AS comments
    `);
    console.log('\n✅ Migration complete!');
    console.table(counts.rows[0]);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('\n❌ Migration failed:', err.message);
  process.exit(1);
});
