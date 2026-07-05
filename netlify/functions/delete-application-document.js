// netlify/functions/delete-application-document.js
// Public (token-validated) delete used by documents.html so an applicant can
// remove (and thereby replace) a document they uploaded, before it's reviewed.
// Removes the blob from Netlify Blobs and detaches it from the application.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, NETLIFY_SITE_ID (or SITE_ID), NETLIFY_API_TOKEN

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

  const { app: appId, token, storagePath } = body;
  if (!appId || !token || !storagePath) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing parameters.' }) };
  }

  const a  = getAdmin();
  const db = a.firestore();

  try {
    const ref  = db.collection('applications').doc(appId);
    const snap = await ref.get();
    if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'This application could not be found.' }) };
    const appData = snap.data();

    if (!appData.responseToken || appData.responseToken !== token) {
      return { statusCode: 403, body: JSON.stringify({ error: 'This link is invalid or has expired.' }) };
    }

    // Safety: only allow deleting a document that belongs to this application.
    const docs = Array.isArray(appData.applicationDocuments) ? appData.applicationDocuments : [];
    const target = docs.find(d => d.storagePath === storagePath);
    if (!target || !String(storagePath).startsWith(`app_${appId}_`)) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Document not found.' }) };
    }

    // Remove the blob (best-effort — proceed to detach even if this fails).
    try {
      const { getStore } = require('@netlify/blobs');
      const siteID   = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
      const blobToken = process.env.NETLIFY_API_TOKEN;
      if (siteID && blobToken) {
        const store = getStore({ name: 'documents', consistency: 'strong', siteID, token: blobToken });
        await store.delete(storagePath);
      }
    } catch (e) { console.warn('delete-application-document blob delete failed:', e.message); }

    const remaining = docs.filter(d => d.storagePath !== storagePath);
    await ref.update({
      applicationDocuments: remaining,
      updatedAt: a.firestore.FieldValue.serverTimestamp(),
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('delete-application-document error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
