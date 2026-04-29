// netlify/functions/upload-document.js
// Stores uploaded documents in Netlify Blobs (free, no delivery restrictions)
// and saves metadata to Firestore.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT
// No Cloudinary needed — files served via /api/view-doc

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

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let fileBuffer = null, fileName = '', mimeType = 'application/octet-stream';
    const bb = Busboy({ headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] || '' } });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file',  (name, stream, info) => {
      fileName = info.filename; mimeType = info.mimeType;
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end',  ()  => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on('finish', () => resolve({ fields, fileBuffer, fileName, mimeType }));
    bb.on('error',  reject);
    const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body || '');
    bb.write(body); bb.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    return { statusCode: 500, body: JSON.stringify({ error: 'FIREBASE_SERVICE_ACCOUNT env var not set' }) };
  }

  try {
    const { fields, fileBuffer, fileName, mimeType } = await parseMultipart(event);
    if (!fileBuffer?.length) return { statusCode: 400, body: JSON.stringify({ error: 'No file received' }) };

    const { name, category, tenantId, propertyId, propertyWide, adminOnly } = fields;
    if (!name) return { statusCode: 400, body: JSON.stringify({ error: 'Document name is required' }) };

    // Store in Netlify Blobs
    const { getStore } = require('@netlify/blobs');
    const store   = getStore({ name: 'documents', consistency: 'strong' });
    const blobKey = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await store.set(blobKey, fileBuffer, { metadata: { contentType: mimeType, fileName } });

    // The URL tenants/admin use to view the file via our proxy
    const siteUrl    = (process.env.SITE_URL || '').replace(/\/+$/, '');
    const viewUrl    = `${siteUrl}/api/view-doc?key=${encodeURIComponent(blobKey)}`;
    const storagePath = blobKey; // used for deletion

    const ext  = fileName.split('.').pop().toLowerCase();
    const type = ext === 'pdf' ? 'pdf' : ['jpg','jpeg','png','gif','webp'].includes(ext) ? 'image' : 'file';

    const a   = getAdmin();
    const ref = await a.firestore().collection('documents').add({
      name, category: category || 'Other',
      url: viewUrl,
      storagePath: blobKey,
      fileName, type,
      tenantId:    tenantId    || null,
      propertyId:  propertyId  || null,
      propertyWide: propertyWide === 'true',
      adminOnly:   adminOnly   === 'true',
      uploadedAt:  a.firestore.FieldValue.serverTimestamp(),
      uploadedBy:  'admin',
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, docId: ref.id, url: viewUrl, storagePath: blobKey }) };
  } catch (err) {
    console.error('upload-document error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
