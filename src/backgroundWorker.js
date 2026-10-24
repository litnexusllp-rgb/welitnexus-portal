'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
function startBackgroundWorker() {
  if (process.env.BACKGROUND_JOBS === 'off') return async () => {};
  const worker = new Worker(__filename, { workerData: { dbPath: require('./db').DB_PATH } });
  let exited = false, stopping = false;
  let errorState = null;
  const done = new Promise(resolve => worker.once('exit', code => { exited = true; if (!stopping) errorState = `Background worker exited with code ${code}`;
    if (errorState) console.error(errorState); resolve(); }));
  worker.on('error', error => console.error('Background worker failed:', error));
  const stop = async () => { stopping = true; if (!exited) worker.postMessage('stop'); await done; };
  stop.health = () => !errorState;
  return stop;
}
if (!isMainThread) {
  const { acquireSchedulerLock } = require('./schedulerLock');
  let release, db, retry, stopping = false;
  const stops = [];
  async function stop() {
    if (stopping) return;
    stopping = true; clearTimeout(retry);
    try { await Promise.all(stops.map(fn => fn())); }
    finally { if (db?.open) db.close(); if (release) release(); parentPort.close(); }
  }
  parentPort.on('message', message => { if (message === 'stop') stop().catch(error => { console.error(error); process.exit(1); }); });
  function start() {
    if (stopping) return;
    try { startOwned(); } catch (error) { console.error('Background startup failed:', error); stop().finally(() => process.exit(1)); }
  }
  function startOwned() {
    release = acquireSchedulerLock(workerData.dbPath + '.scheduler-lock');
    if (!release) { retry = setTimeout(start, 1000); return; }
    db = require('./db').db;
    // Startup-wide recalculation runs here, off the HTTP event loop.
    require('./leavePolicy').syncAllBalances();
    for (const [file, method] of [['recurring', 'startRecurringScheduler'], ['autoAbsence', 'startAbsenceScheduler'], ['backupMailer', 'startBackupScheduler'], ['birthdays', 'startBirthdayScheduler']]) {
      const cancel = require('./' + file)[method](); if (cancel) stops.push(cancel);
    }
    const eod = require('./eodScheduler').getScheduler(); eod.start(); stops.push(() => eod.stop());
    console.log('Background scheduler ownership acquired');
  }
  try { start(); } catch (error) { console.error('Background startup failed:', error); stop().finally(() => process.exit(1)); }
}
module.exports = { startBackgroundWorker };
