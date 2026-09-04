// netlify/functions/log-action.js
// Records a tenant portal action to the auditLogs Firestore collection.
// IP address and user agent are captured server-side (cannot be spoofed).
// Geolocation is resolved from IP using ip-api.com (free, no key needed).
//
// POST body: { tenantId, tenantName, tenantEmail, action, details, sessionId, propertyId, unit }
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

// Best-effort IP geolocation — times out in 2s so it never blocks the response
async function geolocate(ip) {
  if (!ip || ip === 'unknown' || ip.startsWith('127.') || ip.startsWith('::1') || ip === '::ffff:127.0.0.1') {
    return { city: 'localhost', region: '', country: 'DEV', isp: '' };
  }
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 2000);
    const res  = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,city,regionName,country,countryCode,isp`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'success') return null;
    return { city: data.city, region: data.regionName, country: data.country, countryCode: data.countryCode, isp: data.isp };
  } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenantId, tenantName, tenantEmail, action, details, sessionId, propertyId, unit } = body;
  if (!tenantId || !action) {
    return { statusCode: 400, body: JSON.stringify({ error: 'tenantId and action required' }) };
  }

  // Authentication: previously this function had no auth check, meaning
  // an unauthenticated caller could inject arbitrary entries into
  // auditLogs — attributed to any tenantId they chose, with any action/
  // details text. An audit trail that's this easy to forge or pollute
  // defeats its own purpose (it exists to be trustworthy in a dispute or
  // investigation), so this needed the same fix as the collections above.
  const fbForAuth = getAdmin();
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const bearerMatch = authHeader.match(/^Bearer (.+)$/i);
  if (!bearerMatch) return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) };

  let decoded;
  try { decoded = await fbForAuth.auth().verifyIdToken(bearerMatch[1]); }
  catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) }; }

  const isOwnLog = decoded.uid === tenantId;
  if (!isOwnLog) {
    const adminSnap = await fbForAuth.firestore().collection('admins').doc(decoded.uid).get();
    if (!adminSnap.exists || adminSnap.data().status === 'revoked') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized to log an action for this tenant.' }) };
    }
  }

  // Capture audit-critical data server-side
  const ip        = (event.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim()
    || event.headers?.['x-real-ip']
    || event.requestContext?.http?.sourceIp
    || 'unknown';
  const userAgent = event.headers?.['user-agent'] || 'unknown';

  // Run geolocation in parallel with Firestore write
  const [, geoData] = await Promise.allSettled([
    (async () => {
      const fb = getAdmin();
      const db = fb.firestore();
      const geo = await geolocate(ip);
      await db.collection('auditLogs').add({
        tenantId,
        tenantName:  tenantName  || '',
        tenantEmail: tenantEmail || '',
        action,
        details:     details     || '',
        sessionId:   sessionId   || '',
        propertyId:  propertyId  || null,
        unit:        unit        || '',
        ipAddress:   ip,
        userAgent,
        geo: geo || null,  // { city, region, country, countryCode, isp }
        timestamp:   fb.firestore.FieldValue.serverTimestamp(),
      });
    })(),
    geolocate(ip),
  ]);

  return { statusCode: 200, body: JSON.stringify({ logged: true }) };
};
