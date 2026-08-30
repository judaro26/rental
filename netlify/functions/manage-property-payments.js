// netlify/functions/manage-property-payments.js
// Self-serve management of payment-processor credentials (currently: Bold)
// for a specific property. Mirrors manage-integrations.js's write-only-secret
// pattern, but adds a property-ownership check: a Restricted Admin may only
// touch properties in their own assigned country, exactly like they can
// already only edit that property's other fields.
//
// This check happens here, in server code using the Admin SDK (which can
// read anything), NOT as a Firestore rule — `properties` is intentionally
// publicly readable (for the public listing page), so a secret can never
// live as a field on that document or be governed by a rule that assumes
// the document itself is private. Locking propertyPaymentSecrets to
// `allow read, write: if false` in Firestore rules and doing the real
// authorization check here is the only safe way to make this self-serve
// for anyone other than a Super Admin.
//
// POST /api/manage-property-payments
// Body: { action: 'get_status' | 'set_bold' | 'clear_bold', propertyId, ... }

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

function mask(value) {
  if (!value) return null;
  const str = String(value);
  return str.length <= 4 ? '••••' : '••••' + str.slice(-4);
}

// Verifies the caller's token, then checks they're allowed to manage THIS
// specific property: Super Admin can touch any property; a Restricted Admin
// only one whose country matches their own assignment (same rule the
// existing properties/{id} Firestore rules already enforce for edits —
// this mirrors that, since it can't reuse it directly here).
async function requireCanManageProperty(event, a, db, propertyId) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) { const e = new Error('Missing Authorization bearer token.'); e.statusCode = 401; throw e; }
  let decoded;
  try { decoded = await a.auth().verifyIdToken(match[1]); }
  catch { const e = new Error('Invalid or expired session.'); e.statusCode = 401; throw e; }

  const adminSnap = await db.collection('admins').doc(decoded.uid).get();
  if (!adminSnap.exists) { const e = new Error('Caller is not an admin.'); e.statusCode = 403; throw e; }
  const adminData = adminSnap.data();
  if (adminData.status === 'revoked') { const e = new Error('Access revoked.'); e.statusCode = 403; throw e; }

  const propSnap = await db.collection('properties').doc(propertyId).get();
  if (!propSnap.exists) { const e = new Error('Property not found.'); e.statusCode = 404; throw e; }

  const role = adminData.role; // missing role = legacy super_admin, same convention as elsewhere
  const isSuperAdmin = !role || role === 'super_admin';
  if (!isSuperAdmin) {
    if (role !== 'restricted_admin' || adminData.allowedCountry !== propSnap.data().country) {
      const e = new Error('You are not authorized to manage payment settings for this property.');
      e.statusCode = 403;
      throw e;
    }
  }
  return { uid: decoded.uid, email: adminData.email || decoded.email || '', propertyName: propSnap.data().name };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, propertyId } = body;
  if (!propertyId) return { statusCode: 400, body: JSON.stringify({ error: 'propertyId is required.' }) };

  const a = getAdmin();
  const db = a.firestore();

  let caller;
  try { caller = await requireCanManageProperty(event, a, db, propertyId); }
  catch (err) { return { statusCode: err.statusCode || 403, body: JSON.stringify({ error: err.message }) }; }

  const secretRef = db.collection('propertyPaymentSecrets').doc(propertyId);

  try {
    if (action === 'get_status') {
      const snap = await secretRef.get();
      const d = snap.exists ? snap.data() : {};
      const bold = d.bold || {};
      return {
        statusCode: 200,
        body: JSON.stringify({
          bold: {
            configured: !!(bold.apiKey && bold.secretKey),
            enabled: !!bold.enabled,
            apiKeyMasked: mask(bold.apiKey),
            secretKeyMasked: mask(bold.secretKey),
            updatedAt: bold.updatedAt?.toDate?.() || null,
            updatedBy: bold.updatedBy || null,
          },
        }),
      };
    }

    if (action === 'set_bold') {
      const { apiKey, secretKey, enabled } = body;
      if (!apiKey) return { statusCode: 400, body: JSON.stringify({ error: 'apiKey is required.' }) };

      const existing = await secretRef.get();
      const existingSecretKey = existing.exists ? existing.data().bold?.secretKey : null;

      await secretRef.set({
        bold: {
          apiKey,
          secretKey: secretKey ? secretKey : existingSecretKey, // blank on update = keep existing
          enabled: enabled !== undefined ? !!enabled : true,
          updatedAt: a.firestore.FieldValue.serverTimestamp(),
          updatedBy: caller.email,
        },
      }, { merge: true });

      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    if (action === 'clear_bold') {
      await secretRef.set({ bold: a.firestore.FieldValue.delete() }, { merge: true });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error('manage-property-payments error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
