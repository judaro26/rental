// netlify/functions/generate-invoice.js
// HTTP-triggered wrapper around the shared invoice-creation core
// (_lib/create-invoice.js) — creates a branded HTML invoice or receipt,
// stores it in Netlify Blobs, saves metadata to Firestore, and emails the
// tenant a link. Called from admin.html for admin-initiated invoices,
// receipts, and drafts.
//
// The actual creation logic lives in _lib/create-invoice.js, shared with
// send-auto-invoices.js (scheduled, automated per-tenant rent invoicing) —
// this file's only job is translating an HTTP request into a call to that
// shared function, and translating its result back into an HTTP response.
//
// Required env vars:
//   FIREBASE_SERVICE_ACCOUNT
//   NETLIFY_SITE_ID (or SITE_ID), NETLIFY_API_TOKEN
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   SITE_URL

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

  let siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
  if (!siteUrl) {
    const host  = event.headers?.['x-forwarded-host'] || event.headers?.host || '';
    const proto = event.headers?.['x-forwarded-proto'] || 'https';
    if (host) siteUrl = `${proto}://${host}`;
  }

  const { tenantId, tenantEmail, lineItems = [] } = body;
  if (!tenantId || !tenantEmail || !lineItems.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'tenantId, tenantEmail, and lineItems are required' }) };
  }

  const a  = getAdmin();
  const db = a.firestore();

  try {
    const { createInvoice } = require('./_lib/create-invoice');
    const result = await createInvoice({ a, db, siteUrl, ...body });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('generate-invoice error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
