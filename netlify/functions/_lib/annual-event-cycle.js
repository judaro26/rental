// netlify/functions/_lib/annual-event-cycle.js
// Date-cycle math for annual, recurring events (e.g. a yearly board
// meeting) with one or more lead-time reminders per event — a genuinely
// different recurrence pattern than the monthly bill/utility reminder
// cycle in reminder-cycle.js, so kept as its own module rather than
// stretching already-tested monthly logic to cover a yearly case.

function utcMidnightToday() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// Computes a candidate due/send date for a given year's occurrence of the
// event's month/day, for one specific lead-time value.
function computeAnnualCycle(month, day, leadDays, year) {
  const due = new Date(Date.UTC(year, month - 1, Math.min(Math.max(day, 1), 28)));
  const send = new Date(due);
  send.setUTCDate(send.getUTCDate() - (leadDays || 0));
  return { dueMs: due.getTime(), sendMs: send.getTime(), year };
}

// A lead-time reminder always falls ON OR BEFORE its due date. For a
// yearly cycle (unlike the monthly case, where lead days are capped under
// 28), a large lead time — e.g. 60 days before a January event — can push
// the send-date into the PREVIOUS calendar year. It can never push more
// than one year back as long as leadDays stays under 365, which is
// enforced by the caller. Checking [year-1, year, year+1] rather than
// assuming the due date's own year is always the relevant one is what
// makes this correct for lead times of any reasonable size, not just
// small ones that happen to stay within a single year.
function findMatchingAnnualCycle(event, leadDays, todayMs) {
  const today = new Date(todayMs);
  const y = today.getUTCFullYear();
  for (const candidateYear of [y - 1, y, y + 1]) {
    const cycle = computeAnnualCycle(event.month, event.day, leadDays, candidateYear);
    if (cycle.sendMs === todayMs) return cycle;
  }
  return null;
}

module.exports = { utcMidnightToday, computeAnnualCycle, findMatchingAnnualCycle };
