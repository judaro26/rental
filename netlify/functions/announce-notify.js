// netlify/functions/announce-notify.js
// Sends announcement emails to all active tenants (or only those in a specific property).
// Called by the admin panel after posting an announcement.
//
// Required env vars:
//   FIREBASE_SERVICE_ACCOUNT
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM

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

function getTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function buildAnnouncementEmail({ tenantName, title, message, propertyName, siteName, siteUrl, urgent }) {
  const headerColor = urgent ? '#DC2626' : '#1A1A2E';
  const accentColor = urgent ? '#DC2626' : '#C9903A';
  const eyebrow = urgent ? '🚨 Urgent Notice' : '📢 Announcement';
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);${urgent ? 'border:2px solid #DC2626;' : ''}">
    <div style="background:${headerColor};padding:24px 32px;">
      <table width="100%"><tr>
        <td><span style="font-size:20px;font-weight:300;color:${urgent ? '#fff' : '#E8D5B0'};letter-spacing:0.06em;">${siteName||'Tenant Portal'}</span></td>
        <td align="right"><span style="font-size:11px;color:rgba(255,255,255,0.85);letter-spacing:0.08em;text-transform:uppercase;font-weight:${urgent?'700':'400'};">${eyebrow}</span></td>
      </tr></table>
    </div>
    <div style="padding:28px 32px;">
      <p style="font-size:14px;color:#6B7280;margin:0 0 16px;">Hello ${tenantName||'Resident'},</p>
      <h2 style="margin:0 0 12px;font-size:22px;font-weight:500;color:#1A1A2E;">${title}</h2>
      <div style="font-size:14px;color:#374151;line-height:1.7;white-space:pre-wrap;background:#F9FAFB;border-radius:3px;padding:16px;border-left:3px solid ${accentColor};">${message}</div>
      ${propertyName ? `<p style="font-size:12px;color:#9CA3AF;margin:16px 0 0;">This announcement applies to: <strong>${propertyName}</strong></p>` : ''}
    </div>
    <div style="background:#F7F4EF;padding:16px 32px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#9CA3AF;">This is an automated announcement from ${siteName||'your property manager'}.${siteUrl ? ` Visit <a href="${siteUrl}" style="color:${accentColor};">${siteUrl}</a>` : ''}</p>
    </div>
  </div>`;
}

exports.handler = async (event) => {
  await require('./_lib/apply-email-config')(); // load any custom email provider override before this function's existing nodemailer code runs
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!process.env.SMTP_HOST) {
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'SMTP not configured' }) };
  }

  const { title, message, propertyId, propertyName, siteName, tenantIds, urgent } = body;
  if (!title || !message) {
    return { statusCode: 400, body: JSON.stringify({ error: 'title and message are required' }) };
  }

  const a   = getAdmin();
  const db  = a.firestore();
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

  try {
    let tenants;
    if (Array.isArray(tenantIds) && tenantIds.length) {
      // Individual doc reads rather than a Firestore 'in' query — avoids
      // any query size-limit question entirely for what's expected to be
      // a small, hand-picked set of specific recipients.
      const docs = await Promise.all(tenantIds.map(id => db.collection('tenants').doc(id).get()));
      tenants = docs.filter(d => d.exists).map(d => d.data()).filter(t => t.email);
    } else {
      // Fetch active tenants — filtered by property if propertyId is set
      let tenantsQuery = db.collection('tenants').where('status', '==', 'active');
      if (propertyId) tenantsQuery = tenantsQuery.where('propertyId', '==', propertyId);
      const snap = await tenantsQuery.get();
      tenants = snap.docs.map(d => d.data()).filter(t => t.email);
    }

    if (!tenants.length) {
      return { statusCode: 200, body: JSON.stringify({ sent: 0, reason: 'No matching tenants found' }) };
    }

    const transporter = getTransporter();
    let sent = 0, failed = 0;

    // Send individually so one bad address doesn't block others
    for (const tenant of tenants) {
      try {
        await transporter.sendMail({
          from:    process.env.SMTP_FROM || process.env.SMTP_USER,
          to:      tenant.email,
          subject: `${urgent ? '🚨 URGENT' : '📢'}: ${title}${propertyName ? ` — ${propertyName}` : ''}`,
          html:    buildAnnouncementEmail({
            tenantName: `${tenant.firstName||''} ${tenant.lastName||''}`.trim(),
            title, message, propertyName, siteName, siteUrl, urgent,
          }),
        });
        sent++;
      } catch(e) {
        console.warn(`Failed to email ${tenant.email}:`, e.message);
        failed++;
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, sent, failed }) };
  } catch (err) {
    console.error('announce-notify error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
