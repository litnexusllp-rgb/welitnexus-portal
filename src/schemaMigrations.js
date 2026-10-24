'use strict';

// Legacy column additions are adopted once, in order, without hiding SQL errors.
// Keep this list append-only: changing an applied definition must stop startup.
function applyColumnMigrations(db, statements) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      statement TEXT NOT NULL,
      applied_ts INTEGER NOT NULL
    )`);
    const read = db.prepare('SELECT statement FROM schema_versions WHERE version=?');
    const record = db.prepare('INSERT INTO schema_versions(version,statement,applied_ts) VALUES(?,?,?)');
    statements.forEach((statement, index) => {
      const match = /^ALTER TABLE ([a-z_]+) ADD COLUMN ([a-z_]+) /i.exec(statement);
      if (!match) throw new Error(`Unsupported column migration ${index + 1}`);
      const [, table, column] = match;
      const version = index + 1;
      const previous = read.get(version);
      const exists = db.pragma(`table_info(${table})`).some(c => c.name === column);
      if (previous) {
        if (previous.statement !== statement || !exists) throw new Error(`Schema migration ${version} does not match the database`);
        return;
      }
      if (!exists) db.exec(statement);
      record.run(version, statement, Date.now());
    });
  }).immediate();
}

module.exports = { applyColumnMigrations };
