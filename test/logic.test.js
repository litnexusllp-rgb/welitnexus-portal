'use strict';

// Unit tests for the correctness-critical pure logic, using Node's built-in
// test runner (no dependencies). Run with: npm test
//
// Covers: attendance hours/break computation, leave-day math, and recurrence
// date advancement — the numbers that feed timesheets, KPIs, and bonuses.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

// Isolate any SQLite file opened by required modules into a throwaway path.
process.env.DB_PATH = path.join(os.tmpdir(), `wln-test-${process.pid}-${Date.now()}.db`);

const { summarize } = require('../src/compute');
const { inclusiveDays } = require('../src/time');
const { advance } = require('../src/recurring');

const H = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

test('summarize: worked minutes between IN and OUT', () => {
  const s = summarize([{ type: 'IN', ts: T0 }, { type: 'OUT', ts: T0 + 2 * H }], null);
  assert.equal(s.workedMinutes, 120);
  assert.equal(s.breakMinutes, 0);
  assert.equal(s.state, 'OUT');
});

test('summarize: breaks are excluded from worked time', () => {
  const s = summarize([
    { type: 'IN', ts: T0 },
    { type: 'BREAK_START', ts: T0 + 1 * H },
    { type: 'BREAK_END', ts: T0 + 1.5 * H },
    { type: 'OUT', ts: T0 + 3 * H },
  ], null);
  assert.equal(s.workedMinutes, 150); // 1h before break + 1.5h after
  assert.equal(s.breakMinutes, 30);
});

test('summarize: forgotten clock-out on a past day does not accrue time', () => {
  const s = summarize([{ type: 'IN', ts: T0 }], null);
  assert.equal(s.workedMinutes, 0);
  assert.equal(s.state, 'IN');
});

test('summarize: live tail counts the open interval up to now', () => {
  const s = summarize([{ type: 'IN', ts: T0 }], T0 + 1 * H);
  assert.equal(s.workedMinutes, 60);
});

test('inclusiveDays: counts both endpoints, rejects reversed ranges', () => {
  assert.equal(inclusiveDays('2026-06-01', '2026-06-01'), 1);
  assert.equal(inclusiveDays('2026-06-01', '2026-06-03'), 3);
  assert.equal(inclusiveDays('2026-06-03', '2026-06-01'), 0);
});

test('advance: each frequency steps to the right next date', () => {
  assert.equal(advance('2026-01-15', 'WEEKLY', 1), '2026-01-22');
  assert.equal(advance('2026-01-15', 'MONTHLY', 1), '2026-02-15');
  assert.equal(advance('2026-01-15', 'QUARTERLY', 1), '2026-04-15');
  assert.equal(advance('2026-01-15', 'YEARLY', 1), '2027-01-15');
  assert.equal(advance('2026-01-31', 'MONTHLY', 1), '2026-02-28'); // clamps to month end
});
