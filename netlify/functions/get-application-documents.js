// netlify/functions/get-application-documents.js
// Public (token-validated) read used by documents.html to render the secure
// document-upload page: which documents were requested, what's already uploaded,
// and whether document-use consent has been recorded.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT

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
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const appId = event.queryStringParameters?.app;
  const token = event.queryStringParameters?.token;
  if (!appId || !token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing link parameters.' }) };
  }

  try {
    const db   = getAdmin().firestore();
    const snap = await db.collection('applications').doc(appId).get();
    if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'This application could not be found.' }) };
    const app = snap.data();

    if (!app.responseToken || app.responseToken !== token) {
      return { statusCode: 403, body: JSON.stringify({ error: 'This link is invalid or has expired. Please contact us for a new one.' }) };
    }

    let siteName = 'Tenant Portal';
    try { const s = await db.collection('settings').doc('site').get(); if (s.exists) siteName = s.data().siteName || siteName; } catch {}

    const uploaded = Array.isArray(app.applicationDocuments)
      ? app.applicationDocuments.map(d => ({ name: d.name || d.fileName || 'Document', label: d.label || '', uploadedAt: d.uploadedAt || '', storagePath: d.storagePath || '' }))
      : [];

    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        firstName:    app.firstName || '',
        propertyName: app.propertyName || '',
        unitLabel:    app.unitLabel || '',
        requested:    (app.docRequest && Array.isArray(app.docRequest.requested)) ? app.docRequest.requested : [],
        message:      (app.docRequest && app.docRequest.message) || '',
        uploaded,
        consentGiven: !!(app.docConsent && app.docConsent.given),
        siteName,
      }),
    };
  } catch (err) {
    console.error('get-application-documents error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong loading your upload page.' }) };
  }
};
