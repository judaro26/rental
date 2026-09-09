// netlify/functions/rentprep-webhook.js
// Receives postback data from RentPrep once a screening application's
// status changes (see the postbackUri set in create-screening-request.js's
// requestRentPrepScreening).
//
// RentPrep's own documentation confirms a postback is sent as an
// application/json POST, but doesn't provide a concrete sample payload
// the way the "Get Application Details" response is documented with one.
// Rather than guess at field names with false confidence, this stays
// deliberately conservative: it logs the raw payload for visibility, pulls
// out referenceId (which is guaranteed present, since it's the same value
// this app set when creating the request), and flags the application as
// needing a status refresh. fetch-screening-report.js's RentPrep branch —
// which calls the documented, concrete "Get Application Details" and "Get
// Report Status" endpoints — is the actual source of truth for the result;
// this webhook's job is just to prompt that refresh promptly rather than
// waiting for the admin to check back later on their own.
//
// No signature verification is available here — RentPrep's docs describe
// an optional Basic Auth header (postback_username/postback_password) as
// the closest thing to one, which create-screening-request.js currently
// leaves blank. Until those are set, this endpoint can't fully verify the
// caller and only uses the payload to trigger a re-check against
// RentPrep's own API — it never trusts a status or score value taken
// directly from the postback body itself.

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

  console.log('rentprep-webhook payload:', JSON.stringify(body));

  // referenceId was set to this app's own applicationId when the request
  // was created, so this is a direct lookup, not a search.
  const applicationId = body.referenceId || body.ReferenceId || body?.data?.referenceId;
  if (!applicationId) {
    console.warn('rentprep-webhook: no referenceId found in payload, cannot associate with an application.');
    return { statusCode: 200, body: JSON.stringify({ received: true }) }; // 200 regardless — RentPrep has no use for an error response here
  }

  try {
    const a = getAdmin();
    const db = a.firestore();
    const appRef = db.collection('applications').doc(applicationId);
    const snap = await appRef.get();
    if (!snap.exists) {
      console.warn(`rentprep-webhook: application ${applicationId} not found.`);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    await appRef.update({
      'screening.status': 'needs_refresh',
      'screening.lastWebhookAt': a.firestore.FieldValue.serverTimestamp(),
    });

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('rentprep-webhook error:', err);
    // Still 200 — this is a fire-and-forget notification from RentPrep's
    // side, not a request RentPrep will retry meaningfully based on our
    // response code, and an admin can always manually refresh via
    // fetch-screening-report.js regardless of whether this write succeeded.
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }
};
