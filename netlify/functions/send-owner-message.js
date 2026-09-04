// netlify/functions/send-owner-message.js
// Handles owner-portal contact messages: saves to Firestore and emails the
// admin. Modeled closely on send-support.js (the tenant equivalent), but
// uses a separate ownerMessages collection and verifyOwner rather than the
// tenant ownership check — see _lib/verify-owner.js for why owners and
// tenants are kept as distinct caller types rather than conflated.
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
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      });
    }
  }
  return admin;
}

exports.handler = async (event) => {
  await require('./_lib/apply-email-config')();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { subject, message, propertyName } = body;
  if (!subject || !message) {
    return { statusCode: 400, body: JSON.stringify({ error: 'subject and message are required' }) };
  }

  const a  = getAdmin();
  const db = a.firestore();

  const { verifyOwner } = require('./_lib/verify-owner');
  const authResult = await verifyOwner(event, db, a);
  if (authResult.error) return authResult.error;
  const { ownerData, decoded } = authResult;

  const ownerName  = ownerData.name || '';
  const ownerEmail = ownerData.email || decoded.email || '';

  try {
    const msgRef = await db.collection('ownerMessages').add({
      ownerId:      decoded.uid,
      ownerName,
      ownerEmail,
      propertyName: propertyName || '',
      subject,
      message,
      status:       'open',
      createdAt:    a.firestore.FieldValue.serverTimestamp(),
    });

    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
    if (adminEmail && process.env.SMTP_HOST) {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: parseInt(process.env.SMTP_PORT || '587') === 465,
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      await transporter.sendMail({
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      adminEmail,
        replyTo: ownerEmail || undefined,
        subject: `[Owner] ${subject} — ${ownerName || 'Owner'}${propertyName ? ' · ' + propertyName : ''}`,
        html: `
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
            <div style="background:#1A1A2E;padding:24px 32px;">
              <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">Owner Portal</span>
              <span style="float:right;font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:0.08em;text-transform:uppercase;line-height:2.2;">Owner Message</span>
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
                    <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:500;">${ownerName || '—'}</p>
                    ${ownerEmail ? `<p style="margin:2px 0 0;font-size:12px;color:#6B7280;">${ownerEmail}</p>` : ''}
                  </td>
                  <td width="50%" style="padding-bottom:16px;vertical-align:top;">
                    <p style="margin:0 0 3px;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Property</p>
                    <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:500;">${propertyName || '—'}</p>
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
            <div style="background:#F7F4EF;padding:16px 32px;text-align:center;">
              <p style="margin:0;font-size:11px;color:#9CA3AF;">Reply directly to this email to respond to the owner.</p>
            </div>
          </div>`,
      });
    }

    if (ownerEmail && process.env.SMTP_HOST) {
      try {
        const ownerTransporter = nodemailer.createTransport({
          host:   process.env.SMTP_HOST,
          port:   parseInt(process.env.SMTP_PORT || '587'),
          secure: parseInt(process.env.SMTP_PORT || '587') === 465,
          auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await ownerTransporter.sendMail({
          from:    process.env.SMTP_FROM || process.env.SMTP_USER,
          to:      ownerEmail,
          subject: `We received your message — ${subject}`,
          html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
            <div style="background:#1A1A2E;padding:24px 32px;">
              <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">Owner Portal</span>
            </div>
            <div style="padding:28px 32px;">
              <h2 style="margin:0 0 8px;font-size:20px;font-weight:400;color:#1A1A2E;">Message Received</h2>
              <p style="font-size:14px;color:#6B7280;margin:0 0 20px;">Hi ${ownerName||'there'}, we received your message and will get back to you as soon as possible.</p>
              <div style="background:#F9FAFB;border-radius:3px;padding:14px 16px;margin-bottom:20px;border-left:3px solid #C9903A;">
                <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">Your message</div>
                <div style="font-size:13px;font-weight:500;color:#1A1A2E;margin-bottom:4px;">${subject}</div>
                <div style="font-size:13px;color:#374151;line-height:1.5;white-space:pre-wrap;">${message}</div>
              </div>
              <p style="font-size:12px;color:#9CA3AF;margin:0;">You will receive a reply at this email address.</p>
            </div>
          </div>`,
        });
      } catch(emailErr) { console.warn('Owner confirmation email failed:', emailErr.message); }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, msgId: msgRef.id }) };
  } catch (err) {
    console.error('send-owner-message error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
