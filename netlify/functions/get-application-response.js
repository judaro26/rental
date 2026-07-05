// netlify/functions/get-application-response.js
// Public (token-validated) read used by respond.html to prefill the applicant
// response form. Returns only the fields the applicant needs to see/confirm.
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

    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        firstName:   app.firstName || '',
        lastName:    app.lastName || '',
        propertyName: app.propertyName || '',
        unitLabel:   app.unitLabel || '',
        moveInDate:  app.moveInDate || '',
        occupants:   Array.isArray(app.occupants) ? app.occupants : [],
        references:  Array.isArray(app.references) ? app.references : [],
        responseNotes: app.responseNotes || '',
        alreadySubmitted: !!app.responseSubmittedAt,
        siteName,
      }),
    };
  } catch (err) {
    console.error('get-application-response error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong loading your form.' }) };
  }
};
