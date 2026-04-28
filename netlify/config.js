/**
 * /api/config
 * Serves Firebase client config + Stripe publishable key from Netlify env vars.
 * Never hardcode these values in HTML — always fetch from this endpoint.
 *
 * Required Netlify environment variables:
 *   FIREBASE_API_KEY
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_SENDER_ID
 *   FIREBASE_APP_ID
 *   STRIPE_PUBLISHABLE_KEY
 *   ALLOWED_ORIGIN  (e.g. https://your-site.netlify.app or your custom domain)
 */

export const handler = async (event) => {
  // ── Origin check ────────────────────────────────────────────────────────────
  // Only serve config to requests originating from your own domain.
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  const requestOrigin = event.headers?.origin || event.headers?.referer || '';

  // In production, reject requests from unknown origins.
  // During local Netlify dev (netlify dev) origin may be empty — allow localhost.
  const isLocalDev = requestOrigin.startsWith('http://localhost') ||
                     requestOrigin.startsWith('http://127.0.0.1');

  if (allowedOrigin && !isLocalDev) {
    const originOk = requestOrigin === allowedOrigin ||
                     requestOrigin.startsWith(allowedOrigin);
    if (!originOk) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Forbidden' }),
      };
    }
  }

  // ── Method check ────────────────────────────────────────────────────────────
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Validate all env vars are set ───────────────────────────────────────────
  const required = [
    'FIREBASE_API_KEY',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_SENDER_ID',
    'FIREBASE_APP_ID',
    'STRIPE_PUBLISHABLE_KEY',
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Missing env vars:', missing);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server misconfiguration' }),
    };
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;

  const payload = {
    firebase: {
      apiKey:            process.env.FIREBASE_API_KEY,
      authDomain:        `${projectId}.firebaseapp.com`,
      projectId,
      storageBucket:     `${projectId}.appspot.com`,
      messagingSenderId: process.env.FIREBASE_SENDER_ID,
      appId:             process.env.FIREBASE_APP_ID,
    },
    stripePk: process.env.STRIPE_PUBLISHABLE_KEY,
  };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      // Short cache: browsers can reuse for 5 min, but CDN must not store it
      'Cache-Control': 'private, max-age=300',
      // Restrict to same origin in browser
      'Access-Control-Allow-Origin': allowedOrigin || '*',
    },
    body: JSON.stringify(payload),
  };
};
