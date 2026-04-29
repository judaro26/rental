// netlify/functions/upload-document.js
// Uploads a document to Cloudinary server-side (bypasses all delivery restrictions)
// and saves metadata to Firestore.
//
// Required env vars:
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//   FIREBASE_SERVICE_ACCOUNT

const Busboy     = require('busboy');
const cloudinary = require('cloudinary').v2;

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

  const missing = ['CLOUDINARY_CLOUD_NAME','CLOUDINARY_API_KEY','CLOUDINARY_API_SECRET','FIREBASE_SERVICE_ACCOUNT']
    .filter(k => !process.env[k]);
  if (missing.length) {
    return { statusCode: 500, body: JSON.stringify({ error: `Missing env vars: ${missing.join(', ')}` }) };
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure:     true,
  });

  try {
    const { fields, fileBuffer, fileName, mimeType } = await parseMultipart(event);
    if (!fileBuffer?.length) return { statusCode: 400, body: JSON.stringify({ error: 'No file received' }) };

    const { name, category, tenantId, propertyId, propertyWide, adminOnly, scope } = fields;
    if (!name) return { statusCode: 400, body: JSON.stringify({ error: 'Document name is required' }) };

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const folder   = scope || 'documents/misc';

    // Server-side SDK upload — access_mode: public is allowed and enforced
    const uploadResult = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder, resource_type: 'auto', access_mode: 'public', use_filename: true, unique_filename: true },
        (err, result) => err ? reject(err) : resolve(result)
      ).end(fileBuffer);
    });

    const downloadUrl = uploadResult.secure_url;
    const storagePath = uploadResult.public_id;
    const ext  = fileName.split('.').pop().toLowerCase();
    const type = ext === 'pdf' ? 'pdf' : ['jpg','jpeg','png','gif','webp'].includes(ext) ? 'image' : 'file';

    const a   = getAdmin();
    const ref = await a.firestore().collection('documents').add({
      name, category: category || 'Other', url: downloadUrl, storagePath,
      fileName, type,
      tenantId:    tenantId    || null,
      propertyId:  propertyId  || null,
      propertyWide: propertyWide === 'true',
      adminOnly:   adminOnly   === 'true',
      uploadedAt:  a.firestore.FieldValue.serverTimestamp(),
      uploadedBy:  'admin',
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, docId: ref.id, url: downloadUrl, storagePath }) };
  } catch (err) {
    console.error('upload-document error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
