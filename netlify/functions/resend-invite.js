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
  // Derive site URL from env var or fall back to request headers
  let siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
  if (!siteUrl) {
    const host  = event.headers?.host || event.headers?.['x-forwarded-host'] || '';
    const proto = event.headers?.['x-forwarded-proto'] || 'https';
    if (host) siteUrl = `${proto}://${host}`;
  }
  if (!siteUrl) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not determine site URL. Please set SITE_URL in Netlify environment variables.' }) };
  }

  try {
    const continueUrl   = `${siteUrl}/tenant-portal.html`;
    const activationUrl = await a.auth().generatePasswordResetLink(email, { url: continueUrl, handleCodeInApp: false });

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
      subject: `🔑 New activation link — ${siteLine} (click within 1 hour)`,
      html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
        <div style="background:#1A1A2E;padding:24px 32px;">
          <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteLine}</span>
        </div>
        <div style="padding:28px 32px;">
          <h2 style="margin:0 0 12px;font-size:20px;font-weight:400;color:#1A1A2E;">Hello ${firstName || 'there'},</h2>
          <p style="color:#4B5563;font-size:14px;line-height:1.6;margin:0 0 20px;">
            Here is a fresh activation link for your tenant account${propertyName ? ` at <strong>${propertyName}</strong>` : ''}.
            Click the button below to set your password and access the portal.
          </p>
          <p style="margin:0 0 16px;">
            <a href="${activationUrl}" style="display:inline-block;background:#C9903A;color:#fff;padding:13px 28px;text-decoration:none;border-radius:2px;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;">
              Set My Password →
            </a>
          </p>
          <p style="font-size:11px;color:#9CA3AF;word-break:break-all;margin:0 0 20px;">${activationUrl}</p>

          <!-- Expiry warning -->
          <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:3px;padding:12px 14px;margin-bottom:16px;">
            <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#92400E;">⏳ This link expires in 1 hour.</p>
            <p style="margin:0;font-size:12px;color:#92400E;line-height:1.6;">
              If the link has expired by the time you click it, visit the portal and use
              <strong>"Forgot password?"</strong> on the login screen to instantly generate
              a new link without needing to contact your property manager.
            </p>
          </div>
          <p style="font-size:12px;color:#9CA3AF;margin:0;line-height:1.6;">
            After setting your password, you will be redirected to the portal automatically.
            If not, visit <a href="${siteUrl||'#'}" style="color:#C9903A;">${siteUrl || 'the portal'}</a> and sign in with your email and new password.
          </p>
        </div>
        <div style="background:#F7F4EF;padding:16px 32px;text-align:center;">
          <p style="margin:0;font-size:11px;color:#9CA3AF;">&copy; ${new Date().getFullYear()} ${siteLine}. All rights reserved.</p>
        </div>
      </div>`,
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('resend-invite error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
