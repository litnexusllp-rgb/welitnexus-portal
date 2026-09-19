'use strict';
const router = require('express').Router();
const { requireAdmin } = require('../auth');
const { getScheduler } = require('../eodScheduler');
router.use(requireAdmin);
router.get('/status', (_req, res) => res.json(getScheduler().status()));
router.get('/check', async (_req, res) => {
  try { res.json(await getScheduler().check()); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
router.get('/preview', async (_req, res) => {
  try { res.json(await getScheduler().preview()); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
module.exports = router;
