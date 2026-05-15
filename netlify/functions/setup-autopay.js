// netlify/functions/setup-autopay.js
// Creates (or reuses) a Stripe Customer and returns a SetupIntent client secret.
// Supports both card and ACH bank account (us_bank_account).
//
// POST body: { tenantId, tenantEmail, tenantName, methodType? ('card' | 'us_bank_account') }
// Required env vars: STRIPE_SECRET_KEY, FIREBASE_SERVICE_ACCOUNT

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

  const { tenantId, tenantEmail, tenantName, methodType = 'card' } = body;
  if (!tenantId || !tenantEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: 'tenantId and tenantEmail required' }) };
  }

  try {
    const fb = getAdmin();
    const db = fb.firestore();

    // Get or create Stripe Customer
    const tenantDoc  = await db.collection('tenants').doc(tenantId).get();
    const tenantData = tenantDoc.data() || {};
    let customerId   = tenantData.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: tenantEmail,
        name:  tenantName || tenantEmail,
        metadata: { tenantId },
      });
      customerId = customer.id;
      await db.collection('tenants').doc(tenantId).update({ stripeCustomerId: customerId });
    }

    // Build SetupIntent options based on method type
    const siOptions = {
      customer: customerId,
      usage:    'off_session',
      metadata: { tenantId, methodType },
    };

    if (methodType === 'us_bank_account') {
      siOptions.payment_method_types = ['us_bank_account'];
      siOptions.payment_method_options = {
        us_bank_account: {
          financial_connections: { permissions: ['payment_method'] },
          verification_method: 'automatic', // instant via Plaid when available
        },
      };
    } else {
      siOptions.payment_method_types = ['card'];
    }

    const setupIntent = await stripe.setupIntents.create(siOptions);

    return {
      statusCode: 200,
      body: JSON.stringify({
        clientSecret: setupIntent.client_secret,
        customerId,
        methodType,
      }),
    };
  } catch (err) {
    console.error('setup-autopay error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
