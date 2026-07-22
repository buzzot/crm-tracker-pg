'use strict';
/**
 * routes/media.js
 * Serves private Supabase Storage files via signed URL redirect.
 * All authenticated users can access any file via GET /media/<storage-path>
 *
 * Example: /media/products/uuid/12345_image.jpg
 *   → server generates a 1-hour signed URL → 302 redirect to Supabase
 */
const express = require('express');
const router  = express.Router();
const storage = require('../services/storage');

router.get('/media/*', (req, res) => {
  const storagePath = req.params[0]; // everything after /media/
  if (!storagePath) return res.status(400).send('No path specified.');
  // Bucket is public — redirect straight to the public object URL.
  // No signed URL needed and no expiry to worry about.
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const BUCKET = process.env.SUPABASE_BUCKET || 'crm-files';
  res.redirect(302, `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`);
});

module.exports = router;
