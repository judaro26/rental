// netlify/functions/_lib/verify-authenticated.js
// Verifies that an incoming request carries a valid Firebase ID token for
// *any* signed-in user — tenant or admin — without requiring a specific
// role. This is for endpoints where the only requirement is "not a fully
// anonymous caller," not "this specific tenant" or "an admin."
// verify-admin.js covers the admin-only case; this covers the broader one.
//
// A concrete example: maintenance-notify.js doesn't take a tenantId at
// all (it's just free-form name/email/description text for an email
// body), so there's no ownership relationship to check against. But it
// still shouldn't be callable by a fully anonymous request — requiring
// any valid session at least rules out arbitrary internet callers, even
// though a signed-in tenant could still put someone else's name in the
// body. That's a much smaller, more contained risk than fully open
// access, and matches what the endpoint's actual data model supports.
//
// Usage:
//   const { verifyAuthenticated } = require('./_lib/verify-authenticated');
//   const authResult = await verifyAuthenticated(event, a);
//   if (authResult.error) return authResult.error;
//   const { decoded } = authResult;

async function verifyAuthenticated(event, a) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return { error: { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) } };

  let decoded;
  try { decoded = await a.auth().verifyIdToken(match[1]); }
  catch { return { error: { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) } }; }

  return { decoded };
}

module.exports = { verifyAuthenticated };
