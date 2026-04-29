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

const stripe    = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');

function getTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendPaymentNotification({ tenantName, tenantEmail, amount, description, method, siteName, siteUrl }) {
  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
  if (!adminEmail || !process.env.SMTP_HOST) return;
  const label = method === 'zelle' ? 'Zelle' : method === 'stripe' ? 'Stripe' : 'Manual';
  try {
    await getTransporter().sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      adminEmail,
      subject: `💳 Payment Received — ${tenantName} · $${parseFloat(amount).toFixed(2)}`,
      html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
        <div style="background:#1A1A2E;padding:24px 32px;">
          <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName||'Tenant Portal'}</span>
          <span style="float:right;font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;line-height:2.2;">💳 Payment</span>
        </div>
        <div style="padding:28px 32px;">
          <h2 style="margin:0 0 4px;font-size:22px;font-weight:400;color:#1A1A2E;">Payment Received</h2>
          <p style="font-size:13px;color:#9CA3AF;margin:0 0 20px;">${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</p>
          <table width="100%" style="background:#F9FAFB;border-radius:3px;padding:16px;margin-bottom:20px;" cellpadding="0" cellspacing="0">
            <tr><td style="font-size:13px;color:#6B7280;padding-bottom:8px;">Tenant</td><td style="font-size:13px;font-weight:500;text-align:right;padding-bottom:8px;">${tenantName||'—'}</td></tr>
            <tr><td style="font-size:13px;color:#6B7280;padding-bottom:8px;">Description</td><td style="font-size:13px;text-align:right;padding-bottom:8px;">${description||'Rent Payment'}</td></tr>
            <tr><td style="font-size:13px;color:#6B7280;padding-bottom:8px;">Method</td><td style="font-size:13px;text-align:right;padding-bottom:8px;">${label}</td></tr>
            <tr><td style="font-size:16px;font-weight:700;color:#1A1A2E;">Amount</td><td style="font-size:18px;font-weight:700;color:#C9903A;text-align:right;">$${parseFloat(amount).toFixed(2)}</td></tr>
          </table>
          ${siteUrl ? `<a href="${siteUrl}/admin" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:10px 24px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;">View in Admin →</a>` : ''}
        </div>
      </div>`,
    });
  } catch(e) { console.warn('Payment notify email failed:', e.message); }
}

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

// Records a payment to the financials collection
async function recordFinancial(db, fb, { propertyId, propertyName, date, amount, category, description, type, source }) {
  try {
    await db.collection('financials').add({
      type, propertyId: propertyId || null, propertyName: propertyName || '',
      date, amount: parseFloat(amount), category, description,
      source,  // 'auto' — recorded automatically
      createdAt: fb.firestore.FieldValue.serverTimestamp(),
      updatedAt: fb.firestore.FieldValue.serverTimestamp(),
    });
  } catch(e) { console.warn('recordFinancial failed:', e.message); }
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
          stripeMeta: { amount: pi.amount / 100, currency: pi.currency },
        });
        // Notify admin of payment
        try {
          const siteUrl   = (process.env.SITE_URL || '').replace(/\/+$/, '');
          const siteName  = process.env.SITE_NAME || '';
          // Fetch payment record to get tenant info
          const pmtSnap = await db.collection('payments')
            .where('stripePaymentIntentId', '==', pi.id).limit(1).get();
          if (!pmtSnap.empty) {
            const pmt    = pmtSnap.docs[0].data();
            const tSnap  = pmt.tenantId ? await db.collection('tenants').doc(pmt.tenantId).get() : null;
            const tenant = tSnap?.data();
            await sendPaymentNotification({
              tenantName:  tenant ? `${tenant.firstName||''} ${tenant.lastName||''}`.trim() : 'Tenant',
              tenantEmail: tenant?.email || '',
              amount:      pmt.baseAmount || pi.amount / 100,
              description: pmt.description || 'Rent Payment',
              method:      'stripe',
              siteName, siteUrl,
            });
          }
        } catch(e) { console.warn('Notify failed:', e.message); }

        // Record income + Stripe fee expense in financials
        try {
          const pmtSnap2 = await db.collection('payments')
            .where('stripePaymentIntentId', '==', pi.id).limit(1).get();
          if (!pmtSnap2.empty) {
            const pmt    = pmtSnap2.docs[0].data();
            const tSnap2 = pmt.tenantId ? await db.collection('tenants').doc(pmt.tenantId).get() : null;
            const tenant = tSnap2?.data();
            const today  = new Date().toISOString().split('T')[0];
            const name   = tenant ? `${tenant.firstName||''} ${tenant.lastName||''}`.trim() : 'Tenant';
            const baseAmt = pmt.baseAmount || (pi.amount / 100);
            const feeAmt  = pmt.stripeFee  || Math.round((baseAmt * 0.029 + 0.30) * 100) / 100;

            // Income entry (base rent amount, not including fee)
            await recordFinancial(db, fb, {
              propertyId:   pmt.propertyId || tenant?.propertyId || null,
              propertyName: tenant?.propertyName || '',
              date:         today,
              amount:       baseAmt,
              category:     'Rent',
              description:  `${pmt.description || 'Rent Payment'} — ${name} (Stripe)`,
              type:         'income',
              source:       'auto',
            });

            // Expense entry for Stripe processing fee
            await recordFinancial(db, fb, {
              propertyId:   pmt.propertyId || tenant?.propertyId || null,
              propertyName: tenant?.propertyName || '',
              date:         today,
              amount:       feeAmt,
              category:     'Other Expense',
              description:  `Stripe processing fee — ${name}`,
              type:         'expense',
              source:       'auto',
            });
          }
        } catch(e) { console.warn('recordFinancial failed:', e.message); }

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
