// netlify/functions/purge-summary-report.js
// Scheduled (monthly) compliance report. Summarizes what the retention sweep
// purged/deleted during the PREVIOUS calendar month and emails it to the admin
// so there is a durable record of data-minimization activity.
//
// Reads from applicationAuditLog (actions: documents_purged_retention,
// application_deleted_retention). Sends even when nothing happened (a "0 items"
// record is itself useful for compliance).
//
// Schedule is declared in netlify.toml ([functions."purge-summary-report"]).
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, SMTP_*, ADMIN_NOTIFY_EMAIL

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

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

exports.handler = async () => {
  await require('./_lib/apply-email-config')(); // load any custom email provider override before this function's existing nodemailer code runs
  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.SMTP_HOST || !adminEmail) {
    console.warn('purge-summary-report: missing FIREBASE_SERVICE_ACCOUNT / SMTP_HOST / ADMIN_NOTIFY_EMAIL — skipping.');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  const a  = getAdmin();
  const db = a.firestore();

  // Previous calendar month window (UTC).
  const now = new Date();
  const firstThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const firstPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodLabel = firstPrev.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });

  try {
    const Timestamp = a.firestore.Timestamp;
    const snap = await db.collection('applicationAuditLog')
      .where('timestamp', '>=', Timestamp.fromDate(firstPrev))
      .where('timestamp', '<', Timestamp.fromDate(firstThis))
      .get();

    const purged = [], deleted = [];
    snap.forEach(d => {
      const r = d.data();
      if (r.action === 'documents_purged_retention') purged.push(r);
      else if (r.action === 'application_deleted_retention') deleted.push(r);
    });

    const purgedFiles = purged.reduce((s, r) => s + (Number(r.purgedCount) || 0), 0);
    const deletedFiles = deleted.reduce((s, r) => s + (Number(r.deletedFiles) || 0), 0);

    let siteName = 'Tenant Portal';
    try { const s = await db.collection('settings').doc('site').get(); if (s.exists) siteName = s.data().siteName || siteName; } catch {}
    const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

    const rows = (arr, kind) => arr.length
      ? arr.map(r => {
          const when = r.timestamp?.toDate ? r.timestamp.toDate().toLocaleDateString('en-US', { timeZone: 'UTC' }) : '';
          const count = kind === 'purged' ? (r.purgedCount || 0) : (r.deletedFiles || 0);
          return `<tr>
            <td style="padding:6px 10px;border:1px solid #E5E7EB;font-size:12px;">${esc(when)}</td>
            <td style="padding:6px 10px;border:1px solid #E5E7EB;font-size:12px;">${esc(r.shortId || r.applicationId || '—')}</td>
            <td style="padding:6px 10px;border:1px solid #E5E7EB;font-size:12px;">${esc(r.applicantEmail || '—')}</td>
            <td style="padding:6px 10px;border:1px solid #E5E7EB;font-size:12px;">${esc(r.reason || '—')}</td>
            <td style="padding:6px 10px;border:1px solid #E5E7EB;font-size:12px;text-align:right;">${count}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="5" style="padding:8px 10px;border:1px solid #E5E7EB;font-size:12px;color:#9CA3AF;">None</td></tr>`;

    const table = (title, arr, kind) => `
      <h3 style="font-size:14px;color:#1A1A2E;margin:20px 0 6px;">${title}</h3>
      <table style="border-collapse:collapse;width:100%;">
        <tr>
          <th style="padding:6px 10px;border:1px solid #E5E7EB;font-size:11px;text-align:left;background:#F9FAFB;">Date</th>
          <th style="padding:6px 10px;border:1px solid #E5E7EB;font-size:11px;text-align:left;background:#F9FAFB;">App</th>
          <th style="padding:6px 10px;border:1px solid #E5E7EB;font-size:11px;text-align:left;background:#F9FAFB;">Applicant</th>
          <th style="padding:6px 10px;border:1px solid #E5E7EB;font-size:11px;text-align:left;background:#F9FAFB;">Reason</th>
          <th style="padding:6px 10px;border:1px solid #E5E7EB;font-size:11px;text-align:right;background:#F9FAFB;">Files</th>
        </tr>
        ${rows(arr, kind)}
      </table>`;

    const html = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:640px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
      <div style="background:#1A1A2E;padding:24px 32px;">
        <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${esc(siteName)}</span>
        <span style="float:right;font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;line-height:2.2;">🗂 Retention Report</span>
      </div>
      <div style="padding:28px 32px;">
        <h2 style="font-size:22px;font-weight:400;color:#1A1A2E;margin:0 0 4px;">Data retention summary</h2>
        <p style="font-size:13px;color:#9CA3AF;margin:0 0 18px;">Period: ${esc(periodLabel)}</p>
        <table width="100%" style="background:#F9FAFB;border-radius:3px;padding:16px;margin-bottom:8px;" cellpadding="0" cellspacing="0">
          <tr><td style="font-size:13px;color:#6B7280;padding:4px 0;">Applications with documents purged</td><td style="font-size:14px;font-weight:600;text-align:right;">${purged.length} (${purgedFiles} files)</td></tr>
          <tr><td style="font-size:13px;color:#6B7280;padding:4px 0;">Applications fully deleted</td><td style="font-size:14px;font-weight:600;text-align:right;">${deleted.length} (${deletedFiles} files)</td></tr>
        </table>
        ${table('Documents purged (files removed, record kept)', purged, 'purged')}
        ${table('Applications fully deleted (record removed)', deleted, 'deleted')}
        ${siteUrl ? `<a href="${siteUrl}/admin" style="display:inline-block;margin-top:22px;background:#C9903A;color:#fff;text-decoration:none;padding:10px 24px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;">Open Admin →</a>` : ''}
      </div>
      <div style="background:#F7F4EF;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#9CA3AF;">Automated compliance record — retention sweep for ${esc(siteName)}. Keep for your records.</p>
      </div>
    </div>`;

    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: parseInt(process.env.SMTP_PORT || '587') === 465,
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      adminEmail,
      subject: `🗂 Data retention report — ${periodLabel} (${purged.length} purged, ${deleted.length} deleted)`,
      html,
    });

    console.log(`purge-summary-report: ${periodLabel} — ${purged.length} purged, ${deleted.length} deleted. Emailed ${adminEmail}.`);
    return { statusCode: 200, body: JSON.stringify({ success: true, period: periodLabel, purged: purged.length, deleted: deleted.length }) };
  } catch (err) {
    console.error('purge-summary-report error:', err);
    await notifyAdminOnFailure({ functionName: 'purge-summary-report', fatalError: err.message });
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
