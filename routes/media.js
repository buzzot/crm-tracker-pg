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

router.get('/media/*', async (req, res, next) => {
  try {
    const storagePath = req.params[0]; // everything after /media/
    if (!storagePath) return res.status(400).send('No path specified.');
    const signedUrl = await storage.getSignedUrl(storagePath, 3600);
    res.redirect(302, signedUrl);
  } catch (err) {
    // Return a transparent 1×1 GIF so broken images don't crash pages
    res.status(200)
       .set('Content-Type', 'image/gif')
       .send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  }
});

module.exports = router;
