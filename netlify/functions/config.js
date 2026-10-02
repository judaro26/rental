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

const { getDb, getWorkspace, withWorkspace } = require('./_lib/workspace');
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
    const db = getDb();
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
  const ws = getWorkspace();
  const requestOrigin = event.headers?.origin || event.headers?.referer || '';
  const isLocalDev    = requestOrigin.startsWith('http://localhost') ||
                        requestOrigin.startsWith('http://127.0.0.1');

  // Default workspace: unchanged — ALLOWED_ORIGIN, only enforced when set.
  // Any other workspace: ALWAYS enforced, and only against its own registered
  // domains (exact origin match, so portal.acme.com.evil.com cannot pass), never
  // against the default workspace's origin. A workspace with no domains allows nothing.
  let allowedOrigin, originOk;
  if (ws.isDefault) {
    allowedOrigin = process.env.ALLOWED_ORIGIN || '';
    originOk = !allowedOrigin || requestOrigin === allowedOrigin || requestOrigin.startsWith(allowedOrigin);
  } else {
    const origins = ws.domains.map(d => `https://${d}`);
    const matched = origins.find(o => requestOrigin === o || requestOrigin.startsWith(o + '/'));
    allowedOrigin = matched || origins[0] || '';
    originOk = !!matched;
  }
  if (!originOk && !isLocalDev) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
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
      // Which Firestore database this workspace lives in ('(default)' for the original install).
      firestoreDatabaseId: ws.databaseId,
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

// Resolves which workspace (client) this invocation belongs to — see _lib/workspace.js
exports.handler = withWorkspace(exports.handler);
