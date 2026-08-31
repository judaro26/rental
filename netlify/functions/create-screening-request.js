// netlify/functions/create-screening-request.js
// Admin-triggered: initiates a SingleKey "tenant form" screening request for
// a specific application. Uses the form-based flow SingleKey's own docs
// recommend for most integrations — SingleKey hosts the actual data
// collection (SSN/DOB, etc.), so this app never has to receive or store
// that PII itself. The applicant gets emailed a link to complete their
// screening directly with SingleKey; results flow back via webhook
// (singlekey-webhook.js) once complete.
//
// US/Canada only — this is a hard limitation of the underlying provider,
// not a choice made here. Applications tied to a non-US property are
// rejected before any request is sent.

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

async function getActiveScreeningProvider(db) {
  const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
  const activeId = activeSnap.exists ? activeSnap.data().screening : null;
  if (!activeId) return null;
  const snap = await db.collection('integrationSecrets').doc(activeId).get();
  if (!snap.exists) return null;
  return snap.data();
}

exports.handler = async (event) => {
  await require('./_lib/apply-email-config')();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) };

  const a = getAdmin();
  const db = a.firestore();

  let decoded;
  try { decoded = await a.auth().verifyIdToken(match[1]); }
  catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) }; }

  const adminSnap = await db.collection('admins').doc(decoded.uid).get();
  if (!adminSnap.exists) return { statusCode: 403, body: JSON.stringify({ error: 'Caller is not an admin.' }) };
  const adminData = adminSnap.data();
  if (adminData.status === 'revoked') return { statusCode: 403, body: JSON.stringify({ error: 'Access revoked.' }) };
  const callerEmail = adminData.email || decoded.email || '';

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { applicationId } = body;
  if (!applicationId) return { statusCode: 400, body: JSON.stringify({ error: 'applicationId is required.' }) };

  try {
    const appRef = db.collection('applications').doc(applicationId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Application not found.' }) };
    const application = appSnap.data();

    if (!application.email) return { statusCode: 400, body: JSON.stringify({ error: 'This applicant has no email address on file.' }) };
    if (!application.consent?.backgroundCheck) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This applicant has not consented to a background check yet.' }) };
    }

    let property = {};
    if (application.propertyId) {
      const propSnap = await db.collection('properties').doc(application.propertyId).get();
      if (propSnap.exists) property = propSnap.data();
    }

    // Restricted admins may only screen applicants for properties in their
    // own country, matching every other property-scoped action in this app.
    if (adminData.role === 'restricted_admin' && property.country !== adminData.allowedCountry) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized to screen this applicant.' }) };
    }

    // Hard limitation of the underlying provider, not a choice made here —
    // SingleKey only covers USA and Canada.
    if (property.country !== 'US') {
      return { statusCode: 400, body: JSON.stringify({ error: 'This screening provider only supports US (and Canada) properties. This applicant\'s property is not eligible.' }) };
    }
    if (!property.address || !property.city || !property.state) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This property is missing address details needed for screening (street, city, and state are all required).' }) };
    }

    const provider = await getActiveScreeningProvider(db);
    if (!provider) return { statusCode: 400, body: JSON.stringify({ error: 'No screening provider configured. Set one up under Settings → Integrations.' }) };
    const env = provider.environment === 'production' ? 'production' : 'sandbox';
    const token = env === 'production' ? provider.productionToken : provider.sandboxToken;
    if (!token) return { statusCode: 400, body: JSON.stringify({ error: `No ${env} token configured for the screening provider.` }) };
    const baseUrl = env === 'production' ? 'https://platform.singlekey.com' : 'https://sandbox.singlekey.com';

    const purchaseAddress = `${property.address}, ${property.city}, ${property.state}, USA, ${property.zip || ''}`.replace(/,\s*$/, '');

    const res = await fetch(`${baseUrl}/screen/embedded_flow_request`, {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        external_customer_id: process.env.SITE_URL || 'landlord',
        external_tenant_id: applicationId,
        external_listing_id: application.propertyId || undefined,
        tenant_form: true,
        ten_email: application.email,
        ten_first_name: application.firstName || undefined,
        ten_last_name: application.lastName || undefined,
        purchase_address: purchaseAddress,
        purchase_rent: property.rent ? Number(property.rent) : undefined,
        purchase_unit: application.unitLabel || undefined,
        tenant_pays: provider.tenantPays === true,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      return { statusCode: 400, body: JSON.stringify({ error: (data.errors && data.errors.join('; ')) || data.detail || `SingleKey rejected this request (HTTP ${res.status}).` }) };
    }

    await appRef.update({
      screening: {
        provider: 'singlekey',
        environment: env,
        purchaseToken: data.purchase_token,
        tenantFormUrl: data.tenant_form_url,
        status: 'sent',
        requestedAt: a.firestore.FieldValue.serverTimestamp(),
        requestedBy: callerEmail,
        tenantPays: provider.tenantPays === true,
      },
    });

    // Email the applicant their screening link directly.
    if (process.env.SMTP_HOST) {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: parseInt(process.env.SMTP_PORT || '587') === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      let siteName = 'Tenant Portal';
      try {
        const settingsSnap = await db.collection('settings').doc('site').get();
        if (settingsSnap.exists) siteName = settingsSnap.data().siteName || siteName;
      } catch { /* use default siteName */ }
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: application.email,
          subject: `Complete your rental screening for ${property.name || 'your application'}`,
          html: `
            <p>Hi ${application.firstName || 'there'},</p>
            <p>To move forward with your application${property.name ? ` for ${property.name}` : ''}, please complete your rental screening (credit and background check) using the secure link below.</p>
            <p><a href="${data.tenant_form_url}" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:12px 28px;border-radius:2px;">Complete Screening</a></p>
            ${provider.tenantPays ? '<p style="font-size:12px;color:#6B7280;">A screening fee is required as part of this process.</p>' : ''}
            <p style="font-size:12px;color:#9CA3AF;">This link takes you to SingleKey\u2019s secure screening service. ${siteName} does not collect or store your sensitive personal information.</p>
          `,
        });
      } catch (err) {
        console.warn('create-screening-request: applicant email failed to send:', err.message);
        // Not fatal — the admin still has the link to share manually.
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, purchaseToken: data.purchase_token, tenantFormUrl: data.tenant_form_url }) };

  } catch (err) {
    console.error('create-screening-request error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
