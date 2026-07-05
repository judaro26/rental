// netlify/functions/upload-application-document.js
// Public (token-validated) upload used by documents.html. A prospective tenant
// uploads a supporting document (pay stub, ID, etc.). The file is stored in
// Netlify Blobs and attached to the application. Document-use consent is
// required and recorded server-side (timestamp + IP) on first upload.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, NETLIFY_SITE_ID (or SITE_ID),
//                    NETLIFY_API_TOKEN, SITE_URL

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

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'doc', 'docx'];

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let fileBuffer = null, fileName = '', mimeType = 'application/octet-stream';
    const bb = Busboy({ headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] || '' } });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      fileName = info.filename; mimeType = info.mimeType;
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on('finish', () => resolve({ fields, fileBuffer, fileName, mimeType }));
    bb.on('error', reject);
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
    const appId = fields.app, token = fields.token;
    if (!appId || !token) return { statusCode: 400, body: JSON.stringify({ error: 'Missing link parameters.' }) };
    if (!fileBuffer?.length) return { statusCode: 400, body: JSON.stringify({ error: 'No file received.' }) };
    if (fileBuffer.length > MAX_BYTES) return { statusCode: 400, body: JSON.stringify({ error: 'File is too large (max 15 MB).' }) };

    const ext = (fileName.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Unsupported file type. Please upload a PDF, image, or Word document.' }) };
    }

    const a  = getAdmin();
    const db = a.firestore();
    const ref = db.collection('applications').doc(appId);
    const snap = await ref.get();
    if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'This application could not be found.' }) };
    const app = snap.data();
    if (!app.responseToken || app.responseToken !== token) {
      return { statusCode: 403, body: JSON.stringify({ error: 'This link is invalid or has expired.' }) };
    }

    // Consent is required. It must already be recorded, or be provided with this upload.
    const consentAlready = !!(app.docConsent && app.docConsent.given);
    const consentNow = fields.consent === 'true';
    if (!consentAlready && !consentNow) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please provide your consent before uploading documents.' }) };
    }

    // Store the file in Netlify Blobs (same store the admin/tenant docs use)
    const { getStore } = require('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const blobToken = process.env.NETLIFY_API_TOKEN;
    if (!siteID || !blobToken) {
      const missing = [!siteID && 'NETLIFY_SITE_ID (or SITE_ID)', !blobToken && 'NETLIFY_API_TOKEN'].filter(Boolean);
      throw new Error(`Netlify Blobs: missing env vars: ${missing.join(', ')}.`);
    }
    const store = getStore({ name: 'documents', consistency: 'strong', siteID, token: blobToken });
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blobKey = `app_${appId}_${Date.now()}_${safeName}`;
    await store.set(blobKey, fileBuffer, { metadata: { contentType: mimeType, fileName } });

    const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
    const viewUrl = `${siteUrl}/api/view-doc?key=${encodeURIComponent(blobKey)}`;
    const type = ext === 'pdf' ? 'pdf' : ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext) ? 'image' : 'file';
    const label = (fields.label || 'Document').toString().slice(0, 120);

    const ipAddress = (event.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim() || 'unknown';
    const userAgent = event.headers?.['user-agent'] || 'unknown';

    const updates = {
      applicationDocuments: a.firestore.FieldValue.arrayUnion({
        name: label,
        label,
        fileName,
        type,
        url: viewUrl,
        storagePath: blobKey,
        uploadedAt: new Date().toISOString(),
      }),
      updatedAt: a.firestore.FieldValue.serverTimestamp(),
    };
    if (!consentAlready && consentNow) {
      updates.docConsent = {
        given: true,
        recordedAt: new Date().toISOString(),
        ipAddress,
        userAgent,
        legalText: 'Applicant consented to the collection, storage, and use of the uploaded documents for the purpose of evaluating their rental application and, if the application proceeds, for lease processing. Consent recorded with timestamp and IP address.',
      };
    }
    await ref.update(updates);

    return { statusCode: 200, body: JSON.stringify({ success: true, name: label, fileName, storagePath: blobKey }) };
  } catch (err) {
    console.error('upload-application-document error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
