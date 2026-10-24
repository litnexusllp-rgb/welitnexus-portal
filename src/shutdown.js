'use strict';

// Drain HTTP requests before closing SQLite. The deadline prevents a stuck
// connection from holding a deployment open indefinitely.
function installShutdown({ server, db, processRef = process, logger = console, timeoutMs = 10000, stopBackground }) {
  let stopping = false, finished = false, deadline;
  function finish(error) {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    let code = error ? 1 : 0;
    if (error) logger.error('Shutdown failed:', error);
    try { if (db.open) db.close(); }
    catch (e) { code = 1; logger.error('Database close failed:', e); }
    processRef.exit(code);
  }
  function stop(signal) {
    if (stopping) return;
    stopping = true;
    logger.log(`${signal}: draining requests before closing the database`);
    deadline = setTimeout(() => {
      server.closeAllConnections?.();
      finish(new Error('Shutdown deadline exceeded'));
    }, timeoutMs);
    deadline.unref?.();
    let httpDone = false, backgroundDone = !stopBackground, failure;
    const drained = error => { if (error) failure = error; if (httpDone && backgroundDone) finish(failure); };
    server.close(error => { httpDone = true; drained(error); });
    if (stopBackground) Promise.resolve().then(stopBackground).then(() => { backgroundDone = true; drained(); }, error => { backgroundDone = true; drained(error); });
  }
  processRef.once('SIGINT', () => stop('SIGINT'));
  processRef.once('SIGTERM', () => stop('SIGTERM'));
}

module.exports = { installShutdown };
