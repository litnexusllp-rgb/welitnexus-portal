'use strict';

// Download a full, consistent snapshot of the database (one SQLite file).
// Access: an admin session, OR ?token=<BACKUP_TOKEN> for unattended/cron backups.

const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { now } = require('../time');

const router = express.Router();

function allow(req, res, next) {
  const tokenOk = process.env.BACKUP_TOKEN && req.query.token === process.env.BACKUP_TOKEN;
  const adminOk = req.user && req.user.role === 'ADMIN';
  if (tokenOk || adminOk) return next();
  return res.status(403).json({ error: 'Admins only (or a valid backup token)' });
}

router.get('/', allow, async (req, res) => {
  // db.backup() takes a consistent snapshot even while the app is running (WAL-safe).
  const tmp = path.join(os.tmpdir(), `wln-backup-${process.pid}-${Date.now()}.db`);
  try {
    await db.backup(tmp);
    const stamp = now().toFormat('yyyy-LL-dd-HHmm');
    res.download(tmp, `litnexus-portal-${stamp}.db`, () => fs.unlink(tmp, () => {}));
  } catch (e) {
    console.error('Backup failed:', e.message);
    fs.unlink(tmp, () => {});
    res.status(500).json({ error: 'Backup failed' });
  }
});

module.exports = router;
