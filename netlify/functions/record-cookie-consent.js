// netlify/functions/record-cookie-consent.js
// Logs a cookie-consent choice (accepted/rejected) to Firestore, server-side,
// so there's an audit trail beyond the visitor's own browser storage —
// Colombia's Law 1581 expects consent records to be retained, not just a
// client-side flag. Mirrors the existing log-action.js pattern (geolocates
// the IP, never blocks the UI on failure).
//
// POST body: { choice: 'accepted'|'rejected', policyVersion, page, language }
// Required env vars: FIREBASE_SERVICE_ACCOUNT

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

async function geolocate(ip) {
  if (!ip || ip === 'unknown' || ip.startsWith('127.') || ip.startsWith('::1') || ip === '::ffff:127.0.0.1') {
    return { country: 'DEV' };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'success') return null;
    return { country: data.countryCode };
  } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { choice, policyVersion, page, language } = body;
  if (!['accepted', 'rejected'].includes(choice)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'choice must be "accepted" or "rejected"' }) };
  }

  const ip = (event.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim()
    || event.headers?.['x-real-ip']
    || event.requestContext?.http?.sourceIp
    || 'unknown';

  try {
    const a = getAdmin();
    const db = a.firestore();
    const geo = await geolocate(ip);
    await db.collection('cookieConsents').add({
      choice,
      policyVersion: policyVersion || null,
      page: page || null,
      language: language || null,
      country: geo?.country || null,
      ipAddress: ip,
      userAgent: event.headers?.['user-agent'] || 'unknown',
      timestamp: a.firestore.FieldValue.serverTimestamp(),
    });
    return { statusCode: 200, body: JSON.stringify({ logged: true }) };
  } catch (err) {
    console.error('record-cookie-consent error:', err);
    // Never block the visitor's experience on a logging failure.
    return { statusCode: 200, body: JSON.stringify({ logged: false }) };
  }
};
