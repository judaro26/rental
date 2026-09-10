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
    if (d.backend === 'r2') {
      return { ...base, backend: 'r2', accountId: d.accountId, accessKeyIdMasked: mask(d.accessKeyId), secretAccessKeyMasked: mask(d.secretAccessKey), bucketName: d.bucketName, publicUrl: d.publicUrl };
    }
    return { ...base, backend: 'cloudinary', cloudName: d.cloudName, apiKey: d.apiKey, apiSecretMasked: mask(d.apiSecret) };
  }
  if (d.type === 'envelope') {
    return { ...base, provider: 'documenso', apiUrl: d.apiUrl, appUrl: d.appUrl, templateId: d.templateId, apiKeyMasked: mask(d.apiKey), webhookSecretMasked: mask(d.webhookSecret) };
  }
  if (d.type === 'screening') {
    if (d.provider === 'rentprep') {
      return { ...base, provider: 'rentprep', environment: d.environment || 'sandbox', sandboxKeyMasked: mask(d.sandboxKey), productionKeyMasked: mask(d.productionKey), tenantPays: d.tenantPays === true, minScore: d.minScore || null, evictionsIncluded: d.evictionsIncluded !== false, landlordFirstName: d.landlordFirstName, landlordLastName: d.landlordLastName, landlordStreet: d.landlordStreet, landlordCity: d.landlordCity, landlordState: d.landlordState, landlordZip: d.landlordZip, landlordPhone: d.landlordPhone, landlordEmail: d.landlordEmail };
    }
    return { ...base, provider: 'singlekey', environment: d.environment || 'sandbox', sandboxTokenMasked: mask(d.sandboxToken), productionTokenMasked: mask(d.productionToken), handshakeTokenMasked: mask(d.handshakeToken), tenantPays: d.tenantPays === true, minScore: d.minScore || null };
  }
  if (d.type === 'income_verification') {
    return { ...base, provider: 'truv', environment: d.environment || 'sandbox', clientId: d.clientId, sandboxSecretMasked: mask(d.sandboxSecret), productionSecretMasked: mask(d.productionSecret) };
  }
  if (d.type === 'sms') {
    if (d.provider === 'twilio') {
      return { ...base, provider: 'twilio', accountSid: d.accountSid, authTokenMasked: mask(d.authToken), fromNumber: d.fromNumber };
    }
    if (d.provider === 'clicksend') {
      return { ...base, provider: 'clicksend', username: d.username, apiKeyMasked: mask(d.apiKey) };
    }
    return { ...base, provider: 'telnyx', apiKeyMasked: mask(d.apiKey), fromNumber: d.fromNumber, messagingProfileId: d.messagingProfileId };
  }
  if (d.type === 'whatsapp') {
    return { ...base, provider: 'twilio', accountSid: d.accountSid, authTokenMasked: mask(d.authToken), fromNumber: d.fromNumber, contentSid: d.contentSid, contentSidEs: d.contentSidEs || null };
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
      if (!['email', 'storage', 'envelope', 'screening', 'income_verification', 'sms', 'whatsapp'].includes(type)) return { statusCode: 400, body: JSON.stringify({ error: 'type must be "email", "storage", "envelope", "screening", "income_verification", "sms", or "whatsapp".' }) };

      let fields;
      if (type === 'email') {
        const { provider, host, port, user, pass, fromAddress } = body;
        if (!host || !user || !pass) return { statusCode: 400, body: JSON.stringify({ error: 'host, user, and pass are required for a new email provider.' }) };
        fields = { provider: provider || 'custom', host, port: port ? parseInt(port) : 587, user, pass, fromAddress: fromAddress || user };
      } else if (type === 'storage') {
        const { backend, cloudName, apiKey, apiSecret, accountId, accessKeyId, secretAccessKey, bucketName, publicUrl } = body;
        if (backend === 'r2') {
          if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) {
            return { statusCode: 400, body: JSON.stringify({ error: 'accountId, accessKeyId, secretAccessKey, bucketName, and publicUrl are all required for a new R2 storage provider.' }) };
          }
          fields = { backend: 'r2', accountId, accessKeyId, secretAccessKey, bucketName, publicUrl: publicUrl.replace(/\/+$/, '') };
        } else {
          if (!cloudName || !apiKey || !apiSecret) return { statusCode: 400, body: JSON.stringify({ error: 'cloudName, apiKey, and apiSecret are required for a new Cloudinary storage provider.' }) };
          fields = { backend: 'cloudinary', cloudName, apiKey, apiSecret };
        }
      } else if (type === 'envelope') {
        const { apiKey, templateId, apiUrl, appUrl, webhookSecret } = body;
        if (!apiKey) return { statusCode: 400, body: JSON.stringify({ error: 'apiKey is required for a new envelope provider.' }) };
        fields = {
          apiKey, templateId: templateId || null,
          apiUrl: (apiUrl || 'https://app.documenso.com/api/v2').replace(/\/+$/, ''),
          appUrl: (appUrl || 'https://app.documenso.com').replace(/\/+$/, ''),
          webhookSecret: webhookSecret || null,
        };
      } else if (type === 'screening') {
        const { provider, sandboxToken, productionToken, sandboxKey, productionKey, environment, handshakeToken, tenantPays, minScore, evictionsIncluded } = body;
        if (provider === 'rentprep') {
          if (!sandboxKey && !productionKey) return { statusCode: 400, body: JSON.stringify({ error: 'At least a sandbox key is required for a new RentPrep screening provider.' }) };
          const { landlordFirstName, landlordLastName, landlordStreet, landlordCity, landlordState, landlordZip, landlordPhone, landlordEmail } = body;
          if (!landlordFirstName || !landlordLastName || !landlordStreet || !landlordCity || !landlordState || !landlordZip || !landlordPhone || !landlordEmail) {
            return { statusCode: 400, body: JSON.stringify({ error: 'RentPrep\'s API requires your name, address, phone, and email on every request (their "native" order flow, entered here once rather than per application) — all fields are required.' }) };
          }
          fields = {
            provider: 'rentprep',
            sandboxKey: sandboxKey || null,
            productionKey: productionKey || null,
            environment: environment === 'production' ? 'production' : 'sandbox',
            tenantPays: tenantPays === true,
            minScore: minScore ? parseInt(minScore) : null,
            evictionsIncluded: evictionsIncluded !== false,
            landlordFirstName, landlordLastName, landlordStreet, landlordCity, landlordState, landlordZip, landlordPhone, landlordEmail,
          };
        } else {
          if (!sandboxToken && !productionToken) return { statusCode: 400, body: JSON.stringify({ error: 'At least a sandbox token is required for a new screening provider.' }) };
          fields = {
            provider: 'singlekey',
            sandboxToken: sandboxToken || null,
            productionToken: productionToken || null,
            environment: environment === 'production' ? 'production' : 'sandbox',
            handshakeToken: handshakeToken || null,
            tenantPays: tenantPays === true,
            minScore: minScore ? parseInt(minScore) : null,
          };
        }
      } else if (type === 'income_verification') {
        // Truv only, for now — a separate type from 'screening' rather
        // than a third provider option there, since it runs independently
        // (an admin can have RentPrep or SingleKey active for background
        // checks *and* Truv active for income, at the same time — these
        // aren't alternatives to each other the way SingleKey/RentPrep are).
        const { clientId, sandboxSecret, productionSecret, environment } = body;
        if (!clientId) return { statusCode: 400, body: JSON.stringify({ error: 'clientId is required for a new income verification provider.' }) };
        if (!sandboxSecret && !productionSecret) return { statusCode: 400, body: JSON.stringify({ error: 'At least a sandbox secret is required for a new income verification provider.' }) };
        fields = {
          provider: 'truv',
          clientId,
          sandboxSecret: sandboxSecret || null,
          productionSecret: productionSecret || null,
          environment: environment === 'production' ? 'production' : 'sandbox',
        };
      } else if (type === 'sms') {
        const { provider, apiKey, messagingProfileId, accountSid, authToken, fromNumber, username } = body;
        if (provider === 'twilio') {
          if (!fromNumber) return { statusCode: 400, body: JSON.stringify({ error: 'fromNumber is required for a new Twilio SMS provider (the phone number to send from, in +E.164 format).' }) };
          if (!accountSid || !authToken) return { statusCode: 400, body: JSON.stringify({ error: 'accountSid and authToken are required for a new Twilio SMS provider.' }) };
          fields = { provider: 'twilio', accountSid, authToken, fromNumber };
        } else if (provider === 'clicksend') {
          if (!username || !apiKey) return { statusCode: 400, body: JSON.stringify({ error: 'username and apiKey are required for a new ClickSend SMS provider.' }) };
          fields = { provider: 'clicksend', username, apiKey };
        } else {
          if (!fromNumber) return { statusCode: 400, body: JSON.stringify({ error: 'fromNumber is required for a new Telnyx SMS provider (the phone number to send from, in +E.164 format).' }) };
          if (!apiKey) return { statusCode: 400, body: JSON.stringify({ error: 'apiKey is required for a new Telnyx SMS provider.' }) };
          fields = { provider: 'telnyx', apiKey, fromNumber, messagingProfileId: messagingProfileId || null };
        }
      } else {
        // whatsapp — Twilio only. contentSid identifies the WhatsApp
        // template approved for the "new announcement" use case; see
        // _lib/send-whatsapp.js for why a template is required at all.
        // contentSidEs is optional — WhatsApp/Meta approves each language
        // of a template independently, so a Spanish announcement needs
        // its own, separately-approved template and SID, not a translated
        // variable inside the English one.
        const { accountSid, authToken, fromNumber, contentSid, contentSidEs } = body;
        if (!accountSid || !authToken) return { statusCode: 400, body: JSON.stringify({ error: 'accountSid and authToken are required for a new WhatsApp provider.' }) };
        if (!fromNumber) return { statusCode: 400, body: JSON.stringify({ error: 'fromNumber is required for a new WhatsApp provider (your Twilio WhatsApp Sender number, in +E.164 format).' }) };
        if (!contentSid) return { statusCode: 400, body: JSON.stringify({ error: 'contentSid is required — the approved Content Template SID (starts with "HX") from your Twilio Console.' }) };
        fields = { provider: 'twilio', accountSid, authToken, fromNumber, contentSid, contentSidEs: contentSidEs || null };
      }

      const defaultLabel = { email: 'Email Provider', storage: 'Storage Provider', envelope: 'Envelope Provider', screening: 'Screening Provider', income_verification: 'Income Verification Provider', sms: 'SMS Provider', whatsapp: 'WhatsApp Provider' }[type];
      const ref = await coll.add({
        type, label: label || defaultLabel,
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
        if (d.backend === 'r2') {
          if (body.accountId !== undefined) update.accountId = body.accountId;
          if (body.bucketName !== undefined) update.bucketName = body.bucketName;
          if (body.publicUrl !== undefined) update.publicUrl = body.publicUrl.replace(/\/+$/, '');
          if (body.accessKeyId) update.accessKeyId = body.accessKeyId; // blank = keep existing
          if (body.secretAccessKey) update.secretAccessKey = body.secretAccessKey; // blank = keep existing
        } else {
          if (body.cloudName !== undefined) update.cloudName = body.cloudName;
          if (body.apiKey !== undefined) update.apiKey = body.apiKey;
          if (body.apiSecret) update.apiSecret = body.apiSecret; // blank = keep existing
        }
      } else if (d.type === 'envelope') {
        if (body.templateId !== undefined) update.templateId = body.templateId;
        if (body.apiUrl !== undefined) update.apiUrl = body.apiUrl.replace(/\/+$/, '');
        if (body.appUrl !== undefined) update.appUrl = body.appUrl.replace(/\/+$/, '');
        if (body.apiKey) update.apiKey = body.apiKey; // blank = keep existing
        if (body.webhookSecret) update.webhookSecret = body.webhookSecret; // blank = keep existing
      } else if (d.type === 'screening') {
        if (body.environment !== undefined) update.environment = body.environment === 'production' ? 'production' : 'sandbox';
        if (body.tenantPays !== undefined) update.tenantPays = body.tenantPays === true;
        if (body.minScore !== undefined) update.minScore = body.minScore ? parseInt(body.minScore) : null;
        if (d.provider === 'rentprep') {
          if (body.evictionsIncluded !== undefined) update.evictionsIncluded = body.evictionsIncluded !== false;
          if (body.sandboxKey) update.sandboxKey = body.sandboxKey; // blank = keep existing
          if (body.productionKey) update.productionKey = body.productionKey; // blank = keep existing
          for (const f of ['landlordFirstName','landlordLastName','landlordStreet','landlordCity','landlordState','landlordZip','landlordPhone','landlordEmail']) {
            if (body[f] !== undefined) update[f] = body[f];
          }
        } else {
          if (body.sandboxToken) update.sandboxToken = body.sandboxToken; // blank = keep existing
          if (body.productionToken) update.productionToken = body.productionToken; // blank = keep existing
          if (body.handshakeToken) update.handshakeToken = body.handshakeToken; // blank = keep existing
        }
      } else if (d.type === 'income_verification') {
        if (body.environment !== undefined) update.environment = body.environment === 'production' ? 'production' : 'sandbox';
        if (body.clientId !== undefined) update.clientId = body.clientId;
        if (body.sandboxSecret) update.sandboxSecret = body.sandboxSecret; // blank = keep existing
        if (body.productionSecret) update.productionSecret = body.productionSecret; // blank = keep existing
      } else if (d.type === 'sms') {
        if (body.fromNumber !== undefined) update.fromNumber = body.fromNumber; // no-op for ClickSend, which has no fromNumber field
        if (d.provider === 'twilio') {
          if (body.accountSid !== undefined) update.accountSid = body.accountSid;
          if (body.authToken) update.authToken = body.authToken; // blank = keep existing
        } else if (d.provider === 'clicksend') {
          if (body.username !== undefined) update.username = body.username;
          if (body.apiKey) update.apiKey = body.apiKey; // blank = keep existing
        } else {
          if (body.messagingProfileId !== undefined) update.messagingProfileId = body.messagingProfileId;
          if (body.apiKey) update.apiKey = body.apiKey; // blank = keep existing
        }
      } else if (d.type === 'whatsapp') {
        if (body.accountSid !== undefined) update.accountSid = body.accountSid;
        if (body.fromNumber !== undefined) update.fromNumber = body.fromNumber;
        if (body.contentSid !== undefined) update.contentSid = body.contentSid;
        if (body.contentSidEs !== undefined) update.contentSidEs = body.contentSidEs;
        if (body.authToken) update.authToken = body.authToken; // blank = keep existing
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
      const { id, backend, cloudName, apiKey, apiSecret, accountId, accessKeyId, secretAccessKey, bucketName } = body;

      // Resolve which backend is actually being tested: explicit param
      // takes priority (used when testing unsaved form values); otherwise
      // look up the saved document to find out, rather than guessing from
      // which fields happen to be present in the request.
      let resolvedBackend = backend;
      let savedDoc = null;
      if (!resolvedBackend && id) {
        const snap = await coll.doc(id).get();
        if (!snap.exists || snap.data().type !== 'storage') return { statusCode: 404, body: JSON.stringify({ error: 'Storage provider not found.' }) };
        savedDoc = snap.data();
        resolvedBackend = savedDoc.backend || 'cloudinary';
      }

      if (resolvedBackend === 'r2') {
        let creds = null;
        if (accountId && accessKeyId && bucketName) {
          let effectiveSecret = secretAccessKey;
          if (!effectiveSecret && id) {
            effectiveSecret = savedDoc ? savedDoc.secretAccessKey : (await coll.doc(id).get()).data()?.secretAccessKey;
          }
          if (!effectiveSecret) return { statusCode: 400, body: JSON.stringify({ error: 'Enter a secret access key to test with.' }) };
          creds = { accountId, accessKeyId, secretAccessKey: effectiveSecret, bucketName };
        } else if (savedDoc) {
          creds = savedDoc;
        } else {
          return { statusCode: 400, body: JSON.stringify({ error: 'No R2 configuration given to test.' }) };
        }

        const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
        const client = new S3Client({
          region: 'auto',
          endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
          forcePathStyle: true,
        });
        try {
          await client.send(new HeadBucketCommand({ Bucket: creds.bucketName }));
        } catch (err) {
          return { statusCode: 400, body: JSON.stringify({ error: `R2 rejected these credentials: ${err.message || 'check your Account ID, Access Key, Secret, and bucket name.'}` }) };
        }
        return { statusCode: 200, body: JSON.stringify({ success: true, message: `Connected successfully to bucket "${creds.bucketName}".` }) };
      }

      // Cloudinary path (default)
      let creds = null;
      if (cloudName && apiKey) {
        let effectiveSecret = apiSecret;
        if (!effectiveSecret && id) {
          effectiveSecret = savedDoc ? savedDoc.apiSecret : (await coll.doc(id).get()).data()?.apiSecret;
        }
        if (!effectiveSecret) return { statusCode: 400, body: JSON.stringify({ error: 'Enter an API secret to test with.' }) };
        creds = { cloudName, apiKey, apiSecret: effectiveSecret };
      } else if (savedDoc) {
        creds = savedDoc;
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

    // ── TEST ENVELOPE — reuses the exact GET /template/{id} call
    //    generate-lease.js already makes, so this validates both the API
    //    key AND the template id together, not just "is the key valid" ──
    if (action === 'test_envelope') {
      const { id, apiKey, templateId, apiUrl } = body;
      let creds = null;
      if (apiKey && templateId) {
        creds = { apiKey, templateId, apiUrl: (apiUrl || 'https://app.documenso.com/api/v2').replace(/\/+$/, '') };
      } else if (id) {
        const snap = await coll.doc(id).get();
        if (!snap.exists || snap.data().type !== 'envelope') return { statusCode: 404, body: JSON.stringify({ error: 'Envelope provider not found.' }) };
        creds = snap.data();
      } else {
        return { statusCode: 400, body: JSON.stringify({ error: 'No envelope configuration given to test.' }) };
      }
      if (!creds.templateId) return { statusCode: 400, body: JSON.stringify({ error: 'A template ID is required to test — set one from your Documenso template list.' }) };

      const res = await fetch(`${creds.apiUrl}/template/${creds.templateId}`, {
        headers: { Authorization: creds.apiKey, 'Content-Type': 'application/json' },
      });
      let data = null; try { data = await res.json(); } catch {}
      if (!res.ok) {
        return { statusCode: 400, body: JSON.stringify({ error: data?.message || `Documenso rejected this (HTTP ${res.status}). Check the API key and template ID.` }) };
      }
      const recipientCount = (data.recipients || data.Recipient || []).length;
      const fieldCount = (data.fields || data.Field || []).length;
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: `Connected successfully. Template found with ${recipientCount} recipient(s) and ${fieldCount} field(s).`,
        }),
      };
    }

    // ── TEST SCREENING — SingleKey's own auth docs confirm GET /api/payments
    //    is the way to verify a token works; it's read-only and doesn't
    //    create or charge anything. ─────────────────────────────────────
    if (action === 'test_screening') {
      const { id, provider, sandboxToken, productionToken, sandboxKey, productionKey, environment } = body;
      const env = environment === 'production' ? 'production' : 'sandbox';
      let effectiveProvider = provider;
      let key, token, baseUrl;

      if (id && !sandboxToken && !productionToken && !sandboxKey && !productionKey) {
        const snap = await coll.doc(id).get();
        if (!snap.exists || snap.data().type !== 'screening') return { statusCode: 404, body: JSON.stringify({ error: 'Screening provider not found.' }) };
        const d = snap.data();
        effectiveProvider = d.provider || 'singlekey';
        if (effectiveProvider === 'rentprep') key = d.environment === 'production' ? d.productionKey : d.sandboxKey;
        else token = d.environment === 'production' ? d.productionToken : d.sandboxToken;
      } else {
        key = env === 'production' ? productionKey : sandboxKey;
        token = env === 'production' ? productionToken : sandboxToken;
      }

      if (effectiveProvider === 'rentprep') {
        if (!key) return { statusCode: 400, body: JSON.stringify({ error: `No ${env} key given to test with.` }) };
        baseUrl = env === 'production' ? 'https://apiv3.rentprep.com' : 'https://apiv3.sandbox.rentprep.com';
        // No dedicated health-check endpoint is documented, so this uses
        // "get all applications" for a reference ID that's never actually
        // been used to create anything — a bad key fails with an auth
        // error before RentPrep even looks at the reference ID, so this
        // is a safe, read-only way to validate credentials.
        const res = await fetch(`${baseUrl}/smartmove/application/all/connection-test?limit=1`, {
          headers: { 'x-apiKey': key },
        });
        let data = null; try { data = await res.json(); } catch {}
        if (!res.ok) {
          return { statusCode: 400, body: JSON.stringify({ error: data?.Message || `RentPrep rejected this ${env} key (HTTP ${res.status}). Check it's correct for this environment.` }) };
        }
        return { statusCode: 200, body: JSON.stringify({ success: true, message: `${env === 'production' ? 'Production' : 'Sandbox'} key validated successfully.` }) };
      }

      // SingleKey
      if (!token) return { statusCode: 400, body: JSON.stringify({ error: `No ${env} token given to test with.` }) };
      baseUrl = env === 'production' ? 'https://platform.singlekey.com' : 'https://sandbox.singlekey.com';
      const res = await fetch(`${baseUrl}/api/payments`, {
        headers: { Authorization: `Token ${token}` },
      });
      let data = null; try { data = await res.json(); } catch {}
      if (!res.ok) {
        return { statusCode: 400, body: JSON.stringify({ error: data?.detail || `SingleKey rejected this ${env} token (HTTP ${res.status}). Check it's correct for this environment.` }) };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: `${env === 'production' ? 'Production' : 'Sandbox'} token validated successfully.${data?.has_payment_method === false ? ' Note: no payment method on file yet — needed before real screenings can be purchased.' : ''}`,
        }),
      };
    }

    if (action === 'test_income_verification') {
      const { id, clientId, sandboxSecret, productionSecret, environment } = body;
      const env = environment === 'production' ? 'production' : 'sandbox';
      let effectiveClientId = clientId, secret = env === 'production' ? productionSecret : sandboxSecret;

      if (id && !sandboxSecret && !productionSecret) {
        const snap = await coll.doc(id).get();
        if (!snap.exists || snap.data().type !== 'income_verification') return { statusCode: 404, body: JSON.stringify({ error: 'Income verification provider not found.' }) };
        const d = snap.data();
        effectiveClientId = d.clientId;
        secret = d.environment === 'production' ? d.productionSecret : d.sandboxSecret;
      }
      if (!effectiveClientId || !secret) return { statusCode: 400, body: JSON.stringify({ error: `A client ID and ${env} secret are both needed to test.` }) };

      // Truv's own docs describe a single base URL for every environment —
      // the Access Secret's prefix (sandbox-/prod-) is what actually
      // routes the request, not the URL itself.
      //
      // No dedicated, read-only "just validate my credentials" endpoint
      // was found in the documentation gathered for this integration, so
      // this uses "create a user" as the test call — a bad key fails
      // before a user is ever created, but valid credentials will leave
      // behind one small, real (empty) user record per test click. Worth
      // knowing if RentBay's own dashboard ever surfaces a user count.
      const res = await fetch('https://prod.truv.com/v1/users/', {
        method: 'POST',
        headers: { 'X-Access-Client-Id': effectiveClientId, 'X-Access-Secret': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      let data = null; try { data = await res.json(); } catch {}
      if (!res.ok) {
        return { statusCode: 400, body: JSON.stringify({ error: data?.message || data?.detail || `Truv rejected these ${env} credentials (HTTP ${res.status}). Check they're correct for this environment.` }) };
      }
      return { statusCode: 200, body: JSON.stringify({ success: true, message: `${env === 'production' ? 'Production' : 'Sandbox'} credentials validated successfully.` }) };
    }

    // ── TEST SMS — unlike every other provider's test action, this sends
    //    a REAL message with a REAL (small) cost, since neither Telnyx nor
    //    Twilio expose a free "just validate my credentials" endpoint for
    //    SMS the way Cloudinary/Bold/SingleKey do for their own APIs. The
    //    admin must supply a destination number explicitly. ─────────────
    if (action === 'test_sms') {
      const { id, provider, apiKey, fromNumber, messagingProfileId, accountSid, authToken, username, toNumber } = body;
      if (!toNumber) return { statusCode: 400, body: JSON.stringify({ error: 'Enter a phone number (in +E.164 format) to send the test to.' }) };

      const hasUnsavedCreds = provider === 'twilio' ? (accountSid && authToken && fromNumber)
        : provider === 'clicksend' ? (username && apiKey)
        : (apiKey && fromNumber); // telnyx

      let creds = null;
      if (hasUnsavedCreds) {
        creds = { provider: provider || 'telnyx', apiKey, fromNumber, accountSid, authToken, username };
      } else if (id) {
        const snap = await coll.doc(id).get();
        if (!snap.exists || snap.data().type !== 'sms') return { statusCode: 404, body: JSON.stringify({ error: 'SMS provider not found.' }) };
        creds = snap.data();
      } else {
        return { statusCode: 400, body: JSON.stringify({ error: 'No SMS configuration given to test.' }) };
      }

      try {
        const { sendSms } = require('./_lib/send-sms');
        const providerLabel = { twilio: 'Twilio', clicksend: 'ClickSend', telnyx: 'Telnyx' }[creds.provider] || creds.provider;
        const testText = `Test message from your property management portal via ${providerLabel}. If you received this, your SMS integration is working.`;
        const result = await sendSms({
          provider: creds.provider, apiKey: creds.apiKey, fromNumber: creds.fromNumber,
          accountSid: creds.accountSid, authToken: creds.authToken, username: creds.username, to: toNumber, text: testText,
        });
        const cost = result.cost ? ` Cost: ${result.cost.amount} ${result.cost.currency}.` : '';
        return { statusCode: 200, body: JSON.stringify({ success: true, message: `Test SMS sent to ${toNumber} (status: ${result.status}).${cost} This was a real message, not a free validation check.` }) };
      } catch (err) {
        return { statusCode: 400, body: JSON.stringify({ error: err.message || 'Could not send test SMS.' }) };
      }
    }

    if (action === 'test_whatsapp') {
      const { id, accountSid, authToken, fromNumber, contentSid, contentSidEs, toNumber, lang } = body;
      if (!toNumber) return { statusCode: 400, body: JSON.stringify({ error: 'Enter a WhatsApp number (in +E.164 format) to send the test to.' }) };

      let creds = null;
      if (accountSid && authToken && fromNumber && contentSid) {
        creds = { accountSid, authToken, fromNumber, contentSid, contentSidEs };
      } else if (id) {
        const snap = await coll.doc(id).get();
        if (!snap.exists || snap.data().type !== 'whatsapp') return { statusCode: 404, body: JSON.stringify({ error: 'WhatsApp provider not found.' }) };
        creds = snap.data();
      } else {
        return { statusCode: 400, body: JSON.stringify({ error: 'No WhatsApp configuration given to test.' }) };
      }

      const testInSpanish = lang === 'es';
      if (testInSpanish && !creds.contentSidEs) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No Spanish Content SID is configured for this provider yet — save one first, then test it.' }) };
      }
      const testContentSid = testInSpanish ? creds.contentSidEs : creds.contentSid;

      try {
        const { sendWhatsApp } = require('./_lib/send-whatsapp');
        // Matches the {{1}}, {{2}} placeholders the announcement template
        // is documented to expect — see settings.whatsappTemplateHint in
        // admin.html for the exact wording shown to the admin. Content
        // itself is in whichever language is actually being tested, so a
        // successful send is meaningful, not just a connectivity check.
        const result = await sendWhatsApp({
          accountSid: creds.accountSid, authToken: creds.authToken, fromNumber: creds.fromNumber, contentSid: testContentSid,
          contentVariables: testInSpanish
            ? { '1': 'Prueba', '2': 'Este es un mensaje de prueba de su portal de administración de propiedades. Si recibió esto, su integración de WhatsApp está funcionando.' }
            : { '1': 'Test', '2': 'This is a test message from your property management portal. If you received this, your WhatsApp integration is working.' },
          to: toNumber,
        });
        return { statusCode: 200, body: JSON.stringify({ success: true, message: `Test WhatsApp message sent to ${toNumber} (status: ${result.status}). This was a real message, not a free validation check.` }) };
      } catch (err) {
        return { statusCode: 400, body: JSON.stringify({ error: err.message || 'Could not send test WhatsApp message.' }) };
      }
    }

    return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error('manage-integrations error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
