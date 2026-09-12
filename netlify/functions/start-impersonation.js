// netlify/functions/start-impersonation.js
// Mints a short-lived Firebase custom token letting a super admin sign in
// as a specific tenant or admin, for troubleshooting what that person
// actually sees. Restricted to super admins only — a restricted admin,
// even one managing their own country's properties, cannot impersonate
// anyone, since this is meaningfully more powerful than any other action
// a restricted admin can already take.
//
// Every call is logged to adminAuditLogs before the token is minted, not
// after — if the log write fails, impersonation does not proceed. This is
// the one place in this app where "log first, then act" matters more than
// "never let a logging failure block the caller" (log-admin-action.js's
// own stated philosophy), because this action is powerful enough that an
// unlogged instance of it is a bigger risk than a rare failed request.
//
// The minted token itself is a standard Firebase custom token — it
// expires after at most one hour, a property of Firebase's own custom
// token format, not something this function enforces itself. The
// `impersonatedBy`/`impersonatedByEmail`/`impersonatedByName` custom
// claims ride along in the resulting ID token once the client signs in
// with it, which is what lets tenant-portal.html/admin.html detect an
// impersonated session and show a persistent, unmissable banner rather
// than silently pretending to be a normal login.
//
// POST body: { targetType: 'tenant' | 'admin', targetId }
// Header: Authorization: Bearer <Firebase ID token, from the super admin>

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

  const { targetType, targetId } = body;
  if (targetType !== 'tenant' && targetType !== 'admin') {
    return { statusCode: 400, body: JSON.stringify({ error: 'targetType must be "tenant" or "admin".' }) };
  }
  if (!targetId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'targetId is required.' }) };
  }

  const a = getAdmin();
  const db = a.firestore();
  const { verifyAdmin } = require('./_lib/verify-admin');
  const authResult = await verifyAdmin(event, db, a);
  if (authResult.error) return authResult.error;
  const { decoded, adminData } = authResult;

  // Mirrors isSuperAdmin() in firestore.rules exactly: a doc with no role
  // field at all (every admin that existed before restricted admins were
  // introduced) counts as super admin; only an explicit
  // role === 'restricted_admin' is excluded.
  const isSuperAdmin = !('role' in adminData) || adminData.role !== 'restricted_admin';
  if (!isSuperAdmin) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Only super admins can view as another user.' }) };
  }

  // Can't impersonate yourself — there's no scenario where this makes
  // sense, and it would produce a confusing session (your own account,
  // wrapped in an "impersonating" banner pointed at yourself).
  if (targetId === decoded.uid) {
    return { statusCode: 400, body: JSON.stringify({ error: 'You cannot view as your own account.' }) };
  }

  const targetCollection = targetType === 'tenant' ? 'tenants' : 'admins';
  const targetSnap = await db.collection(targetCollection).doc(targetId).get();
  if (!targetSnap.exists) {
    return { statusCode: 404, body: JSON.stringify({ error: `${targetType === 'tenant' ? 'Tenant' : 'Admin'} not found.` }) };
  }
  const targetData = targetSnap.data();
  const targetName = targetType === 'tenant'
    ? `${targetData.firstName || ''} ${targetData.lastName || ''}`.trim() || targetData.email || targetId
    : targetData.email || targetId;

  const ip = (event.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim()
    || event.headers?.['x-real-ip']
    || event.requestContext?.http?.sourceIp
    || 'unknown';

  // Logged before minting the token, deliberately — see header comment.
  try {
    await db.collection('adminAuditLogs').add({
      adminUid: decoded.uid,
      adminEmail: decoded.email || 'unknown',
      action: 'impersonation_started',
      targetType,
      targetId,
      targetLabel: targetName,
      details: `Viewing as ${targetType} "${targetName}"`,
      ipAddress: ip,
      userAgent: event.headers?.['user-agent'] || 'unknown',
      timestamp: a.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('start-impersonation: audit log write failed, aborting', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not record this action to the audit log, so impersonation was not started.' }) };
  }

  let customToken;
  try {
    customToken = await a.auth().createCustomToken(targetId, {
      impersonatedBy: decoded.uid,
      impersonatedByEmail: decoded.email || '',
      impersonatedByName: adminData.name || decoded.email || '',
    });
  } catch (err) {
    console.error('start-impersonation: createCustomToken failed', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not create an impersonation session: ' + err.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ token: customToken, targetName }) };
};
