'use strict';

// Minimal iCalendar (RFC 5545) reader for client/ICS calendar links.
// Handles line folding, TZID / UTC / floating / all-day dates, DURATION,
// EXDATE, and the common RRULEs (DAILY, WEEKLY with BYDAY, MONTHLY, YEARLY,
// INTERVAL, COUNT, UNTIL). Recurrence-ID overrides replace the matching
// occurrence. Anything more exotic falls back to the first occurrence.

const { DateTime, Duration } = require('luxon');

const WINDOWS_TZ = { 'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles', 'India Standard Time': 'Asia/Kolkata', 'GMT Standard Time': 'Europe/London', 'UTC': 'UTC' };

function unfold(text) {
  return String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
}

function parseLine(line) {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon < 0) return null;
  const head = line.slice(0, colon), value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');
  const params = {};
  for (const p of paramParts) { const i = p.indexOf('='); if (i > 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, ''); }
  return { name: name.toUpperCase(), params, value };
}

const unescape = (v) => String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseDate(value, params, defaultZone) {
  const v = String(value).trim();
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    const d = DateTime.fromFormat(v.slice(0, 8), 'yyyyLLdd', { zone: defaultZone });
    return { dt: d, allDay: true };
  }
  if (v.endsWith('Z')) return { dt: DateTime.fromFormat(v, "yyyyLLdd'T'HHmmss'Z'", { zone: 'UTC' }), allDay: false };
  const tz = params.TZID ? (WINDOWS_TZ[params.TZID] || params.TZID) : defaultZone;
  let dt = DateTime.fromFormat(v, "yyyyLLdd'T'HHmmss", { zone: tz });
  if (!dt.isValid) dt = DateTime.fromFormat(v, "yyyyLLdd'T'HHmmss", { zone: defaultZone });
  return { dt, allDay: false };
}

function parseRrule(v) {
  const out = {};
  for (const part of String(v).split(';')) { const [k, val] = part.split('='); if (k) out[k.toUpperCase()] = val; }
  return out;
}

const DAYS = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

function expand(ev, rangeStart, rangeEnd, maxOccurrences = 500) {
  const lengthMs = ev.end.toMillis() - ev.start.toMillis();
  const out = [];
  const push = (start) => { if (!ev.exdates.has(start.toMillis())) out.push({ start, end: start.plus({ milliseconds: lengthMs }) }); };
  if (!ev.rrule) { push(ev.start); return out; }
  const r = parseRrule(ev.rrule);
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? parseDate(r.UNTIL, {}, ev.start.zoneName).dt : null;
  const freq = r.FREQ;
  const unit = { DAILY: 'days', WEEKLY: 'weeks', MONTHLY: 'months', YEARLY: 'years' }[freq];
  if (!unit) { push(ev.start); return out; }
  const byday = freq === 'WEEKLY' && r.BYDAY ? r.BYDAY.split(',').map(d => DAYS[d.slice(-2)]).filter(Boolean) : null;
  let n = 0;
  for (let i = 0; i < 5000 && n < count && out.length < maxOccurrences; i++) {
    const base = ev.start.plus({ [unit]: i * interval });
    const candidates = byday
      ? byday.map(wd => base.startOf('week').plus({ days: wd - 1 }).set({ hour: ev.start.hour, minute: ev.start.minute, second: ev.start.second })).filter(d => d >= ev.start).sort((a, b) => a - b)
      : [base];
    let stop = false;
    for (const c of candidates) {
      if (until && c > until) { stop = true; break; }
      if (n >= count) { stop = true; break; }
      n++;
      if (c.toMillis() + lengthMs >= rangeStart && c.toMillis() <= rangeEnd) push(c);
    }
    if (stop || base.toMillis() > rangeEnd) break;
  }
  return out;
}

// Returns occurrences overlapping [rangeStart, rangeEnd] (epoch ms).
function parseIcs(text, { rangeStart, rangeEnd, defaultZone = 'UTC' } = {}) {
  const lines = unfold(text);
  const events = []; let cur = null; let depth = 0;
  for (const raw of lines) {
    const line = parseLine(raw); if (!line) continue;
    if (line.name === 'BEGIN' && line.value.toUpperCase() === 'VEVENT') { cur = { exdates: new Set() }; depth = 1; continue; }
    if (!cur) continue;
    if (line.name === 'BEGIN') { depth++; continue; }
    if (line.name === 'END') {
      depth--;
      if (depth === 0) { if (cur.start) events.push(cur); cur = null; }
      continue;
    }
    if (depth !== 1) continue; // skip VALARM etc.
    switch (line.name) {
      case 'UID': cur.uid = line.value; break;
      case 'SUMMARY': cur.title = unescape(line.value); break;
      case 'LOCATION': cur.location = unescape(line.value); break;
      case 'URL': cur.url = line.value; break;
      case 'TRANSP': cur.busy = line.value.toUpperCase() !== 'TRANSPARENT'; break;
      case 'STATUS': cur.cancelled = line.value.toUpperCase() === 'CANCELLED'; break;
      case 'DTSTART': { const p = parseDate(line.value, line.params, defaultZone); cur.start = p.dt; cur.allDay = p.allDay; break; }
      case 'DTEND': cur.end = parseDate(line.value, line.params, defaultZone).dt; break;
      case 'DURATION': cur.duration = Duration.fromISO(line.value); break;
      case 'RRULE': cur.rrule = line.value; break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDate(line.value, line.params, defaultZone).dt.toMillis(); break;
      case 'EXDATE': for (const v of line.value.split(',')) cur.exdates.add(parseDate(v, line.params, defaultZone).dt.toMillis()); break;
      default: break;
    }
  }
  const start = rangeStart ?? -Infinity, end = rangeEnd ?? Infinity;
  const overrides = new Map();
  for (const e of events) if (e.recurrenceId) overrides.set(`${e.uid}|${e.recurrenceId}`, e);
  const out = [];
  for (const e of events) {
    if (!e.start || !e.start.isValid) continue;
    e.end = e.end && e.end.isValid ? e.end : (e.duration ? e.start.plus(e.duration) : e.start.plus(e.allDay ? { days: 1 } : { hours: 1 }));
    if (e.recurrenceId) { if (!e.cancelled && e.end.toMillis() >= start && e.start.toMillis() <= end) out.push(occ(e, e.start, e.end)); continue; }
    if (e.cancelled) continue;
    for (const o of expand(e, start, end)) {
      if (overrides.has(`${e.uid}|${o.start.toMillis()}`)) continue;
      if (o.end.toMillis() >= start && o.start.toMillis() <= end) out.push(occ(e, o.start, o.end));
    }
  }
  return out.sort((a, b) => a.start_ts - b.start_ts);
}

function occ(e, s, en) {
  return { uid: e.uid || `${e.title}-${s.toMillis()}`, title: e.title || '(No title)', start_ts: s.toMillis(), end_ts: en.toMillis(), all_day: Boolean(e.allDay), location: e.location || '', url: e.url || '', busy: e.busy !== false };
}

module.exports = { parseIcs };
