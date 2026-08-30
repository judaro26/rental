// netlify/functions/manage-integrations.js
// The only way to read (masked), add, edit, remove, or activate entries in
// the integrationSecrets collection. Mirrors manage-admin.js's authorization
// pattern exactly: a Firebase ID token is required and independently
// re-verified server-side as belonging to an active Super Admin — the
// Firestore rules for this collection are a hard `false`, so this function
// is the entire trust boundary, not a convenience layer in front of
// client-writable data.
//
// Data model:
//   integrationSecrets/{autoId}  — one saved provider: { type: 'email'|
//     'storage', label, ...fields, createdAt, updatedAt, updatedBy }
//   integrationSecrets/_active   — a single pointer doc: { email: <id|null>,
//     storage: <id|null> }, naming which saved provider is active per type.
//
// Deliberately NOT modeled as querying `type==X AND isActive==true` — that
// needs a Firestore composite index whose behavior I can't verify without
// live testing, and I'd rather not ship something uncertain on this
// collection specifically. A pointer doc means every "what's active" lookup
// (here and in apply-email-config.js / sign-cloudinary-upload.js / config.js)
// is a direct get-by-ID, which has no indexing question at all.
//
// Secrets are WRITE-ONLY from the client's perspective: list_providers never
// returns a real secret value, only a masked preview (last 4 characters).
// Leaving a password/secret field blank when editing means "keep the
// existing value" — the client never needs to know the current value to
// preserve it.
//
// POST /api/manage-integrations
// Body: { action: 'list_providers' | 'add_provider' | 'update_provider'
//               | 'remove_provider' | 'set_active_provider' | 'test_email', ... }

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

async function requireSuperAdmin(event, a, db) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) { const e = new Error('Missing Authorization bearer token.'); e.statusCode = 401; throw e; }
  let decoded;
  try { decoded = await a.auth().verifyIdToken(match[1]); }
  catch { const e = new Error('Invalid or expired session.'); e.statusCode = 401; throw e; }
  const snap = await db.collection('admins').doc(decoded.uid).get();
  if (!snap.exists) { const e = new Error('Caller is not an admin.'); e.statusCode = 403; throw e; }
  const data = snap.data();
  if (data.status === 'revoked') { const e = new Error('Access revoked.'); e.statusCode = 403; throw e; }
  const role = data.role; // missing role = legacy super_admin, same convention as elsewhere
  if (role && role !== 'super_admin') { const e = new Error('Only Super Admins can manage integrations.'); e.statusCode = 403; throw e; }
  return { uid: decoded.uid, email: data.email || decoded.email || '' };
}

function maskProvider(id, d, activeId) {
  const base = { id, type: d.type, label: d.label || '(untitled)', isActive: id === activeId, updatedAt: d.updatedAt?.toDate?.() || null, updatedBy: d.updatedBy || null };
  if (d.type === 'email') {
    return { ...base, provider: d.provider || 'custom', host: d.host, port: d.port, user: d.user, fromAddress: d.fromAddress, passMasked: mask(d.pass) };
  }
  if (d.type === 'storage') {
    return { ...base, provider: 'cloudinary', cloudName: d.cloudName, apiKey: d.apiKey, apiSecretMasked: mask(d.apiSecret) };
  }
  return base;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const a = getAdmin();
  const db = a.firestore();
  const coll = db.collection('integrationSecrets');
  const activeRef = coll.doc('_active');

  let caller;
  try { caller = await requireSuperAdmin(event, a, db); }
  catch (err) { return { statusCode: err.statusCode || 403, body: JSON.stringify({ error: err.message }) }; }

  const { action } = body;

  try {
    // ── LIST (masked — never returns real secret values) ────────────────────
    if (action === 'list_providers') {
      const [snap, activeSnap] = await Promise.all([coll.get(), activeRef.get()]);
      const active = activeSnap.exists ? activeSnap.data() : {};
      const providers = snap.docs
        .filter(d => d.id !== '_active')
        .map(d => maskProvider(d.id, d.data(), active[d.data().type]));
      return { statusCode: 200, body: JSON.stringify({ providers }) };
    }

    // ── ADD a new provider ───────────────────────────────────────────────────
    if (action === 'add_provider') {
      const { type, label } = body;
      if (!['email', 'storage'].includes(type)) return { statusCode: 400, body: JSON.stringify({ error: 'type must be "email" or "storage".' }) };

      let fields;
      if (type === 'email') {
        const { provider, host, port, user, pass, fromAddress } = body;
        if (!host || !user || !pass) return { statusCode: 400, body: JSON.stringify({ error: 'host, user, and pass are required for a new email provider.' }) };
        fields = { provider: provider || 'custom', host, port: port ? parseInt(port) : 587, user, pass, fromAddress: fromAddress || user };
      } else {
        const { cloudName, apiKey, apiSecret } = body;
        if (!cloudName || !apiKey || !apiSecret) return { statusCode: 400, body: JSON.stringify({ error: 'cloudName, apiKey, and apiSecret are required for a new storage provider.' }) };
        fields = { cloudName, apiKey, apiSecret };
      }

      const ref = await coll.add({
        type, label: label || (type === 'email' ? 'Email Provider' : 'Storage Provider'),
        ...fields,
        createdAt: a.firestore.FieldValue.serverTimestamp(),
        updatedAt: a.firestore.FieldValue.serverTimestamp(),
        updatedBy: caller.email,
      });

      // First provider of its type becomes active automatically.
      const activeSnap = await activeRef.get();
      if (!activeSnap.exists || !activeSnap.data()[type]) {
        await activeRef.set({ [type]: ref.id }, { merge: true });
      }

      return { statusCode: 200, body: JSON.stringify({ success: true, id: ref.id }) };
    }

    // ── UPDATE an existing provider (blank secret = keep current) ───────────
    if (action === 'update_provider') {
      const { id } = body;
      if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };
      const ref = coll.doc(id);
      const existing = await ref.get();
      if (!existing.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Provider not found.' }) };
      const d = existing.data();

      const update = { updatedAt: a.firestore.FieldValue.serverTimestamp(), updatedBy: caller.email };
      if (body.label !== undefined) update.label = body.label;

      if (d.type === 'email') {
        if (body.provider !== undefined) update.provider = body.provider;
        if (body.host !== undefined) update.host = body.host;
        if (body.port !== undefined) update.port = parseInt(body.port) || 587;
        if (body.user !== undefined) update.user = body.user;
        if (body.fromAddress !== undefined) update.fromAddress = body.fromAddress;
        if (body.pass) update.pass = body.pass; // blank = keep existing
      } else if (d.type === 'storage') {
        if (body.cloudName !== undefined) update.cloudName = body.cloudName;
        if (body.apiKey !== undefined) update.apiKey = body.apiKey;
        if (body.apiSecret) update.apiSecret = body.apiSecret; // blank = keep existing
      }

      await ref.update(update);
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // ── REMOVE a provider ────────────────────────────────────────────────────
    if (action === 'remove_provider') {
      const { id } = body;
      if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };
      const snap = await coll.doc(id).get();
      if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Provider not found.' }) };
      const type = snap.data().type;

      await coll.doc(id).delete();

      // If this was the active one, clear the pointer rather than silently
      // promoting some other saved provider — falling back to the
      // environment default is less surprising than an unannounced switch.
      const activeSnap = await activeRef.get();
      if (activeSnap.exists && activeSnap.data()[type] === id) {
        await activeRef.set({ [type]: null }, { merge: true });
      }

      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // ── SET ACTIVE ───────────────────────────────────────────────────────────
    if (action === 'set_active_provider') {
      const { id } = body;
      if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };
      const snap = await coll.doc(id).get();
      if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Provider not found.' }) };
      const type = snap.data().type;
      await activeRef.set({ [type]: id }, { merge: true });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // ── TEST EMAIL — tests a specific saved provider (or the active one if
    //    no id given) without requiring it to be active first ─────────────
    if (action === 'test_email') {
      const { id, host, user, pass, port, fromAddress } = body;
      let cfg = null;
      if (host && user) {
        // Test whatever's currently typed in the form, even if unsaved yet.
        // A blank password here means "use the saved one" only if editing
        // an existing entry (id present) — for a brand-new, never-saved
        // entry there's nothing to fall back to, so pass is required.
        let effectivePass = pass;
        if (!effectivePass && id) {
          const existing = await coll.doc(id).get();
          effectivePass = existing.exists ? existing.data().pass : null;
        }
        if (!effectivePass) return { statusCode: 400, body: JSON.stringify({ error: 'Enter a password/API key to test with.' }) };
        cfg = { host, user, pass: effectivePass, port, fromAddress };
      } else if (id) {
        const snap = await coll.doc(id).get();
        if (!snap.exists || snap.data().type !== 'email') return { statusCode: 404, body: JSON.stringify({ error: 'Email provider not found.' }) };
        cfg = snap.data();
      } else {
        const activeSnap = await activeRef.get();
        const activeId = activeSnap.exists ? activeSnap.data().email : null;
        if (activeId) {
          const snap = await coll.doc(activeId).get();
          cfg = snap.exists ? snap.data() : null;
        }
      }

      const nodemailer = require('nodemailer');
      let transportOpts;
      if (cfg) {
        transportOpts = { host: cfg.host, port: cfg.port || 587, secure: (cfg.port || 587) === 465, auth: { user: cfg.user, pass: cfg.pass } };
      } else if (process.env.SMTP_HOST) {
        transportOpts = { host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'), secure: parseInt(process.env.SMTP_PORT || '587') === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } };
      } else {
        return { statusCode: 400, body: JSON.stringify({ error: 'No email configuration available to test (neither a saved provider nor an environment default).' }) };
      }

      // verify() checks the connection/auth without sending anything —
      // fails fast with a clear reason if the credentials are wrong,
      // rather than only finding out via a bounced/failed send.
      try {
        await nodemailer.createTransport(transportOpts).verify();
      } catch (err) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Could not connect/authenticate: ' + err.message }) };
      }

      const transporter = nodemailer.createTransport(transportOpts);
      await transporter.sendMail({
        from: (cfg && cfg.fromAddress) || process.env.SMTP_FROM || transportOpts.auth.user,
        to: caller.email,
        subject: 'Test email — RentBay integration check',
        html: `<p>This confirms ${cfg ? `the "${cfg.label || 'saved'}" provider` : 'your environment default configuration'} is working. Sent to ${caller.email} at ${new Date().toISOString()}.</p>`,
      });
      return { statusCode: 200, body: JSON.stringify({ success: true, sentTo: caller.email }) };
    }

    // ── TEST STORAGE — validates Cloudinary credentials with a read-only
    //    call (account usage stats), no file is uploaded or stored ────────
    if (action === 'test_storage') {
      const { id, cloudName, apiKey, apiSecret } = body;
      let creds = null;
      if (cloudName && apiKey) {
        let effectiveSecret = apiSecret;
        if (!effectiveSecret && id) {
          const existing = await coll.doc(id).get();
          effectiveSecret = existing.exists ? existing.data().apiSecret : null;
        }
        if (!effectiveSecret) return { statusCode: 400, body: JSON.stringify({ error: 'Enter an API secret to test with.' }) };
        creds = { cloudName, apiKey, apiSecret: effectiveSecret };
      } else if (id) {
        const snap = await coll.doc(id).get();
        if (!snap.exists || snap.data().type !== 'storage') return { statusCode: 404, body: JSON.stringify({ error: 'Storage provider not found.' }) };
        creds = snap.data();
      } else {
        return { statusCode: 400, body: JSON.stringify({ error: 'No storage configuration given to test.' }) };
      }

      const basicAuth = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
      const res = await fetch(`https://api.cloudinary.com/v1_1/${creds.cloudName}/usage`, {
        headers: { Authorization: `Basic ${basicAuth}` },
      });
      const data = await res.json();
      if (!res.ok) {
        return { statusCode: 400, body: JSON.stringify({ error: data.error?.message || `Cloudinary rejected these credentials (HTTP ${res.status}).` }) };
      }
      const plan = data.plan || 'unknown';
      const usedCredits = typeof data.credits?.usage === 'number' ? data.credits.usage.toFixed(2) : null;
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: `Connected successfully. Plan: ${plan}${usedCredits ? `, ${usedCredits} credits used this cycle` : ''}.`,
        }),
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error('manage-integrations error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
