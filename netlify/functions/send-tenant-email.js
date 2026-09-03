// netlify/functions/send-tenant-email.js
// Admin action: send a custom, rich-formatted, branded email to a specific
// tenant. The admin composes and previews the message in admin.html using
// a contenteditable rich-text toolbar; this endpoint sanitizes the
// resulting HTML, wraps it in the same branded shell shown in the
// client-side preview, and sends it.
//
// Enforces country scope server-side for a restricted admin (looking up
// the tenant's property and comparing its country against the caller's
// allowedCountry) rather than relying only on the admin.html UI not
// showing an out-of-scope tenant — this app's Firestore rules aren't
// visible from here to verify independently, so for a new, sensitive,
// email-sending action it's worth this one real check rather than
// trusting the client alone.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, SMTP_*

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

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Strips dangerous HTML while preserving the safe formatting tags the
// admin's contenteditable toolbar actually produces (b, i, u, a, ul, ol,
// li, br, div, p, span). Defense-in-depth: the admin composing this is
// trusted and email clients strip scripts themselves regardless, but this
// guards against pasted content bringing in unexpected markup.
function sanitizeEmailHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(iframe|object|embed|form|input|button)[\s\S]*?>/gi, '')
    .replace(/<\/(iframe|object|embed|form)>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

// Mirrors buildTenantEmailPreviewHtml() in admin.html — kept in sync
// manually since this is presentational templating, not logic that
// benefits from being shared over the network for an instant preview.
function buildEmail({ siteName, subject, bodyHtml }) {
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
    <div style="background:#1A1A2E;padding:24px 32px;"><span style="font-size:18px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${esc(siteName) || 'Tenant Portal'}</span></div>
    <div style="padding:28px 32px;">
      <p style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 6px;">Message</p>
      <p style="font-size:16px;font-weight:500;color:#1A1A2E;margin:0 0 20px;">${esc(subject)}</p>
      <div style="font-size:14px;color:#374151;line-height:1.7;">${bodyHtml}</div>
    </div>
    <div style="background:#F7F4EF;padding:16px 32px;text-align:center;"><p style="margin:0;font-size:11px;color:#9CA3AF;">This message was sent to you by ${esc(siteName) || 'your property manager'} via the tenant portal.</p></div>
  </div>`;
}

exports.handler = async (event) => {
  await require('./_lib/apply-email-config')();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!process.env.SMTP_HOST) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Email is not configured (SMTP env vars are missing).' }) };
  }

  const a = getAdmin();
  const db = a.firestore();

  const { verifyAdmin } = require('./_lib/verify-admin');
  const authResult = await verifyAdmin(event, db, a);
  if (authResult.error) return authResult.error;
  const { adminData } = authResult;

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenantId, subject, bodyHtml, siteName } = body;
  if (!tenantId || !subject || !bodyHtml) {
    return { statusCode: 400, body: JSON.stringify({ error: 'tenantId, subject, and bodyHtml are required.' }) };
  }

  try {
    const tenantRef = db.collection('tenants').doc(tenantId);
    const tenantSnap = await tenantRef.get();
    if (!tenantSnap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Tenant not found.' }) };
    const tenant = tenantSnap.data();
    if (!tenant.email) return { statusCode: 400, body: JSON.stringify({ error: 'This tenant has no email address on file.' }) };

    // Server-side country-scope enforcement for a restricted admin.
    if (adminData.role === 'restricted_admin') {
      let tenantCountry = null;
      if (tenant.propertyId) {
        try {
          const propSnap = await db.collection('properties').doc(tenant.propertyId).get();
          if (propSnap.exists) tenantCountry = propSnap.data().country || null;
        } catch {}
      }
      if (tenantCountry !== adminData.allowedCountry) {
        return { statusCode: 403, body: JSON.stringify({ error: 'This tenant is outside your assigned country scope.' }) };
      }
    }

    const cleanBodyHtml = sanitizeEmailHtml(bodyHtml);

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: parseInt(process.env.SMTP_PORT || '587') === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: tenant.email,
      subject,
      html: buildEmail({ siteName, subject, bodyHtml: cleanBodyHtml }),
    });

    await tenantRef.update({
      emailsSent: a.firestore.FieldValue.arrayUnion({
        subject, sentAt: new Date().toISOString(), sentBy: authResult.decoded.email || authResult.decoded.uid,
      }),
    });

    // Matches log-admin-action.js's collection and field shape exactly, so
    // this shows up correctly in the existing Admin Activity Audit Log UI
    // rather than silently landing in a collection nothing reads from.
    try {
      const ip = (event.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim()
        || event.headers?.['x-real-ip'] || event.requestContext?.http?.sourceIp || 'unknown';
      await db.collection('adminAuditLogs').add({
        adminUid: authResult.decoded.uid, adminEmail: authResult.decoded.email || 'unknown',
        action: 'tenant_email_sent', targetType: 'tenant', targetId: tenantId,
        targetLabel: `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim(),
        details: subject, ipAddress: ip, userAgent: event.headers?.['user-agent'] || 'unknown',
        timestamp: a.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) { console.warn('send-tenant-email: audit log failed:', e.message); }

    return { statusCode: 200, body: JSON.stringify({ success: true, sentTo: tenant.email }) };
  } catch (err) {
    console.error('send-tenant-email error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
