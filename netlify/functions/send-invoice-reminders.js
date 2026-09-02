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
const { toUtcMidnight, buildEmail, buildSubject } = require('./_lib/invoice-reminder-email');

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
      const subject = buildSubject({ invoiceNumber: inv.invoiceNumber, total: inv.total, daysUntil, ...(isOverdue ? { daysOverdue } : {}) });
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
