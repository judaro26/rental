// netlify/functions/sign-cloudinary-upload.js
// Generates a Cloudinary upload signature so the browser can upload directly
// to Cloudinary (no file passes through our own server/function, avoiding
// Netlify Functions' request-size limits entirely). Signed (not unsigned)
// uploads so the resulting asset can be made publicly accessible without
// exposing a permanently-reusable unsigned preset.
//
// This exact contract is already relied on by tenant-portal.html's
// maintenance-photo upload — this function fills in that missing piece, and
// the property-image upload in admin.html reuses the same contract rather
// than inventing a second way to do the same thing.
//
// POST body: { folder: 'maintenance/<uid>' | 'properties/<id>' | ... }
// Response:  { signature, timestamp, apiKey }
//
// Credentials: checks integrationSecrets/storage (set via
// manage-integrations.js) first, falling back to CLOUDINARY_API_KEY /
// CLOUDINARY_API_SECRET env vars if nothing is configured there — same
// override-with-fallback pattern as email, so this keeps working
// unchanged today and only changes behavior once someone actually
// configures something through the new UI.

const crypto = require('crypto');

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

async function getCloudinaryCredentials() {
  try {
    const a = getAdmin();
    const snap = await a.firestore().collection('integrationSecrets').doc('storage').get();
    if (snap.exists) {
      const d = snap.data();
      if (d.cloudName && d.apiKey && d.apiSecret) {
        return { cloudName: d.cloudName, apiKey: d.apiKey, apiSecret: d.apiSecret };
      }
    }
  } catch (err) {
    console.warn('sign-cloudinary-upload: could not check storage override, using env vars:', err.message);
  }
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || null,
    apiKey: process.env.CLOUDINARY_API_KEY || null,
    apiSecret: process.env.CLOUDINARY_API_SECRET || null,
  };
}

// Cloudinary's documented signing algorithm: every parameter that will be
// sent with the upload EXCEPT file/cloud_name/resource_type/api_key/signature
// must be included here, sorted alphabetically by key, joined as
// "key=value&key=value", with the api_secret appended, then SHA-1 hashed.
function signParams(params, apiSecret) {
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const creds = await getCloudinaryCredentials();
  if (!creds.apiKey || !creds.apiSecret) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Cloudinary is not configured (set it up under Settings → Integrations, or set CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET).' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Keep folders scoped to known prefixes — this doesn't gate WHO can ask
  // for a signature (matching the existing maintenance-photo flow, which
  // has never required auth for this), just prevents an arbitrary folder
  // path from being requested.
  const folder = (body.folder || '').trim();
  const allowedPrefixes = ['maintenance/', 'properties/'];
  if (!folder || !allowedPrefixes.some(p => folder.startsWith(p))) {
    return { statusCode: 400, body: JSON.stringify({ error: 'folder must start with one of: ' + allowedPrefixes.join(', ') }) };
  }

  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = { access_mode: 'public', folder, timestamp };
  const signature = signParams(paramsToSign, creds.apiSecret);

  return {
    statusCode: 200,
    body: JSON.stringify({ signature, timestamp, apiKey: creds.apiKey }),
  };
};

