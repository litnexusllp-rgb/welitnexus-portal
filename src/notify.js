'use strict';

// In-app notifications. Other routes call notify()/notifyAdmins()/notifyAll()
// to drop a row in the notifications table; the frontend polls for unread ones.
// (Email delivery can be layered on here later without touching callers.)

const { db } = require('./db');
const { now } = require('./time');
const { dmUser } = require('./slackNotify');

const insert = db.prepare(
  `INSERT INTO notifications (user_id, type, title, body, link_view, created_ts)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const activeAdmins = db.prepare(`SELECT id FROM users WHERE role = 'ADMIN' AND active = 1`);
const activeUserIds = db.prepare(`SELECT id FROM users WHERE active = 1`);

// Notify one user. type: LEAVE | TASK | PUNCH | ANNOUNCEMENT | GENERAL.
function notify(userId, { type = 'GENERAL', title, body = '', link = '' }) {
  if (!userId || !title) return;
  insert.run(userId, type, String(title).slice(0, 160), String(body).slice(0, 500), String(link).slice(0, 40), now().toMillis());
  dmUser(userId, title, body); // also DM on Slack if SLACK_BOT_TOKEN is set (no-op otherwise)
}

// Notify every active admin (optionally excluding one user, e.g. the actor).
function notifyAdmins(payload, exceptUserId) {
  for (const a of activeAdmins.all()) if (a.id !== exceptUserId) notify(a.id, payload);
}

// Notify every active user (optionally excluding the actor).
function notifyAll(payload, exceptUserId) {
  for (const u of activeUserIds.all()) if (u.id !== exceptUserId) notify(u.id, payload);
}

module.exports = { notify, notifyAdmins, notifyAll };
