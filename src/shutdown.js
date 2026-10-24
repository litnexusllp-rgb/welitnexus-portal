'use strict';

// Drain HTTP requests before closing SQLite. The deadline prevents a stuck
// connection from holding a deployment open indefinitely.
function installShutdown({ server, db, processRef = process, logger = console, timeoutMs = 10000 }) {
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
    server.close(finish);
  }
  processRef.once('SIGINT', () => stop('SIGINT'));
  processRef.once('SIGTERM', () => stop('SIGTERM'));
}

module.exports = { installShutdown };
