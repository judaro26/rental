// netlify/functions/delete-document.js
// Deletes a document from Firebase Storage and Firestore.
// Called by the admin panel to avoid CORS issues with direct Storage SDK calls.

let admin;
function getAdmin() {
  if (!admin) {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(
          JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        ),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
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

  const { docId, storagePath } = body;
  if (!docId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'docId is required' }) };
  }

  const a  = getAdmin();
  const db = a.firestore();

  try {
    // Delete from Storage (best-effort — don't fail if file is already gone)
    if (storagePath) {
      try {
        await a.storage().bucket().file(storagePath).delete();
      } catch (e) {
        if (e.code !== 404) console.warn('Storage delete warning:', e.message);
      }
    }

    // Delete Firestore doc
    await db.collection('documents').doc(docId).delete();

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('delete-document error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
