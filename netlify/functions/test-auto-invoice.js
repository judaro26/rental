// netlify/functions/test-auto-invoice.js
// Previews what a tenant's automated rent invoice would look like, without
// creating anything real: no Firestore record, no Blob storage, no
// consumed invoice number. Reuses the same buildHtml/buildEmail functions
// the real invoice uses (via _lib/create-invoice.js), so the preview is
// genuinely accurate — just never persisted, and always sent to the
// caller's own verified email, never the tenant's.
//
// This exists specifically because a "test" that behaves like the real
// createInvoice() would leave a fake entry in the tenant's real invoice
// history and burn a real sequential invoice number — neither of which is
// an acceptable side effect of just wanting to see a preview.

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

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) };

  const a = getAdmin();
  const db = a.firestore();

  let decoded;
  try { decoded = await a.auth().verifyIdToken(match[1]); }
  catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) }; }

  const adminSnap = await db.collection('admins').doc(decoded.uid).get();
  if (!adminSnap.exists) return { statusCode: 403, body: JSON.stringify({ error: 'Caller is not an admin.' }) };
  const adminData = adminSnap.data();
  if (adminData.status === 'revoked') return { statusCode: 403, body: JSON.stringify({ error: 'Access revoked.' }) };
  const callerEmail = adminData.email || decoded.email || '';

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenantId, dueDayLabel } = body;
  if (!tenantId) return { statusCode: 400, body: JSON.stringify({ error: 'tenantId is required.' }) };

  try {
    const tenantSnap = await db.collection('tenants').doc(tenantId).get();
    if (!tenantSnap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Tenant not found.' }) };
    const tenant = tenantSnap.data();

    // Restricted admins may only preview invoices for tenants in their own
    // country, matching the same scoping used for reminders and Bold.
    if (adminData.role === 'restricted_admin') {
      let propertyCountry = null;
      if (tenant.propertyId) {
        const propSnap = await db.collection('properties').doc(tenant.propertyId).get();
        if (propSnap.exists) propertyCountry = propSnap.data().country;
      }
      if (propertyCountry !== adminData.allowedCountry) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized to preview invoices for this tenant.' }) };
      }
    }

    if (!tenant.monthlyRent) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This tenant has no monthly rent amount set.' }) };
    }

    let siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
    let siteName = 'Tenant Portal';
    try {
      const settingsSnap = await db.collection('settings').doc('site').get();
      if (settingsSnap.exists) siteName = settingsSnap.data().siteName || siteName;
    } catch { /* use default siteName */ }

    const { buildHtml, buildEmail } = require('./_lib/create-invoice');
    const tenantName = `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'Tenant';
    const total = Number(tenant.monthlyRent);
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const dueLabel = dueDayLabel || 'its next due date';

    const html = buildHtml({
      type: 'invoice', invoiceNumber: 'TEST-PREVIEW', date, dueDate: dueLabel, siteName, siteUrl,
      tenantName, tenantEmail: tenant.email || '', unit: tenant.unit || '', propertyName: tenant.propertyName || '',
      lineItems: [{ description: 'Monthly Rent', quantity: 1, unitPrice: total, amount: total }],
      subtotal: total, taxRate: 0, taxAmount: 0, total, notes: '', isPaid: false,
    });

    if (!process.env.SMTP_HOST) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No email configuration available. Set one up under Settings → Integrations.' }) };
    }
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: parseInt(process.env.SMTP_PORT || '587') === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    // Send the caller a copy of the actual rendered invoice HTML (as an
    // attachment) plus the normal "your invoice is ready" email shell, so
    // they see exactly what the tenant would receive — without a fake
    // invoice record ever touching Firestore or Blobs.
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: callerEmail,
      subject: `[TEST PREVIEW] Rent invoice for ${tenantName} — $${total.toFixed(2)}`,
      html: `
        <p style="background:#FEF3C7;color:#92400E;padding:8px 12px;border-radius:4px;font-size:12px;font-family:Arial,sans-serif;">This is a preview only — sent to you, not ${tenant.email || 'the tenant'}. Nothing was saved or sent to anyone else.</p>
        ${buildEmail({ isReceipt: false, invoiceNumber: 'TEST-PREVIEW', tenantName, total, dueDate: dueLabel, invoiceUrl: '#', siteName })}
      `,
      attachments: [{ filename: 'invoice-preview.html', content: html, contentType: 'text/html' }],
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, sentTo: callerEmail }) };

  } catch (err) {
    console.error('test-auto-invoice error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
