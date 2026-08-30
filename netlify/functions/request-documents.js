// netlify/functions/request-documents.js
// Admin action: ask a prospective tenant to securely upload supporting documents
// (pay stubs, ID, proof of income, etc.). Stores the request on the application,
// generates a secure token link to documents.html, and emails the applicant.
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

function buildEmail({ siteName, firstName, message, requested, formUrl }) {
  const items = (requested || []).map(d => `<li style="margin-bottom:4px;">${esc(d)}</li>`).join('');
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:580px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
    <div style="background:#1A1A2E;padding:28px 36px;">
      <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${esc(siteName) || 'Tenant Portal'}</span>
    </div>
    <div style="padding:32px 36px;">
      <h2 style="font-size:22px;font-weight:400;color:#1A1A2E;margin:0 0 8px;">A few documents to move forward</h2>
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px;">Hi ${esc(firstName) || 'there'}, ${message ? esc(message) : "we're moving your application to the next step. Please upload the following documents securely using the button below."}</p>
      ${items ? `<ul style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 20px;padding-left:20px;">${items}</ul>` : ''}
      <div style="margin-top:8px;padding-top:20px;border-top:1px solid #F3F4F6;">
        <a href="${formUrl}" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:13px 26px;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;border-radius:3px;font-weight:600;">Upload documents securely →</a>
        <p style="font-size:12px;color:#9CA3AF;margin:14px 0 0;line-height:1.6;">Your upload is encrypted in transit and stored securely. You'll be asked to confirm your consent to how these documents are used.<br><br>Or paste this link into your browser:<br><span style="color:#6B7280;word-break:break-all;">${formUrl}</span></p>
      </div>
    </div>
    <div style="background:#F7F4EF;padding:16px 36px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#9CA3AF;">This request relates to your rental application with ${esc(siteName) || 'us'}.</p>
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

  const { applicationId, requestedDocs, message, siteName } = body;
  const requested = Array.isArray(requestedDocs) ? requestedDocs.map(d => String(d).trim()).filter(Boolean).slice(0, 20) : [];
  if (!applicationId) return { statusCode: 400, body: JSON.stringify({ error: 'applicationId is required.' }) };
  if (!requested.length) return { statusCode: 400, body: JSON.stringify({ error: 'Select at least one document to request.' }) };

  const a  = getAdmin();
  const db = a.firestore();

  try {
    const ref  = db.collection('applications').doc(applicationId);
    const snap = await ref.get();
    if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Application not found.' }) };
    const app = snap.data();
    if (!app.email) return { statusCode: 400, body: JSON.stringify({ error: 'This applicant has no email address on file.' }) };

    let token = app.responseToken;
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
    }
    const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
    if (!siteUrl) return { statusCode: 400, body: JSON.stringify({ error: 'SITE_URL is not set, so a secure link cannot be generated.' }) };
    const formUrl = `${siteUrl}/documents.html?app=${encodeURIComponent(applicationId)}&token=${encodeURIComponent(token)}`;

    await ref.update({
      responseToken: token,
      docRequest: {
        requested,
        message: message ? String(message).slice(0, 1000) : null,
        requestedAt: new Date().toISOString(),
      },
      messagesSent: a.firestore.FieldValue.arrayUnion({
        subject: 'Document request',
        includeForm: true,
        docRequest: true,
        sentAt: new Date().toISOString(),
      }),
      updatedAt: a.firestore.FieldValue.serverTimestamp(),
    });

    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: parseInt(process.env.SMTP_PORT || '587') === 465,
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      app.email,
      subject: `Document request — your application${app.propertyName ? ` for ${app.propertyName}` : ''}`,
      html:    buildEmail({ siteName, firstName: app.firstName, message, requested, formUrl }),
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, sentTo: app.email, formUrl }) };
  } catch (err) {
    console.error('request-documents error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
