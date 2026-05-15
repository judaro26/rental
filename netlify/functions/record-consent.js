// netlify/functions/record-consent.js
// Records a tenant's autopay authorization consent with full audit trail.
// Captures IP address, user agent, timestamp, and legal agreement text server-side.
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

  const {
    tenantId, tenantName, tenantEmail, unit, propertyId, propertyName,
    monthlyAmount, paymentMethod, paymentDay, signatureName, siteName,
    stripePaymentMethodId, stripeCustomerId,
  } = body;

  if (!tenantId || !signatureName || !monthlyAmount) {
    return { statusCode: 400, body: JSON.stringify({ error: 'tenantId, signatureName, and monthlyAmount are required' }) };
  }

  // Capture audit data server-side (cannot be spoofed by client)
  const ipAddress = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || event.headers?.['x-real-ip']
    || event.requestContext?.http?.sourceIp
    || 'unknown';
  const userAgent  = event.headers?.['user-agent'] || 'unknown';
  const consentDate = new Date().toISOString();

  const siteUrl  = (process.env.SITE_URL || '').replace(/\/+$/, '');
  const methodLabel = paymentMethod === 'stripe' ? 'Credit/Debit Card (Stripe)'
    : paymentMethod === 'zelle' ? 'Zelle'
    : paymentMethod === 'cashapp' ? 'Cash App' : paymentMethod;

  const consentText = `RECURRING PAYMENT AUTHORIZATION AGREEMENT

I, ${signatureName}, ("Tenant") hereby authorize ${siteName || 'the Property Manager'} ("Property Manager") to initiate recurring monthly payment entries from my designated payment account for the amount of $${parseFloat(monthlyAmount).toFixed(2)} USD on or around the ${paymentDay || '1st'} day of each month.

Payment Method: ${methodLabel}
Authorized Amount: $${parseFloat(monthlyAmount).toFixed(2)} per month
Property: ${propertyName || ''}${unit ? ', Unit ' + unit : ''}

This authorization shall remain in full force and effect until Tenant notifies Property Manager in writing of cancellation no less than 30 days prior to the next scheduled payment date. Property Manager reserves the right to cancel this authorization with written notice.

Tenant certifies that all information provided is accurate and that they are authorized to initiate transactions from the designated payment account.

By electronically signing this agreement, Tenant acknowledges having read, understood, and agreed to these terms.

Electronic Signature: ${signatureName}
Date: ${new Date(consentDate).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', timeZoneName:'short' })}
IP Address: ${ipAddress}
Device: ${userAgent}`;

  const a  = getAdmin();
  const db = a.firestore();

  try {
    // Save consent record
    const ref = await db.collection('paymentConsents').add({
      tenantId, tenantName, tenantEmail,
      unit: unit || '', propertyId: propertyId || null, propertyName: propertyName || '',
      monthlyAmount: parseFloat(monthlyAmount),
      paymentMethod, paymentDay: paymentDay || '1',
      signatureName,
      consentText,
      consentDate,
      ipAddress, userAgent,
      stripePaymentMethodId: stripePaymentMethodId || null,
      stripeCustomerId:      stripeCustomerId || null,
      status:    'active',
      createdAt: a.firestore.FieldValue.serverTimestamp(),
    });

    // Update tenant doc with autopay flag
    await db.collection('tenants').doc(tenantId).update({
      autopayEnabled:  true,
      autopayMethod:   paymentMethod,
      autopayAmount:   parseFloat(monthlyAmount),
      autopayDay:      paymentDay || '1',
      autopayConsentId: ref.id,
      updatedAt: a.firestore.FieldValue.serverTimestamp(),
    });

    // Email confirmation to tenant
    if (tenantEmail && process.env.SMTP_HOST) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'),
        secure: parseInt(process.env.SMTP_PORT || '587') === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      tenantEmail,
        subject: `Auto-Pay Authorization Confirmed — $${parseFloat(monthlyAmount).toFixed(2)}/month`,
        html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
          <div style="background:#1A1A2E;padding:24px 32px;">
            <span style="font-size:20px;font-weight:300;color:#E8D5B0;">${siteName||'Tenant Portal'}</span>
          </div>
          <div style="padding:28px 32px;">
            <h2 style="margin:0 0 8px;font-size:20px;font-weight:400;color:#1A1A2E;">Auto-Pay Authorization Confirmed</h2>
            <p style="font-size:14px;color:#6B7280;margin:0 0 20px;">Your recurring payment authorization has been recorded. A copy of your agreement is below for your records.</p>
            <div style="background:#F9FAFB;border-radius:3px;padding:14px 16px;margin-bottom:20px;border-left:3px solid #C9903A;font-size:13px;color:#374151;">
              <div><strong>Amount:</strong> $${parseFloat(monthlyAmount).toFixed(2)}/month</div>
              <div><strong>Method:</strong> ${methodLabel}</div>
              <div><strong>Payment Day:</strong> ${paymentDay || '1'}${['1','21','31'].includes(paymentDay) ? 'st' : paymentDay === '2' ? 'nd' : paymentDay === '3' ? 'rd' : 'th'} of each month</div>
              <div><strong>Authorized:</strong> ${new Date(consentDate).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
            </div>
            <details style="margin-bottom:20px;">
              <summary style="font-size:13px;color:#C9903A;cursor:pointer;">View full authorization agreement</summary>
              <pre style="font-size:11px;color:#6B7280;white-space:pre-wrap;margin-top:10px;padding:12px;background:#F9FAFB;border-radius:3px;">${consentText}</pre>
            </details>
            <p style="font-size:12px;color:#9CA3AF;">To cancel auto-pay, contact your property manager at least 30 days before the next payment date.</p>
          </div>
        </div>`,
      });

      // Notify admin
      const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
      if (adminEmail) {
        await transporter.sendMail({
          from:    process.env.SMTP_FROM || process.env.SMTP_USER,
          to:      adminEmail,
          subject: `✅ Auto-Pay Authorized — ${tenantName} · $${parseFloat(monthlyAmount).toFixed(2)}/mo`,
          html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:auto;padding:32px;">
            <h2 style="color:#1A1A2E;">New Auto-Pay Authorization</h2>
            <p style="color:#6B7280;">${tenantName} has authorized recurring ${methodLabel} payments of <strong>$${parseFloat(monthlyAmount).toFixed(2)}/month</strong>${unit?' for Unit '+unit:''}.</p>
            <pre style="font-size:11px;color:#6B7280;white-space:pre-wrap;padding:12px;background:#F9FAFB;border-radius:3px;">${consentText}</pre>
            ${siteUrl ? `<a href="${siteUrl}/admin" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:10px 24px;font-size:12px;border-radius:2px;margin-top:16px;">View in Admin →</a>` : ''}
          </div>`,
        });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, consentId: ref.id }) };
  } catch (err) {
    console.error('record-consent error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
