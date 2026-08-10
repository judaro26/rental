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

  const { docId, storagePath, documentGroupId } = body;
  if (!docId && !documentGroupId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'docId or documentGroupId is required' }) };
  }

  try {
    const a  = getAdmin();
    const db = a.firestore();

    // Gather the set of {docId, storagePath} pairs to delete. For a chunked
    // upload this is every part sharing the group id, not just the one
    // record the person clicked on.
    let targets = [{ docId, storagePath }];
    if (documentGroupId) {
      const snap = await db.collection('documents').where('documentGroupId', '==', documentGroupId).get();
      targets = snap.docs.map(d => ({ docId: d.id, storagePath: d.data().storagePath }));
      if (!targets.length) targets = [{ docId, storagePath }];
    }

    const { getStore } = require('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token  = process.env.NETLIFY_API_TOKEN;
    let store = null;
    if (siteID && token) {
      store = getStore({ name: 'documents', consistency: 'strong', siteID, token });
    } else {
      console.warn('Netlify Blobs env vars missing — skipping blob cleanup, deleting Firestore records only.');
    }

    for (const t of targets) {
      if (!t.docId) continue;
      if (store && t.storagePath) {
        try { await store.delete(t.storagePath); }
        catch (e) { console.warn(`Blob delete warning for ${t.storagePath}:`, e.message); }
      }
      try { await db.collection('documents').doc(t.docId).delete(); }
      catch (e) { console.warn(`Firestore delete warning for ${t.docId}:`, e.message); }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, deletedCount: targets.length }) };
  } catch (err) {
    console.error('delete-document error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
