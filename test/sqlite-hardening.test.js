'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { EventEmitter } = require('node:events');
const { applyColumnMigrations } = require('../src/schemaMigrations');
const { installShutdown } = require('../src/shutdown');
const statements = ['ALTER TABLE sample ADD COLUMN first TEXT', 'ALTER TABLE sample ADD COLUMN second INTEGER'];
test('legacy columns are adopted and new columns applied exactly once with a version ledger', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE sample(id INTEGER,first TEXT); INSERT INTO sample VALUES(1,\'preserved\')');
    applyColumnMigrations(db, statements); applyColumnMigrations(db, statements);
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_versions').get().n, 2);
    assert.equal(db.prepare('SELECT first FROM sample').get().first, 'preserved');
    assert.deepEqual(db.pragma('table_info(sample)').map(c => c.name), ['id', 'first', 'second']);
    assert.throws(() => applyColumnMigrations(db, [statements[0].replace('TEXT', 'INTEGER')]), /does not match/);
  } finally { db.close(); }
});
test('SQL failures roll back the entire legacy migration batch and stop startup', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE sample(id INTEGER)');
    assert.throws(() => applyColumnMigrations(db, [statements[0], 'ALTER TABLE missing ADD COLUMN value TEXT']), /no such table/);
    assert.deepEqual(db.pragma('table_info(sample)').map(c => c.name), ['id']);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='schema_versions'").get(), undefined);
  } finally { db.close(); }
});
test('disk-full and permission errors propagate unchanged and do not record successful migrations', () => {
  for (const code of ['SQLITE_FULL', 'SQLITE_READONLY', 'SQLITE_CORRUPT', 'SQLITE_BUSY']) {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE sample(id INTEGER)');
      const exec = db.exec.bind(db), error = Object.assign(new Error('injected failure'), { code });
      db.exec = sql => { if (sql === statements[1]) throw error; return exec(sql); };
      assert.throws(() => applyColumnMigrations(db, statements), e => e === error);
      assert.deepEqual(db.pragma('table_info(sample)').map(c => c.name), ['id']);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='schema_versions'").get(), undefined);
    } finally { db.close(); }
  }
});
function shutdownHarness(options = {}) {
  const processRef = new EventEmitter(), exits = [], errors = [];
  processRef.exit = code => exits.push(code);
  let drain, closes = 0, forced = 0;
  const db = { open: true, close() { closes++; this.open = false; } };
  const server = { close(fn) { drain = fn; }, closeAllConnections() { forced++; } };
  installShutdown({ server, db, processRef, logger: { log() {}, error: (...args) => errors.push(args) }, ...options });
  return { processRef, db, exits, errors, drain: error => drain(error), get closes() { return closes; }, get forced() { return forced; } };
}
test('both shutdown signals drain requests before synchronously closing the database once', () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const h = shutdownHarness(); h.processRef.emit(signal);
    assert.equal(h.closes, 0); assert.deepEqual(h.exits, []);
    h.processRef.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
    h.drain(); h.drain(); assert.equal(h.closes, 1); assert.deepEqual(h.exits, [0]);
  }
});
test('a stuck connection has a bounded shutdown deadline', async () => {
  const h = shutdownHarness({ timeoutMs: 10 }); h.processRef.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.forced, 1); assert.equal(h.closes, 1); assert.deepEqual(h.exits, [1]);
});
test('database close failure exits with failure instead of claiming clean shutdown', () => {
  const h = shutdownHarness(); h.db.close = () => { throw Error('close failed'); };
  h.processRef.emit('SIGINT'); h.drain(); assert.deepEqual(h.exits, [1]); assert.equal(h.errors.length, 1);
});
test('real database startup sets WAL and a five-second timeout and can safely restart', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-sqlite-startup-'));
  const previous = process.env.DB_PATH; process.env.DB_PATH = path.join(dir, 'test.db');
  let db;
  try {
    const modulePath = require.resolve('../src/db');
    db = require(modulePath).db;
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    const count = db.prepare('SELECT count(*) AS n FROM schema_versions').get().n;
    assert.equal(count, 19);
    db.exec('CREATE TABLE half_days(value REAL); INSERT INTO half_days VALUES(0.5),(0.5),(0.5),(0.5)');
    assert.equal(db.prepare('SELECT sum(value) AS days FROM half_days').get().days, 2);
    db.close(); delete require.cache[modulePath]; db = require(modulePath).db;
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_versions').get().n, count);
    assert.equal(db.prepare('SELECT sum(value) AS days FROM half_days').get().days, 2);
    delete require.cache[modulePath];
  } finally {
    if (db?.open) db.close();
    if (previous === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('actual server exits cleanly on SIGINT and SIGTERM with a healthy database', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-shutdown-'));
  try {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const filename = path.join(dir, `${signal}.db`);
      const child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
        env: { PATH: process.env.PATH, DB_PATH: filename, PORT: '0', NODE_ENV: 'test', JWT_SECRET: 'shutdown-test-only', ADMIN_EMAIL: 'shutdown@example.test', ADMIN_PASSWORD: 'shutdown-test-password' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '', sent = false;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error(`Server did not stop: ${output}`)); }, 15000);
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.stdout.on('data', chunk => {
          output += chunk;
          if (!sent && output.includes('WeLitNexus portal running')) { sent = true; child.kill(signal); }
        });
        child.stderr.on('data', chunk => { output += chunk; });
        child.on('close', (code, terminatingSignal) => { clearTimeout(timer); resolve({ code, terminatingSignal }); });
      });
      assert.equal(result.code, 0, output); assert.equal(result.terminatingSignal, null, output);
      assert.match(output, /draining requests before closing the database/);
      assert.equal(fs.existsSync(filename + '-wal'), false);
      const db = new Database(filename);
      try { assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); }
      finally { db.close(); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
