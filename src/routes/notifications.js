'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const listForUser = db.prepare(
  `SELECT id, type, title, body, link_view, read, created_ts
   FROM notifications WHERE user_id = ? ORDER BY created_ts DESC, id DESC LIMIT 50`
);
const unreadCount = db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0`);
const markOneRead = db.prepare(`UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`);
const markAllRead = db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0`);

// My notifications + unread count (polled by the bell).
router.get('/', requireAuth, (req, res) => {
  res.json({ notifications: listForUser.all(req.user.id), unread: unreadCount.get(req.user.id).c });
});

// Lightweight poll — just the unread count.
router.get('/count', requireAuth, (req, res) => res.json({ unread: unreadCount.get(req.user.id).c }));

// Mark one as read.
router.post('/:id/read', requireAuth, (req, res) => {
  markOneRead.run(Number(req.params.id), req.user.id);
  res.json({ unread: unreadCount.get(req.user.id).c });
});

// Mark all as read.
router.post('/read-all', requireAuth, (req, res) => {
  markAllRead.run(req.user.id);
  res.json({ unread: 0 });
});

module.exports = router;
