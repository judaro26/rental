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
// The `documents` collection case: if the key belongs to a document
// record, a valid Bearer token is required, and ownership is checked
// against the exact same logic already enforced by this collection's
// Firestore rule (admin, the owning tenant, or a propertyWide doc).
// Frontend callers switched from a plain <a href> to fetching with the
// token and rendering the result as a Blob URL — see admin.html's
// previewAdminDoc/buildGroupedBlobUrl for the pattern.
//
// The application-document case (an array field on the applications doc,
// not a documents-collection record) has TWO legitimate audiences with
// different auth models, and needs to accept either:
//   - The applicant themselves, via ?app={applicationId}&token={responseToken}
//     — same token already used by submit-application-response.js,
//     get-application-documents.js, etc. Verified against
//     applications/{app}.responseToken, then confirmed the specific key
//     actually belongs to that application's applicationDocuments array
//     (not just that the token is valid for *some* application).
//   - The admin reviewing the application, via a Bearer token — same
//     admin check as the documents-collection case above.
// A key matching neither branch, and not found in `documents` either, is
// treated as not found rather than served — this endpoint doesn't accept
// a bare key with no proof of access as a fallback.
//
// GET /api/view-doc?key={blobKey}                       (documents collection)
// GET /api/view-doc?key={blobKey}&app={id}&token={tok}  (application document, applicant)
// GET /api/view-doc?key={blobKey}                       (application document, admin — Bearer header)
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, plus NETLIFY_SITE_ID/SITE_ID
// and NETLIFY_API_TOKEN as before.

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
    } else {
      // Not a documents-collection record — check whether this is an
      // application document instead, which has two legitimate audiences
      // with two different auth models.
      let authorized = false;

      // Path 1: the applicant themselves, via the same responseToken used
      // throughout the application-response system (submit-application-
      // response.js, get-application-documents.js, etc).
      const { app: appId, token } = event.queryStringParameters || {};
      if (appId && token) {
        const appSnap = await db.collection('applications').doc(appId).get();
        if (appSnap.exists) {
          const appData = appSnap.data();
          if (appData.responseToken && appData.responseToken === token) {
            // Confirm this specific key actually belongs to this
            // application's own documents — a valid token proves identity
            // for that application, not blanket access to any file.
            const belongsToApp = (appData.applicationDocuments || []).some(d => d.storagePath === key);
            if (belongsToApp) authorized = true;
          }
        }
      }

      // Path 2: an admin reviewing the application, via Bearer token —
      // same admin check as the documents-collection case above.
      if (!authorized) {
        const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
        const bearerMatch = authHeader.match(/^Bearer (.+)$/i);
        if (bearerMatch) {
          try {
            const decoded = await a.auth().verifyIdToken(bearerMatch[1]);
            const adminSnap = await db.collection('admins').doc(decoded.uid).get();
            if (adminSnap.exists && adminSnap.data().status !== 'revoked') authorized = true;
          } catch { /* invalid token just means this path didn't authorize, not a hard error */ }
        }
      }

      if (!authorized) {
        return { statusCode: 403, body: 'Not authorized to view this document.' };
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
