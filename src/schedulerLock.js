'use strict';
// Hold a RESERVED lock on a SEPARATE database for the scheduler lifetime.
// Unlike expiring leases this cannot admit a second owner during event-loop stalls.
// SQLite releases it on process/worker failure; no stale lock-file deletion needed.
const Database = require('better-sqlite3');
function acquireSchedulerLock(filename) {
  const lock = new Database(filename, { timeout: 0 });
  try { lock.exec('BEGIN IMMEDIATE'); }
  catch (error) { lock.close(); if (error.code === 'SQLITE_BUSY') return null; throw error; }
  return () => { lock.exec('ROLLBACK'); lock.close(); };
}
module.exports = { acquireSchedulerLock };
