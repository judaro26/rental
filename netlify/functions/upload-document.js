// netlify/functions/upload-document.js
// Accepts a multipart/form-data file upload from the admin panel,
// uploads the file to Firebase Storage via the Admin SDK (server-to-server,
// no CORS issues), saves metadata to Firestore, and returns the download URL.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, FIREBASE_STORAGE_BUCKET
//   FIREBASE_STORAGE_BUCKET — e.g. rental-a0793.appspot.com  (no gs:// prefix)

const Busboy = require('busboy');

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

// Parse multipart body using busboy
function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let fileBuffer = null;
    let fileName   = '';
    let mimeType   = 'application/octet-stream';

    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
    const bb = Busboy({ headers: { 'content-type': contentType } });

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('file', (name, stream, info) => {
      fileName = info.filename;
      mimeType = info.mimeType;
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end',  ()    => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('finish', () => resolve({ fields, fileBuffer, fileName, mimeType }));
    bb.on('error',  reject);

    // Netlify sends body as base64 when isBase64Encoded is true
    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body || '');

    bb.write(body);
    bb.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Validate env vars ──────────────────────────────────────────────────────
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    return { statusCode: 500, body: JSON.stringify({ error: 'FIREBASE_STORAGE_BUCKET env var not set (e.g. your-project.appspot.com)' }) };
  }

  try {
    const { fields, fileBuffer, fileName, mimeType } = await parseMultipart(event);

    if (!fileBuffer || !fileBuffer.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No file received' }) };
    }

    const { name, category, tenantId, propertyId, propertyWide, scope } = fields;

    if (!name) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Document name is required' }) };
    }

    const a  = getAdmin();
    const db = a.firestore();

    // ── Upload to Firebase Storage ─────────────────────────────────────────
    const safeName    = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `documents/${scope || 'misc'}/${Date.now()}_${safeName}`;
    const bucket      = a.storage().bucket();
    const fileRef     = bucket.file(storagePath);

    await fileRef.save(fileBuffer, {
      metadata: { contentType: mimeType },
      resumable: false,
    });

    // Make the file publicly readable so tenants can view it in the browser
    await fileRef.makePublic();
    const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;

    // ── Determine file type ────────────────────────────────────────────────
    const ext  = fileName.split('.').pop().toLowerCase();
    const type = ext === 'pdf' ? 'pdf'
               : ['jpg','jpeg','png','gif','webp'].includes(ext) ? 'image'
               : 'file';

    // ── Save Firestore metadata ────────────────────────────────────────────
    const docRef = await db.collection('documents').add({
      name,
      category:     category || 'Other',
      url:          downloadUrl,
      storagePath,
      fileName:     fileName,
      type,
      tenantId:     tenantId   || null,
      propertyId:   propertyId || null,
      propertyWide: propertyWide === 'true',
      uploadedAt:   a.firestore.FieldValue.serverTimestamp(),
      uploadedBy:   'admin',
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, docId: docRef.id, url: downloadUrl, storagePath }),
    };

  } catch (err) {
    console.error('upload-document error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
