'use strict';
const router = require('express').Router();
const { requireAdmin } = require('../auth');
const { db } = require('../db');
const { buildSalaries } = require('../salaries');
router.use(requireAdmin);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/', (req, res) => {
  try { res.json(buildSalaries(db, req.query.month)); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not calculate salaries. Please try again.' }); }
});
module.exports = router;
