// netlify/functions/stripe-webhook.js
// Handles Stripe webhook events and updates payment status in Firestore.
//
// Required Netlify env vars:
//   STRIPE_SECRET_KEY        — sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET    — whsec_... (from Stripe Dashboard → Webhooks)
//   FIREBASE_SERVICE_ACCOUNT — JSON string of your Firebase service account key
//
// Register this webhook URL in Stripe Dashboard:
//   https://YOUR-SITE.netlify.app/api/stripe-webhook
//
// Events to listen for:
//   payment_intent.succeeded
//   payment_intent.payment_failed

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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const fb = getAdmin();
  const db = fb.firestore();

  try {
    switch (stripeEvent.type) {

      case 'payment_intent.succeeded': {
        const pi = stripeEvent.data.object;
        await updatePaymentByIntentId(db, fb, pi.id, {
          status:  'paid',
          paidAt:  fb.firestore.FieldValue.serverTimestamp(),
          stripeMeta: {
            amount:   pi.amount / 100,
            currency: pi.currency,
          },
        });
        console.log(`Payment succeeded: ${pi.id}`);
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = stripeEvent.data.object;
        const reason = pi.last_payment_error?.message || 'Unknown error';
        await updatePaymentByIntentId(db, fb, pi.id, {
          status:      'failed',
          failReason:  reason,
          failedAt:    fb.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Payment failed: ${pi.id} — ${reason}`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }
  } catch (err) {
    console.error('Error processing webhook:', err);
    return { statusCode: 500, body: `Internal error: ${err.message}` };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

async function updatePaymentByIntentId(db, admin, intentId, updateData) {
  const q = db.collection('payments')
    .where('stripePaymentIntentId', '==', intentId)
    .limit(1);

  const snap = await q.get();
  if (snap.empty) {
    console.warn(`No payment record found for intent: ${intentId}`);
    return;
  }
  await snap.docs[0].ref.update(updateData);
}
