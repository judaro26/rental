// netlify/functions/send-invoice-reminder-now.js
// Admin-triggered, on-demand version of send-invoice-reminders.js — sends
// a single reminder or overdue notice immediately for one invoice,
// bypassing the configured lead-time schedule entirely (the admin is
// explicitly asking for this, right now, regardless of whether today
// happens to match a configured threshold).
//
// Reuses the exact same email content as the scheduled system via
// _lib/invoice-reminder-email.js, so a manually-triggered reminder looks
// identical to an automatic one to the tenant. Records the send in the
// invoice's remindersSent history (tagged manual: true) so it shows up
// alongside automatic reminders in admin.html's reminder tooltip, and so
// the scheduled function's dedup logic sees it if it happens to land on
// a day that also matches a configured threshold.
//
// Required env vars:
//   FIREBASE_SERVICE_ACCOUNT
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   ADMIN_NOTIFY_EMAIL (optional — for admin copies, same as the scheduled system)
//   SITE_URL (optional — for links)

const nodemailer = require('nodemailer');
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

exports.handler = async (event) => {
  await require('./_lib/apply-email-config')(); // load any custom email provider override before this function's existing nodemailer code runs
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.SMTP_HOST) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Email is not configured on this deployment.' }) };
  }

  const a = getAdmin();
  const db = a.firestore();

  const { verifyAdmin } = require('./_lib/verify-admin');
  const authResult = await verifyAdmin(event, db, a);
  if (authResult.error) return authResult.error;

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { invoiceId } = body;
  if (!invoiceId) return { statusCode: 400, body: JSON.stringify({ error: 'invoiceId is required' }) };

  const invRef = db.collection('invoices').doc(invoiceId);
  const invSnap = await invRef.get();
  if (!invSnap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Invoice not found.' }) };
  const inv = invSnap.data();

  if (inv.type === 'receipt') return { statusCode: 400, body: JSON.stringify({ error: 'Receipts don\'t have reminders — only invoices do.' }) };
  if (inv.status === 'paid' || inv.paidDate || inv.paidAt) return { statusCode: 400, body: JSON.stringify({ error: 'This invoice is already marked paid.' }) };
  if (inv.status === 'draft') return { statusCode: 400, body: JSON.stringify({ error: 'This invoice is still a draft — send it first before reminding about it.' }) };
  if (!inv.tenantEmail) return { statusCode: 400, body: JSON.stringify({ error: 'This invoice has no tenant email on file.' }) };
  if (!inv.dueDate) return { statusCode: 400, body: JSON.stringify({ error: 'This invoice has no due date set.' }) };

  const dueMs = toUtcMidnight(inv.dueDate);
  if (dueMs === null) return { statusCode: 400, body: JSON.stringify({ error: 'This invoice\'s due date could not be parsed.' }) };

  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysUntil = Math.round((dueMs - todayMs) / 86400000);
  const isOverdue = daysUntil < 0;
  const daysOverdue = isOverdue ? -daysUntil : 0;

  const siteSnap = await db.collection('settings').doc('site').get();
  const site = siteSnap.exists ? siteSnap.data() : {};
  const cfg = site.invoiceReminders || {};
  const copyAdmin = cfg.copyAdmin !== false;
  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
  const siteName = site.siteName || 'Tenant Portal';
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  try {
    const html = buildEmail({
      siteName, tenantName: inv.tenantName, invoiceNumber: inv.invoiceNumber,
      total: inv.total, dueMs, invoiceUrl: inv.invoiceUrl, siteUrl,
      ...(isOverdue ? { daysOverdue } : { daysBefore: daysUntil }),
    });
    const subject = buildSubject({ invoiceNumber: inv.invoiceNumber, total: inv.total, daysUntil, ...(isOverdue ? { daysOverdue } : {}) });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: inv.tenantEmail,
      cc: (copyAdmin && adminEmail) ? adminEmail : undefined,
      subject,
      html,
    });
    // Signed key matches the scheduled system's dedup convention (+before-due, -overdue),
    // so if this manual send happens to land on a day the schedule would also fire, that
    // specific threshold is correctly treated as already sent rather than duplicated later today.
    await invRef.update({
      remindersSent: a.firestore.FieldValue.arrayUnion({
        days: isOverdue ? -daysOverdue : daysUntil,
        sentAt: new Date().toISOString(),
        manual: true,
      }),
    });
    return { statusCode: 200, body: JSON.stringify({ success: true, isOverdue, daysUntil, daysOverdue, sentTo: inv.tenantEmail }) };
  } catch (err) {
    console.error('send-invoice-reminder-now error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
