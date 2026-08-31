'use strict';

// Read-only Asana views for the portal. Work happens in Asana; this just shows
// people their own tasks and lets an admin check the connection.

const express = require('express');
const { requireAuth, requireAdmin } = require('../auth');
const { enabled, myTasks, teamTasks, diagnose } = require('../asana');

const router = express.Router();

// Is the integration switched on? (Used by the frontend to pick which view to
// show, so nothing breaks before the token is added.)
router.get('/status', requireAuth, (_req, res) => res.json({ enabled: enabled() }));

// My open Asana tasks.
router.get('/my-tasks', requireAuth, async (req, res) => {
  if (!enabled()) return res.json({ enabled: false, tasks: [] });
  try {
    res.json({ enabled: true, tasks: await myTasks(req.user.id) });
  } catch (e) {
    res.status(502).json({ error: `Could not reach Asana: ${e.message}` });
  }
});

// ADMIN: the whole team's pending tasks, grouped by person.
router.get('/team-tasks', requireAdmin, async (_req, res) => {
  if (!enabled()) return res.json({ enabled: false, groups: [], totalPending: 0, totalOverdue: 0 });
  try {
    res.json({ enabled: true, ...(await teamTasks()) });
  } catch (e) {
    res.status(502).json({ error: `Could not reach Asana: ${e.message}` });
  }
});

// ADMIN: connection test — also reports which Asana people aren't matching an
// employee, which is the usual reason someone's tasks look missing.
router.post('/test', requireAdmin, async (_req, res) => res.json(await diagnose()));

module.exports = router;
