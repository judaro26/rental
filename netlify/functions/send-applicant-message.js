// netlify/functions/send-applicant-message.js
// Admin action: send a message to a prospective tenant who has applied.
// Optionally includes a secure link to a form where the applicant can update
// their application details (residents, ages, desired move-in, references).
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, SMTP_*, SITE_URL

const nodemailer = require('nodemailer');
const crypto = require('crypto');

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

function buildEmail({ siteName, bodyHtml, formUrl }) {
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:580px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
    <div style="background:#1A1A2E;padding:28px 36px;">
      <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${esc(siteName) || 'Tenant Portal'}</span>
    </div>
    <div style="padding:32px 36px;">
      <div style="font-size:14px;color:#374151;line-height:1.7;">${bodyHtml}</div>
      ${formUrl ? `<div style="margin-top:26px;padding-top:22px;border-top:1px solid #F3F4F6;">
        <a href="${formUrl}" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:13px 26px;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;border-radius:3px;font-weight:600;">Confirm my details →</a>
        <p style="font-size:12px;color:#9CA3AF;margin:14px 0 0;line-height:1.6;">Or paste this secure link into your browser:<br><span style="color:#6B7280;word-break:break-all;">${formUrl}</span></p>
      </div>` : ''}
    </div>
    <div style="background:#F7F4EF;padding:16px 36px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#9CA3AF;">This message was sent regarding your rental application with ${esc(siteName) || 'us'}.</p>
    </div>
  </div>`;
}

exports.handler = async (event) => {
  await require('./_lib/apply-email-config')(); // load any custom email provider override before this function's existing nodemailer code runs
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!process.env.SMTP_HOST) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Email is not configured (SMTP env vars are missing).' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { applicationId, subject, body: messageBody, includeForm, siteName } = body;
  if (!applicationId || !subject || !messageBody) {
    return { statusCode: 400, body: JSON.stringify({ error: 'applicationId, subject, and message body are required.' }) };
  }

  const a  = getAdmin();
  const db = a.firestore();

  // Admin-only: same issue as request-documents.js — no auth check, and
  // when includeForm is set, the response leaks a valid responseToken via
  // formUrl to whoever called this, not just to the real applicant via
  // email.
  const { verifyAdmin } = require('./_lib/verify-admin');
  const authResult = await verifyAdmin(event, db, a);
  if (authResult.error) return authResult.error;

  try {
    const ref  = db.collection('applications').doc(applicationId);
    const snap = await ref.get();
    if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Application not found.' }) };
    const app = snap.data();
    if (!app.email) return { statusCode: 400, body: JSON.stringify({ error: 'This applicant has no email address on file.' }) };

    // Build the secure response-form link if requested.
    let formUrl = '';
    if (includeForm) {
      let token = app.responseToken;
      if (!token) {
        token = crypto.randomBytes(24).toString('hex');
        await ref.update({ responseToken: token });
      }
      const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
      if (!siteUrl) return { statusCode: 400, body: JSON.stringify({ error: 'SITE_URL is not set, so a form link cannot be generated.' }) };
      formUrl = `${siteUrl}/respond.html?app=${encodeURIComponent(applicationId)}&token=${encodeURIComponent(token)}`;
    }

    const bodyHtml = esc(messageBody).replace(/\n/g, '<br>');

    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: parseInt(process.env.SMTP_PORT || '587') === 465,
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      app.email,
      subject: subject,
      html:    buildEmail({ siteName, bodyHtml, formUrl }),
    });

    await ref.update({
      messagesSent: a.firestore.FieldValue.arrayUnion({
        subject,
        includeForm: !!includeForm,
        sentAt: new Date().toISOString(),
      }),
      updatedAt: a.firestore.FieldValue.serverTimestamp(),
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, sentTo: app.email, formUrl }) };
  } catch (err) {
    console.error('send-applicant-message error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
