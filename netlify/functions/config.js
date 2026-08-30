/**
 * /api/config
 * Serves Firebase client config + Stripe publishable key from Netlify env vars.
 * Never hardcode these values in HTML — always fetch from this endpoint.
 *
 * Required Netlify environment variables:
 *   FIREBASE_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_SENDER_ID, FIREBASE_APP_ID
 *   STRIPE_PUBLISHABLE_KEY
 *   ALLOWED_ORIGIN  (e.g. https://your-site.netlify.app)
 */

let admin;
function getAdmin() {
  if (!admin) {
    admin = require('firebase-admin');
    if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      });
    }
  }
  return admin;
}

// If a Super Admin has configured a custom Cloudinary account via
// manage-integrations.js, prefer it over the environment variable default.
// Fails silently to the env var on any error — a lookup hiccup here should
// never break the whole config endpoint.
async function getCloudinaryCloudName() {
  try {
    const a = getAdmin();
    if (!a.apps.length) return process.env.CLOUDINARY_CLOUD_NAME || null;
    const db = a.firestore();
    const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
    const activeId = activeSnap.exists ? activeSnap.data().storage : null;
    if (activeId) {
      const snap = await db.collection('integrationSecrets').doc(activeId).get();
      if (snap.exists && snap.data().cloudName) return snap.data().cloudName;
    }
  } catch (err) {
    console.warn('config.js: could not check storage override, using env var:', err.message);
  }
  return process.env.CLOUDINARY_CLOUD_NAME || null;
}

exports.handler = async (event) => {
  // ── Origin check ────────────────────────────────────────────────────────────
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  const requestOrigin = event.headers?.origin || event.headers?.referer || '';
  const isLocalDev    = requestOrigin.startsWith('http://localhost') ||
                        requestOrigin.startsWith('http://127.0.0.1');

  if (allowedOrigin && !isLocalDev) {
    const originOk = requestOrigin === allowedOrigin ||
                     requestOrigin.startsWith(allowedOrigin);
    if (!originOk) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
    }
  }

  // ── Method check ────────────────────────────────────────────────────────────
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Validate env vars ───────────────────────────────────────────────────────
  const required = ['FIREBASE_API_KEY','FIREBASE_PROJECT_ID','FIREBASE_SENDER_ID','FIREBASE_APP_ID','STRIPE_PUBLISHABLE_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Missing env vars:', missing);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }
  // Cloudinary is optional — warn but don't block
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_UPLOAD_PRESET) {
    console.warn('CLOUDINARY_CLOUD_NAME or CLOUDINARY_UPLOAD_PRESET not set — document uploads will be unavailable.');
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const cloudinaryCloud = await getCloudinaryCloudName();

  return {
    statusCode: 200,
    headers: {
      'Content-Type':                'application/json',
      'Cache-Control':               'private, max-age=300',
      'Access-Control-Allow-Origin': allowedOrigin || '*',
    },
    body: JSON.stringify({
      firebase: {
        apiKey:            process.env.FIREBASE_API_KEY,
        authDomain:        `${projectId}.firebaseapp.com`,
        projectId,
        storageBucket:     `${projectId}.appspot.com`,
        messagingSenderId: process.env.FIREBASE_SENDER_ID,
        appId:             process.env.FIREBASE_APP_ID,
      },
      stripePk:         process.env.STRIPE_PUBLISHABLE_KEY,
      cloudinaryCloud,
      cloudinaryPreset: process.env.CLOUDINARY_UPLOAD_PRESET || null,
    }),
  };
};
