// netlify/functions/submit-feature-request.js
// Saves a tenant feature request to Firestore and notifies the admin.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, SMTP_*, ADMIN_NOTIFY_EMAIL

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenantId, tenantName, tenantEmail, propertyName, unit, title, description, category, siteName } = body;
  if (!tenantId || !title || !description) {
    return { statusCode: 400, body: JSON.stringify({ error: 'tenantId, title, and description are required' }) };
  }

  const a  = getAdmin();
  const db = a.firestore();
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

  try {
    const ref = await db.collection('featureRequests').add({
      tenantId, tenantName, tenantEmail,
      propertyName: propertyName || '', unit: unit || '',
      title, description, category: category || 'General',
      status: 'new',
      adminNotes: '',
      votes: 0,
      createdAt: a.firestore.FieldValue.serverTimestamp(),
      updatedAt: a.firestore.FieldValue.serverTimestamp(),
    });

    // Email admin
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
    if (adminEmail && process.env.SMTP_HOST) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'),
        secure: parseInt(process.env.SMTP_PORT || '587') === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      adminEmail,
        subject: `💡 Feature Request — ${title} (${tenantName})`,
        html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
          <div style="background:#1A1A2E;padding:24px 32px;">
            <span style="font-size:20px;font-weight:300;color:#E8D5B0;">${siteName||'Tenant Portal'}</span>
            <span style="float:right;font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;line-height:2.2;">💡 Feature Request</span>
          </div>
          <div style="padding:28px 32px;">
            <h2 style="margin:0 0 4px;font-size:20px;font-weight:500;color:#1A1A2E;">${title}</h2>
            <p style="font-size:13px;color:#9CA3AF;margin:0 0 16px;">from ${tenantName}${unit?' · Unit '+unit:''}${propertyName?' · '+propertyName:''} · Category: ${category||'General'}</p>
            <div style="background:#F9FAFB;border-radius:3px;padding:14px 16px;border-left:3px solid #C9903A;font-size:14px;color:#374151;line-height:1.6;">${description}</div>
            ${siteUrl ? `<a href="${siteUrl}/admin" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:10px 24px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;margin-top:20px;">Review in Admin →</a>` : ''}
          </div>
        </div>`,
      });
    }

    // Confirm to tenant
    if (tenantEmail && process.env.SMTP_HOST) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'),
        secure: parseInt(process.env.SMTP_PORT || '587') === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      tenantEmail,
        subject: `We received your feature request — ${title}`,
        html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
          <div style="background:#1A1A2E;padding:24px 32px;">
            <span style="font-size:20px;font-weight:300;color:#E8D5B0;">${siteName||'Tenant Portal'}</span>
          </div>
          <div style="padding:28px 32px;">
            <h2 style="margin:0 0 8px;font-size:20px;font-weight:400;color:#1A1A2E;">Request Received!</h2>
            <p style="font-size:14px;color:#6B7280;margin:0 0 16px;">Thanks ${tenantName?.split(' ')[0]||'there'}! We've received your feature request and will review it soon.</p>
            <div style="background:#F9FAFB;border-radius:3px;padding:12px 16px;border-left:3px solid #C9903A;">
              <div style="font-size:14px;font-weight:500;color:#1A1A2E;">${title}</div>
              <div style="font-size:13px;color:#6B7280;margin-top:4px;">${description}</div>
            </div>
          </div>
        </div>`,
      }).catch(() => {});
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, requestId: ref.id }) };
  } catch (err) {
    console.error('submit-feature-request error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
