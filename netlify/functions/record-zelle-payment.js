// netlify/functions/record-zelle-payment.js
// Records a tenant's Zelle payment confirmation in Firestore and notifies the admin.
// Payment is saved as status='pending_approval' until admin approves.
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
  await require('./_lib/apply-email-config')(); // load any custom email provider override before this function's existing nodemailer code runs
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenantId, tenantName, tenantEmail, propertyId, propertyName, unit,
          amount, description, zelleConfirmation, method: payMethod = 'zelle', siteName } = body;

  if (!tenantId || !amount) {
    return { statusCode: 400, body: JSON.stringify({ error: 'tenantId and amount are required' }) };
  }

  // Authentication: previously this function had no auth check, so an
  // unauthenticated caller could submit a fake "I paid via Zelle/Cash App"
  // claim for any tenantId — landing in the admin's pending-approval
  // queue as if it were real. If approved without careful cross-checking
  // against an actual bank record, this could mark real rent as paid when
  // it wasn't.
  const a  = getAdmin();
  const db = a.firestore();

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const bearerMatch = authHeader.match(/^Bearer (.+)$/i);
  if (!bearerMatch) return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) };

  let decoded;
  try { decoded = await a.auth().verifyIdToken(bearerMatch[1]); }
  catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) }; }

  const isOwnPayment = decoded.uid === tenantId;
  if (!isOwnPayment) {
    const adminSnap = await db.collection('admins').doc(decoded.uid).get();
    if (!adminSnap.exists || adminSnap.data().status === 'revoked') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized to record a payment for this tenant.' }) };
    }
  }

  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

  try {
    // Save payment as pending_approval
    const ref = await db.collection('payments').add({
      tenantId,
      propertyId:   propertyId || null,
      amount:       parseFloat(amount),
      description:  description || 'Rent Payment',
      method:       payMethod || 'zelle',
      status:       'pending_approval',
      zelleConfirmation: zelleConfirmation || '',
      createdAt:    a.firestore.FieldValue.serverTimestamp(),
    });

    // Notify admin
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
        subject: `${payMethod === 'cashapp' ? '💚 Cash App' : '💸 Zelle'} Payment Confirmation — ${tenantName||'Tenant'} · $${parseFloat(amount).toFixed(2)}`,
        html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
          <div style="background:#1A1A2E;padding:24px 32px;">
            <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName||'Tenant Portal'}</span>
            <span style="float:right;font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:0.08em;text-transform:uppercase;line-height:2.2;">${payMethod==="cashapp"?"💚 Cash App":"💸 Zelle"} Payment</span>
          </div>
          <div style="padding:28px 32px;">
            <h2 style="margin:0 0 4px;font-size:22px;font-weight:400;color:#1A1A2E;">Payment Confirmation Received</h2>
            <p style="font-size:13px;color:#9CA3AF;margin:0 0 20px;">A tenant has submitted a ${payMethod === 'cashapp' ? 'Cash App' : 'Zelle'} payment for your approval.</p>
            <table width="100%" style="background:#F9FAFB;border-radius:3px;padding:16px;margin-bottom:20px;" cellpadding="0" cellspacing="0">
              <tr><td style="font-size:13px;color:#6B7280;padding-bottom:8px;">Tenant</td><td style="font-size:13px;font-weight:500;text-align:right;padding-bottom:8px;">${tenantName||'—'} ${unit?'· Unit '+unit:''}</td></tr>
              <tr><td style="font-size:13px;color:#6B7280;padding-bottom:8px;">Property</td><td style="font-size:13px;text-align:right;padding-bottom:8px;">${propertyName||'—'}</td></tr>
              <tr><td style="font-size:13px;color:#6B7280;padding-bottom:8px;">Description</td><td style="font-size:13px;text-align:right;padding-bottom:8px;">${description||'Rent Payment'}</td></tr>
              <tr><td style="font-size:16px;font-weight:700;color:#1A1A2E;">Amount</td><td style="font-size:18px;font-weight:700;color:#C9903A;text-align:right;">$${parseFloat(amount).toFixed(2)}</td></tr>
            </table>
            ${zelleConfirmation ? `<div style="background:#FFFBEB;border-left:3px solid #C9903A;padding:10px 14px;border-radius:0 3px 3px 0;margin-bottom:20px;font-size:13px;color:#374151;"><strong>Tenant's confirmation note:</strong> ${zelleConfirmation}</div>` : ''}
            <p style="font-size:13px;color:#6B7280;margin:0 0 16px;">Please verify receipt in your Zelle account and approve or reject this payment in the admin portal.</p>
            <a href="${siteUrl}/admin" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:12px 28px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;">Review in Admin Panel →</a>
          </div>
        </div>`,
      });
    }

    // Confirmation email to tenant
    if (tenantEmail && process.env.SMTP_HOST) {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: parseInt(process.env.SMTP_PORT || '587') === 465,
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      tenantEmail,
        subject: `${payMethod === 'cashapp' ? 'Cash App' : 'Zelle'} Payment Received — Pending Confirmation · $${parseFloat(amount).toFixed(2)}`,
        html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
          <div style="background:#1A1A2E;padding:24px 32px;">
            <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName||'Tenant Portal'}</span>
          </div>
          <div style="padding:28px 32px;">
            <h2 style="margin:0 0 8px;font-size:20px;font-weight:400;color:#1A1A2E;">Payment Submitted</h2>
            <p style="font-size:14px;color:#6B7280;margin:0 0 20px;">Hi ${tenantName?.split(' ')[0]||'there'}, we received your Zelle payment notification. Your payment is pending confirmation — you will receive a receipt once approved.</p>
            <table width="100%" style="background:#F9FAFB;border-radius:3px;padding:16px;" cellpadding="0" cellspacing="0">
              <tr><td style="font-size:13px;color:#6B7280;">Description</td><td style="font-size:13px;font-weight:500;text-align:right;">${description||'Rent Payment'}</td></tr>
              <tr><td style="font-size:16px;font-weight:700;color:#1A1A2E;padding-top:8px;">Amount</td><td style="font-size:18px;font-weight:700;color:#C9903A;text-align:right;padding-top:8px;">$${parseFloat(amount).toFixed(2)}</td></tr>
            </table>
          </div>
          <div style="background:#F7F4EF;padding:16px 32px;text-align:center;">
            <p style="font-size:11px;color:#9CA3AF;">You will receive a receipt email once your payment is confirmed.</p>
          </div>
        </div>`,
      });
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, paymentId: ref.id }) };
  } catch (err) {
    console.error('record-zelle-payment error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
