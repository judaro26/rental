// netlify/functions/resend-invite.js
// Regenerates a password-reset activation link and resends the invitation email.
//
// Required env vars: same as send-invite.js

const nodemailer = require('nodemailer');

let admin;
function getAdmin() {
  if (!admin) {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(
          JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        ),
      });
    }
  }
  return admin;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { inviteId, email, firstName, propertyName, unit, siteName } = body;
  if (!inviteId || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'inviteId and email are required' }) };
  }

  const a   = getAdmin();
  const db  = a.firestore();
  const siteUrl = process.env.SITE_URL || '';

  try {
    const continueUrl   = `${siteUrl}/tenant-portal.html`;
    const activationUrl = await a.auth().generatePasswordResetLink(email, { url: continueUrl });

    // Update sentAt timestamp on the invite
    await db.collection('invites').doc(inviteId).update({
      sentAt: a.firestore.FieldValue.serverTimestamp(),
      status: 'pending',
    });

    // Send email
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: parseInt(process.env.SMTP_PORT || '587') === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const siteLine = siteName || 'the Tenant Portal';
    await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      email,
      subject: `Invitation resent — ${siteLine}`,
      html: `<div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;">
        <h2 style="color:#1A1A2E;">Hello ${firstName || 'there'},</h2>
        <p style="color:#4B5563;">Here is your updated invitation link to activate your tenant account${propertyName ? ` at <strong>${propertyName}</strong>` : ''}.</p>
        <p><a href="${activationUrl}" style="display:inline-block;background:#C9903A;color:#fff;padding:12px 28px;text-decoration:none;border-radius:2px;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;">Activate Account</a></p>
        <p style="font-size:12px;color:#9CA3AF;word-break:break-all;">${activationUrl}</p>
        <p style="font-size:12px;color:#9CA3AF;">This link expires in 24 hours.</p>
      </div>`,
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('resend-invite error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
