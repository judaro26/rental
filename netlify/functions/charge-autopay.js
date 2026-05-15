// netlify/functions/charge-autopay.js
// Charges a tenant's saved Stripe card for auto-pay.
// Called by the admin panel — admin verifies and clicks "Charge".
//
// Required env vars: STRIPE_SECRET_KEY, FIREBASE_SERVICE_ACCOUNT, SMTP_*, SITE_URL

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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

  const { consentId } = body;
  if (!consentId) return { statusCode: 400, body: JSON.stringify({ error: 'consentId required' }) };

  const fb = getAdmin();
  const db = fb.firestore();
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

  try {
    // Load consent record
    const consentSnap = await db.collection('paymentConsents').doc(consentId).get();
    if (!consentSnap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Consent not found' }) };
    const consent = consentSnap.data();

    if (consent.status !== 'active') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Consent is not active' }) };
    }
    if (!consent.stripePaymentMethodId || !consent.stripeCustomerId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No saved card on file for this consent' }) };
    }

    const amount     = Math.round(parseFloat(consent.monthlyAmount) * 100); // cents
    const description = `Auto-pay — ${consent.tenantName || 'Tenant'}${consent.unit ? ' Unit '+consent.unit : ''}`;

    // Create and confirm PaymentIntent using saved card (off_session)
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer: consent.stripeCustomerId,
      payment_method: consent.stripePaymentMethodId,
      off_session: true,
      confirm: true,
      description,
      metadata: { tenantId: consent.tenantId, consentId, type: 'autopay' },
    });

    // Record payment in Firestore
    const payRef = await db.collection('payments').add({
      tenantId:              consent.tenantId,
      propertyId:            consent.propertyId || null,
      amount:                parseFloat(consent.monthlyAmount),
      baseAmount:            parseFloat(consent.monthlyAmount),
      description,
      method:                'stripe',
      status:                'paid',
      stripePaymentIntentId: paymentIntent.id,
      autopay:               true,
      consentId,
      createdAt:             fb.firestore.FieldValue.serverTimestamp(),
      paidAt:                fb.firestore.FieldValue.serverTimestamp(),
    });

    // Record in financials
    const today = new Date().toISOString().split('T')[0];
    await db.collection('financials').add({
      type: 'income', propertyId: consent.propertyId || null,
      propertyName: consent.propertyName || '',
      date: today, amount: parseFloat(consent.monthlyAmount),
      category: 'Rent',
      description: `${description} (Auto-pay)`,
      source: 'auto',
      createdAt: fb.firestore.FieldValue.serverTimestamp(),
      updatedAt: fb.firestore.FieldValue.serverTimestamp(),
    });

    // Email receipt to tenant via generate-invoice
    if (consent.tenantEmail) {
      try {
        const invoiceUrl = `${siteUrl}/api/generate-invoice`;
        await fetch(invoiceUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'receipt',
            tenantId:    consent.tenantId,
            tenantName:  consent.tenantName,
            tenantEmail: consent.tenantEmail,
            unit:        consent.unit || '',
            propertyId:  consent.propertyId || '',
            propertyName: consent.propertyName || '',
            lineItems: [{ description: 'Monthly Rent (Auto-pay)', quantity: 1, unitPrice: consent.monthlyAmount, amount: consent.monthlyAmount }],
            taxRate: 0,
            paidDate: new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }),
            notes: 'Charged automatically via saved card on file.',
          }),
        });
      } catch(e) { console.warn('Receipt generation failed:', e.message); }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        paymentId: payRef.id,
        amount: parseFloat(consent.monthlyAmount),
        intentId: paymentIntent.id,
      }),
    };
  } catch (err) {
    // Stripe authentication_required or card_error
    console.error('charge-autopay error:', err);
    const msg = err.raw?.message || err.message;
    return { statusCode: 500, body: JSON.stringify({ error: msg }) };
  }
};
