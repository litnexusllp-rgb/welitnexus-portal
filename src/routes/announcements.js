'use strict';

// Company notice board. Admins post/edit/delete; everyone reads. Posting a new
// announcement notifies all active users.

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now } = require('../time');
const { notifyAll } = require('../notify');

const router = express.Router();

const SELECT = `SELECT a.*, u.name AS author FROM announcements a LEFT JOIN users u ON u.id = a.created_by`;
const listAll = db.prepare(`${SELECT} ORDER BY a.pinned DESC, a.created_ts DESC LIMIT 100`);
const getOne = db.prepare(`${SELECT} WHERE a.id = ?`);
const insertA = db.prepare(`INSERT INTO announcements (title, body, pinned, created_by, created_ts) VALUES (?, ?, ?, ?, ?)`);
const updateA = db.prepare(`UPDATE announcements SET title = ?, body = ?, pinned = ? WHERE id = ?`);
const deleteA = db.prepare(`DELETE FROM announcements WHERE id = ?`);

// Everyone can read the board.
router.get('/', requireAuth, (_req, res) => res.json({ announcements: listAll.all() }));

// ADMIN: post a notice.
router.post('/', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 160);
  const body = String(req.body.body || '').slice(0, 4000);
  if (!title) return res.status(400).json({ error: 'A title is required' });
  const info = insertA.run(title, body, req.body.pinned ? 1 : 0, req.user.id, now().toMillis());
  notifyAll({ type: 'ANNOUNCEMENT', title: 'New announcement', body: title, link: 'noticeboard' }, req.user.id);
  res.json({ announcement: getOne.get(info.lastInsertRowid) });
});

// ADMIN: edit a notice.
router.put('/:id', requireAdmin, (req, res) => {
  const a = getOne.get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Not found' });
  updateA.run(
    String(req.body.title ?? a.title).trim().slice(0, 160),
    String(req.body.body ?? a.body).slice(0, 4000),
    req.body.pinned === undefined ? a.pinned : (req.body.pinned ? 1 : 0),
    a.id
  );
  res.json({ announcement: getOne.get(a.id) });
});

// ADMIN: delete a notice.
router.delete('/:id', requireAdmin, (req, res) => {
  deleteA.run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
