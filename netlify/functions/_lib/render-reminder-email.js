// netlify/functions/_lib/invoice-reminder-email.js
// Pure helpers for building an invoice reminder/overdue-notice email.
// Extracted from send-invoice-reminders.js (the scheduled, rule-based
// reminder system) so the same exact email content can also be triggered
// on-demand from send-invoice-reminder-now.js, without duplicating the
// markup in two places that could quietly drift apart over time.
//
// No side effects here - no Firestore, no email sending. Callers own
// deciding *whether* to send and *how* (transporter setup, recording the
// send), this file only builds the message itself.

// Parse a due date into a UTC-midnight timestamp so day math is timezone-stable.
function toUtcMidnight(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(value);
  if (isNaN(d)) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function buildEmail({ siteName, tenantName, invoiceNumber, total, dueMs, daysBefore, daysOverdue, invoiceUrl, siteUrl }) {
  const amount = `$${Number(total || 0).toFixed(2)}`;
  const isOverdue = typeof daysOverdue === 'number';
  const when = isOverdue
    ? `is now ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue`
    : (daysBefore === 0 ? 'is due today' : `is due in ${daysBefore} day${daysBefore === 1 ? '' : 's'}`);
  const accent = isOverdue ? '#DC2626' : '#C9903A';
  const heading = isOverdue ? 'Overdue invoice notice' : 'Invoice reminder';
  const tag = isOverdue ? '⚠️ Overdue Notice' : '🔔 Payment Reminder';
  const intro = isOverdue
    ? `Hi ${tenantName || 'there'}, our records show your invoice <strong>${invoiceNumber || ''}</strong> ${when} and remains unpaid. Please submit payment as soon as possible.`
    : `Hi ${tenantName || 'there'}, this is a friendly reminder that your invoice <strong>${invoiceNumber || ''}</strong> ${when}.`;
  const link = invoiceUrl || (siteUrl ? `${siteUrl}/tenant-portal` : '');
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
    <div style="background:#1A1A2E;padding:24px 32px;">
      <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName || 'Tenant Portal'}</span>
      <span style="float:right;font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;line-height:2.2;">${tag}</span>
    </div>
    <div style="padding:28px 32px;">
      <h2 style="margin:0 0 4px;font-size:22px;font-weight:400;color:#1A1A2E;">${heading}</h2>
      <p style="font-size:14px;color:#374151;margin:0 0 20px;">${intro}</p>
      <table width="100%" style="background:#F9FAFB;border-radius:3px;padding:16px;margin-bottom:20px;" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:13px;color:#6B7280;padding-bottom:8px;">Invoice</td><td style="font-size:13px;font-weight:500;text-align:right;padding-bottom:8px;">${invoiceNumber || '—'}</td></tr>
        <tr><td style="font-size:13px;color:#6B7280;padding-bottom:8px;">Due date</td><td style="font-size:13px;text-align:right;padding-bottom:8px;">${fmtDate(dueMs)}</td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#1A1A2E;padding-top:8px;">Amount due</td><td style="font-size:20px;font-weight:700;color:${accent};text-align:right;padding-top:8px;">${amount}</td></tr>
      </table>
      ${link ? `<a href="${link}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:10px 24px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;">View invoice →</a>` : ''}
      <p style="font-size:12px;color:#9CA3AF;margin:20px 0 0;">If you have already made this payment, please disregard this reminder.</p>
    </div>
    <div style="background:#F7F4EF;padding:16px 32px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#9CA3AF;">Automated reminder from ${siteName || 'Tenant Portal'}.</p>
    </div>
  </div>`;
}

function buildSubject({ invoiceNumber, total, daysUntil, daysOverdue }) {
  const isOverdue = typeof daysOverdue === 'number';
  return isOverdue
    ? `⚠️ Overdue — Invoice ${invoiceNumber || ''} is ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue · $${Number(total || 0).toFixed(2)}`
    : `🔔 Reminder — Invoice ${invoiceNumber || ''} ${daysUntil === 0 ? 'is due today' : `due in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`} · $${Number(total || 0).toFixed(2)}`;
}

module.exports = { toUtcMidnight, fmtDate, buildEmail, buildSubject };
