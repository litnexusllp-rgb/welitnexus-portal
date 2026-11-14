'use strict';

// Slack as the messaging backbone; the portal is the interface.
//
// Required Slack app bot scopes:
//   channels:read channels:history groups:read groups:history chat:write chat:write.customize files:read files:write
//   users:read users:read.email
// Event subscriptions (Request URL: <PUBLIC_BASE_URL>/api/hooks/slack/events):
//   message.channels message.groups
// Add the app to each channel the portal should show (/invite @YourApp).
// Env: SLACK_BOT_TOKEN (already used for attendance alerts), SLACK_SIGNING_SECRET.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { db } = require('../db');

const API = process.env.SLACK_API_BASE || 'https://slack.com/api';
const bus = new EventEmitter();
bus.setMaxListeners(500);

const token = () => process.env.SLACK_BOT_TOKEN || '';
const enabled = () => Boolean(token());

async function call(method, params = {}, { json = true } = {}) {
  if (!enabled()) throw Object.assign(new Error('Slack is not connected. Add SLACK_BOT_TOKEN in Railway.'), { status: 503 });
  const opts = { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(20000) };
  if (json) { opts.headers['Content-Type'] = 'application/json; charset=utf-8'; opts.body = JSON.stringify(params); }
  else { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])); }
  const res = await fetch(`${API}/${method}`, opts);
  if (res.status === 429) throw Object.assign(new Error('Slack is rate limiting requests. Try again in a minute.'), { status: 503 });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw Object.assign(new Error(`Slack: ${body.error || 'request failed'}`), { status: 502, slackError: body.error });
  return body;
}

// ---------- identity ----------
const upsertSlackUser = db.prepare(`INSERT INTO int_slack_users(slack_user, user_id, name, email, updated_ts) VALUES (?,?,?,?,?)
  ON CONFLICT(slack_user) DO UPDATE SET user_id=excluded.user_id, name=excluded.name, email=excluded.email, updated_ts=excluded.updated_ts`);
const findPortalByEmail = db.prepare('SELECT id FROM users WHERE lower(email)=lower(?) OR (asana_email<>\'\' AND lower(asana_email)=lower(?))');

async function slackUserFor(portalUser) {
  const known = db.prepare('SELECT slack_user FROM int_slack_users WHERE user_id=? AND updated_ts > ?').get(portalUser.id, Date.now() - 86400000);
  if (known) return known.slack_user;
  try {
    const r = await call('users.lookupByEmail', { email: portalUser.email }, { json: false });
    upsertSlackUser.run(r.user.id, portalUser.id, r.user.real_name || r.user.name || '', r.user.profile?.email || portalUser.email, Date.now());
    return r.user.id;
  } catch (e) {
    if (e.slackError === 'users_not_found') return null;
    throw e;
  }
}

async function nameOf(slackUser) {
  if (!slackUser) return { name: 'Slack', user_id: null };
  const row = db.prepare('SELECT name, user_id, updated_ts FROM int_slack_users WHERE slack_user=?').get(slackUser);
  if (row && row.updated_ts > Date.now() - 7 * 86400000) return row;
  try {
    const r = await call('users.info', { user: slackUser }, { json: false });
    const email = r.user.profile?.email || '';
    const portal = email ? findPortalByEmail.get(email, email) : null;
    upsertSlackUser.run(slackUser, portal ? portal.id : null, r.user.real_name || r.user.name || slackUser, email, Date.now());
    return { name: r.user.real_name || r.user.name || slackUser, user_id: portal ? portal.id : null };
  } catch (_e) { return row || { name: slackUser, user_id: null }; }
}

// ---------- channels the person can see ----------
const channelCache = new Map(); // portal user id -> { at, channels }

let botChannels = { at: 0, ids: null };
async function botChannelIds() {
  if (botChannels.ids && Date.now() - botChannels.at < 5 * 60 * 1000) return botChannels.ids;
  const ids = new Set(); let cursor;
  for (let i = 0; i < 20; i++) {
    const r = await call('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor }, { json: false });
    for (const c of r.channels || []) if (c.is_member) ids.add(c.id);
    cursor = r.response_metadata?.next_cursor; if (!cursor) break;
  }
  botChannels = { at: Date.now(), ids };
  return ids;
}

// Channels shown in the portal = channels the person is in AND the portal's
// Slack app has been added to (/invite @LIT Portal). Direct messages between
// people need each person's own Slack sign-in and are not read by the bot.
async function channelsFor(portalUser) {
  const hit = channelCache.get(portalUser.id);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.channels;
  const slackUser = await slackUserFor(portalUser);
  if (!slackUser) return [];
  const botIds = await botChannelIds();
  const out = []; let cursor;
  for (let i = 0; i < 20; i++) {
    const r = await call('users.conversations', { user: slackUser, types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor }, { json: false });
    for (const c of r.channels || []) if (botIds.has(c.id)) out.push({ id: c.id, name: c.name, is_private: Boolean(c.is_private) });
    cursor = r.response_metadata?.next_cursor; if (!cursor) break;
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  channelCache.set(portalUser.id, { at: Date.now(), channels: out });
  return out;
}

async function assertMember(portalUser, channelId) {
  const list = await channelsFor(portalUser);
  const ch = list.find(c => c.id === channelId);
  if (!ch) throw Object.assign(new Error('You are not a member of that conversation in Slack.'), { status: 403 });
  return ch;
}

// ---------- messages ----------
const cacheMessage = db.prepare(`INSERT INTO int_messages(channel_id, ts, thread_ts, slack_user, user_id, text, files_json, edited, deleted, received_ts)
  VALUES (?,?,?,?,?,?,?,?,0,?) ON CONFLICT(channel_id, ts) DO UPDATE SET text=excluded.text, files_json=excluded.files_json, edited=excluded.edited`);

function fileSummary(files = []) {
  return files.map(f => ({ id: f.id, name: f.name || f.title || 'file', mimetype: f.mimetype || '', size: f.size || 0, filetype: f.filetype || '' }));
}

async function shape(channelId, m) {
  const who = m.user ? await nameOf(m.user) : { name: m.username || m.bot_profile?.name || 'Bot', user_id: null };
  return {
    channel: channelId, ts: m.ts, thread_ts: m.thread_ts || null, reply_count: m.reply_count || 0,
    user: m.user || null, user_name: m.username || who.name, portal_user_id: who.user_id || null,
    text: m.text || '', files: fileSummary(m.files), edited: Boolean(m.edited), subtype: m.subtype || null,
  };
}

async function history(portalUser, channelId, { cursor, thread } = {}) {
  await assertMember(portalUser, channelId);
  const r = thread
    ? await call('conversations.replies', { channel: channelId, ts: thread, limit: 100, cursor }, { json: false })
    : await call('conversations.history', { channel: channelId, limit: 50, cursor }, { json: false });
  const messages = [];
  for (const m of r.messages || []) {
    if (m.subtype && !['bot_message', 'file_share', 'thread_broadcast'].includes(m.subtype)) continue;
    const s = await shape(channelId, m);
    cacheMessage.run(channelId, m.ts, m.thread_ts || null, m.user || '', s.portal_user_id, s.text, JSON.stringify(s.files), s.edited ? 1 : 0, Date.now());
    messages.push(s);
  }
  if (!thread) messages.reverse(); // oldest first for display
  return { messages, next_cursor: r.response_metadata?.next_cursor || null };
}

async function post(portalUser, channelId, text, threadTs) {
  await assertMember(portalUser, channelId);
  const clean = String(text || '').trim().slice(0, 4000);
  if (!clean) throw Object.assign(new Error('Write a message first'), { status: 400 });
  const r = await call('chat.postMessage', {
    channel: channelId, text: clean, thread_ts: threadTs || undefined,
    username: portalUser.name, unfurl_links: false,
    metadata: { event_type: 'portal_message', event_payload: { portal_user_id: portalUser.id } },
  });
  const msg = { channel: channelId, ts: r.ts, thread_ts: threadTs || null, user: null, user_name: portalUser.name, portal_user_id: portalUser.id, text: clean, files: [], edited: false };
  bus.emit('message', msg);
  return msg;
}

async function upload(portalUser, channelId, { filename, buffer, comment, threadTs }) {
  await assertMember(portalUser, channelId);
  // eslint-disable-next-line no-control-regex -- filenames must not carry control characters
  const name = String(filename || 'file').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200);
  const start = await call('files.getUploadURLExternal', { filename: name, length: buffer.length }, { json: false });
  const put = await fetch(start.upload_url, { method: 'POST', body: buffer, headers: { 'Content-Type': 'application/octet-stream' }, signal: AbortSignal.timeout(120000) });
  if (!put.ok) throw Object.assign(new Error('Slack did not accept the file upload'), { status: 502 });
  const done = await call('files.completeUploadExternal', {
    files: [{ id: start.file_id, title: name }], channel_id: channelId, thread_ts: threadTs || undefined,
    initial_comment: comment ? `${comment}\n— ${portalUser.name} (via portal)` : `Shared by ${portalUser.name} (via portal)`,
  });
  return { file: fileSummary(done.files)[0] || { id: start.file_id, name } };
}

async function downloadFile(portalUser, fileId) {
  const info = await call('files.info', { file: fileId }, { json: false });
  const channels = [...(info.file.channels || []), ...(info.file.groups || [])];
  const mine = await channelsFor(portalUser);
  if (!channels.some(id => mine.some(c => c.id === id))) throw Object.assign(new Error('You do not have access to this file.'), { status: 403 });
  const url = info.file.url_private_download || info.file.url_private;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw Object.assign(new Error('Could not fetch the file from Slack'), { status: 502 });
  return { name: info.file.name || 'file', mimetype: info.file.mimetype || 'application/octet-stream', body: Buffer.from(await res.arrayBuffer()) };
}

// ---------- inbound events ----------
function verifySignature(rawBody, timestamp, signature, now = Date.now()) {
  const secret = process.env.SLACK_SIGNING_SECRET || '';
  if (!secret || !timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

async function handleEvent(payload) {
  if (payload.type === 'url_verification') return { challenge: payload.challenge };
  const e = payload.event;
  if (payload.type !== 'event_callback' || !e || e.type !== 'message') return { ok: true };
  if (e.subtype === 'message_deleted') {
    db.prepare('UPDATE int_messages SET deleted=1 WHERE channel_id=? AND ts=?').run(e.channel, e.deleted_ts);
    bus.emit('message', { channel: e.channel, ts: e.deleted_ts, deleted: true });
    return { ok: true };
  }
  const m = e.subtype === 'message_changed' ? { ...e.message, edited: true } : e;
  if (m.metadata?.event_type === 'portal_message') return { ok: true }; // our own post, already pushed
  const s = await shape(e.channel, m);
  cacheMessage.run(e.channel, m.ts, m.thread_ts || null, m.user || '', s.portal_user_id, s.text, JSON.stringify(s.files), s.edited ? 1 : 0, Date.now());
  bus.emit('message', s);
  return { ok: true };
}

module.exports = { enabled, call, channelsFor, assertMember, history, post, upload, downloadFile, verifySignature, handleEvent, bus, slackUserFor, _cache: channelCache, _resetBotChannels: () => { botChannels = { at: 0, ids: null }; } };
