// netlify/functions/_lib/verify-owner.js
// Verifies that an incoming request comes from a real, currently-active
// owner-portal user — mirrors _lib/verify-admin.js exactly, but checks the
// ownerUsers collection instead of admins. Kept as a separate file (rather
// than teaching verify-admin.js two collections) because an admin and an
// owner-portal user are different kinds of caller with different data
// shapes and different things they're allowed to see; conflating them
// risked a future edit to one accidentally weakening the other.
//
// Usage:
//   const { verifyOwner } = require('./_lib/verify-owner');
//   const authResult = await verifyOwner(event, db, a);
//   if (authResult.error) return authResult.error; // a ready-to-return {statusCode, body}
//   const { ownerData, decoded } = authResult;

async function verifyOwner(event, db, a) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return { error: { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) } };

  let decoded;
  try { decoded = await a.auth().verifyIdToken(match[1]); }
  catch { return { error: { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) } }; }

  const ownerSnap = await db.collection('ownerUsers').doc(decoded.uid).get();
  if (!ownerSnap.exists) return { error: { statusCode: 403, body: JSON.stringify({ error: 'Caller is not a registered owner-portal user.' }) } };
  const ownerData = ownerSnap.data();
  if (ownerData.status === 'revoked') return { error: { statusCode: 403, body: JSON.stringify({ error: 'Access revoked.' }) } };

  return { decoded, ownerData };
}

module.exports = { verifyOwner };
