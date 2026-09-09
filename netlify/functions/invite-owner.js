// netlify/functions/invite-owner.js
// Invites a property owner to the read-only Owner Portal. Mirrors
// send-invite.js's proven pattern exactly (Firebase Auth account +
// Firebase's own password-reset link as the activation mechanism, so no
// custom token/expiry logic needs reinventing) — the one real difference
// is that a single owner can be linked to multiple properties over time
// (e.g. invited once, then later added as a co-owner on a second
// property), so this upserts into a linkedProperties array rather than
// overwriting the owner's doc outright.
//
// Admin-only (verify-admin.js) — this creates a real account and sends a
// real email, so it must never be reachable by anyone but an authenticated
// admin.
//
// Required env vars:
//   FIREBASE_SERVICE_ACCOUNT
//   SITE_URL (or falls back to the request's own host)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM

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

async function sendEmail({ to, subject, html }) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
}

function inviteEmailHtml({ name, propertyName, activationUrl, siteUrl, siteName }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F4EF;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EF;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
        <tr>
          <td style="background:#1A1A2E;padding:32px 40px;text-align:center;">
            <h1 style="margin:0;font-size:24px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName || 'Owner Portal'}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:40px;">
            <p style="margin:0 0 16px;font-size:16px;color:#1A1A2E;">Hello ${name},</p>
            <p style="margin:0 0 24px;font-size:15px;color:#4B5563;line-height:1.6;">
              You've been invited to the owner portal${propertyName ? ` for <strong>${propertyName}</strong>` : ''} — a private, read-only view of the property's income, expenses, and your own ownership breakdown.
              Click the button below to set your password and activate your account.
            </p>
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
            <p style="margin:0 0 16px;font-size:12px;color:#9CA3AF;word-break:break-all;">${activationUrl}</p>
            <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:3px;padding:12px 14px;margin-bottom:20px;">
              <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#92400E;">⏳ This link expires in 1 hour.</p>
              <p style="margin:0;font-size:12px;color:#92400E;line-height:1.6;">
                If it has expired by the time you click it, visit
                ${siteUrl ? `<a href="${siteUrl}/owner-portal.html" style="color:#C9903A;">${siteUrl}/owner-portal.html</a>` : 'the owner portal'}
                and click <strong>"Forgot password?"</strong> on the login screen to get a fresh link instantly.
              </p>
            </div>
            <hr style="border:none;border-top:1px solid #F3F0EB;margin:0 0 24px;">
            <p style="margin:0;font-size:12px;color:#9CA3AF;line-height:1.6;">
              If you did not expect this invitation, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#F7F4EF;padding:20px 40px;text-align:center;">
            <p style="margin:0;font-size:11px;color:#9CA3AF;">&copy; ${new Date().getFullYear()} ${siteName || 'Owner Portal'}. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

exports.handler = async (event) => {
  await require('./_lib/apply-email-config')();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const a = getAdmin();
  const db = a.firestore();

  const { verifyAdmin } = require('./_lib/verify-admin');
  const authResult = await verifyAdmin(event, db, a);
  if (authResult.error) return authResult.error;

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { email, name, propertyId, propertyName, ownerName, siteName } = body;
  if (!email || !name || !propertyId || !ownerName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email, name, propertyId, and ownerName are required' }) };
  }

  let siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
  if (!siteUrl) {
    const host = event.headers?.['x-forwarded-host'] || event.headers?.host || '';
    const proto = event.headers?.['x-forwarded-proto'] || 'https';
    if (host) siteUrl = `${proto}://${host}`;
  }
  if (!siteUrl) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not determine site URL. Please set SITE_URL in Netlify environment variables.' }) };
  }

  try {
    // ── 1. Create or find the Firebase Auth account ─────────────────────────
    let uid;
    try {
      const user = await a.auth().createUser({ email, password: crypto.randomUUID(), displayName: name });
      uid = user.uid;
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        const existing = await a.auth().getUserByEmail(email);
        uid = existing.uid;
      } else { throw err; }
    }

    // ── 2. Upsert ownerUsers doc — merge this property link rather than ─────
    // overwrite, since the same person can be linked to more than one
    // property over time. Replace any existing link for this exact
    // property (rather than appending a duplicate) so re-inviting after a
    // name change or ownership correction updates cleanly.
    const ownerRef = db.collection('ownerUsers').doc(uid);
    const existingSnap = await ownerRef.get();
    const existingLinks = existingSnap.exists ? (existingSnap.data().linkedProperties || []) : [];
    const newLinks = [
      ...existingLinks.filter(l => l.propertyId !== propertyId),
      { propertyId, propertyName: propertyName || '', ownerName },
    ];
    await ownerRef.set({
      email, name,
      status: existingSnap.exists && existingSnap.data().status === 'active' ? 'active' : 'invited',
      linkedProperties: newLinks,
      updatedAt: a.firestore.FieldValue.serverTimestamp(),
      ...(existingSnap.exists ? {} : { createdAt: a.firestore.FieldValue.serverTimestamp() }),
    }, { merge: true });

    // ── 3. Generate activation link (Firebase's own password-reset flow) ────
    const continueUrl = `${siteUrl}/owner-portal.html`;
    const activationUrl = await a.auth().generatePasswordResetLink(email, { url: continueUrl, handleCodeInApp: false });

    // ── 4. Send invitation email ──────────────────────────────────────────
    await sendEmail({
      to: email,
      subject: `You're invited to ${siteName || 'the Owner Portal'}`,
      html: inviteEmailHtml({ name, propertyName, activationUrl, siteUrl, siteName }),
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, uid }) };

  } catch (err) {
    console.error('invite-owner error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
