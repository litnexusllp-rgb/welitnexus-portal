'use strict';
// A bounded pool keeps bcrypt CPU work off the HTTP event loop.
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
if (!isMainThread) {
  const bcrypt = require('bcryptjs');
  parentPort.on('message', ({ operation, plain, hash }) => {
    try { parentPort.postMessage({ value: operation === 'hash' ? bcrypt.hashSync(plain, 10) : bcrypt.compareSync(plain, hash) }); }
    catch (_) { parentPort.postMessage({ error: 'Password operation failed' }); }
  });
} else {
  const queue = [], slots = [];
  const failure = () => Object.assign(new Error('Password service busy. Please retry shortly.'), { status: 503 });
  function dispatch() {
    for (const slot of slots) {
      if (slot.job || !queue.length) continue;
      slot.job = queue.shift(); slot.worker.ref(); slot.worker.postMessage(slot.job.input);
    }
  }
  function addWorker() {
    const slot = { worker: new Worker(__filename), job: null };
    slots.push(slot);
    slot.worker.on('message', result => {
      const job = slot.job; slot.job = null; slot.worker.unref();
      if (result.error) job.reject(failure()); else job.resolve(result.value);
      dispatch();
    });
    slot.worker.on('error', () => {}); // exit rejects the current job exactly once
    slot.worker.on('exit', () => {
      slots.splice(slots.indexOf(slot), 1);
      if (slot.job) slot.job.reject(failure());
      if (queue.length) { addWorker(); dispatch(); }
    });
    slot.worker.unref();
  }
  function run(operation, plain, hash) {
    if (queue.length >= 32) return Promise.reject(failure());
    if (slots.length < 2) addWorker();
    return new Promise((resolve, reject) => { queue.push({ input: { operation, plain, hash }, resolve, reject }); dispatch(); });
  }
  module.exports = { hashPasswordAsync: plain => run('hash', plain), verifyPasswordAsync: (plain, hash) => run('verify', plain, hash) };
}
