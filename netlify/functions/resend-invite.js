// netlify/functions/resend-invite.js
// Generates a custom-expiry invite token stored in Firestore, then emails the tenant
// a link to /api/activate-invite?token=UUID. At click time, activate-invite.js
// generates a fresh Firebase password-reset link — so the Firebase 1-hr window
// only starts when the tenant actually clicks, not when the email is sent.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, SITE_URL, SMTP_*

const crypto     = require('crypto');
const nodemailer = require('nodemailer');

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

function expiryLabel(hours) {
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = hours / 24;
  return `${days} day${days === 1 ? '' : 's'}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { inviteId, email, firstName, propertyName, unit, siteName, expiresInHours = 24 } = body;
  if (!inviteId || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'inviteId and email are required' }) };
  }

  const hours = Math.max(1, Math.min(168, parseInt(expiresInHours) || 24));

  const a  = getAdmin();
  const db = a.firestore();

  let siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
  if (!siteUrl) {
    const host  = event.headers?.host || event.headers?.['x-forwarded-host'] || '';
    const proto = event.headers?.['x-forwarded-proto'] || 'https';
    if (host) siteUrl = `${proto}://${host}`;
  }
  if (!siteUrl) {
    return { statusCode: 500, body: JSON.stringify({ error: 'SITE_URL env var not set.' }) };
  }

  try {
    // Invalidate any previous unused tokens for this invite
    const prevSnap = await db.collection('inviteTokens')
      .where('inviteId', '==', inviteId).where('used', '==', false).get();
    if (!prevSnap.empty) {
      const batch = db.batch();
      prevSnap.forEach(d => batch.update(d.ref, {
        used: true, supersededAt: a.firestore.FieldValue.serverTimestamp(),
      }));
      await batch.commit();
    }

    // Generate UUID token with custom expiry
    const token     = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    await db.collection('inviteTokens').add({
      token, inviteId, email,
      firstName: firstName || '', propertyName: propertyName || '', unit: unit || '',
      expiresInHours: hours,
      expiresAt: a.firestore.Timestamp.fromDate(expiresAt),
      used:      false,
      createdAt: a.firestore.FieldValue.serverTimestamp(),
    });

    const activationLink = `${siteUrl}/api/activate-invite?token=${token}`;
    const expiresLabel   = expiryLabel(hours);
    const expiresStr     = expiresAt.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });

    // Update invite record with new expiry info
    await db.collection('invites').doc(inviteId).update({
      sentAt: a.firestore.FieldValue.serverTimestamp(),
      status: 'pending',
      lastTokenExpiry: expiresAt.toISOString(),
    });

    if (!process.env.SMTP_HOST) {
      return { statusCode: 200, body: JSON.stringify({ success: true, activationLink, skippedEmail: true }) };
    }

    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: parseInt(process.env.SMTP_PORT || '587') === 465,
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const siteLine = siteName || 'the Tenant Portal';

    await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      email,
      subject: `🔑 Activate your account — ${siteLine} (expires in ${expiresLabel})`,
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F4EF;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EF;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
  <tr><td style="background:#1A1A2E;padding:28px 40px;">
    <span style="font-size:22px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteLine}</span>
  </td></tr>
  <tr><td style="padding:36px 40px 8px;">
    <p style="margin:0 0 14px;font-size:16px;color:#1A1A2E;">Hello ${firstName || 'there'},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4B5563;line-height:1.65;">
      Here is your activation link for${propertyName ? ` <strong>${propertyName}</strong>` : ' the tenant portal'}${unit ? `, Unit ${unit}` : ''}.
      Click the button below to set your password.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding-bottom:24px;">
      <a href="${activationLink}" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:14px 36px;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;border-radius:2px;font-weight:500;">
        Activate My Account →
      </a>
    </td></tr></table>
    <p style="margin:0 0 6px;font-size:12px;color:#9CA3AF;">Or copy this link into your browser:</p>
    <p style="margin:0 0 24px;font-size:11px;color:#9CA3AF;word-break:break-all;">${activationLink}</p>
  </td></tr>
  <tr><td style="padding:0 40px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:3px;">
      <tr><td style="padding:14px 16px;">
        <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#92400E;">⏳ This link expires in ${expiresLabel}</p>
        <p style="margin:0;font-size:12px;color:#92400E;line-height:1.65;">
          Expires: <strong>${expiresStr}</strong><br>
          If it expires, visit the portal and click <strong>"Forgot password?"</strong> to get a new link instantly.
        </p>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#F7F4EF;padding:18px 40px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#9CA3AF;">
      &copy; ${new Date().getFullYear()} ${siteLine}.
      ${siteUrl ? `<a href="${siteUrl}" style="color:#C9903A;text-decoration:none;">${siteUrl}</a>` : ''}
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, expiresInHours: hours, expiresAt: expiresAt.toISOString() }),
    };
  } catch (err) {
    console.error('resend-invite error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
