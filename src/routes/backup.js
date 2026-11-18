'use strict';

// Download a full, consistent snapshot of the database (one SQLite file).
// Access: an admin session, OR ?token=<BACKUP_TOKEN> for unattended/cron backups.

const express = require('express');
const asyncRoute = require('../asyncRoute');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { now } = require('../time');
const { requireAdmin, hasAdminAccess } = require('../auth');
const { sendBackup } = require('../backupMailer');
const { safeEqual } = require('../v2/crypto');

const router = express.Router();

// ADMIN: email a backup right now (test the scheduled email delivery).
router.post(
  '/email',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const result = await sendBackup('Test');
    res.json(result);
  }),
);

function allow(req, res, next) {
  const expected = process.env.BACKUP_TOKEN;
  const presented = req.get('authorization')?.replace(/^Bearer /i, '') || req.query.token;
  const tokenOk = Boolean(expected) && safeEqual(expected, presented);
  // Same rule as every other admin route: with ADMIN_CONSOLE_REQUIRED=on a
  // password-only admin session is not enough to download the database.
  if (tokenOk || hasAdminAccess(req)) return next();
  if (req.user && req.user.role === 'ADMIN')
    return res.status(403).json({ error: 'Sign in to the admin console to continue', code: 'ADMIN_CONSOLE' });
  return res.status(403).json({ error: 'Admins only (or a valid backup token)' });
}

router.get(
  '/',
  allow,
  asyncRoute(async (req, res) => {
    // db.backup() takes a consistent snapshot even while the app is running (WAL-safe).
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wln-backup-'));
    const tmp = path.join(dir, 'portal.db');
    const cleanup = () =>
      fs.promises
        .rm(dir, { recursive: true, force: true })
        .catch((error) => console.error('Backup cleanup failed:', error.message));
    res.set('Cache-Control', 'no-store');
    try {
      await db.backup(tmp);
      const stamp = now().toFormat('yyyy-LL-dd-HHmm');
      res.download(tmp, `litnexus-portal-${stamp}.db`, () => {
        cleanup();
      });
    } catch (e) {
      console.error('Backup failed:', e.message);
      await cleanup();
      res.status(500).json({ error: 'Backup failed' });
    }
  }),
);

module.exports = router;
