// netlify/functions/generate-lease.js
// Admin action (for an APPROVED application): generates a lease agreement for
// e-signature using Documenso. It reads a Documenso TEMPLATE you set up once,
// prefills the template's text fields with the property + term details the admin
// selected, attaches the applicant (Tenant) and you (Landlord) as signers, and
// sends it for signature.
//
// ── One-time Documenso setup ────────────────────────────────────────────────────────
// 1. Create an API key: Documenso → Settings → API Tokens. Set DOCUMENSO_API_KEY.
// 2. Create a lease Template (upload your lease PDF) with:
//    • Recipients named "Tenant" and "Landlord" (add SIGNATURE + DATE fields for each).
//    • TEXT fields whose labels match any of these (spaces/underscores/case ignored):
//      property_address, minor_occupants, lease_start, lease_end, monthly_rent, security_deposit, late_fee_day, late_fee, shared_meter_pct, pet_breed, pet_weight, pet_name, pet_rent, additional_terms
//      and checkbox-mark fields (write 'X' to mark true): property_type_mark_single/multi,
//      rent_control_exempt/subject_mark, utilities_option_a/b/c_mark, utilities_b_electricity/gas/water/trash_mark, shared_meter_electricity/gas_mark, shared_meter_billing_absorbed/prorated_mark, pets_none/allowed_mark
//    Copy the template's numeric `id` (NOT the "envelope_..." string) → set DOCUMENSO_TEMPLATE_ID.
//    (Optional: a property can override with its own `documensoTemplateId` field.)
//
// NOTE: Documenso is migrating from templates/documents to a unified "envelope" model.
// This file uses the v2 /template/* endpoints (numeric IDs), which still work today but
// are themselves flagged for eventual replacement by /envelope/* — see Documenso's
// migration guide before March 2027.
//
// Required env vars:
//   FIREBASE_SERVICE_ACCOUNT
//   DOCUMENSO_API_KEY
//   DOCUMENSO_TEMPLATE_ID        (numeric template id, e.g. "123")
//   DOCUMENSO_API_URL (optional, default https://app.documenso.com/api/v2)
//   DOCUMENSO_APP_URL (optional, default https://app.documenso.com — builds signing links)

const nodemailer = require('nodemailer');

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

exports.handler = async (event) => {
  await require('./_lib/apply-email-config')(); // load any custom email provider override before this function's existing nodemailer code runs
    if (event.httpMethod !== 'POST') {
          return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const a = getAdmin();
    const db = a.firestore();

    // Resolve Documenso credentials: a saved integration (Settings →
    // Integrations) takes priority over the environment variables, which
    // remain the fallback if nothing is configured there — same
    // override-with-fallback pattern as email/storage.
    let apiKey = process.env.DOCUMENSO_API_KEY;
    let apiUrl = (process.env.DOCUMENSO_API_URL || 'https://app.documenso.com/api/v2').replace(/\/+$/, '');
    let appUrl = (process.env.DOCUMENSO_APP_URL || 'https://app.documenso.com').replace(/\/+$/, '');
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
                          if (d.appUrl) appUrl = d.appUrl;
                          if (d.templateId) envDefaultTemplateId = d.templateId;
                  }
          }
    } catch (err) {
          console.warn('generate-lease: could not check envelope override, using env vars:', err.message);
    }

    if (!apiKey) {
          return { statusCode: 400, body: JSON.stringify({ error: 'Documenso is not configured. Set it up under Settings → Integrations, or set DOCUMENSO_API_KEY in your Netlify environment.' }) };
    }

    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { applicationId, terms = {}, siteName } = body;
    if (!applicationId) return { statusCode: 400, body: JSON.stringify({ error: 'applicationId is required.' }) };

    try {
          const ref = db.collection('applications').doc(applicationId);
          const snap = await ref.get();
          if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Application not found.' }) };
          const app = snap.data();
          if (!app.email) return { statusCode: 400, body: JSON.stringify({ error: 'This applicant has no email address on file.' }) };
          if (app.status !== 'approved') return { statusCode: 400, body: JSON.stringify({ error: 'The application must be approved before a lease can be generated.' }) };

      let prop = {};
          if (app.propertyId) {
                  try { const p = await db.collection('properties').doc(app.propertyId).get(); if (p.exists) prop = p.data(); } catch {}
          }

      const templateId = prop.documensoTemplateId || envDefaultTemplateId;
          if (!templateId) return { statusCode: 400, body: JSON.stringify({ error: 'No Documenso template configured. Set a default under Settings → Integrations (or a per-property documensoTemplateId).' }) };

      // Landlord identity: terms → site settings → admin email.
      let siteEmail = '', resolvedSiteName = siteName;
          try { const s = await db.collection('settings').doc('site').get(); if (s.exists) { siteEmail = s.data().email || ''; resolvedSiteName = resolvedSiteName || s.data().siteName; } } catch {}
          const landlordName = terms.landlordName || resolvedSiteName || 'Landlord';
          const landlordEmail = terms.landlordEmail || siteEmail || process.env.ADMIN_NOTIFY_EMAIL;
          if (!landlordEmail) return { statusCode: 400, body: JSON.stringify({ error: 'No landlord email is configured. Set a contact email in Settings or provide one on the lease form.' }) };

      const tenantName = `${app.firstName || ''} ${app.lastName || ''}`.trim() || 'Tenant';
          const fullAddress = [prop.address, prop.city, [prop.state, prop.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || prop.name || '';
          
                  

      const minorOccupants = Array.isArray(app.occupants) ? app.occupants.filter(o => o && Number(o.age) < 18).map(o => `${o.name || ''}${o.age ? ' (age ' + o.age + ')' : ''}`).join(', ') : ''; // 1) Read the template to discover recipient + field IDs.
      const tpl = await documenso(`/template/${templateId}`, apiUrl, apiKey);
          if (!tpl.ok) {
                  console.error('Documenso get template error:', tpl.status, tpl.data);
                  return { statusCode: 502, body: JSON.stringify({ error: `Could not read Documenso template ${templateId}: ${tpl.data?.message || tpl.status}` }) };
          }
          const tplRecipients = tpl.data.recipients || tpl.data.Recipient || [];
          const tplFields = tpl.data.fields || tpl.data.Field || [];

      // Map recipients → actual signers. Match by "landlord" keyword; otherwise by order.
      const sorted = [...tplRecipients].sort((x, y) => (x.signingOrder || 0) - (y.signingOrder || 0));
          const recipients = sorted.map((r, i) => {
                  const isLandlord = /landlord|lessor|owner/i.test(`${r.name || ''} ${r.email || ''}`) || (sorted.length > 1 && i === sorted.length - 1 && !/tenant|lessee/i.test(`${r.name || ''} ${r.email || ''}`));
                  return {
                            id: r.id,
                            name: isLandlord ? landlordName : tenantName,
                            email: isLandlord ? landlordEmail : app.email,
                  };
          });

      // Build the value map, then match to template text fields by normalized label.
      const values = {
              property_address: fullAddress, landlord_name: landlordName, tenant_name: tenantName, minor_occupants: minorOccupants, lease_start: terms.leaseStart, lease_end: terms.leaseEnd, monthly_rent: terms.monthlyRent, security_deposit: terms.securityDeposit, late_fee_day: terms.lateFeeDay, late_fee: terms.lateFee, shared_meter_pct: terms.sharedMeterBilling === 'prorated' ? terms.sharedMeterPct : undefined, pet_breed: terms.pets === 'allowed' ? terms.petBreed : undefined, pet_weight: terms.pets === 'allowed' ? terms.petWeight : undefined, pet_name: terms.pets === 'allowed' ? terms.petName : undefined, pet_rent: terms.pets === 'allowed' ? terms.petRent : undefined, additional_terms: terms.additionalTerms,
      };
          const marks = { property_type_mark_single: terms.propertyType === 'single', property_type_mark_multi: terms.propertyType === 'multi', rent_control_exempt_mark: terms.rentControl === 'exempt', rent_control_subject_mark: terms.rentControl === 'subject', utilities_option_a_mark: terms.utilitiesOption === 'a', utilities_option_b_mark: terms.utilitiesOption === 'b', utilities_option_c_mark: terms.utilitiesOption === 'c', utilities_b_electricity_mark: terms.utilitiesOption === 'b' && (terms.utilitiesIncluded||[]).includes('electricity'), utilities_b_gas_mark: terms.utilitiesOption === 'b' && (terms.utilitiesIncluded||[]).includes('gas'), utilities_b_water_mark: terms.utilitiesOption === 'b' && (terms.utilitiesIncluded||[]).includes('water'), utilities_b_trash_mark: terms.utilitiesOption === 'b' && (terms.utilitiesIncluded||[]).includes('trash'), shared_meter_electricity_mark: terms.utilitiesOption === 'c' && (terms.sharedMeterIncluded||[]).includes('electricity'), shared_meter_gas_mark: terms.utilitiesOption === 'c' && (terms.sharedMeterIncluded||[]).includes('gas'), shared_meter_billing_absorbed_mark: terms.utilitiesOption === 'c' && terms.sharedMeterBilling === 'absorbed', shared_meter_billing_prorated_mark: terms.utilitiesOption === 'c' && terms.sharedMeterBilling === 'prorated', pets_none_mark: terms.pets !== 'allowed', pets_allowed_mark: terms.pets === 'allowed', }; const fieldByLabel = {};
          for (const f of tplFields) {
                  const label = f.fieldMeta?.label || f.fieldMeta?.text || f.name || ''; if (!label) continue; const key = norm(label); (fieldByLabel[key] = fieldByLabel[key] || []).push(f); }
        const prefillFields = [];
        for (const [key, val] of Object.entries(values)) { if (val === undefined || val === null || val === '') continue; const fs = fieldByLabel[norm(key)]; if (!fs) continue; for (const f of fs) { const type = String(f.type || 'TEXT').toLowerCase(); prefillFields.push({ id: f.id, type: type === 'number' ? 'number' : 'text', value: String(val) }); } }

        for (const [key, checked] of Object.entries(marks)) { const fs = fieldByLabel[norm(key)]; if (!fs) continue; for (const f of fs) { prefillFields.push({ id: f.id, type: 'text', value: checked ? 'X' : ' ' }); } } // 2) Create + immediately send the document from the template (v2 template/use).
      const gen = await documenso('/template/use', apiUrl, apiKey, 'POST', {
              templateId: Number(templateId) || templateId,
              recipients,
              prefillFields,
              distributeDocument: true,
              override: { title: 'Lease — ' + tenantName + (prop.name ? ' — ' + prop.name : '') },
      });
          if (!gen.ok) {
                  console.error('Documenso template/use error:', gen.status, gen.data);
                  return { statusCode: 502, body: JSON.stringify({ error: `Documenso document generation failed: ${gen.data?.message || JSON.stringify(gen.data) || gen.status}` }) };
          }
          const docObj = gen.data.document || gen.data;
          const documentId = docObj.id || docObj.documentId;
          const recs = docObj.recipients || docObj.Recipient || [];

      const tenantRec = recs.find(r => (r.email || '').toLowerCase() === (app.email || '').toLowerCase());
          const landlordRec = recs.find(r => (r.email || '').toLowerCase() === (landlordEmail || '').toLowerCase());

      const leaseAgreement = {
              provider: 'documenso',
              templateId: String(templateId),
              documentId: documentId != null ? String(documentId) : null,
              status: 'sent',
              tenantSigningUrl: tenantRec?.signingUrl || null,
              landlordSigningUrl: landlordRec?.signingUrl || null,
              terms, landlordName,
              createdAt: new Date().toISOString(),
      };
          await ref.update({ leaseAgreement, updatedAt: a.firestore.FieldValue.serverTimestamp() });

      try {
              await db.collection('applicationAuditLog').add({
                        applicationId, shortId: app.applicationId || applicationId.substring(0, 8).toUpperCase(),
                        action: 'lease_generated', applicantEmail: app.email,
                        documentId: leaseAgreement.documentId, timestamp: a.firestore.FieldValue.serverTimestamp(),
              });
      } catch (e) { console.warn('lease audit failed:', e.message); }

      if (process.env.SMTP_HOST && process.env.ADMIN_NOTIFY_EMAIL) {
              try {
                        const transporter = nodemailer.createTransport({
                                    host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'),
                                    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
                                    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
                        });
                        const llLink = leaseAgreement.landlordSigningUrl ? `<p><a href="${leaseAgreement.landlordSigningUrl}">Open your (landlord) signing link</a></p>` : '';
                        await transporter.sendMail({
                                    from: process.env.SMTP_FROM || process.env.SMTP_USER,
                                    to: process.env.ADMIN_NOTIFY_EMAIL,
                                    subject: `📝 Lease sent for signature — ${tenantName}`,
                                    html: `<p>A lease agreement was generated via Documenso and sent for signature.</p>
                                                     <p><strong>Tenant:</strong> ${tenantName} (${app.email})<br><strong>Property:</strong> ${prop.name || app.propertyName || ''}</p>${llLink}`,
                        });
              } catch (e) { console.warn('lease admin notify failed:', e.message); }
      }

      return { statusCode: 200, body: JSON.stringify({ success: true, documentId: leaseAgreement.documentId, tenantSigningUrl: leaseAgreement.tenantSigningUrl, landlordSigningUrl: leaseAgreement.landlordSigningUrl }) };
    } catch (err) {
          console.error('generate-lease error:', err);
          return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
