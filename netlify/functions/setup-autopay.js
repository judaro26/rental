// netlify/functions/setup-autopay.js
// Creates a Stripe SetupIntent and Stripe Customer (if needed) so the tenant
// can save a card for future automated charges.
//
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

  const { tenantId, tenantEmail, tenantName } = body;
  if (!tenantId || !tenantEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: 'tenantId and tenantEmail required' }) };
  }

  try {
    const fb = getAdmin();
    const db = fb.firestore();

    // Get or create a Stripe Customer for this tenant
    const tenantDoc = await db.collection('tenants').doc(tenantId).get();
    const tenantData = tenantDoc.data() || {};
    let customerId = tenantData.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: tenantEmail,
        name:  tenantName || tenantEmail,
        metadata: { tenantId },
      });
      customerId = customer.id;
      await db.collection('tenants').doc(tenantId).update({
        stripeCustomerId: customerId,
      });
    }

    // Create SetupIntent — allows saving the card without charging now
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session', // card will be charged server-side in future
      metadata: { tenantId },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        clientSecret: setupIntent.client_secret,
        customerId,
      }),
    };
  } catch (err) {
    console.error('setup-autopay error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
