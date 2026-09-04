// netlify/functions/view-doc.js
// Serves a document stored in Netlify Blobs directly to the browser.
//
// This endpoint is used from two different worlds: Firebase-authenticated
// tenants/admins viewing their own uploaded documents (the `documents`
// Firestore collection), and unauthenticated rental applicants viewing
// application attachments via the separate responseToken system (see
// submit-application-response.js and friends). Both reach this same URL
// as a plain browser link — a direct navigation or <img>/<iframe> src —
// so neither can attach a custom Authorization header the way a fetch()
// call could.
//
// This fix covers the `documents` collection case only: if the key
// belongs to a document record, a valid Bearer token is now required, and
// ownership is checked against the exact same logic already enforced by
// this collection's Firestore rule (admin, the owning tenant, or a
// propertyWide doc). Frontend callers switched from a plain <a href> to
// fetching with the token and rendering the result as a Blob URL — see
// admin.html's previewAdminDoc/buildGroupedBlobUrl for the pattern.
//
// Application documents are NOT covered by this change and are served
// exactly as before (no auth check) — they're a separate storage/data
// path (an array field on the applications doc, not a documents-
// collection record) that needs its own pass, ideally reusing the
// responseToken this endpoint doesn't yet check. Flagging rather than
// guessing at that flow in the same change.
//
// GET /api/view-doc?key={blobKey}
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT (for the documents-collection
// auth check), plus NETLIFY_SITE_ID/SITE_ID and NETLIFY_API_TOKEN as before.

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
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { key } = event.queryStringParameters || {};
  if (!key) return { statusCode: 400, body: 'Missing key parameter' };

  try {
    const a  = getAdmin();
    const db = a.firestore();

    // Look up whether this key belongs to a documents-collection record.
    // If it does, this is the tenant/admin path and needs real auth. If it
    // doesn't match anything here, it's presumed to be an application
    // document (or a legacy/unknown key) and falls through unchanged,
    // per the scope note above.
    const docQuery = await db.collection('documents').where('storagePath', '==', key).limit(1).get();
    if (!docQuery.empty) {
      const docData = docQuery.docs[0].data();

      const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
      const bearerMatch = authHeader.match(/^Bearer (.+)$/i);
      if (!bearerMatch) return { statusCode: 401, body: 'Missing Authorization bearer token.' };

      let decoded;
      try { decoded = await a.auth().verifyIdToken(bearerMatch[1]); }
      catch { return { statusCode: 401, body: 'Invalid or expired session.' }; }

      const isOwner = docData.tenantId === decoded.uid;
      const isPropertyWide = docData.propertyWide === true;
      if (!isOwner && !isPropertyWide) {
        const adminSnap = await db.collection('admins').doc(decoded.uid).get();
        if (!adminSnap.exists || adminSnap.data().status === 'revoked') {
          return { statusCode: 403, body: 'Not authorized to view this document.' };
        }
      }
    }

    const { getStore } = require('@netlify/blobs');
    // Netlify injects SITE_ID automatically; NETLIFY_API_TOKEN must be set manually
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const blobToken = process.env.NETLIFY_API_TOKEN;
    if (!siteID || !blobToken) {
      const missing = [!siteID && 'NETLIFY_SITE_ID (or SITE_ID)', !blobToken && 'NETLIFY_API_TOKEN'].filter(Boolean);
      throw new Error(`Netlify Blobs: missing env vars: ${missing.join(', ')}. Add them in Netlify → Site → Environment variables.`);
    }
    const store = getStore({ name: 'documents', consistency: 'strong', siteID, token: blobToken });

    const blob = await store.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!blob) return { statusCode: 404, body: 'Document not found' };

    const { data, metadata } = blob;
    const contentType = metadata?.contentType || 'application/octet-stream';
    const buffer      = Buffer.from(data);

    return {
      statusCode:      200,
      headers: {
        'Content-Type':        contentType,
        'Content-Disposition': 'inline',
        'Cache-Control':       'private, max-age=3600',
      },
      body:            buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('view-doc error:', err);
    return { statusCode: 500, body: err.message };
  }
};
