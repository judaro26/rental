// netlify/functions/create-bold-payment.js
// Creates a Bold payment link for a specific, existing invoice. Looks up the
// invoice's property to find that property's own Bold merchant credentials
// (each property/client has their own account — money settles directly to
// them, this app never touches it).
//
// POST /api/create-bold-payment
// Body: { invoiceId }
// Auth: Bearer <Firebase ID token> — either the tenant who owns the invoice,
//       or an admin.
//
// Currency note: this passes the invoice's `total` field through as-is with
// currency:'USD', matching how amounts are tracked everywhere else in this
// app (Stripe, the $-formatted UI, etc.) — Bold explicitly supports USD
// alongside COP, so no conversion is attempted here. If invoice totals for
// Colombian properties are actually meant to represent COP directly, this
// is the one line to change (currency + removing any USD assumption) —
// flagging this explicitly rather than silently guessing.

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

const BOLD_BASE_URL = 'https://integrations.api.bold.co';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { invoiceId } = body;
  if (!invoiceId) return { statusCode: 400, body: JSON.stringify({ error: 'invoiceId is required.' }) };

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) };

  const a = getAdmin();
  const db = a.firestore();

  let decoded;
  try { decoded = await a.auth().verifyIdToken(match[1]); }
  catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) }; }

  try {
    const invoiceSnap = await db.collection('invoices').doc(invoiceId).get();
    if (!invoiceSnap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Invoice not found.' }) };
    const invoice = invoiceSnap.data();

    // Caller must be the tenant who owns this invoice, or an admin.
    const isOwner = invoice.tenantId === decoded.uid;
    if (!isOwner) {
      const adminSnap = await db.collection('admins').doc(decoded.uid).get();
      if (!adminSnap.exists || adminSnap.data().status === 'revoked') {
        return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized to pay this invoice.' }) };
      }
    }

    if (invoice.status === 'paid') {
      return { statusCode: 400, body: JSON.stringify({ error: 'This invoice is already marked as paid.' }) };
    }
    if (!invoice.propertyId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This invoice has no associated property, so no payment processor can be determined for it.' }) };
    }

    const secretSnap = await db.collection('propertyPaymentSecrets').doc(invoice.propertyId).get();
    const bold = secretSnap.exists ? secretSnap.data().bold : null;
    if (!bold || !bold.enabled || !bold.apiKey) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Bold is not configured or is disabled for this property.' }) };
    }

    const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
    const reference = `invoice_${invoiceId}`;

    const boldRes = await fetch(`${BOLD_BASE_URL}/online/link/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `x-api-key ${bold.apiKey}` },
      body: JSON.stringify({
        amount_type: 'CLOSE',
        amount: { currency: 'USD', total_amount: Number(invoice.total) || 0, tip_amount: 0 },
        reference,
        description: `${invoice.invoiceNumber || 'Invoice'} — ${invoice.propertyName || ''}`.slice(0, 100),
        payer_email: invoice.tenantEmail || undefined,
        callback_url: siteUrl ? `${siteUrl}/tenant-portal.html?paid=bold` : undefined,
      }),
    });
    const boldData = await boldRes.json();
    if (!boldRes.ok || boldData.errors?.length) {
      console.error('Bold link creation failed:', boldData);
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not create payment link with Bold.', details: boldData.errors || boldData }) };
    }

    await invoiceSnap.ref.update({
      boldPaymentLinkId: boldData.payload.payment_link,
      boldPaymentUrl: boldData.payload.url,
      boldReference: reference,
      updatedAt: a.firestore.FieldValue.serverTimestamp(),
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, url: boldData.payload.url }) };

  } catch (err) {
    console.error('create-bold-payment error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
