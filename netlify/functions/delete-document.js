// netlify/functions/delete-document.js
// Deletes a document from Netlify Blobs and Firestore.

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

  const { docId, storagePath } = body;
  if (!docId) return { statusCode: 400, body: JSON.stringify({ error: 'docId is required' }) };

  try {
    // Delete from Netlify Blobs
    if (storagePath) {
      try {
        const { getStore } = require('@netlify/blobs');
        const store = getStore({ name: 'documents', consistency: 'strong' });
        await store.delete(storagePath);
      } catch (e) { console.warn('Blob delete warning:', e.message); }
    }

    // Delete Firestore record
    const a = getAdmin();
    await a.firestore().collection('documents').doc(docId).delete();

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('delete-document error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
