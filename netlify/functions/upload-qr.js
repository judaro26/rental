// netlify/functions/upload-qr.js
// Stores a payment QR code image in Netlify Blobs.
//
//   POST /api/upload-qr?method=zelle|cashapp      multipart form with one file
//
// Which QR code it is travels in the URL (that is what the admin page sends); a form field named `method`
// is still accepted, and the URL wins if both are given. The type is REQUIRED and must be exactly one of
// the two: an upload that does not say which QR it is used to be silently stored as the Zelle one, which
// meant every Cash App upload overwrote the Zelle QR and the Cash App image never existed.
//
// Only plain images are accepted (PNG, JPEG, WebP — what the admin page's file picker offers). view-qr
// serves the image back from this site's own domain with the type recorded here, so it must be an image.
//
//   GET /api/view-qr?method=zelle  or  ?method=cashapp
const QR_METHODS = new Set(['zelle', 'cashapp']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const { getDb, getWorkspaceStore, withWorkspace } = require('./_lib/workspace');
const Busboy = require('busboy');

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

  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_API_TOKEN;
  if (!siteID || !token) {
    return { statusCode: 500, body: JSON.stringify({ error: 'NETLIFY_SITE_ID and NETLIFY_API_TOKEN required.' }) };
  }

  // Admin-only: this had no auth check, and unlike view-qr.js (which just
  // serves an intentionally-public image), this is the write side.
  // Anyone who could call this could replace a real payment QR code with
  // one pointing to their own Zelle/Cash App account — redirecting future
  // tenant rent payments to themselves, a direct financial-fraud vector,
  // not just an unauthorized-write concern.
  const a  = getAdmin();
  const db = getDb();
  const { verifyAdmin } = require('./_lib/verify-admin');
  const authResult = await verifyAdmin(event, db, a);
  if (authResult.error) return authResult.error;

  try {
    const bb = Busboy({ headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] || '' } });
    const result = await new Promise((resolve, reject) => {
      let fileBuffer = null, mimeType = 'image/png', method = null; // no default: see the header
      bb.on('field', (name, val) => { if (name === 'method') method = val; });
      bb.on('file',  (name, stream, info) => {
        mimeType = info.mimeType;
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end',  ()  => { fileBuffer = Buffer.concat(chunks); });
      });
      bb.on('finish', () => resolve({ fileBuffer, mimeType, method }));
      bb.on('error',  reject);
      const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body || '');
      bb.write(body); bb.end();
    });

    // The URL wins over a form field. No fallback: a missing or unknown type is refused, never guessed.
    const method = event.queryStringParameters?.method ?? result.method;
    if (!QR_METHODS.has(method)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'method must be exactly "zelle" or "cashapp" (it goes in the URL: /api/upload-qr?method=cashapp).' }) };
    }
    if (!result.fileBuffer?.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No file received' }) };
    }
    if (!IMAGE_TYPES.has(String(result.mimeType || '').toLowerCase())) {
      return { statusCode: 400, body: JSON.stringify({ error: 'The QR code must be a PNG, JPEG or WebP image.' }) };
    }

    const store   = getWorkspaceStore({ name: 'settings', consistency: 'strong', siteID, token });
    const blobKey = `${method}-qr`;
    await store.set(blobKey, result.fileBuffer, { metadata: { contentType: String(result.mimeType).toLowerCase() } });

    return { statusCode: 200, body: JSON.stringify({ success: true, key: blobKey }) };
  } catch (err) {
    console.error('upload-qr error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Resolves which workspace (client) this invocation belongs to — see _lib/workspace.js
exports.handler = withWorkspace(exports.handler);
