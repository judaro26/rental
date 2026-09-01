// netlify/functions/_lib/verify-admin.js
// Verifies that an incoming request comes from a real, currently-active
// admin — extracted from a pattern that was already duplicated across
// several functions (create-screening-request.js, generate-invoice-now.js,
// fetch-screening-report.js, test-auto-invoice.js). This check is
// security-critical, so it belongs in exactly one place, not copy-pasted
// independently into every function that needs it — a fix or tightening
// made here applies everywhere at once, rather than needing to be found
// and repeated across every call site.
//
// Usage:
//   const { verifyAdmin } = require('./_lib/verify-admin');
//   const authResult = await verifyAdmin(event, db, a);
//   if (authResult.error) return authResult.error; // a ready-to-return {statusCode, body}
//   const { adminData, decoded } = authResult;
//
// Does not parse the request body — callers do that themselves, since
// some need it before this check (e.g. to look up a resource) and some
// after.

async function verifyAdmin(event, db, a) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return { error: { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) } };

  let decoded;
  try { decoded = await a.auth().verifyIdToken(match[1]); }
  catch { return { error: { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) } }; }

  const adminSnap = await db.collection('admins').doc(decoded.uid).get();
  if (!adminSnap.exists) return { error: { statusCode: 403, body: JSON.stringify({ error: 'Caller is not an admin.' }) } };
  const adminData = adminSnap.data();
  if (adminData.status === 'revoked') return { error: { statusCode: 403, body: JSON.stringify({ error: 'Access revoked.' }) } };

  return { decoded, adminData };
}

module.exports = { verifyAdmin };
