'use strict';

// Optional: mirror in-app notifications to Slack as personal DMs. Completely
// off unless SLACK_BOT_TOKEN is set, so the portal runs unchanged without it.
// Employees are matched to their Slack account by email (no manual mapping).
//
// Slack app scopes required on the bot token: users:read.email, chat:write, im:write.

const { db } = require('./db');

const token = () => process.env.SLACK_BOT_TOKEN || '';
const enabled = () => !!token();

const getUser = db.prepare('SELECT email, name FROM users WHERE id = ?');
const emailToSlackId = new Map(); // cache: email -> slack user id (or null if none)

async function slackPost(method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token()}` },
    body: JSON.stringify(payload),
  });
  return res.json();
}
async function slackGet(method, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, { headers: { Authorization: `Bearer ${token()}` } });
  return res.json();
}

// Resolve (and cache) a Slack user id from an email address.
async function slackIdForEmail(email) {
  if (emailToSlackId.has(email)) return emailToSlackId.get(email);
  const r = await slackGet('users.lookupByEmail', { email });
  const id = r.ok ? r.user.id : null;
  emailToSlackId.set(email, id);
  if (!id) console.warn(`Slack DM: no Slack user for ${email} (${r.error || 'not found'})`);
  return id;
}

// Fire-and-forget: DM the portal user (by id) their notification on Slack.
// Never throws into the caller; logs and moves on if anything fails.
function dmUser(userId, title, body) {
  if (!enabled() || !userId) return;
  const u = getUser.get(userId);
  if (!u || !u.email) return;
  (async () => {
    try {
      const slackId = await slackIdForEmail(u.email);
      if (!slackId) return;
      const open = await slackPost('conversations.open', { users: slackId });
      if (!open.ok) return console.warn('Slack DM: conversations.open failed:', open.error);
      const text = `*${title}*${body ? `\n${body}` : ''}`;
      const post = await slackPost('chat.postMessage', { channel: open.channel.id, text });
      if (!post.ok) console.warn('Slack DM: chat.postMessage failed:', post.error);
    } catch (e) {
      console.error('Slack DM error:', e.message);
    }
  })();
}

module.exports = { dmUser, enabled };
