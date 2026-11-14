'use strict';

// Permanent deletion of one employee and everything that belongs to them.
//
// Safety rules:
//  * A full database backup is written next to the database first.
//  * Rows ABOUT the person (user_id, assignee_id ...) are deleted, together with
//    any child rows that point at them (found from the declared foreign keys).
//  * Nullable "who did it" columns elsewhere (decided_by, approved_by ...) are
//    set to NULL so other people's records survive.
//  * If the person is recorded as the required author of someone else's record
//    (e.g. they created a bonus or changed a salary rate), deletion is refused:
//    deactivate instead. Nothing is deleted in that case.

const fs = require('node:fs');
const path = require('node:path');

const SUBJECT = new Set(['user_id', 'assignee_id']);

function referenceMap(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  const refs = [];
  for (const table of tables) {
    const cols = db.pragma(`table_info(${table})`);
    const fks = db.pragma(`foreign_key_list(${table})`);
    for (const fk of fks)
      refs.push({
        table,
        column: fk.from,
        parent: fk.table,
        parentColumn: fk.to || 'id',
        notnull: Boolean(cols.find((c) => c.name === fk.from)?.notnull),
        declared: true,
      });
    // Undeclared people columns (older tables) are handled too.
    for (const col of cols) {
      if (fks.some((f) => f.from === col.name) || table === 'users') continue;
      if (
        /^(user_id|assignee_id|actor_id|created_by|decided_by|reviewed_by|approved_by|updated_by|changed_by|recorded_by|voided_by|reopened_by|granted_by)$/.test(
          col.name,
        )
      ) {
        refs.push({
          table,
          column: col.name,
          parent: 'users',
          parentColumn: 'id',
          notnull: Boolean(col.notnull),
          declared: false,
        });
      }
    }
  }
  return refs;
}

function blockers(db, userId, refs = referenceMap(db)) {
  const out = [];
  for (const r of refs) {
    if (r.parent !== 'users' || SUBJECT.has(r.column) || !r.notnull) continue;
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${r.table} WHERE ${r.column} = ?`).get(userId).n;
    // Rows where the person is also the subject will be deleted anyway.
    const ownSubject = db.pragma(`table_info(${r.table})`).some((c) => c.name === 'user_id')
      ? db.prepare(`SELECT COUNT(*) AS n FROM ${r.table} WHERE ${r.column} = ? AND user_id = ?`).get(userId, userId).n
      : 0;
    if (n - ownSubject > 0) out.push({ table: r.table, column: r.column, rows: n - ownSubject });
  }
  return out;
}

function deleteWhere(db, refs, table, column, value, counts, depth = 0) {
  if (depth > 6) throw new Error('Delete chain too deep');
  const pkRows = db.prepare(`SELECT rowid AS _rid, * FROM ${table} WHERE ${column} = ?`).all(value);
  if (!pkRows.length) return;
  for (const child of refs.filter((r) => r.parent === table && r.declared)) {
    for (const row of pkRows) {
      const key = row[child.parentColumn];
      if (key === undefined || key === null) continue;
      if (child.notnull) deleteWhere(db, refs, child.table, child.column, key, counts, depth + 1);
      else db.prepare(`UPDATE ${child.table} SET ${child.column} = NULL WHERE ${child.column} = ?`).run(key);
    }
  }
  const info = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(value);
  counts[table] = (counts[table] || 0) + info.changes;
}

async function backupBeforeDelete(db, dbPath, userId) {
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `before-delete-user-${userId}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  await db.backup(file);
  return file;
}

function eraseUser(db, userId) {
  const refs = referenceMap(db);
  const blocked = blockers(db, userId, refs);
  if (blocked.length) {
    const err = new Error(
      'This person is recorded as the author of other people’s records, so they cannot be permanently deleted. Deactivate them instead.',
    );
    err.status = 409;
    err.blockers = blocked;
    throw err;
  }
  const counts = {};
  db.transaction(() => {
    for (const r of refs.filter((x) => x.parent === 'users')) {
      if (SUBJECT.has(r.column)) deleteWhere(db, refs, r.table, r.column, userId, counts);
      else if (!r.notnull) db.prepare(`UPDATE ${r.table} SET ${r.column} = NULL WHERE ${r.column} = ?`).run(userId);
      else deleteWhere(db, refs, r.table, r.column, userId, counts); // only own-subject rows remain here
    }
    const info = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    if (!info.changes) {
      const e = new Error('Not found');
      e.status = 404;
      throw e;
    }
    counts.users = 1;
  }).immediate();
  return counts;
}

module.exports = { eraseUser, blockers, referenceMap, backupBeforeDelete };
