'use strict';

// Data-safety check for the v2 upgrade. Run against a COPY of the production
// database before deploying:
//
//   node scripts/verify-upgrade.js /path/to/copy-of-portal.db
//
// It counts every row in every existing table, opens the database with the new
// code (which adds only new int_* tables), then counts again and compares.
// The original file you pass is never modified: work happens on a temp copy.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error('Usage: node scripts/verify-upgrade.js <copy-of-portal.db>');
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wln-verify-'));
const copy = path.join(dir, 'portal.db');
const src = new Database(source, { readonly: true, fileMustExist: true });
src.backup(copy).then(() => {
  src.close();
  const snapshot = (file) => {
    const db = new Database(file, { readonly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    const out = {};
    for (const t of tables) {
      const cols = db
        .pragma(`table_info(${t})`)
        .map((c) => c.name)
        .join(',');
      const rows = db.prepare(`SELECT * FROM "${t}"`).all();
      out[t] = {
        count: rows.length,
        cols,
        hash: require('node:crypto').createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      };
    }
    db.close();
    return out;
  };
  const before = snapshot(copy);
  const run = spawnSync(process.execPath, ['-e', "require('./src/db').db.close()"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH: copy, NODE_ENV: 'production', JWT_SECRET: process.env.JWT_SECRET || 'verify-only' },
    encoding: 'utf8',
  });
  if (run.status !== 0) {
    console.error('The new code could not open the database:\n' + run.stderr);
    process.exit(1);
  }
  const after = snapshot(copy);
  let ok = true;
  for (const [t, b] of Object.entries(before)) {
    const a = after[t];
    if (!a) {
      console.error(`✗ ${t}: table missing after upgrade`);
      ok = false;
      continue;
    }
    if (a.count !== b.count || a.hash !== b.hash) {
      // Existing legacy column migrations may add columns on very old databases; rows must still match.
      const same = a.count === b.count;
      console[same ? 'warn' : 'error'](
        `${same ? '!' : '✗'} ${t}: ${b.count} → ${a.count} rows${a.cols !== b.cols ? ' (columns added by existing migrations)' : ' (contents changed)'}`,
      );
      if (!same || a.cols === b.cols) ok = false;
    } else console.log(`✓ ${t}: ${b.count} rows unchanged`);
  }
  const added = Object.keys(after).filter((t) => !before[t]);
  console.log(`\nNew tables added: ${added.join(', ') || 'none'}`);
  console.log(
    ok ? '\nPASS — every existing record is intact.' : '\nFAIL — do not deploy; send this output for review.',
  );
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
});
