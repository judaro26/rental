// netlify/functions/create-payment-intent.js
// Creates a Stripe PaymentIntent and records a pending payment in Firestore.
//
// Required Netlify env vars:
//   STRIPE_SECRET_KEY          — sk_live_... or sk_test_...
//   FIREBASE_SERVICE_ACCOUNT   — JSON string of your Firebase service account key

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

let admin;
function getAdmin() {
  if (!admin) {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(
          JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        ),
      });
    }
  }
  return admin;
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };
  }

  try {
    const { amount, tenantId, propertyId, description } = JSON.parse(event.body || '{}');

    if (!amount || isNaN(amount) || amount < 0.5) {
      return jsonResponse(400, { error: 'Invalid amount. Minimum is $0.50.' });
    }
    if (!tenantId) {
      return jsonResponse(400, { error: 'Missing tenantId.' });
    }

    // Create Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(parseFloat(amount) * 100), // cents
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        tenantId:    tenantId,
        propertyId:  propertyId || '',
        description: description || 'Rent Payment',
      },
    });

    // Record pending payment in Firestore
    const fb = getAdmin();
    const db = fb.firestore();
    await db.collection('payments').add({
      tenantId,
      propertyId:             propertyId || null,
      amount:                 parseFloat(amount),
      description:            description || 'Rent Payment',
      status:                 'pending',
      stripePaymentIntentId:  paymentIntent.id,
      createdAt:              fb.firestore.FieldValue.serverTimestamp(),
    });

    return jsonResponse(200, { clientSecret: paymentIntent.client_secret });

  } catch (err) {
    console.error('create-payment-intent error:', err);
    return jsonResponse(500, { error: err.message });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}
