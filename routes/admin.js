const express = require('express');
const router = express.Router();
const crm = require('../services/crm');

// Admin-only directory of everyone who shows up as an "Owner" collaborator
// somewhere in the base, mounted at /admin and gated by requireAdmin in
// server.js.
router.get('/', async (req, res, next) => {
  try {
    const users = await crm.listTeamUsers();
    res.render('admin', { title: 'Admin · Users', users });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
