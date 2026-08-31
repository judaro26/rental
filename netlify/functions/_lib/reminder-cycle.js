// netlify/functions/_lib/reminder-cycle.js
// Shared "due day + lead time, recurring monthly" scheduling math, extracted
// verbatim from send-property-reminders.js so it has exactly one
// implementation rather than being copy-pasted (and potentially drifting,
// or re-introducing a bug already found and fixed once) into every function
// that needs this same kind of scheduling. Used by send-property-reminders.js
// (bill/utility reminders) and send-auto-invoices.js (automated per-tenant
// rent invoicing).

function utcMidnightToday() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// Computes a candidate due/send date for a given (year, month) occurrence of
// the rule's day-of-month.
function computeCycle(dayOfMonth, leadDays, year, month) {
  const due = new Date(Date.UTC(year, month, Math.min(Math.max(dayOfMonth, 1), 28)));
  const send = new Date(due);
  send.setUTCDate(send.getUTCDate() - (leadDays || 0));
  const period = `${due.getUTCFullYear()}-${String(due.getUTCMonth() + 1).padStart(2, '0')}`;
  return { dueMs: due.getTime(), sendMs: send.getTime(), period };
}

// A lead window always falls ON OR BEFORE its due date, so relative to
// "today", the relevant due date is either in today's own month, or in
// NEXT month (when the lead window pushes send-date earlier than the due
// date's own month — e.g. "5 days before the 2nd", checked in the last
// days of the prior month). It can never be the previous month, since
// leadDays is never negative — subtracting days only moves a date earlier,
// never forward into a later month. Checking both candidates, rather than
// assuming the due date is always in today's own month, is what makes this
// correct for every day-of-month/lead-day combination, not just the ones
// where the whole lead window happens to sit inside a single month.
function findMatchingCycle(rule, todayMs) {
  const today = new Date(todayMs);
  const y = today.getUTCFullYear(), m = today.getUTCMonth();
  for (const candidateMonth of [m, m + 1]) { // Date.UTC rolls month 12 into next year automatically
    const cycle = computeCycle(rule.dayOfMonth, rule.leadDays || 0, y, candidateMonth);
    if (cycle.sendMs === todayMs) return cycle;
  }
  return null;
}

// Answers a different question than findMatchingCycle: not "should this
// fire today," but "what's the next upcoming occurrence of this due day,
// whether or not its lead-time send-date has already passed." Used for
// ad-hoc, admin-triggered invoice generation — e.g. auto-invoicing was
// enabled for a tenant after this cycle's normal generate-window already
// passed, and the admin wants to generate the upcoming one right now
// rather than wait for next month.
function findNextDueDate(dayOfMonth, todayMs) {
  const today = new Date(todayMs);
  const y = today.getUTCFullYear(), m = today.getUTCMonth();
  for (const candidateMonth of [m, m + 1]) {
    const due = new Date(Date.UTC(y, candidateMonth, Math.min(Math.max(dayOfMonth, 1), 28)));
    if (due.getTime() >= todayMs) {
      const period = `${due.getUTCFullYear()}-${String(due.getUTCMonth() + 1).padStart(2, '0')}`;
      return { dueMs: due.getTime(), period };
    }
  }
  return null; // unreachable given dayOfMonth is clamped to 1-28, kept for safety
}

module.exports = { utcMidnightToday, computeCycle, findMatchingCycle, findNextDueDate };
