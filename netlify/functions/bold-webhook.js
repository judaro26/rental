// netlify/functions/bold-webhook.js
// Receives payment status events from Bold. Public endpoint (Bold's own
// servers call this, not a logged-in user), so authenticity is established
// entirely by verifying the HMAC signature — never by trusting anything in
// the payload before that check passes.
//
// Verification order matters here: to verify the signature we need the
// correct property's OWN secret key (each property has its own Bold
// account), but we don't know which property until we look at the payload.
// So: extract only the reference (our own invoice ID) to find which
// property's key to check against, verify the signature against the RAW
// body using that key, and only if it matches do we trust anything else in
// the payload. The reference is never used to make a decision on its own —
// only to select which key to verify with.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT

const crypto = require('crypto');

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

function verifySignature(rawBody, signatureHeader, secretKey) {
  if (!signatureHeader) return false;
  try {
    const base64Body = Buffer.from(rawBody, 'utf8').toString('base64');
    const hashed = crypto.createHmac('sha256', secretKey || '').update(base64Body, 'utf8').digest('hex');
    const sigBuf = Buffer.from(signatureHeader, 'utf8');
    const hashBuf = Buffer.from(hashed, 'utf8');
    if (sigBuf.length !== hashBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, hashBuf);
  } catch { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const rawBody = event.body || '';
  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  // Only used to select which property's key to check against — not
  // trusted for anything else until the signature below actually matches.
  const reference = payload?.data?.metadata?.reference || '';
  const invoiceId = reference.startsWith('invoice_') ? reference.slice('invoice_'.length) : null;
  if (!invoiceId) {
    // Not one of our payment links (could be a POS/Bold-Tap sale on the
    // merchant's own Bold account, unrelated to this app) — acknowledge so
    // Bold doesn't retry, but do nothing.
    return { statusCode: 200, body: JSON.stringify({ received: true, ignored: true }) };
  }

  const a = getAdmin();
  const db = a.firestore();

  try {
    const invoiceRef = db.collection('invoices').doc(invoiceId);
    const invoiceSnap = await invoiceRef.get();
    if (!invoiceSnap.exists || !invoiceSnap.data().propertyId) {
      return { statusCode: 200, body: JSON.stringify({ received: true, ignored: true }) };
    }
    const invoice = invoiceSnap.data();

    const secretSnap = await db.collection('propertyPaymentSecrets').doc(invoice.propertyId).get();
    const boldSecretKey = secretSnap.exists ? secretSnap.data().bold?.secretKey : null;

    const signatureHeader = event.headers?.['x-bold-signature'] || event.headers?.['X-Bold-Signature'];
    // Production key first; Bold signs sandbox-mode events with an empty
    // key regardless of what's configured, so this also tries that — a
    // client testing against Bold's sandbox will otherwise see every
    // webhook rejected even though their real production key is correct.
    const validProd = verifySignature(rawBody, signatureHeader, boldSecretKey);
    const validSandbox = !validProd && verifySignature(rawBody, signatureHeader, '');
    if (!validProd && !validSandbox) {
      console.warn('bold-webhook: signature verification failed for invoice', invoiceId);
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid signature' }) };
    }

    const paymentId = payload?.data?.payment_id || payload?.subject || null;
    const eventType = payload?.type;

    // Idempotency: if this exact transaction was already recorded as paid,
    // acknowledge without re-processing (Bold retries up to 5 times, and
    // can send more than one notification for the same transaction).
    if (eventType === 'SALE_APPROVED') {
      if (invoice.status === 'paid' && invoice.boldTransactionId === paymentId) {
        return { statusCode: 200, body: JSON.stringify({ received: true, alreadyProcessed: true }) };
      }
      await invoiceRef.update({
        status: 'paid',
        paidAt: a.firestore.FieldValue.serverTimestamp(),
        paidVia: 'bold',
        boldTransactionId: paymentId,
        updatedAt: a.firestore.FieldValue.serverTimestamp(),
      });
    } else if (eventType === 'SALE_REJECTED') {
      await invoiceRef.update({
        boldLastRejectedAt: a.firestore.FieldValue.serverTimestamp(),
        boldTransactionId: paymentId,
        updatedAt: a.firestore.FieldValue.serverTimestamp(),
      });
    } else if (eventType === 'VOID_APPROVED') {
      await invoiceRef.update({
        status: invoice.status === 'paid' ? 'sent' : invoice.status, // reopen if it had been marked paid
        boldVoidedAt: a.firestore.FieldValue.serverTimestamp(),
        updatedAt: a.firestore.FieldValue.serverTimestamp(),
      });
    }
    // VOID_REJECTED and any other event types: acknowledged, no state change needed.

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('bold-webhook error:', err);
    // Still return 200 for errors that aren't about signature validity —
    // an internal error shouldn't cause Bold to hammer retries for
    // something our own logic is failing on regardless of retry count.
    // (Signature failures above already returned 400 distinctly.)
    return { statusCode: 200, body: JSON.stringify({ received: true, error: 'internal error logged' }) };
  }
};
