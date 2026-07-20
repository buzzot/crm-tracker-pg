'use strict';
/**
 * services/storage.js
 * Thin wrapper around the Supabase Storage REST API.
 *
 * Required env vars:
 *   SUPABASE_URL          – e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  – service_role key (Settings → API in Supabase dashboard)
 *   SUPABASE_BUCKET       – storage bucket name (default: crm-files)
 */

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const BUCKET        = process.env.SUPABASE_BUCKET || 'crm-files';

function storageHeaders(extra = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for file storage.');
  }
  return { Authorization: `Bearer ${SERVICE_KEY}`, ...extra };
}

/**
 * Ensure the bucket exists. Safe to call repeatedly — ignores "already exists".
 */
async function ensureBucket() {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: storageHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Ignore "already exists" error
    if (body.error !== 'Duplicate') {
      throw new Error(`Could not create bucket: ${JSON.stringify(body)}`);
    }
  }
}

/**
 * Upload a Buffer/Uint8Array to Supabase Storage.
 * Returns { path, publicUrl }.
 */
async function uploadBuffer({ entityType, entityId, filename, contentType, buffer }) {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${entityType}/${entityId}/${Date.now()}_${safeName}`;

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: storageHeaders({
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true',
    }),
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage upload failed (${res.status}): ${text}`);
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  return { path, publicUrl };
}

/**
 * Download a file from a remote URL, then upload it to Supabase Storage.
 * Returns { path, publicUrl }.
 */
async function uploadFromUrl({ entityType, entityId, filename, sourceUrl }) {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Could not download ${sourceUrl}: ${res.status}`);

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await res.arrayBuffer());
  return uploadBuffer({ entityType, entityId, filename, contentType, buffer });
}

/**
 * Upload a multer file object (req.files[i]) to Supabase Storage.
 * Returns { path, publicUrl, filename, contentType, sizeBytes }.
 */
async function uploadMulterFile({ entityType, entityId, file }) {
  const { originalname, mimetype, buffer, size } = file;
  const { path, publicUrl } = await uploadBuffer({
    entityType,
    entityId,
    filename: originalname,
    contentType: mimetype,
    buffer,
  });
  return { path, publicUrl, filename: originalname, contentType: mimetype, sizeBytes: size };
}

/**
 * Delete a file from Supabase Storage by its storage path.
 */
async function deleteFile(storagePath) {
  await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'DELETE',
    headers: storageHeaders(),
  });
}

module.exports = { ensureBucket, uploadBuffer, uploadFromUrl, uploadMulterFile, deleteFile, BUCKET };
