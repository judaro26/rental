// netlify/functions/send-support.js
// Handles tenant support messages: saves to Firestore and emails the admin.
//
// Required env vars:
//   FIREBASE_SERVICE_ACCOUNT
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   ADMIN_NOTIFY_EMAIL

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

  const { tenantId, tenantName, tenantEmail, unit, propertyName, subject, message, siteName } = body;
  if (!subject || !message) {
    return { statusCode: 400, body: JSON.stringify({ error: 'subject and message are required' }) };
  }

  const a  = getAdmin();
  const db = a.firestore();
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

  try {
    // 1. Save to Firestore
    const msgRef = await db.collection('supportMessages').add({
      tenantId:     tenantId || null,
      tenantName:   tenantName || '',
      tenantEmail:  tenantEmail || '',
      unit:         unit || '',
      propertyName: propertyName || '',
      subject,
      message,
      status:       'open',
      createdAt:    a.firestore.FieldValue.serverTimestamp(),
    });

    // 2. Email admin
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
    if (adminEmail && process.env.SMTP_HOST) {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: parseInt(process.env.SMTP_PORT || '587') === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      await transporter.sendMail({
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      adminEmail,
        replyTo: tenantEmail || undefined,
        subject: `[Support] ${subject} — ${tenantName || 'Tenant'}${unit ? ' · Unit ' + unit : ''}`,
        html: `
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
            <div style="background:#1A1A2E;padding:24px 32px;">
              <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName || 'Tenant Portal'}</span>
              <span style="float:right;font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:0.08em;text-transform:uppercase;line-height:2.2;">Support Message</span>
            </div>
            <div style="padding:28px 32px 8px;">
              <h2 style="margin:0 0 4px;font-size:22px;font-weight:400;color:#1A1A2E;">${subject}</h2>
              <p style="margin:0;font-size:13px;color:#9CA3AF;">${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</p>
            </div>
            <div style="padding:16px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="50%" style="padding-bottom:16px;vertical-align:top;">
                    <p style="margin:0 0 3px;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">From</p>
                    <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:500;">${tenantName || '—'}</p>
                    ${tenantEmail ? `<p style="margin:2px 0 0;font-size:12px;color:#6B7280;">${tenantEmail}</p>` : ''}
                  </td>
                  <td width="50%" style="padding-bottom:16px;vertical-align:top;">
                    <p style="margin:0 0 3px;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Unit / Property</p>
                    <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:500;">${unit ? 'Unit ' + unit : '—'}${propertyName ? ' · ' + propertyName : ''}</p>
                  </td>
                </tr>
              </table>
            </div>
            <div style="padding:0 32px 28px;">
              <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Message</p>
              <div style="background:#F9FAFB;border-radius:4px;padding:14px 16px;border:1px solid #F3F4F6;">
                <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;white-space:pre-wrap;">${message}</p>
              </div>
            </div>
            ${siteUrl ? `<div style="padding:0 32px 32px;"><a href="${siteUrl}/admin" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:12px 28px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;font-weight:500;">View in Admin Panel →</a></div>` : ''}
            <div style="background:#F7F4EF;padding:16px 32px;text-align:center;">
              <p style="margin:0;font-size:11px;color:#9CA3AF;">Reply directly to this email to respond to the tenant.</p>
            </div>
          </div>`,
      });
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, msgId: msgRef.id }) };
  } catch (err) {
    console.error('send-support error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
