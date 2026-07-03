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

// Plain-English hint for common Slack API error codes.
function hintFor(error) {
  switch (error) {
    case 'not_authed':
    case 'invalid_auth':
      return 'The bot token is missing or wrong. Check SLACK_BOT_TOKEN on Railway — it must be the Bot User OAuth Token starting with "xoxb-".';
    case 'token_revoked':
    case 'account_inactive':
      return 'The Slack token was revoked or the app was removed. Reinstall the app to your workspace and paste the new token into SLACK_BOT_TOKEN.';
    case 'missing_scope':
      return 'The Slack app is missing a permission. Add users:read.email, chat:write and im:write under Bot Token Scopes, then Reinstall the app, and update the token.';
    case 'users_not_found':
      return 'No Slack user has this email. Make sure the person\'s portal email exactly matches the email on their Slack account.';
    default:
      return 'Slack returned an unexpected error. Double-check the token and that the app is installed to your workspace.';
  }
}

// Admin diagnostic: run the whole DM chain for one email and report exactly
// where it succeeds or fails, in plain English.
async function diagnose(email) {
  if (!enabled()) return { ok: false, step: 'token', error: 'not_set', message: 'SLACK_BOT_TOKEN is not set on the server. Add it in Railway and redeploy.' };
  try {
    const auth = await slackPost('auth.test', {});
    if (!auth.ok) return { ok: false, step: 'token', error: auth.error, message: hintFor(auth.error) };
    const base = { workspace: auth.team, botUser: auth.user };
    const look = await slackGet('users.lookupByEmail', { email });
    if (!look.ok) return { ok: false, step: 'lookup', error: look.error, message: hintFor(look.error), ...base };
    const open = await slackPost('conversations.open', { users: look.user.id });
    if (!open.ok) return { ok: false, step: 'open', error: open.error, message: hintFor(open.error), ...base };
    const post = await slackPost('chat.postMessage', { channel: open.channel.id, text: '✅ LIT Nexus portal is connected to Slack. This is a test message — you can ignore it.' });
    if (!post.ok) return { ok: false, step: 'send', error: post.error, message: hintFor(post.error), ...base };
    return { ok: true, message: `Success — a test DM was sent to ${email} in the "${auth.team}" workspace.`, ...base };
  } catch (e) {
    return { ok: false, step: 'network', error: e.message, message: 'Could not reach Slack. Check the server has internet access.' };
  }
}

module.exports = { dmUser, enabled, diagnose };
