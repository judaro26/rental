// netlify/functions/upload-qr.js
// Stores a payment QR code image in Netlify Blobs.
// POST with multipart form: file + method ('zelle' | 'cashapp')
// GET /api/view-qr?method=zelle  or  ?method=cashapp

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
  const db = a.firestore();
  const { verifyAdmin } = require('./_lib/verify-admin');
  const authResult = await verifyAdmin(event, db, a);
  if (authResult.error) return authResult.error;

  try {
    const bb = Busboy({ headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] || '' } });
    const result = await new Promise((resolve, reject) => {
      let fileBuffer = null, mimeType = 'image/png', method = 'zelle';
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

    if (!result.fileBuffer?.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No file received' }) };
    }

    const { getStore } = require('@netlify/blobs');
    const store   = getStore({ name: 'settings', consistency: 'strong', siteID, token });
    const blobKey = `${result.method}-qr`;
    await store.set(blobKey, result.fileBuffer, { metadata: { contentType: result.mimeType } });

    return { statusCode: 200, body: JSON.stringify({ success: true, key: blobKey }) };
  } catch (err) {
    console.error('upload-qr error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
