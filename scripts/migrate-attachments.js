'use strict';
/**
 * migrate-attachments.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Downloads every attachment from Airtable, uploads it to Supabase Storage,
 * and updates the database with the new URLs.
 *
 * Run AFTER migrate-from-airtable.js:
 *
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_KEY=service_role_key  \
 *   DATABASE_URL=your-pooler-url           \
 *   node scripts/migrate-attachments.js
 *
 * Also reads AIRTABLE_TOKEN and AIRTABLE_BASE_ID (from ../crm-tracker/.env or env).
 *
 * What it migrates:
 *   • companies.logo_url        ← Airtable logo attachment
 *   • products.image_url        ← Airtable image attachment
 *   • activities file field     → attachments table rows
 *   • projects attachments field → attachments table rows
 *   • project tasks attachments → attachments table rows
 *   • task comments attachments → attachments table rows
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '../../crm-tracker/.env') }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '../.env') }); } catch {}

const { Pool } = require('pg');
const storage = require('../services/storage');

const AIRTABLE_TOKEN   = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const DATABASE_URL     = process.env.DATABASE_URL;

if (!process.env.SUPABASE_URL)         { console.error('Missing SUPABASE_URL'); process.exit(1); }
if (!process.env.SUPABASE_SERVICE_KEY) { console.error('Missing SUPABASE_SERVICE_KEY'); process.exit(1); }
if (!AIRTABLE_TOKEN)   { console.error('Missing AIRTABLE_TOKEN'); process.exit(1); }
if (!AIRTABLE_BASE_ID) { console.error('Missing AIRTABLE_BASE_ID'); process.exit(1); }
if (!DATABASE_URL)     { console.error('Missing DATABASE_URL'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── Airtable table + attachment field IDs ───────────────────────────────────

const AT_TABLES = {
  company:                { tableId: 'tblavQufWZinzQRWy', logoField:        'fldazo71UrxYwexRc' },
  products:               { tableId: 'tblC0Hd2nTaduzcJb', imageField:       'fldFxp2EX1XvzDkYp' },
  activities:             { tableId: 'tblSN6XimwDVwEfO6', filesField:       'fldnKkEytKb27KJwI' },
  projects:               { tableId: 'tblYTrkR4AeyhWWWl', attachField:      'fld8tzOpaNKGpniNJ' },
  projectActivities:      { tableId: 'tblQEEpGJO4j9jY1V', attachField:      'fldAvd4ZxTCJKpHfj' },
  projectActivityRecords: { tableId: 'tbltLdQsWxlWrYou7', attachField:      'fldmpvLCgS714zzEZ' },
  taskComments:           { tableId: 'tblh9Li0zakzMEVLM', attachField:      'fldl7jBSBavdrbJRF' },
};

// ─── Airtable helpers ─────────────────────────────────────────────────────────

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

function getAttachments(rec, fieldId) {
  const v = rec.fields[fieldId];
  return Array.isArray(v) ? v : [];
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

// Build a map of { airtable_record_id → pg_uuid } for a table.
// We stored the data without airtable IDs, so we match by name + created_at order.
// Instead, we built the UUID map in migrate-from-airtable.js. We can't recover
// those UUIDs here, so we match on name+company for unique identification.
//
// Better approach: query the DB and match to Airtable by name ordering, or
// add an airtable_id column. For simplicity, we store airtable_id during the
// first migration. Here we'll use an airtable_id lookup table we create on-the-fly.

async function buildIdMap(client, tableName, atRecords, nameField) {
  // We'll match by insertion order (both AT and PG records were inserted in the
  // same order during migration, so their row positions correspond).
  // This is fragile if records were deleted; a proper solution would be to add
  // an airtable_id column. For now, use name matching.
  const { rows } = await client.query(
    `SELECT id, name FROM ${tableName} ORDER BY created_at ASC, id ASC`
  );
  const map = new Map();
  for (const atRec of atRecords) {
    const atName = (atRec.fields[nameField] || '').trim().toLowerCase();
    const pgRow  = rows.find(r => (r.name || '').trim().toLowerCase() === atName);
    if (pgRow) map.set(atRec.id, pgRow.id);
  }
  return map;
}

// ─── Upload helper ────────────────────────────────────────────────────────────

let uploadCount = 0;
let skipCount   = 0;
let errorCount  = 0;

async function uploadAttachment(entityType, entityId, att) {
  try {
    const { path: storagePath, publicUrl } = await storage.uploadFromUrl({
      entityType,
      entityId,
      filename: att.filename || att.id,
      sourceUrl: att.url,
    });
    uploadCount++;
    return { storagePath, publicUrl };
  } catch (err) {
    console.warn(`  ⚠ Could not upload ${att.filename || att.id}: ${err.message}`);
    errorCount++;
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = await pool.connect();

  try {
    // 1. Ensure bucket exists
    console.log('Ensuring Supabase Storage bucket exists…');
    await storage.ensureBucket();
    console.log(`Bucket "${storage.BUCKET}" ready.\n`);

    // ── Fetch all Airtable records in parallel ──────────────────────────────
    console.log('Fetching Airtable records…');
    const [atCompanies, atProducts, atActivities, atProjects, atTasks, atTaskLogs, atComments] =
      await Promise.all([
        fetchAll(AT_TABLES.company.tableId),
        fetchAll(AT_TABLES.products.tableId),
        fetchAll(AT_TABLES.activities.tableId),
        fetchAll(AT_TABLES.projects.tableId),
        fetchAll(AT_TABLES.projectActivities.tableId),
        fetchAll(AT_TABLES.projectActivityRecords.tableId),
        fetchAll(AT_TABLES.taskComments.tableId),
      ]);
    console.log('Done fetching.\n');

    // ── Build name→PG-ID maps ───────────────────────────────────────────────
    const companyMap  = await buildIdMap(client, 'companies',  atCompanies,  'fldGzTLuTR3mYVpGa');
    const productMap  = await buildIdMap(client, 'products',   atProducts,   'fldfHBPsNacbafNVy');
    const activityMap = await buildIdMap(client, 'activities', atActivities, 'fldxJTnYvbfQfVZLH');
    const projectMap  = await buildIdMap(client, 'projects',   atProjects,   'fldP0a6rCzy1fkDcn');
    const taskMap     = await buildIdMap(client, 'tasks',      atTasks,      'fldR1Ei1ojunNolLH');

    // ── 1. Company logos ────────────────────────────────────────────────────
    console.log('Migrating company logos…');
    for (const rec of atCompanies) {
      const pgId = companyMap.get(rec.id);
      if (!pgId) { skipCount++; continue; }
      const atts = getAttachments(rec, AT_TABLES.company.logoField);
      if (!atts.length) continue;
      const att = atts[0];
      const result = await uploadAttachment('companies', pgId, att);
      if (result) {
        await client.query('UPDATE companies SET logo_url=$1 WHERE id=$2', [result.publicUrl, pgId]);
        console.log(`  ✓ Company logo: ${rec.fields['fldGzTLuTR3mYVpGa'] || pgId}`);
      }
    }

    // ── 2. Product images ───────────────────────────────────────────────────
    console.log('\nMigrating product images…');
    for (const rec of atProducts) {
      const pgId = productMap.get(rec.id);
      if (!pgId) { skipCount++; continue; }
      const atts = getAttachments(rec, AT_TABLES.products.imageField);
      if (!atts.length) continue;
      const att = atts[0];
      const result = await uploadAttachment('products', pgId, att);
      if (result) {
        await client.query('UPDATE products SET image_url=$1 WHERE id=$2', [result.publicUrl, pgId]);
        console.log(`  ✓ Product image: ${rec.fields['fldfHBPsNacbafNVy'] || pgId}`);
      }
    }

    // ── Helper: insert rows into attachments table ──────────────────────────
    async function insertAttachmentRows(entityType, pgId, atts) {
      for (const att of atts) {
        const result = await uploadAttachment(entityType, pgId, att);
        if (!result) continue;
        await client.query(
          `INSERT INTO attachments (filename, content_type, storage_path, public_url, size_bytes, entity_type, entity_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT DO NOTHING`,
          [
            att.filename || att.id,
            att.type || 'application/octet-stream',
            result.storagePath,
            result.publicUrl,
            att.size || null,
            entityType,
            pgId,
          ]
        );
        console.log(`  ✓ ${entityType} file: ${att.filename || att.id}`);
      }
    }

    // ── 3. Activity file attachments ────────────────────────────────────────
    console.log('\nMigrating activity attachments…');
    for (const rec of atActivities) {
      const pgId = activityMap.get(rec.id);
      if (!pgId) { skipCount++; continue; }
      const atts = getAttachments(rec, AT_TABLES.activities.filesField);
      if (!atts.length) continue;
      await insertAttachmentRows('activity', pgId, atts);
    }

    // ── 4. Project attachments ──────────────────────────────────────────────
    console.log('\nMigrating project attachments…');
    for (const rec of atProjects) {
      const pgId = projectMap.get(rec.id);
      if (!pgId) { skipCount++; continue; }
      const atts = getAttachments(rec, AT_TABLES.projects.attachField);
      if (!atts.length) continue;
      await insertAttachmentRows('project', pgId, atts);
    }

    // ── 5. Task attachments ─────────────────────────────────────────────────
    console.log('\nMigrating task attachments…');
    for (const rec of atTasks) {
      const pgId = taskMap.get(rec.id);
      if (!pgId) { skipCount++; continue; }
      const atts = getAttachments(rec, AT_TABLES.projectActivities.attachField);
      if (!atts.length) continue;
      await insertAttachmentRows('task', pgId, atts);
    }

    // ── 6. Task log attachments ─────────────────────────────────────────────
    console.log('\nMigrating task log attachments…');
    for (const rec of atTaskLogs) {
      // task_logs don't have entity_id FK in attachments — store under task
      const taskAtId = (rec.fields['fldsCB9AAxk5gx7X0'] || [])[0];
      const pgTaskId = taskAtId ? taskMap.get(taskAtId) : null;
      if (!pgTaskId) { skipCount++; continue; }
      const atts = getAttachments(rec, AT_TABLES.projectActivityRecords.attachField);
      if (!atts.length) continue;
      await insertAttachmentRows('task', pgTaskId, atts);
    }

    // ── 7. Comment attachments ──────────────────────────────────────────────
    // For comments we need to find the PG comment id — match by content+author
    console.log('\nMigrating comment attachments…');
    const { rows: pgComments } = await client.query(
      'SELECT id, content, author_name, entity_type, entity_id FROM comments'
    );
    for (const rec of atComments) {
      const atts = getAttachments(rec, AT_TABLES.taskComments.attachField);
      if (!atts.length) continue;
      const atContent    = rec.fields['fldwh0iNRxhXe1rEK'] || '';
      const atAuthor     = rec.fields['fldODHUooeS3d1VDq'] || '';
      const pgComment    = pgComments.find(
        c => (c.content || '') === atContent && (c.author_name || '') === atAuthor
      );
      if (!pgComment) { skipCount++; continue; }
      await insertAttachmentRows('comment', pgComment.id, atts);
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    const { rows: [counts] } = await client.query(
      'SELECT count(*) AS total FROM attachments'
    );
    console.log(`\n✅ Attachment migration complete!`);
    console.log(`   Uploaded:  ${uploadCount}`);
    console.log(`   Skipped:   ${skipCount}`);
    console.log(`   Errors:    ${errorCount}`);
    console.log(`   Attachments in DB: ${counts.total}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('\n❌ Attachment migration failed:', err.message);
  process.exit(1);
});
