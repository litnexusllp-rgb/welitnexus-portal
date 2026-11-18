'use strict';

// Unified calendar: any number of Google and Microsoft 365/Outlook accounts per
// person (personal or work, no admin rights needed on the account), private
// ICS links (client calendars, iCloud public links), plus portal events
// (holidays, approved time off, birthdays, invoice due dates).
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MS_CLIENT_ID, MS_CLIENT_SECRET,
//      MS_TENANT (default "common"), PUBLIC_BASE_URL (for OAuth redirects).

const dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');
const { db } = require('../db');
const { ZONE, DateTime } = require('../time');
const c = require('./crypto');
const { parseIcs } = require('./ics');

const base = () => String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const redirectUri = (provider) => `${base()}/api/calendar/oauth/${provider}/callback`;
const PALETTE = ['#2F6FB5', '#0E8A6D', '#7C5CC4', '#D9822B', '#C2417A', '#3B8EA5', '#8A6D3B', '#5B6B7B'];

const PROVIDERS = {
  google: {
    kind: 'GOOGLE',
    configured: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && base()),
    authUrl: (state, challenge) =>
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri('google'),
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent select_account',
        include_granted_scopes: 'true',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope:
          'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events',
      }),
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  microsoft: {
    kind: 'MICROSOFT',
    configured: () => Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && base()),
    authUrl: (state, challenge) =>
      `https://login.microsoftonline.com/${process.env.MS_TENANT || 'common'}/oauth2/v2.0/authorize?` +
      new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID,
        redirect_uri: redirectUri('microsoft'),
        response_type: 'code',
        response_mode: 'query',
        prompt: 'select_account',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'openid email offline_access User.Read Calendars.ReadWrite Calendars.Read.Shared',
      }),
    tokenUrl: `https://login.microsoftonline.com/${process.env.MS_TENANT || 'common'}/oauth2/v2.0/token`,
    clientId: () => process.env.MS_CLIENT_ID,
    clientSecret: () => process.env.MS_CLIENT_SECRET,
  },
};

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function json(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      body.error_description ||
      body.error?.message ||
      (typeof body.error === 'string' ? body.error : '') ||
      `HTTP ${res.status}`;
    // Organization policies show up as consent / admin-approval errors.
    const adminBlock = /admin|consent|AADSTS65001|AADSTS90094|access_denied|org_internal|admin_policy_enforced/i.test(
      msg,
    );
    throw Object.assign(
      new Error(
        adminBlock
          ? 'This account’s organization blocks outside apps. Share the calendar to an account you own, or use its ICS link instead.'
          : msg,
      ),
      { status: res.status === 401 ? 401 : 502, adminBlock },
    );
  }
  return body;
}

// ---------- OAuth ----------
function startOAuth(user, provider) {
  const p = PROVIDERS[provider];
  if (!p) throw fail('Unknown calendar provider');
  if (!p.configured())
    throw fail(
      `${provider === 'google' ? 'Google' : 'Microsoft'} calendar sign-in is not set up yet. Add the client ID and secret in Railway.`,
      503,
    );
  const state = c.randomId(24),
    verifier = c.randomId(48);
  const challenge = require('node:crypto').createHash('sha256').update(verifier).digest('base64url');
  db.prepare('DELETE FROM int_oauth_states WHERE expires_ts < ?').run(Date.now());
  db.prepare('INSERT INTO int_oauth_states(state, user_id, provider, verifier, expires_ts) VALUES (?,?,?,?,?)').run(
    state,
    user.id,
    provider,
    verifier,
    Date.now() + 10 * 60 * 1000,
  );
  return p.authUrl(state, challenge);
}

function emailFromIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || '';
  } catch (_e) {
    return '';
  }
}

async function finishOAuth(user, provider, { code, state }) {
  const row = db.prepare('SELECT * FROM int_oauth_states WHERE state=?').get(String(state || ''));
  db.prepare('DELETE FROM int_oauth_states WHERE state=?').run(String(state || ''));
  if (!row || row.expires_ts < Date.now() || row.provider !== provider || row.user_id !== user.id)
    throw fail('This sign-in link expired. Please try connecting again.');
  const p = PROVIDERS[provider];
  const tok = await json(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: p.clientId(),
      client_secret: p.clientSecret(),
      code: String(code || ''),
      redirect_uri: redirectUri(provider),
      grant_type: 'authorization_code',
      code_verifier: row.verifier,
    }),
  });
  let email = emailFromIdToken(tok.id_token);
  if (!email && provider === 'microsoft')
    email =
      (await json('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${tok.access_token}` } }))
        .mail || '';
  const data = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
  };
  db.prepare(
    `INSERT INTO int_oauth_tokens(user_id, provider, account_email, data_enc, updated_ts) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, provider, account_email) DO UPDATE SET data_enc=excluded.data_enc, updated_ts=excluded.updated_ts`,
  ).run(user.id, provider, email, c.encryptJson(data), Date.now());
  const tokenId = db
    .prepare('SELECT id FROM int_oauth_tokens WHERE user_id=? AND provider=? AND account_email=?')
    .get(user.id, provider, email).id;
  const calendars = await listRemoteCalendars(tokenId);
  const used = db
    .prepare('SELECT color FROM int_calendar_sources WHERE user_id=?')
    .all(user.id)
    .map((r) => r.color);
  let added = 0;
  for (const cal of calendars) {
    if (db.prepare('SELECT id FROM int_calendar_sources WHERE token_id=? AND remote_id=?').get(tokenId, cal.id))
      continue;
    const color = PALETTE.find((x) => !used.includes(x)) || PALETTE[(used.length + added) % PALETTE.length];
    used.push(color);
    db.prepare(
      `INSERT INTO int_calendar_sources(user_id, kind, label, color, visible, token_id, remote_id, read_only, created_ts) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      user.id,
      p.kind,
      `${cal.name}${email ? ' · ' + email : ''}`.slice(0, 120),
      color,
      cal.primary ? 1 : 0,
      tokenId,
      cal.id,
      cal.readOnly ? 1 : 0,
      Date.now(),
    );
    added++;
  }
  return { email, calendars: calendars.length, added };
}

async function accessToken(tokenId) {
  const row = db.prepare('SELECT * FROM int_oauth_tokens WHERE id=?').get(tokenId);
  if (!row) throw fail('Calendar account disconnected', 404);
  const data = c.decryptJson(row.data_enc);
  if (data.expires_at - 60000 > Date.now()) return { token: data.access_token, provider: row.provider };
  if (!data.refresh_token) throw fail('Please reconnect this calendar account', 401);
  const p = PROVIDERS[row.provider];
  const tok = await json(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: p.clientId(),
      client_secret: p.clientSecret(),
      refresh_token: data.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const next = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || data.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
  };
  db.prepare('UPDATE int_oauth_tokens SET data_enc=?, updated_ts=? WHERE id=?').run(
    c.encryptJson(next),
    Date.now(),
    tokenId,
  );
  return { token: next.access_token, provider: row.provider };
}

async function listRemoteCalendars(tokenId) {
  const { token, provider } = await accessToken(tokenId);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  if (provider === 'google') {
    const r = await json('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', auth);
    return (r.items || []).map((x) => ({
      id: x.id,
      name: x.summaryOverride || x.summary,
      primary: Boolean(x.primary),
      readOnly: !['owner', 'writer'].includes(x.accessRole),
    }));
  }
  const r = await json(
    'https://graph.microsoft.com/v1.0/me/calendars?$top=100&$select=id,name,canEdit,isDefaultCalendar',
    auth,
  );
  return (r.value || []).map((x) => ({
    id: x.id,
    name: x.name,
    primary: Boolean(x.isDefaultCalendar),
    readOnly: !x.canEdit,
  }));
}

// ---------- ICS links (SSRF-safe) ----------
async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(
      String(raw)
        .trim()
        .replace(/^webcal:/i, 'https:'),
    );
  } catch (_e) {
    throw fail('That is not a valid calendar link');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw fail('Calendar links must start with https:// or webcal://');
  const hosts = ipaddr.isValid(url.hostname)
    ? [url.hostname]
    : (await dns.lookup(url.hostname, { all: true }).catch(() => [])).map((a) => a.address);
  if (!hosts.length) throw fail('That calendar address could not be reached');
  for (const h of hosts) {
    if (ipaddr.process(h).range() !== 'unicast') throw fail('Private network addresses are not allowed');
  }
  return url.toString();
}

async function fetchIcs(urlString) {
  let url = await assertPublicUrl(urlString);
  let res;
  for (let hop = 0; hop < 4; hop++) {
    // follow redirects, re-checking every hop
    res = await fetch(url, {
      redirect: 'manual',
      headers: { Accept: 'text/calendar, */*' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) break;
    url = await assertPublicUrl(new URL(res.headers.get('location'), url).toString());
  }
  if (!res.ok) throw fail(`The calendar link answered ${res.status}`, 502);
  const text = (await c.readCapped(res, 15 * 1024 * 1024, () => fail('That calendar is too large', 502))).toString(
    'utf8',
  );
  if (!/BEGIN:VCALENDAR/i.test(text)) throw fail('That link did not return a calendar (.ics) file', 502);
  return text;
}

async function addIcs(user, { url, label, color, client_id }) {
  const text = await fetchIcs(url);
  const info = db
    .prepare(
      `INSERT INTO int_calendar_sources(user_id, kind, label, color, visible, ics_url_enc, client_id, read_only, created_ts) VALUES (?,?,?,?,1,?,?,1,?)`,
    )
    .run(
      user.id,
      'ICS',
      String(label || 'Shared calendar').slice(0, 120),
      /^#[0-9a-f]{6}$/i.test(color || '') ? color : PALETTE[3],
      c.encrypt(url),
      client_id || null,
      Date.now(),
    );
  storeIcs(info.lastInsertRowid, text);
  return info.lastInsertRowid;
}

const replaceCache = (sourceId, events) =>
  db.transaction(() => {
    db.prepare('DELETE FROM int_calendar_events_cache WHERE source_id=?').run(sourceId);
    const ins = db.prepare(
      'INSERT OR REPLACE INTO int_calendar_events_cache(source_id, uid, title, start_ts, end_ts, all_day, location, url, busy) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    for (const e of events)
      ins.run(
        sourceId,
        e.uid,
        e.title,
        e.start_ts,
        e.end_ts,
        e.all_day ? 1 : 0,
        e.location || '',
        e.url || '',
        e.busy ? 1 : 0,
      );
    db.prepare("UPDATE int_calendar_sources SET last_sync_ts=?, last_error='' WHERE id=?").run(Date.now(), sourceId);
  })();

function storeIcs(sourceId, text) {
  const from = Date.now() - 60 * 86400000,
    to = Date.now() + 365 * 86400000;
  replaceCache(sourceId, parseIcs(text, { rangeStart: from, rangeEnd: to, defaultZone: ZONE }));
}

// ---------- reading events ----------
async function remoteEvents(src, from, to) {
  const { token, provider } = await accessToken(src.token_id);
  const auth = { headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="UTC"` } };
  const out = [];
  if (provider === 'google') {
    let page;
    for (let i = 0; i < 10; i++) {
      const q = new URLSearchParams({
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '2500',
      });
      if (page) q.set('pageToken', page);
      const r = await json(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(src.remote_id)}/events?${q}`,
        auth,
      );
      for (const e of r.items || []) {
        if (e.status === 'cancelled') continue;
        const allDay = Boolean(e.start?.date);
        const s = allDay ? DateTime.fromISO(e.start.date, { zone: ZONE }).toMillis() : Date.parse(e.start?.dateTime);
        const en = allDay ? DateTime.fromISO(e.end.date, { zone: ZONE }).toMillis() : Date.parse(e.end?.dateTime);
        out.push({
          uid: e.id,
          title: e.summary || '(No title)',
          start_ts: s,
          end_ts: en,
          all_day: allDay,
          location: e.location || '',
          url: e.hangoutLink || e.htmlLink || '',
          busy: e.transparency !== 'transparent',
        });
      }
      page = r.nextPageToken;
      if (!page) break;
    }
  } else {
    let next =
      `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(src.remote_id)}/calendarView?` +
      new URLSearchParams({
        startDateTime: new Date(from).toISOString(),
        endDateTime: new Date(to).toISOString(),
        $top: '500',
        $select: 'id,subject,start,end,isAllDay,location,onlineMeeting,webLink,showAs,isCancelled',
      });
    for (let i = 0; i < 10 && next; i++) {
      const r = await json(next, auth);
      for (const e of r.value || []) {
        if (e.isCancelled) continue;
        out.push({
          uid: e.id,
          title: e.subject || '(No title)',
          start_ts: Date.parse(e.start.dateTime + 'Z'),
          end_ts: Date.parse(e.end.dateTime + 'Z'),
          all_day: Boolean(e.isAllDay),
          location: e.location?.displayName || '',
          url: e.onlineMeeting?.joinUrl || e.webLink || '',
          busy: !['free', 'tentative'].includes(e.showAs),
        });
      }
      next = r['@odata.nextLink'];
    }
  }
  return out;
}

async function syncSource(src, from, to) {
  try {
    if (src.kind === 'ICS') storeIcs(src.id, await fetchIcs(c.decrypt(src.ics_url_enc)));
    else
      replaceCache(
        src.id,
        await remoteEvents(src, Math.min(from, Date.now() - 31 * 86400000), Math.max(to, Date.now() + 120 * 86400000)),
      );
  } catch (e) {
    db.prepare('UPDATE int_calendar_sources SET last_error=? WHERE id=?').run(String(e.message).slice(0, 300), src.id);
  }
}

function portalEvents(user, from, to, { billing, admin = false } = {}) {
  const day = (ms) => DateTime.fromMillis(ms, { zone: ZONE }).toISODate();
  const a = day(from),
    b = day(to);
  const allDay = (iso) => ({
    start_ts: DateTime.fromISO(iso, { zone: ZONE }).toMillis(),
    end_ts: DateTime.fromISO(iso, { zone: ZONE }).plus({ days: 1 }).toMillis(),
    all_day: true,
  });
  const out = [];
  for (const h of db.prepare('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ?').all(a, b))
    out.push({ source: 'portal', kind: 'holiday', uid: 'holiday:' + h.date, title: h.name, ...allDay(h.date) });
  const leaveSql = admin
    ? "SELECT l.*, u.name FROM leaves l JOIN users u ON u.id=l.user_id WHERE l.status='APPROVED' AND l.end_date >= ? AND l.start_date <= ?"
    : "SELECT l.*, u.name FROM leaves l JOIN users u ON u.id=l.user_id WHERE l.status='APPROVED' AND l.end_date >= ? AND l.start_date <= ? AND l.user_id = " +
      Number(user.id);
  for (const l of db.prepare(leaveSql).all(a, b)) {
    out.push({
      source: 'portal',
      kind: 'time_off',
      uid: 'leave:' + l.id,
      title: `${l.name} — time off${l.kind === 'HALF' ? ' (half day)' : ''}`,
      start_ts: DateTime.fromISO(l.start_date, { zone: ZONE }).toMillis(),
      end_ts: DateTime.fromISO(l.end_date, { zone: ZONE }).plus({ days: 1 }).toMillis(),
      all_day: true,
    });
  }
  for (const u of db.prepare("SELECT name, birthday FROM users WHERE active=1 AND birthday<>''").all()) {
    for (let y = Number(a.slice(0, 4)); y <= Number(b.slice(0, 4)); y++) {
      const iso = `${y}-${u.birthday.slice(5, 10)}`;
      if (iso >= a && iso <= b && DateTime.fromISO(iso).isValid)
        out.push({
          source: 'portal',
          kind: 'birthday',
          uid: `bday:${u.name}:${iso}`,
          title: `${u.name}’s birthday`,
          ...allDay(iso),
          busy: false,
        });
    }
  }
  if (billing) {
    for (const i of db
      .prepare(
        "SELECT i.id, i.number, i.due_date, c.name FROM int_invoices i JOIN clients c ON c.id=i.client_id WHERE i.status='SENT' AND i.due_date BETWEEN ? AND ?",
      )
      .all(a, b)) {
      out.push({
        source: 'portal',
        kind: 'invoice_due',
        uid: 'invoice:' + i.id,
        title: `${i.number} due — ${i.name}`,
        ...allDay(i.due_date),
        busy: false,
      });
    }
  }
  return out.map((e) => ({ busy: true, location: '', url: '', ...e, color: '#64748B', source_label: 'Portal' }));
}

async function events(user, from, to, { billing = false, admin = false, refresh = false } = {}) {
  const sources = db.prepare('SELECT * FROM int_calendar_sources WHERE user_id=? AND visible=1').all(user.id);
  const stale = sources.filter(
    (s) => refresh || !s.last_sync_ts || Date.now() - s.last_sync_ts > (s.kind === 'ICS' ? 15 : 5) * 60 * 1000,
  );
  await Promise.all(stale.map((s) => syncSource(s, from, to)));
  const rows = sources.length
    ? db
        .prepare(
          `SELECT e.*, s.label AS source_label, s.color, s.kind, s.read_only FROM int_calendar_events_cache e JOIN int_calendar_sources s ON s.id=e.source_id
    WHERE s.user_id=? AND s.visible=1 AND e.end_ts >= ? AND e.start_ts <= ? ORDER BY e.start_ts`,
        )
        .all(user.id, from, to)
    : [];
  const list = rows
    .map((r) => ({
      source: r.source_id,
      kind: 'event',
      uid: r.uid,
      title: r.title,
      start_ts: r.start_ts,
      end_ts: r.end_ts,
      all_day: Boolean(r.all_day),
      location: r.location,
      url: r.url,
      busy: Boolean(r.busy),
      color: r.color,
      source_label: r.source_label,
      read_only: Boolean(r.read_only),
    }))
    .concat(portalEvents(user, from, to, { billing, admin }));
  return {
    events: list.sort((x, y) => x.start_ts - y.start_ts),
    conflicts: conflicts(list),
    errors: db
      .prepare("SELECT id, label, last_error FROM int_calendar_sources WHERE user_id=? AND last_error<>''")
      .all(user.id),
  };
}

// Overlapping busy, timed events from different calendars.
function conflicts(list) {
  const timed = list.filter((e) => !e.all_day && e.busy).sort((a, b) => a.start_ts - b.start_ts);
  const out = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j].start_ts < timed[i].end_ts; j++) {
      if (timed[i].source !== timed[j].source || timed[i].uid !== timed[j].uid) out.push([timed[i].uid, timed[j].uid]);
    }
  }
  return out;
}

async function createEvent(user, { source_id, title, starts_at, ends_at, location, description, attendees }) {
  const src = db.prepare('SELECT * FROM int_calendar_sources WHERE id=? AND user_id=?').get(Number(source_id), user.id);
  if (!src) throw fail('Choose one of your calendars');
  if (src.kind === 'ICS' || src.read_only) throw fail('That calendar is read-only. Pick one of your own calendars.');
  const s = Date.parse(starts_at),
    e = Date.parse(ends_at);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw fail('Choose a valid start and end time');
  const name = String(title || '')
    .trim()
    .slice(0, 300);
  if (!name) throw fail('Give the event a title');
  const people = (Array.isArray(attendees) ? attendees : [])
    .map(String)
    .filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
    .slice(0, 50);
  const { token, provider } = await accessToken(src.token_id);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let created;
  if (provider === 'google') {
    created = await json(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(src.remote_id)}/events?sendUpdates=all`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          summary: name,
          location: location || undefined,
          description: description || undefined,
          start: { dateTime: new Date(s).toISOString() },
          end: { dateTime: new Date(e).toISOString() },
          attendees: people.map((email) => ({ email })),
        }),
      },
    );
  } else {
    created = await json(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(src.remote_id)}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        subject: name,
        location: location ? { displayName: location } : undefined,
        body: description ? { contentType: 'text', content: description } : undefined,
        start: { dateTime: new Date(s).toISOString().replace('Z', ''), timeZone: 'UTC' },
        end: { dateTime: new Date(e).toISOString().replace('Z', ''), timeZone: 'UTC' },
        attendees: people.map((address) => ({ emailAddress: { address }, type: 'required' })),
      }),
    });
  }
  db.prepare('UPDATE int_calendar_sources SET last_sync_ts=NULL WHERE id=?').run(src.id); // refresh on next read
  return { id: created.id };
}

// Team availability: busy blocks only, never titles.
function freeBusy(userIds, from, to) {
  const out = {};
  for (const id of userIds) {
    out[id] = db
      .prepare(
        `SELECT e.start_ts, e.end_ts FROM int_calendar_events_cache e JOIN int_calendar_sources s ON s.id=e.source_id
      WHERE s.user_id=? AND e.busy=1 AND e.all_day=0 AND e.end_ts >= ? AND e.start_ts <= ? ORDER BY e.start_ts`,
      )
      .all(id, from, to);
  }
  return out;
}

function status() {
  return {
    google: PROVIDERS.google.configured(),
    microsoft: PROVIDERS.microsoft.configured(),
    redirectBase: base() || null,
  };
}

async function refreshAllIcs() {
  for (const src of db
    .prepare("SELECT * FROM int_calendar_sources WHERE kind='ICS' AND (last_sync_ts IS NULL OR last_sync_ts < ?)")
    .all(Date.now() - 15 * 60 * 1000)) {
    await syncSource(src, Date.now(), Date.now());
  }
}

module.exports = {
  startOAuth,
  finishOAuth,
  addIcs,
  events,
  createEvent,
  freeBusy,
  status,
  conflicts,
  assertPublicUrl,
  refreshAllIcs,
  PALETTE,
};
