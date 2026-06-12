'use strict';

// Shared day-summary logic: derive state and worked/break minutes from a
// day's punch events. Used by the attendance routes (live view) and the
// KPI report (historical aggregation).

const VALID = {
  OUT:   ['IN'],
  IN:    ['OUT', 'BREAK_START'],
  BREAK: ['BREAK_END', 'OUT'],
};

// events: ordered punch rows for ONE user on ONE day.
// liveTs: epoch ms to extend an open IN/BREAK interval to (i.e. "now") —
//         pass null for past days so a forgotten clock-out doesn't keep
//         accruing time forever; the open interval is simply dropped.
function summarize(events, liveTs) {
  let state = 'OUT';
  let workedMs = 0;
  let breakMs = 0;
  let lastIn = null;
  let lastBreak = null;
  let firstIn = null;
  let lastOut = null;

  for (const e of events) {
    if (e.type === 'IN') {
      if (state === 'OUT') { lastIn = e.ts; if (firstIn === null) firstIn = e.ts; }
      state = 'IN';
    } else if (e.type === 'OUT') {
      if (state === 'IN' && lastIn !== null) workedMs += e.ts - lastIn;
      if (state === 'BREAK' && lastBreak !== null) breakMs += e.ts - lastBreak;
      lastOut = e.ts;
      state = 'OUT';
    } else if (e.type === 'BREAK_START') {
      if (state === 'IN' && lastIn !== null) workedMs += e.ts - lastIn;
      lastBreak = e.ts;
      state = 'BREAK';
    } else if (e.type === 'BREAK_END') {
      if (state === 'BREAK' && lastBreak !== null) breakMs += e.ts - lastBreak;
      lastIn = e.ts;
      state = 'IN';
    }
  }
  if (liveTs) {
    if (state === 'IN' && lastIn !== null) workedMs += liveTs - lastIn;
    if (state === 'BREAK' && lastBreak !== null) breakMs += liveTs - lastBreak;
  }

  return {
    state,
    workedMinutes: Math.round(workedMs / 60000),
    breakMinutes: Math.round(breakMs / 60000),
    firstIn,
    lastOut,
  };
}

module.exports = { summarize, VALID };
