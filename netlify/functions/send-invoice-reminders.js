// netlify/functions/send-invoice-reminders.js
// Scheduled (daily) function that emails tenants a reminder before an unpaid
// invoice's due date, based on the lead times configured by the admin in
// Settings → Automatic Invoice Reminders (settings/site.invoiceReminders).
// A copy of each reminder is sent to ADMIN_NOTIFY_EMAIL when enabled.
//
// The schedule is declared in netlify.toml ([functions."send-invoice-reminders"]).
//
// Required env vars:
//   FIREBASE_SERVICE_ACCOUNT
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   ADMIN_NOTIFY_EMAIL (optional — for admin copies)
//   SITE_URL (optional — for links)

const nodemailer = require('nodemailer');
const { notifyAdminOnFailure } = require('./_lib/notify-admin-on-failure');

let admin;
function getAdmin() {
  if (!admin) {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      });
    }
  }
  return admin;
}

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

async function runSendInvoiceReminders() {
  await require('./_lib/apply-email-config')(); // load any custom email provider override before this function's existing nodemailer code runs
  if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.SMTP_HOST) {
    console.warn('send-invoice-reminders: missing FIREBASE_SERVICE_ACCOUNT or SMTP_HOST — skipping.');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  const db = getAdmin().firestore();
  const siteSnap = await db.collection('settings').doc('site').get();
  const site = siteSnap.exists ? siteSnap.data() : {};
  const cfg = site.invoiceReminders || {};

  const leadTimes = Array.isArray(cfg.daysBefore) ? cfg.daysBefore.map(Number) : [];
  const overdueTimes = (cfg.overdueEnabled === true && Array.isArray(cfg.daysAfter)) ? cfg.daysAfter.map(Number) : [];
  const remindersActive = cfg.enabled === true && (leadTimes.length > 0 || overdueTimes.length > 0);
  // Draft auto-send: a per-invoice scheduledSendDate always applies; the global rule is opt-in.
  const autoSendDrafts = cfg.autoSendDrafts === true;
  const autoSendDaysBefore = Number(cfg.autoSendDaysBefore) || 0;

  const copyAdmin = cfg.copyAdmin !== false;
  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
  const siteName = site.siteName || 'Tenant Portal';
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

  // Today at UTC midnight
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const snap = await db.collection('invoices').get();
  let sent = 0, checked = 0, autoSent = 0;
  const errorMessages = [];

  for (const docSnap of snap.docs) {
    const inv = docSnap.data();
    if (inv.type === 'receipt') continue;
    if (inv.status === 'paid' || inv.paidDate || inv.paidAt) continue;

    // ── Draft auto-send ───────────────────────────────────────────────────
    // Send when its scheduled date has arrived (per-invoice date wins; otherwise
    // the global "N days before due" rule). Delivered via the same endpoint the
    // admin uses, so the email is identical to a manual send.
    if (inv.status === 'draft') {
      if (!inv.tenantEmail) continue;
      const dueMsDraft = toUtcMidnight(inv.dueDate);
      let sendMs = null;
      if (inv.scheduledSendDate) sendMs = toUtcMidnight(inv.scheduledSendDate);
      else if (autoSendDrafts && dueMsDraft !== null) sendMs = dueMsDraft - autoSendDaysBefore * 86400000;
      if (sendMs === null) continue;      // no schedule set for this draft
      if (todayMs < sendMs) continue;     // not time yet
      if (!siteUrl) { console.warn('send-invoice-reminders: SITE_URL not set — cannot auto-send draft', docSnap.id); continue; }
      try {
        const r = await fetch(`${siteUrl}/api/generate-invoice`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'invoice', existingInvoiceId: docSnap.id, sendNow: true,
            tenantId: inv.tenantId, tenantName: inv.tenantName, tenantEmail: inv.tenantEmail,
            unit: inv.unit || '', propertyId: inv.propertyId || '', propertyName: inv.propertyName || '',
            lineItems: inv.lineItems || [], taxRate: inv.taxRate || 0, dueDate: inv.dueDate || '', notes: inv.notes || '', siteName,
          }),
        });
        if (r.ok) { autoSent++; console.log(`send-invoice-reminders: auto-sent draft ${inv.invoiceNumber || docSnap.id}`); }
        else { console.error(`send-invoice-reminders: auto-send failed for ${inv.invoiceNumber || docSnap.id}:`, await r.text()); }
      } catch (err) { console.error(`send-invoice-reminders: auto-send error for ${docSnap.id}:`, err.message); errorMessages.push(`auto-send ${docSnap.id}: ${err.message}`); }
      continue;
    }

    // ── Reminders (for invoices already delivered to the tenant) ───────────
    if (!remindersActive) continue;
    if (!inv.tenantEmail || !inv.dueDate) continue;

    const dueMs = toUtcMidnight(inv.dueDate);
    if (dueMs === null) continue;
    checked++;

    const daysUntil = Math.round((dueMs - todayMs) / 86400000);
    const priorRems = inv.remindersSent || [];

    // Dedup on a signed key: before-due uses +threshold, overdue uses -threshold, so they never collide.
    let isOverdue = false, daysOverdue = 0, alreadyKey = daysUntil;
    if (daysUntil >= 0) {
      // Before-due: exact-day match, sent once per threshold.
      if (!leadTimes.includes(daysUntil)) continue;
      if (priorRems.some(r => Number(r.days) === daysUntil)) continue;
    } else {
      // Overdue: catch-up — send the furthest-passed threshold not yet sent, and only
      // ever escalate (never fall back to a smaller threshold once a larger one has gone out).
      isOverdue = true;
      daysOverdue = -daysUntil;
      const maxSent = priorRems.filter(r => Number(r.days) < 0)
        .reduce((m, r) => Math.max(m, -Number(r.days)), 0);
      const eligible = overdueTimes.filter(t => t <= daysOverdue && t > maxSent);
      if (!eligible.length) continue;
      alreadyKey = -Math.max(...eligible);
    }

    try {
      const html = buildEmail({
        siteName, tenantName: inv.tenantName, invoiceNumber: inv.invoiceNumber,
        total: inv.total, dueMs, invoiceUrl: inv.invoiceUrl, siteUrl,
        ...(isOverdue ? { daysOverdue } : { daysBefore: daysUntil }),
      });
      const subject = isOverdue
        ? `⚠️ Overdue — Invoice ${inv.invoiceNumber || ''} is ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue · $${Number(inv.total || 0).toFixed(2)}`
        : `🔔 Reminder — Invoice ${inv.invoiceNumber || ''} ${daysUntil === 0 ? 'is due today' : `due in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`} · $${Number(inv.total || 0).toFixed(2)}`;
      await transporter.sendMail({
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      inv.tenantEmail,
        cc:      (copyAdmin && adminEmail) ? adminEmail : undefined,
        subject,
        html,
      });
      await docSnap.ref.update({
        remindersSent: getAdmin().firestore.FieldValue.arrayUnion({
          days: alreadyKey,
          sentAt: new Date().toISOString(),
        }),
      });
      sent++;
    } catch (err) {
      console.error(`send-invoice-reminders: failed for invoice ${inv.invoiceNumber || docSnap.id}:`, err.message);
      errorMessages.push(`invoice ${inv.invoiceNumber || docSnap.id}: ${err.message}`);
    }
  }

  console.log(`send-invoice-reminders: checked ${checked} unpaid invoice(s), sent ${sent} reminder(s), auto-sent ${autoSent} draft(s).`);
  await notifyAdminOnFailure({ functionName: 'send-invoice-reminders', errorCount: errorMessages.length, sampleErrors: errorMessages });
  return { statusCode: 200, body: JSON.stringify({ success: true, checked, sent, autoSent }) };
}

exports.handler = async () => {
  try {
    return await runSendInvoiceReminders();
  } catch (err) {
    console.error('send-invoice-reminders error:', err);
    await notifyAdminOnFailure({ functionName: 'send-invoice-reminders', fatalError: err.message });
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
