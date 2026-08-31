// netlify/functions/_lib/generate-ics.js
// Generates a standard iCalendar (.ics) file for an annual recurring
// event, per RFC 5545 — attached to reminder emails so the recipient gets
// a one-click "Add to Calendar" button in virtually any email client
// (Gmail, Outlook, Apple Mail), without needing to connect a Google/
// Outlook account or grant any OAuth permissions.
//
// Uses a stable UID (derived from propertyId + eventId, not the specific
// year or lead-time) so that every reminder email for the same recurring
// event references the same calendar entry — a calendar app that already
// has this event will treat a later reminder's .ics as an update, not a
// duplicate. Includes RRULE:FREQ=YEARLY so the recipient only has to add
// it once; the calendar app itself then understands it recurs annually.

// Escapes text per RFC 5545 4.3.11: backslash, comma, semicolon must be
// escaped; newlines become the literal two-character sequence \n.
function escapeIcsText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r\n|\n|\r/g, '\\n');
}

// RFC 5545 requires CRLF line endings and 75-octet line folding for long
// lines. None of the fields here (short labels/property names) are
// realistically going to exceed that in normal use, so folding is
// intentionally not implemented — keeping this simple and correct for the
// actual inputs it receives, rather than adding complexity for a case
// that won't occur.
function generateIcs({ uid, label, propertyName, month, day, description }) {
  const now = new Date();
  const dtstamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  // All-day event for the NEXT occurrence of month/day from today — the
  // YEARLY RRULE is what actually makes this recur every year in the
  // recipient's calendar app; this specific date just anchors the series.
  const todayY = now.getUTCFullYear();
  let anchorYear = todayY;
  const todayMs = Date.UTC(todayY, now.getUTCMonth(), now.getUTCDate());
  const thisYearMs = Date.UTC(todayY, month - 1, day);
  if (thisYearMs < todayMs) anchorYear = todayY + 1;
  const dateStr = `${anchorYear}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  const nextDay = new Date(Date.UTC(anchorYear, month - 1, day));
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const dateEndStr = `${nextDay.getUTCFullYear()}${String(nextDay.getUTCMonth() + 1).padStart(2, '0')}${String(nextDay.getUTCDate()).padStart(2, '0')}`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RentBay//Annual Event Reminder//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${dateStr}`,
    `DTEND;VALUE=DATE:${dateEndStr}`,
    'RRULE:FREQ=YEARLY',
    `SUMMARY:${escapeIcsText(label)}${propertyName ? ' - ' + escapeIcsText(propertyName) : ''}`,
    ...(description ? [`DESCRIPTION:${escapeIcsText(description)}`] : []),
    ...(propertyName ? [`LOCATION:${escapeIcsText(propertyName)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return lines.join('\r\n') + '\r\n';
}

module.exports = { generateIcs, escapeIcsText };
