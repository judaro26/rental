// netlify/functions/_lib/notify-admin-on-failure.js
// Sends a short summary email to ADMIN_NOTIFY_EMAIL when a scheduled
// function's run had one or more failures — so a broken reminder, invoice,
// or retention job doesn't go unnoticed in logs nobody is actively
// watching. A no-op if there's nothing to report, no admin email is
// configured, or no email provider is available — this must never itself
// become a new source of failure, so every path here is wrapped and
// swallows its own errors rather than throwing.
//
// Usage, at the end of a scheduled function's run:
//   const { notifyAdminOnFailure } = require('./notify-admin-on-failure');
//   await notifyAdminOnFailure({ functionName: 'send-property-reminders', errorCount, sampleErrors });
// Or, from a catastrophic top-level catch:
//   await notifyAdminOnFailure({ functionName: 'send-property-reminders', fatalError: err.message });

async function notifyAdminOnFailure({ functionName, errorCount, sampleErrors, fatalError }) {
  if (!fatalError && (!errorCount || errorCount === 0)) return; // nothing to report
  if (!process.env.ADMIN_NOTIFY_EMAIL) return; // no one to notify

  try {
    await require('./apply-email-config')();
    if (!process.env.SMTP_HOST) return; // can't send without email configured

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: parseInt(process.env.SMTP_PORT || '587') === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const subject = fatalError
      ? `⚠️ ${functionName} failed to run`
      : `⚠️ ${functionName} completed with ${errorCount} error(s)`;

    const errorsList = Array.isArray(sampleErrors) ? sampleErrors : [];
    const sampleHtml = errorsList.length
      ? `<ul>${errorsList.slice(0, 5).map(m => `<li style="font-family:monospace;font-size:12px;">${String(m).slice(0, 300)}</li>`).join('')}</ul>${errorsList.length > 5 ? `<p style="font-size:12px;color:#6B7280;">+ ${errorsList.length - 5} more — check Netlify function logs for the full list.</p>` : ''}`
      : '<p style="font-size:12px;color:#6B7280;">Check Netlify function logs for details.</p>';

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.ADMIN_NOTIFY_EMAIL,
      subject,
      html: `
        <p>The scheduled function <strong>${functionName}</strong> ${fatalError ? 'did not complete' : 'ran with errors'}.</p>
        ${fatalError ? `<p style="font-family:monospace;font-size:12px;background:#FEF2F2;padding:10px;border-radius:4px;">${String(fatalError).slice(0, 500)}</p>` : ''}
        ${sampleHtml}
        <p style="font-size:12px;color:#9CA3AF;">This is an automated alert — you're receiving it because ADMIN_NOTIFY_EMAIL is configured.</p>
      `,
    });
  } catch (err) {
    // If the notification itself fails, just log it — never let a
    // notification failure cascade into anything else.
    console.error('notify-admin-on-failure: could not send notification:', err.message);
  }
}

module.exports = { notifyAdminOnFailure };
