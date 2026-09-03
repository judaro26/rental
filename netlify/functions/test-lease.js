// netlify/functions/test-lease.js
// Validates the Documenso lease-generation integration end-to-end by
// actually generating and sending a real Documenso document — using
// realistic placeholder lease terms and an obviously-fake tenant name —
// to whatever email address the admin specifies, instead of a real
// applicant.
//
// This is deliberately NOT a dry run: it calls Documenso's real API, the
// same way generate-lease.js does, because a dry run wouldn't actually
// validate the thing that's most likely to be wrong — whether the
// Documenso template's field labels match what this app sends, and
// whether the generated PDF looks right. Kept as a separate,
// self-contained function rather than refactoring generate-lease.js to
// share code, specifically to avoid any risk of destabilizing the
// already-working real lease-generation path while building a test tool
// for it.
//
// Writes nothing to Firestore beyond nothing at all — no application
// record exists for a test send, so there's nothing to update and no
// audit log entry to make. The one deliberate difference from a real
// lease: the "additional terms" field states in the document itself that
// this is a test, in case it's ever opened later without context.
//
// Admin-only (verify-admin.js) — this creates a real Documenso document
// and sends real email, so it must never be reachable by anyone but an
// authenticated admin.
//
// Required env vars: same as generate-lease.js
//   FIREBASE_SERVICE_ACCOUNT
//   DOCUMENSO_API_KEY, DOCUMENSO_TEMPLATE_ID (or a saved integration under Settings → Integrations)
//   DOCUMENSO_API_URL / DOCUMENSO_APP_URL (optional)

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

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

async function documenso(path, apiUrl, apiKey, method = 'GET', payload) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

// A realistic, complete set of lease terms so the test exercises every
// field the real form can send — the admin only needs to supply an email
// (and optionally a property) to run this, matching the low-friction
// pattern of every other "send test X" button in this app.
function placeholderTerms() {
  const start = new Date(); start.setDate(1); start.setMonth(start.getMonth() + 1);
  const end = new Date(start); end.setFullYear(end.getFullYear() + 1); end.setDate(end.getDate() - 1);
  const fmt = d => d.toISOString().split('T')[0];
  return {
    leaseStart: fmt(start), leaseEnd: fmt(end),
    monthlyRent: '2000', securityDeposit: '2000',
    propertyType: 'single', rentControl: 'exempt',
    lateFeeDay: '5', lateFee: '50',
    utilitiesOption: 'a', utilitiesIncluded: [],
    sharedMeterIncluded: [], sharedMeterBilling: 'absorbed', sharedMeterPct: '',
    pets: 'none', petBreed: '', petWeight: '', petName: '', petRent: '',
    additionalTerms: 'THIS IS A TEST DOCUMENT generated to verify the Documenso integration. No real tenancy is created and this lease is not valid.',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const a = getAdmin();
  const db = a.firestore();

  const { verifyAdmin } = require('./_lib/verify-admin');
  const authResult = await verifyAdmin(event, db, a);
  if (authResult.error) return authResult.error;

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { testEmail, propertyId, siteName } = body;
  if (!testEmail) return { statusCode: 400, body: JSON.stringify({ error: 'testEmail is required.' }) };

  // Same credential resolution as generate-lease.js: a saved integration
  // (Settings → Integrations) takes priority over environment variables.
  let apiKey = process.env.DOCUMENSO_API_KEY;
  let apiUrl = (process.env.DOCUMENSO_API_URL || 'https://app.documenso.com/api/v2').replace(/\/+$/, '');
  let envDefaultTemplateId = process.env.DOCUMENSO_TEMPLATE_ID;
  try {
    const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
    const activeId = activeSnap.exists ? activeSnap.data().envelope : null;
    if (activeId) {
      const snap = await db.collection('integrationSecrets').doc(activeId).get();
      if (snap.exists) {
        const d = snap.data();
        if (d.apiKey) apiKey = d.apiKey;
        if (d.apiUrl) apiUrl = d.apiUrl;
        if (d.templateId) envDefaultTemplateId = d.templateId;
      }
    }
  } catch (err) {
    console.warn('test-lease: could not check envelope override, using env vars:', err.message);
  }
  if (!apiKey) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Documenso is not configured. Set it up under Settings → Integrations, or set DOCUMENSO_API_KEY in your Netlify environment.' }) };
  }

  try {
    let prop = {};
    if (propertyId) {
      try { const p = await db.collection('properties').doc(propertyId).get(); if (p.exists) prop = p.data(); } catch {}
    }
    const templateId = prop.documensoTemplateId || envDefaultTemplateId;
    if (!templateId) return { statusCode: 400, body: JSON.stringify({ error: 'No Documenso template configured. Set a default under Settings → Integrations (or a per-property documensoTemplateId).' }) };

    let siteEmail = '', resolvedSiteName = siteName;
    try { const s = await db.collection('settings').doc('site').get(); if (s.exists) { siteEmail = s.data().email || ''; resolvedSiteName = resolvedSiteName || s.data().siteName; } } catch {}
    const landlordName = resolvedSiteName || 'Landlord';
    const landlordEmail = siteEmail || process.env.ADMIN_NOTIFY_EMAIL;
    if (!landlordEmail) return { statusCode: 400, body: JSON.stringify({ error: 'No landlord email is configured. Set a contact email in Settings.' }) };

    const terms = placeholderTerms();
    const tenantName = 'Test Tenant (Sample)';
    const fullAddress = [prop.address, prop.city, [prop.state, prop.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || prop.name || '123 Sample Street (no property selected)';

    // 1) Read the template to discover recipient + field IDs — identical to generate-lease.js.
    const tpl = await documenso(`/template/${templateId}`, apiUrl, apiKey);
    if (!tpl.ok) {
      console.error('test-lease: Documenso get template error:', tpl.status, tpl.data);
      return { statusCode: 502, body: JSON.stringify({ error: `Could not read Documenso template ${templateId}: ${tpl.data?.message || tpl.status}` }) };
    }
    const tplRecipients = tpl.data.recipients || tpl.data.Recipient || [];
    const tplFields = tpl.data.fields || tpl.data.Field || [];

    // 2) Map recipients — the tenant slot goes to testEmail; the landlord
    // slot goes to the real, configured landlord email so that side of
    // the signing flow gets validated too.
    const sorted = [...tplRecipients].sort((x, y) => (x.signingOrder || 0) - (y.signingOrder || 0));
    const recipients = sorted.map((r, i) => {
      const isLandlord = /landlord|lessor|owner/i.test(`${r.name || ''} ${r.email || ''}`) || (sorted.length > 1 && i === sorted.length - 1 && !/tenant|lessee/i.test(`${r.name || ''} ${r.email || ''}`));
      return { id: r.id, name: isLandlord ? landlordName : tenantName, email: isLandlord ? landlordEmail : testEmail };
    });

    // 3) Build the value map and checkbox marks — identical field set to generate-lease.js.
    const values = {
      property_address: fullAddress, landlord_name: landlordName, tenant_name: tenantName, minor_occupants: '',
      lease_start: terms.leaseStart, lease_end: terms.leaseEnd, monthly_rent: terms.monthlyRent, security_deposit: terms.securityDeposit,
      late_fee_day: terms.lateFeeDay, late_fee: terms.lateFee, additional_terms: terms.additionalTerms,
    };
    const marks = {
      property_type_mark_single: terms.propertyType === 'single', property_type_mark_multi: terms.propertyType === 'multi',
      rent_control_exempt_mark: terms.rentControl === 'exempt', rent_control_subject_mark: terms.rentControl === 'subject',
      utilities_option_a_mark: terms.utilitiesOption === 'a', utilities_option_b_mark: terms.utilitiesOption === 'b', utilities_option_c_mark: terms.utilitiesOption === 'c',
      pets_none_mark: terms.pets !== 'allowed', pets_allowed_mark: terms.pets === 'allowed',
    };
    const fieldByLabel = {};
    for (const f of tplFields) {
      const label = f.fieldMeta?.label || f.fieldMeta?.text || f.name || ''; if (!label) continue;
      const key = norm(label); (fieldByLabel[key] = fieldByLabel[key] || []).push(f);
    }
    const prefillFields = [];
    for (const [key, val] of Object.entries(values)) {
      if (val === undefined || val === null || val === '') continue;
      const fs = fieldByLabel[norm(key)]; if (!fs) continue;
      for (const f of fs) { const type = String(f.type || 'TEXT').toLowerCase(); prefillFields.push({ id: f.id, type: type === 'number' ? 'number' : 'text', value: String(val) }); }
    }
    for (const [key, checked] of Object.entries(marks)) {
      const fs = fieldByLabel[norm(key)]; if (!fs) continue;
      for (const f of fs) prefillFields.push({ id: f.id, type: 'text', value: checked ? 'X' : ' ' });
    }

    // 4) Create + immediately send the document — this is the real, live call.
    const gen = await documenso('/template/use', apiUrl, apiKey, 'POST', {
      templateId: Number(templateId) || templateId,
      recipients,
      prefillFields,
      distributeDocument: true,
      override: { title: `TEST Lease — ${tenantName}` },
    });
    if (!gen.ok) {
      console.error('test-lease: Documenso template/use error:', gen.status, gen.data);
      return { statusCode: 502, body: JSON.stringify({ error: `Documenso document generation failed: ${gen.data?.message || JSON.stringify(gen.data) || gen.status}` }) };
    }
    const docObj = gen.data.document || gen.data;
    const documentId = docObj.id || docObj.documentId;
    const recs = docObj.recipients || docObj.Recipient || [];
    const tenantRec = recs.find(r => (r.email || '').toLowerCase() === testEmail.toLowerCase());

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        documentId: documentId != null ? String(documentId) : null,
        sentTo: testEmail,
        fieldsMatched: prefillFields.length,
        fieldsRequested: Object.keys(values).length + Object.keys(marks).length,
        signingUrl: tenantRec?.signingUrl || null,
      }),
    };
  } catch (err) {
    console.error('test-lease error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
