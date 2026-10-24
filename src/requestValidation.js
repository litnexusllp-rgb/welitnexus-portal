'use strict';
const { DateTime } = require('luxon');
const day = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && DateTime.fromISO(v).isValid;
const month = v => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v) && day(v + '-01');
const id = v => (typeof v === 'number' || typeof v === 'string') && /^[1-9]\d*$/.test(String(v)) && Number.isSafeInteger(Number(v));
const dates = new Set(['date', 'day', 'start', 'end', 'start_date', 'end_date', 'due_date', 'next_due', 'join_date', 'exit_date', 'birthday', 'paid_on', 'effective_from', 'event_date']);
const booleans = new Set(['active', 'done', 'ignore_late', 'pinned', 'normal']);
function inputError(value, key = '', depth = 0) {
  if (depth > 8) return 'Input nesting exceeds the limit';
  if (value === null) return booleans.has(key) ? `${key} must be a boolean` : null;
  if (typeof value === 'object') {
    if (key && !['salary', 'items', 'checklist', 'user_ids', 'ids', 'days', 'events', 'punches'].includes(key)) return `${key} must be a scalar value`;
    if (Array.isArray(value) && value.length > 500) return 'Too many items';
    for (const [k, v] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(k)) return 'Invalid field';
      const error = inputError(v, Array.isArray(value) ? '' : k, depth + 1); if (error) return error;
    }
    return null;
  }
  if (typeof value === 'string' && value.length > 10000) return `${key} is too long`;
  if (key === 'role' && !['ADMIN', 'EMPLOYEE'].includes(String(value).toUpperCase())) return 'Choose a valid user role';
  if (key === 'month' && value !== '' && !month(value)) return 'Use a valid month (yyyy-mm)';
  if (dates.has(key) && value !== '' && !day(value)) return `${key} must be a valid date (yyyy-mm-dd)`;
  if ((key === 'id' || key.endsWith('_id')) && value !== '' && value !== 0 && value !== '0' && !id(value)) return `${key} must be a positive integer`;
  if (booleans.has(key) && ![true, false, 0, 1].includes(value)) return `${key} must be a boolean`;
  if (['password', 'new_password', 'current_password'].includes(key) && typeof value !== 'string') return 'Password must be text';
  if (['password', 'new_password'].includes(key) && Buffer.byteLength(value) > 72) return 'Password must be at most 72 UTF-8 bytes';
  if (['name', 'email', 'title', 'reason', 'description', 'note', 'text', 'body', 'client_name', 'code', 'business_type', 'stage', 'notes', 'billing_address', 'emp_code', 'role', 'department', 'phone', 'shift_start', 'asana_email', 'attendance_timezone', 'type', 'status', 'priority', 'category', 'duration', 'decision', 'time', 'operation'].includes(key) && typeof value !== 'string') return `${key} must be text`;
  if (key === 'email' && value !== '' && (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return 'Use a valid email address';
  if (['step', 'lead_days', 'points', 'attendance_cutover'].includes(key) && (!Number.isFinite(Number(value)) || !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 10000)) return `${key} must be a bounded integer`;
  return null;
}
function validateRequest(req, res, next) {
  const body = req.body;
  if (body === null || Array.isArray(body) || typeof body !== 'object') return res.status(400).json({ error: 'JSON body must be an object' });
  const error = inputError(body) || inputError(req.query);
  if (error) return res.status(400).json({ error });
  for (const [a, b] of [['start', 'end'], ['start_date', 'end_date']]) {
    for (const source of [req.query, body]) {
      if (day(source[a]) && day(source[b]) && (source[a] > source[b] || DateTime.fromISO(source[b]).diff(DateTime.fromISO(source[a]), 'days').days > 366)) return res.status(400).json({ error: 'Date range must be ordered and at most 367 days' });
    }
  }
  next();
}
// Mounted inside each router so parameter validation also applies in direct router tests.
function validateParams(req, res, next) {
  for (const [key, value] of Object.entries(req.params)) {
    if ((key === 'id' || key.endsWith('Id') || key.endsWith('_id')) && !id(value)) return res.status(400).json({ error: 'Invalid record ID' });
    if (key === 'role' && !['ADMIN', 'EMPLOYEE'].includes(String(value).toUpperCase())) return 'Choose a valid user role';
  if (key === 'month' && !month(value)) return res.status(400).json({ error: 'Invalid month' });
  }
  next();
}
function validateReferences(body, db) {
  for (const key of ['assignee_id', 'default_assignee_id', 'client_id']) {
    const value = body?.[key]; if (value === undefined || value === null || value === '' || value === 0) continue;
    if (!id(value)) return `${key} must be a positive integer`;
    const sql = key === 'client_id' ? "SELECT id FROM clients WHERE id=? AND active=1 AND approval='APPROVED'" : 'SELECT id FROM users WHERE id=? AND active=1';
    if (!db.prepare(sql).get(Number(value))) return `${key} must reference an active, approved record`;
  }
  return null;
}
module.exports = { validateRequest, validateParams, validateReferences, day, month, id };
