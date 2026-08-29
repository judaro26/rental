// netlify/functions/log-admin-action.js
// Records an admin action to the adminAuditLogs Firestore collection.
// Identity comes from a verified Firebase ID token, never from the request
// body — an admin (especially a restricted one) should never be able to
// write a log entry attributed to someone else, or forge their own history.
// IP/user-agent captured server-side, mirroring log-action.js's pattern for
// tenant activity.
//
// POST body: { action, targetType, targetId, targetLabel, details }
// Header: Authorization: Bearer <Firebase ID token>
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, targetType, targetId, targetLabel, details } = body;
  if (!action) {
    return { statusCode: 400, body: JSON.stringify({ error: 'action is required' }) };
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) };
  }

  const a = getAdmin();
  let decoded;
  try {
    decoded = await a.auth().verifyIdToken(match[1]);
  } catch {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  }

  const db = a.firestore();
  // Confirm the caller is a real (non-revoked) admin — this is an admin
  // audit log, not a general-purpose logging endpoint.
  try {
    const adminSnap = await db.collection('admins').doc(decoded.uid).get();
    if (!adminSnap.exists || adminSnap.data().status === 'revoked') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Not an active admin.' }) };
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not verify admin status.' }) };
  }

  const ip = (event.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim()
    || event.headers?.['x-real-ip']
    || event.requestContext?.http?.sourceIp
    || 'unknown';

  try {
    await db.collection('adminAuditLogs').add({
      adminUid: decoded.uid,
      adminEmail: decoded.email || 'unknown',
      action,
      targetType: targetType || null,
      targetId: targetId || null,
      targetLabel: targetLabel || null,
      details: details || '',
      ipAddress: ip,
      userAgent: event.headers?.['user-agent'] || 'unknown',
      timestamp: a.firestore.FieldValue.serverTimestamp(),
    });
    return { statusCode: 200, body: JSON.stringify({ logged: true }) };
  } catch (err) {
    console.error('log-admin-action error:', err);
    // Never let a logging failure surface as a blocking error to the caller.
    return { statusCode: 200, body: JSON.stringify({ logged: false }) };
  }
};
