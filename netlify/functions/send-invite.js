// netlify/functions/send-invite.js
// Creates a Firebase Auth account for a new tenant, generates a password-reset
// (activation) link, sends a branded invitation email via SMTP, and logs the
// invite to Firestore.
//
// Required Netlify env vars:
//   FIREBASE_SERVICE_ACCOUNT   — JSON string of Firebase service account key
//   SITE_URL                   — https://your-site.netlify.app (no trailing slash)
//   SMTP_HOST                  — e.g. smtp.gmail.com
//   SMTP_PORT                  — 587 (TLS) or 465 (SSL)
//   SMTP_USER                  — your sending email address
//   SMTP_PASS                  — app password / SMTP password
//   SMTP_FROM                  — "My Properties <noreply@yourcompany.com>"

const crypto = require('crypto');

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

async function sendEmail({ to, subject, html }) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  await transporter.sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
  });
}

function inviteEmailHtml({ firstName, propertyName, unit, activationUrl, siteUrl, siteName }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F4EF;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EF;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:#1A1A2E;padding:32px 40px;text-align:center;">
            <h1 style="margin:0;font-size:24px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName || 'Tenant Portal'}</h1>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:40px;">
            <p style="margin:0 0 16px;font-size:16px;color:#1A1A2E;">Hello ${firstName},</p>
            <p style="margin:0 0 24px;font-size:15px;color:#4B5563;line-height:1.6;">
              You've been invited to the tenant portal${propertyName ? ` for <strong>${propertyName}</strong>` : ''}${unit ? `, Unit ${unit}` : ''}.
              Click the button below to set your password and activate your account.
            </p>
            <!-- CTA -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding:8px 0 32px;">
                  <a href="${activationUrl}"
                    style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:14px 36px;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;border-radius:2px;font-weight:500;">
                    Activate My Account
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px;font-size:13px;color:#6B7280;">If the button doesn't work, copy and paste this link into your browser:</p>
            <p style="margin:0 0 24px;font-size:12px;color:#9CA3AF;word-break:break-all;">${activationUrl}</p>
            <hr style="border:none;border-top:1px solid #F3F0EB;margin:0 0 24px;">
            <p style="margin:0;font-size:12px;color:#9CA3AF;line-height:1.6;">
              This invitation link expires in 24 hours. If you did not expect this invitation, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#F7F4EF;padding:20px 40px;text-align:center;">
            <p style="margin:0;font-size:11px;color:#9CA3AF;">&copy; ${new Date().getFullYear()} ${siteName || 'Tenant Portal'}. All rights reserved.</p>
            ${siteUrl ? `<p style="margin:4px 0 0;font-size:11px;"><a href="${siteUrl}" style="color:#C9903A;text-decoration:none;">${siteUrl}</a></p>` : ''}
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { email, firstName, lastName, propertyId, propertyName, unit, monthlyRent, siteName } = body;
  if (!email || !firstName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email and firstName are required' }) };
  }

  const a   = getAdmin();
  const db  = a.firestore();
  const siteUrl = process.env.SITE_URL || '';

  try {
    // ── 1. Create Firebase Auth user (random password — they'll reset it) ───
    let uid;
    try {
      const user = await a.auth().createUser({
        email,
        password:    crypto.randomUUID(),
        displayName: `${firstName} ${lastName || ''}`.trim(),
      });
      uid = user.uid;
    } catch (err) {
      // If user already exists, fetch their UID and re-send
      if (err.code === 'auth/email-already-exists') {
        const existing = await a.auth().getUserByEmail(email);
        uid = existing.uid;
      } else { throw err; }
    }

    // ── 2. Create / update tenant Firestore doc ─────────────────────────────
    await db.collection('tenants').doc(uid).set({
      firstName, lastName: lastName || '', email,
      propertyId: propertyId || null,
      propertyName: propertyName || '',
      unit: unit || '',
      monthlyRent: parseFloat(monthlyRent) || 0,
      status: 'invited',
      createdAt: a.firestore.FieldValue.serverTimestamp(),
      updatedAt: a.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // ── 3. Generate activation link (Firebase password-reset flow) ──────────
    const continueUrl = `${siteUrl}/tenant-portal.html`;
    const activationUrl = await a.auth().generatePasswordResetLink(email, { url: continueUrl });

    // ── 4. Log invite to Firestore ──────────────────────────────────────────
    const inviteRef = await db.collection('invites').add({
      uid, email, firstName, lastName: lastName || '',
      propertyId: propertyId || null, propertyName: propertyName || '',
      unit: unit || '',
      status: 'pending',
      sentAt: a.firestore.FieldValue.serverTimestamp(),
      activatedAt: null,
    });

    // ── 5. Send invitation email ────────────────────────────────────────────
    await sendEmail({
      to:      email,
      subject: `You're invited to ${siteName || 'the Tenant Portal'}`,
      html:    inviteEmailHtml({ firstName, propertyName, unit, activationUrl, siteUrl, siteName }),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, uid, inviteId: inviteRef.id }),
    };

  } catch (err) {
    console.error('send-invite error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'Internal server error' }),
    };
  }
};
