// netlify/functions/generate-invoice-now.js
// Admin-triggered, ad-hoc rent invoice generation for a single tenant —
// for exactly the situation where automatic invoicing was enabled (or a
// due day/lead time was changed) after this cycle's scheduled generate
// window already passed, so send-auto-invoices.js won't pick it up until
// next month. This creates a REAL invoice (through the same shared
// _lib/create-invoice.js core the scheduled function uses) right now,
// for the tenant's next upcoming due date — not a test, not a preview.
//
// Marks the tenant's autoInvoiceLastPeriod for that cycle afterward (when
// rentDueDay is set), so the scheduled function doesn't also try to
// generate a duplicate when it later runs for the same period.
//
// Required env vars: same as generate-invoice.js / send-auto-invoices.js
// (FIREBASE_SERVICE_ACCOUNT, SITE_URL, NETLIFY_SITE_ID/SITE_ID,
// NETLIFY_API_TOKEN, SMTP_* or a configured email integration).

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

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenantId } = body;
  if (!tenantId) return { statusCode: 400, body: JSON.stringify({ error: 'tenantId is required.' }) };

  try {
    const tenantRef = db.collection('tenants').doc(tenantId);
    const tenantSnap = await tenantRef.get();
    if (!tenantSnap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Tenant not found.' }) };
    const tenant = tenantSnap.data();

    // Restricted admins may only invoice tenants in their own country,
    // matching the scoping used for reminders, Bold, and the test preview.
    if (adminData.role === 'restricted_admin') {
      let propertyCountry = null;
      if (tenant.propertyId) {
        const propSnap = await db.collection('properties').doc(tenant.propertyId).get();
        if (propSnap.exists) propertyCountry = propSnap.data().country;
      }
      if (propertyCountry !== adminData.allowedCountry) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized to invoice this tenant.' }) };
      }
    }

    if (!tenant.monthlyRent) return { statusCode: 400, body: JSON.stringify({ error: 'This tenant has no monthly rent amount set.' }) };
    if (!tenant.email) return { statusCode: 400, body: JSON.stringify({ error: 'This tenant has no email address on file.' }) };

    const { findNextDueDate, utcMidnightToday } = require('./_lib/reminder-cycle');
    const { createInvoice } = require('./_lib/create-invoice');

    // If a rent due day is configured, invoice for the next upcoming
    // occurrence of it (so this lines up with what the automatic system
    // would eventually generate). If not configured at all, there's no
    // cycle to target — invoice due immediately, as a one-off.
    let dueDateLabel, matchedPeriod = null;
    if (tenant.rentDueDay) {
      const next = findNextDueDate(tenant.rentDueDay, utcMidnightToday());
      dueDateLabel = new Date(next.dueMs).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
      matchedPeriod = next.period;
    } else {
      dueDateLabel = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    }

    let siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
    let siteName = 'Tenant Portal';
    try {
      const settingsSnap = await db.collection('settings').doc('site').get();
      if (settingsSnap.exists) siteName = settingsSnap.data().siteName || siteName;
    } catch { /* use default siteName */ }

    const tenantName = `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'Tenant';

    const result = await createInvoice({
      a, db, siteUrl, siteName,
      type: 'invoice',
      tenantId,
      tenantName,
      tenantEmail: tenant.email,
      unit: tenant.unit || '',
      propertyId: tenant.propertyId || null,
      propertyName: tenant.propertyName || '',
      lineItems: [{ description: 'Monthly Rent', quantity: 1, unitPrice: tenant.monthlyRent, amount: tenant.monthlyRent }],
      dueDate: dueDateLabel,
      sendNow: true,
    });

    // Mark this cycle as done so the scheduled sweep doesn't duplicate it.
    if (matchedPeriod) {
      await tenantRef.update({ autoInvoiceLastPeriod: matchedPeriod });
    }

    return { statusCode: 200, body: JSON.stringify({ ...result, dueDate: dueDateLabel, tenantEmail: tenant.email }) };

  } catch (err) {
    console.error('generate-invoice-now error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
