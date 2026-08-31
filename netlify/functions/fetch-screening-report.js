// netlify/functions/fetch-screening-report.js
// Admin-triggered: fetches the current status of a screening request,
// including fresh viewing links. Exists separately from the webhook
// handler because SingleKey's S3 report_url expires after 5 days — an
// admin viewing a report a week later needs a fresh call, not a cached
// link from whenever the webhook first fired. Also useful as a manual
// "check status now" for admins who don't want to wait for a webhook.

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

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) };

  const a = getAdmin();
  const db = a.firestore();

  let decoded;
  try { decoded = await a.auth().verifyIdToken(match[1]); }
  catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) }; }

  const adminSnap = await db.collection('admins').doc(decoded.uid).get();
  if (!adminSnap.exists) return { statusCode: 403, body: JSON.stringify({ error: 'Caller is not an admin.' }) };
  if (adminSnap.data().status === 'revoked') return { statusCode: 403, body: JSON.stringify({ error: 'Access revoked.' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { applicationId } = body;
  if (!applicationId) return { statusCode: 400, body: JSON.stringify({ error: 'applicationId is required.' }) };

  try {
    const appRef = db.collection('applications').doc(applicationId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Application not found.' }) };
    const application = appSnap.data();
    const screening = application.screening;
    if (!screening?.purchaseToken) return { statusCode: 400, body: JSON.stringify({ error: 'No screening has been requested for this applicant yet.' }) };

    const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
    const activeId = activeSnap.exists ? activeSnap.data().screening : null;
    if (!activeId) return { statusCode: 400, body: JSON.stringify({ error: 'No screening provider configured.' }) };
    const providerSnap = await db.collection('integrationSecrets').doc(activeId).get();
    const provider = providerSnap.exists ? providerSnap.data() : null;
    if (!provider) return { statusCode: 400, body: JSON.stringify({ error: 'No screening provider configured.' }) };

    const env = screening.environment === 'production' ? 'production' : 'sandbox';
    const token = env === 'production' ? provider.productionToken : provider.sandboxToken;
    const baseUrl = env === 'production' ? 'https://platform.singlekey.com' : 'https://sandbox.singlekey.com';
    if (!token) return { statusCode: 400, body: JSON.stringify({ error: `No ${env} token configured.` }) };

    const res = await fetch(`${baseUrl}/api/report/${screening.purchaseToken}`, {
      headers: { Authorization: `Token ${token}` },
    });
    const report = await res.json();

    const update = { 'screening.lastCheckedAt': a.firestore.FieldValue.serverTimestamp() };
    if (report.success === true) {
      update['screening.status'] = 'complete';
      if (report.singlekey_score != null) update['screening.score'] = report.singlekey_score;
      if (report.pdf_report_ready != null) update['screening.pdfReady'] = report.pdf_report_ready;
    } else if (report.detail) {
      update['screening.detail'] = report.detail;
    }
    await appRef.update(update);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        complete: report.success === true,
        score: report.singlekey_score ?? null,
        minScore: provider.minScore || null,
        detail: report.detail || null,
        htmlReportUrl: report.html_report_url || null,
        reportUrl: report.report_url || null, // expires in 5 days from SingleKey's side
        formUrl: report.form_url || null,
        tenantFormUrl: report.tenant_form_url || null,
        errors: report.errors || null,
      }),
    };

  } catch (err) {
    console.error('fetch-screening-report error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
