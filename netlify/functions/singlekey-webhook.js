// netlify/functions/singlekey-webhook.js
// Receives SingleKey's screening status webhooks and updates the matching
// application's screening.status. On "Report Complete" (or "Partial Report
// Complete"), fetches the actual report data to store the score and
// readiness flags. Idempotent by construction — repeated delivery of the
// same event just re-sets the same status/data, which is harmless (the
// docs note "Report Complete" is retried once automatically on failure).
//
// Configure this URL (https://yoursite.com/api/singlekey-webhook) and an
// optional Handshake Token in the SingleKey Partner Portal.

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

const STATUS_MAP = {
  'Request sent to tenant': 'sent',
  'Tenant email opened': 'opened',
  'Report in Progress': 'in_progress',
  'Partial Report Complete': 'partial',
  'Report Complete': 'complete',
};

async function getActiveScreeningProvider(db) {
  const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
  const activeId = activeSnap.exists ? activeSnap.data().screening : null;
  if (!activeId) return null;
  const snap = await db.collection('integrationSecrets').doc(activeId).get();
  return snap.exists ? snap.data() : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const a = getAdmin();
  const db = a.firestore();

  // Optional Handshake Token verification, same override-with-fallback
  // pattern used elsewhere: a saved provider's own token takes priority.
  // Timing-safe comparison, same reasoning as Bold's webhook signature
  // check — a secret-token comparison shouldn't leak timing information.
  try {
    const provider = await getActiveScreeningProvider(db);
    const expected = provider?.handshakeToken;
    if (expected) {
      const got = event.headers?.['handshake-token'] || event.headers?.['Handshake-Token'] || '';
      const crypto = require('crypto');
      const expectedBuf = Buffer.from(expected);
      const gotBuf = Buffer.from(got);
      const valid = expectedBuf.length === gotBuf.length && crypto.timingSafeEqual(expectedBuf, gotBuf);
      if (!valid) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid handshake token' }) };
      }
    }
  } catch (err) {
    console.warn('singlekey-webhook: could not verify handshake token, proceeding without verification:', err.message);
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 200, body: JSON.stringify({ received: true, note: 'unparseable body ignored' }) }; }

  const { detail, purchase_token, external_tenant_id } = body;
  const applicationId = external_tenant_id;
  const status = STATUS_MAP[detail];

  // Always acknowledge with 200 even for events we don't recognize or
  // can't match to an application — per SingleKey's own best-practice
  // guidance, failures here should be logged, not surfaced as an error
  // that might trigger unnecessary retries.
  if (!status || !applicationId) {
    console.warn('singlekey-webhook: unrecognized event or missing tenant id:', detail, applicationId);
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  try {
    const appRef = db.collection('applications').doc(applicationId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) {
      console.warn(`singlekey-webhook: no application found for external_tenant_id ${applicationId}`);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    const update = { 'screening.status': status, 'screening.lastWebhookAt': a.firestore.FieldValue.serverTimestamp() };

    if (status === 'partial' || status === 'complete') {
      const provider = await getActiveScreeningProvider(db);
      if (provider) {
        const env = provider.environment === 'production' ? 'production' : 'sandbox';
        const token = env === 'production' ? provider.productionToken : provider.sandboxToken;
        const baseUrl = env === 'production' ? 'https://platform.singlekey.com' : 'https://sandbox.singlekey.com';
        if (token && purchase_token) {
          try {
            const res = await fetch(`${baseUrl}/api/report/${purchase_token}`, {
              headers: { Authorization: `Token ${token}` },
            });
            const report = await res.json();
            if (report.singlekey_score != null) update['screening.score'] = report.singlekey_score;
            if (report.pdf_report_ready != null) update['screening.pdfReady'] = report.pdf_report_ready;
            if (report.detail) update['screening.detail'] = report.detail;
          } catch (err) {
            console.error('singlekey-webhook: could not fetch report after completion event:', err.message);
          }
        }
      }
    }

    await appRef.update(update);
    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('singlekey-webhook error:', err);
    // Still return 200 — an internal error here shouldn't cause SingleKey
    // to endlessly retry a webhook we're not going to succeed at anyway.
    return { statusCode: 200, body: JSON.stringify({ received: true, error: 'internal error logged' }) };
  }
};
