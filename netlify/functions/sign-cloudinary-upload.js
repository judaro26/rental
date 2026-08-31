// netlify/functions/sign-cloudinary-upload.js
// Generates an upload authorization for whichever storage backend is
// currently active — Cloudinary (signed FormData upload) or Cloudflare R2
// (presigned PUT URL) — so the browser can upload directly to storage with
// no file passing through our own server/function, avoiding Netlify
// Functions' request-size limits entirely.
//
// This exact contract is already relied on by tenant-portal.html's
// maintenance-photo upload, admin.html's property-photo/logo uploads —
// the response shape now includes a `backend` field so a single shared
// client-side helper (/shared/upload.js) can branch correctly rather than
// each call site needing its own backend-specific logic.
//
// POST body: { folder: 'maintenance/<uid>' | 'properties/<id>' | ..., fileName?, contentType? }
// Response (Cloudinary): { backend: 'cloudinary', signature, timestamp, apiKey, cloudName }
// Response (R2):         { backend: 'r2', uploadUrl, publicUrl }
//
// Credentials: checks integrationSecrets/storage (set via
// manage-integrations.js) first, falling back to CLOUDINARY_API_KEY /
// CLOUDINARY_API_SECRET env vars if nothing is configured there (R2 has no
// env-var fallback — it's a newer addition with no prior established
// convention to preserve) — same override-with-fallback pattern as email.

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

async function getActiveStorageConfig() {
  try {
    const a = getAdmin();
    const db = a.firestore();
    const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
    const activeId = activeSnap.exists ? activeSnap.data().storage : null;
    if (activeId) {
      const snap = await db.collection('integrationSecrets').doc(activeId).get();
      if (snap.exists) {
        const d = snap.data();
        if (d.backend === 'r2' && d.accountId && d.accessKeyId && d.secretAccessKey && d.bucketName && d.publicUrl) {
          return { backend: 'r2', accountId: d.accountId, accessKeyId: d.accessKeyId, secretAccessKey: d.secretAccessKey, bucketName: d.bucketName, publicUrl: d.publicUrl.replace(/\/+$/, '') };
        }
        if (d.cloudName && d.apiKey && d.apiSecret) {
          return { backend: 'cloudinary', cloudName: d.cloudName, apiKey: d.apiKey, apiSecret: d.apiSecret };
        }
      }
    }
  } catch (err) {
    console.warn('sign-cloudinary-upload: could not check storage override, using env vars:', err.message);
  }
  if (process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    return { backend: 'cloudinary', cloudName: process.env.CLOUDINARY_CLOUD_NAME || null, apiKey: process.env.CLOUDINARY_API_KEY, apiSecret: process.env.CLOUDINARY_API_SECRET };
  }
  return null;
}

// Cloudinary's documented signing algorithm: every parameter that will be
// sent with the upload EXCEPT file/cloud_name/resource_type/api_key/signature
// must be included here, sorted alphabetically by key, joined as
// "key=value&key=value", with the api_secret appended, then SHA-1 hashed.
function signCloudinaryParams(params, apiSecret) {
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const config = await getActiveStorageConfig();
  if (!config) {
    return { statusCode: 500, body: JSON.stringify({ error: 'No storage provider is configured (set one up under Settings → Integrations, or set CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET).' }) };
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

  if (config.backend === 'r2') {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: true, // R2 supports both addressing styles; path-style is the longer-established, more conservative choice
    });
    const rawExt = (body.fileName || '').split('.').pop();
    const extension = (rawExt && rawExt.length <= 5 && /^[a-zA-Z0-9]+$/.test(rawExt)) ? rawExt.toLowerCase() : 'bin';
    const key = `${folder}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${extension}`;
    let uploadUrl;
    try {
      uploadUrl = await getSignedUrl(client, new PutObjectCommand({
        Bucket: config.bucketName, Key: key, ContentType: body.contentType || 'application/octet-stream',
      }), { expiresIn: 300 });
    } catch (err) {
      console.error('sign-cloudinary-upload: R2 presign failed:', err.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not prepare upload: ' + err.message }) };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ backend: 'r2', uploadUrl, publicUrl: `${config.publicUrl}/${key}` }),
    };
  }

  // Cloudinary (default)
  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = { access_mode: 'public', folder, timestamp };
  const signature = signCloudinaryParams(paramsToSign, config.apiSecret);

  return {
    statusCode: 200,
    body: JSON.stringify({ backend: 'cloudinary', signature, timestamp, apiKey: config.apiKey, cloudName: config.cloudName }),
  };
};
