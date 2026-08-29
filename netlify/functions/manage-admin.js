// netlify/functions/manage-admin.js
// Single endpoint for the full admin-account lifecycle: invite, resend invite,
// update role/country scope, revoke, and reactivate.
//
// Every action requires a valid Firebase ID token (Authorization: Bearer <token>)
// belonging to an existing Super Admin. This is the ONLY place role/allowedCountry
// on an `admins/{uid}` doc can be written — Firestore rules block direct client
// writes to those fields, so this server-side check is the real security boundary,
// not just the admin.html UI.
//
// POST /api/manage-admin
// Body: { action: 'invite'|'resend'|'update'|'revoke'|'reactivate', ... }
//
// Required Netlify env vars (all already used by the tenant invite flow):
//   FIREBASE_SERVICE_ACCOUNT, SITE_URL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM

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
  if (!process.env.SMTP_HOST) return { skippedEmail: true };
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
  return { skippedEmail: false };
}

function countryLabel(code) {
  return code === 'CO' ? 'Colombia' : code === 'US' ? 'United States' : 'All Countries';
}

function inviteEmailHtml({ displayName, role, allowedCountry, activationUrl, siteUrl, siteName, expiresLabel }) {
  const scopeLine = role === 'super_admin'
    ? 'You will have full access to all properties, in every country.'
    : `Your access will be scoped to <strong>${countryLabel(allowedCountry)}</strong> properties only.`;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F4EF;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EF;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
  <tr><td style="background:#1A1A2E;padding:32px 40px;text-align:center;">
    <h1 style="margin:0;font-size:24px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName || 'Admin Portal'}</h1>
  </td></tr>
  <tr><td style="padding:40px;">
    <p style="margin:0 0 16px;font-size:16px;color:#1A1A2E;">Hello ${displayName || 'there'},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#4B5563;line-height:1.6;">
      You've been invited as an administrator on ${siteName || 'the portal'}. ${scopeLine}
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#4B5563;line-height:1.6;">
      Click below to set your password and access the admin dashboard.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:8px 0 32px;">
      <a href="${activationUrl}" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:14px 36px;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;border-radius:2px;font-weight:500;">
        Activate Admin Account
      </a>
    </td></tr></table>
    <p style="margin:0 0 8px;font-size:13px;color:#6B7280;">If the button doesn't work, copy and paste this link:</p>
    <p style="margin:0 0 16px;font-size:12px;color:#9CA3AF;word-break:break-all;">${activationUrl}</p>
    <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:3px;padding:12px 14px;margin-bottom:20px;">
      <p style="margin:0;font-size:12px;color:#92400E;">⏳ This link expires in ${expiresLabel}.</p>
    </div>
    <hr style="border:none;border-top:1px solid #F3F0EB;margin:0 0 24px;">
    <p style="margin:0;font-size:12px;color:#9CA3AF;line-height:1.6;">If you did not expect this invitation, you can safely ignore this email.</p>
  </td></tr>
  <tr><td style="background:#F7F4EF;padding:20px 40px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#9CA3AF;">&copy; ${new Date().getFullYear()} ${siteName || 'Admin Portal'}.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function expiryLabel(hours) {
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = hours / 24;
  return `${days} day${days === 1 ? '' : 's'}`;
}

function getSiteUrl(event) {
  let siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
  if (!siteUrl) {
    const host = event.headers?.host || event.headers?.['x-forwarded-host'] || '';
    const proto = event.headers?.['x-forwarded-proto'] || 'https';
    if (host) siteUrl = `${proto}://${host}`;
  }
  return siteUrl;
}

// ── Auth guard: caller must hold a valid ID token for an existing, active Super Admin ──
async function requireSuperAdmin(event, a, db) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) {
    const err = new Error('Missing Authorization bearer token.');
    err.statusCode = 401;
    throw err;
  }
  let decoded;
  try {
    decoded = await a.auth().verifyIdToken(match[1]);
  } catch {
    const err = new Error('Invalid or expired session. Please sign in again.');
    err.statusCode = 401;
    throw err;
  }
  const ref = db.collection('admins').doc(decoded.uid);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error('Caller is not an admin.');
    err.statusCode = 403;
    throw err;
  }
  const data = snap.data();
  if (data.status === 'revoked') {
    const err = new Error('Your admin access has been revoked.');
    err.statusCode = 403;
    throw err;
  }
  // Legacy admin docs created before roles existed have no `role` field.
  // Treat them as Super Admin (this preserves — does not expand — their
  // existing unrestricted access) and backfill the field for clarity.
  if (!data.role) {
    await ref.update({ role: 'super_admin', allowedCountry: null });
  } else if (data.role !== 'super_admin') {
    const err = new Error('Only Super Admins can manage admin accounts.');
    err.statusCode = 403;
    throw err;
  }
  return { uid: decoded.uid, email: data.email || decoded.email || '' };
}

async function countOtherActiveSuperAdmins(db, excludeUid) {
  const snap = await db.collection('admins').where('role', '==', 'super_admin').get();
  return snap.docs.filter(d => d.id !== excludeUid && d.data().status !== 'revoked').length;
}

function validateRoleAndCountry(role, allowedCountry) {
  if (!['super_admin', 'restricted_admin'].includes(role)) {
    throw Object.assign(new Error('role must be "super_admin" or "restricted_admin".'), { statusCode: 400 });
  }
  if (role === 'restricted_admin' && !['US', 'CO'].includes(allowedCountry)) {
    throw Object.assign(new Error('allowedCountry must be "US" or "CO" for a restricted_admin.'), { statusCode: 400 });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const a = getAdmin();
  const db = a.firestore();
  const siteUrl = getSiteUrl(event);

  let caller;
  try {
    caller = await requireSuperAdmin(event, a, db);
  } catch (err) {
    return { statusCode: err.statusCode || 403, body: JSON.stringify({ error: err.message }) };
  }

  const { action } = body;

  try {
    // ── INVITE (new admin) ──────────────────────────────────────────────────
    if (action === 'invite') {
      const { email, displayName, role, allowedCountry, expiresInHours = 24, siteName } = body;
      if (!email) return { statusCode: 400, body: JSON.stringify({ error: 'email is required' }) };
      validateRoleAndCountry(role, allowedCountry);
      if (!siteUrl) return { statusCode: 500, body: JSON.stringify({ error: 'SITE_URL not configured.' }) };

      let uid;
      try {
        const user = await a.auth().createUser({ email, password: crypto.randomUUID(), displayName: displayName || '' });
        uid = user.uid;
      } catch (err) {
        if (err.code === 'auth/email-already-exists') {
          uid = (await a.auth().getUserByEmail(email)).uid;
        } else { throw err; }
      }

      const existing = await db.collection('admins').doc(uid).get();
      const finalCountry = role === 'restricted_admin' ? allowedCountry : null;
      await db.collection('admins').doc(uid).set({
        email, displayName: displayName || '',
        role, allowedCountry: finalCountry,
        status: 'invited',
        invitedBy: caller.email,
        invitedAt: a.firestore.FieldValue.serverTimestamp(),
        createdAt: existing.exists ? existing.data().createdAt : a.firestore.FieldValue.serverTimestamp(),
        updatedAt: a.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      const hours = Math.max(1, Math.min(168, parseInt(expiresInHours) || 24));
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
      await db.collection('adminInviteTokens').add({
        token, uid, email, role, allowedCountry: finalCountry,
        expiresAt: a.firestore.Timestamp.fromDate(expiresAt),
        used: false,
        createdAt: a.firestore.FieldValue.serverTimestamp(),
      });

      const activationUrl = `${siteUrl}/api/activate-admin-invite?token=${token}`;
      const emailResult = await sendEmail({
        to: email,
        subject: `You're invited to administer ${siteName || 'the portal'}`,
        html: inviteEmailHtml({ displayName, role, allowedCountry: finalCountry, activationUrl, siteUrl, siteName, expiresLabel: expiryLabel(hours) }),
      });

      return { statusCode: 200, body: JSON.stringify({ success: true, uid, activationUrl, skippedEmail: emailResult.skippedEmail }) };
    }

    // ── RESEND (fresh token + email for an existing invited/active admin) ──
    if (action === 'resend') {
      const { uid, expiresInHours = 24, siteName } = body;
      if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'uid is required' }) };
      const snap = await db.collection('admins').doc(uid).get();
      if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Admin not found.' }) };
      const data = snap.data();
      if (!siteUrl) return { statusCode: 500, body: JSON.stringify({ error: 'SITE_URL not configured.' }) };

      const prevSnap = await db.collection('adminInviteTokens').where('uid', '==', uid).where('used', '==', false).get();
      if (!prevSnap.empty) {
        const batch = db.batch();
        prevSnap.forEach(d => batch.update(d.ref, { used: true }));
        await batch.commit();
      }

      const hours = Math.max(1, Math.min(168, parseInt(expiresInHours) || 24));
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
      await db.collection('adminInviteTokens').add({
        token, uid, email: data.email, role: data.role, allowedCountry: data.allowedCountry || null,
        expiresAt: a.firestore.Timestamp.fromDate(expiresAt),
        used: false,
        createdAt: a.firestore.FieldValue.serverTimestamp(),
      });

      const activationUrl = `${siteUrl}/api/activate-admin-invite?token=${token}`;
      const emailResult = await sendEmail({
        to: data.email,
        subject: `Your admin activation link — ${siteName || 'the portal'}`,
        html: inviteEmailHtml({ displayName: data.displayName, role: data.role, allowedCountry: data.allowedCountry, activationUrl, siteUrl, siteName, expiresLabel: expiryLabel(hours) }),
      });

      return { statusCode: 200, body: JSON.stringify({ success: true, activationUrl, skippedEmail: emailResult.skippedEmail }) };
    }

    // ── UPDATE (change role / country scope) ─────────────────────────────────
    if (action === 'update') {
      const { uid, role, allowedCountry } = body;
      if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'uid is required' }) };
      validateRoleAndCountry(role, allowedCountry);

      if (uid === caller.uid && role !== 'super_admin') {
        return { statusCode: 400, body: JSON.stringify({ error: 'You cannot change your own role away from Super Admin.' }) };
      }
      const snap = await db.collection('admins').doc(uid).get();
      if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Admin not found.' }) };
      if (snap.data().role === 'super_admin' && role !== 'super_admin') {
        const others = await countOtherActiveSuperAdmins(db, uid);
        if (others < 1) {
          return { statusCode: 400, body: JSON.stringify({ error: 'Cannot demote the only Super Admin. Promote another admin first.' }) };
        }
      }
      await snap.ref.update({
        role,
        allowedCountry: role === 'restricted_admin' ? allowedCountry : null,
        updatedAt: a.firestore.FieldValue.serverTimestamp(),
        updatedBy: caller.email,
      });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // ── REVOKE (disable Auth account + mark doc revoked) ────────────────────
    if (action === 'revoke') {
      const { uid } = body;
      if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'uid is required' }) };
      if (uid === caller.uid) {
        return { statusCode: 400, body: JSON.stringify({ error: 'You cannot revoke your own access. Ask another Super Admin.' }) };
      }
      const snap = await db.collection('admins').doc(uid).get();
      if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Admin not found.' }) };
      if (snap.data().role === 'super_admin') {
        const others = await countOtherActiveSuperAdmins(db, uid);
        if (others < 1) {
          return { statusCode: 400, body: JSON.stringify({ error: 'Cannot revoke the only Super Admin.' }) };
        }
      }
      await a.auth().updateUser(uid, { disabled: true }).catch(() => {});
      await snap.ref.update({ status: 'revoked', revokedAt: a.firestore.FieldValue.serverTimestamp(), revokedBy: caller.email });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // ── REACTIVATE ───────────────────────────────────────────────────────────
    if (action === 'reactivate') {
      const { uid } = body;
      if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'uid is required' }) };
      const snap = await db.collection('admins').doc(uid).get();
      if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Admin not found.' }) };
      await a.auth().updateUser(uid, { disabled: false }).catch(() => {});
      await snap.ref.update({ status: 'active', reactivatedAt: a.firestore.FieldValue.serverTimestamp(), reactivatedBy: caller.email });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error('manage-admin error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
