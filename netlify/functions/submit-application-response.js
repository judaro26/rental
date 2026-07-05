// netlify/functions/submit-application-response.js
// Public (token-validated) write. The applicant submits their prospective
// residents (name + age), desired move-in date, and references. These update
// the existing application record and notify the admin.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, SMTP_* (optional), ADMIN_NOTIFY_EMAIL (optional), SITE_URL (optional)

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

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function cleanOccupants(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(o => ({ name: clip(o?.name, 120), age: clip(o?.age, 4) }))
    .filter(o => o.name || o.age)
    .slice(0, 15);
}
function cleanReferences(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(r => ({ name: clip(r?.name, 120), relationship: clip(r?.relationship, 80), contact: clip(r?.contact, 160) }))
    .filter(r => r.name || r.contact)
    .slice(0, 15);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { app: appId, token, occupants, references, moveInDate, notes } = body;
  if (!appId || !token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing link parameters.' }) };
  }

  const a  = getAdmin();
  const db = a.firestore();

  try {
    const ref  = db.collection('applications').doc(appId);
    const snap = await ref.get();
    if (!snap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'This application could not be found.' }) };
    const appData = snap.data();

    if (!appData.responseToken || appData.responseToken !== token) {
      return { statusCode: 403, body: JSON.stringify({ error: 'This link is invalid or has expired.' }) };
    }

    const cleanedOccupants  = cleanOccupants(occupants);
    const cleanedReferences = cleanReferences(references);
    const cleanedMoveIn     = clip(moveInDate, 40) || appData.moveInDate || null;
    const cleanedNotes      = clip(notes, 2000) || null;

    await ref.update({
      occupants:          cleanedOccupants,
      references:         cleanedReferences,
      moveInDate:         cleanedMoveIn,
      responseNotes:      cleanedNotes,
      responseSubmittedAt: a.firestore.FieldValue.serverTimestamp(),
      updatedAt:          a.firestore.FieldValue.serverTimestamp(),
    });

    // Audit trail
    const ipAddress = (event.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim() || 'unknown';
    try {
      await db.collection('applicationAuditLog').add({
        applicationId: appId,
        shortId:       appData.applicationId || appId.substring(0, 8).toUpperCase(),
        action:        'applicant_response_submitted',
        applicantEmail: appData.email || 'unknown',
        ipAddress,
        timestamp:     a.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) { console.warn('audit log failed:', e.message); }

    // Notify admin (best-effort)
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
    if (adminEmail && process.env.SMTP_HOST) {
      try {
        let siteName = 'Tenant Portal';
        try { const s = await db.collection('settings').doc('site').get(); if (s.exists) siteName = s.data().siteName || siteName; } catch {}
        const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
        const occHtml = cleanedOccupants.length
          ? cleanedOccupants.map(o => `<li>${o.name || '—'}${o.age ? ` — age ${o.age}` : ''}</li>`).join('')
          : '<li>None provided</li>';
        const refHtml = cleanedReferences.length
          ? cleanedReferences.map(r => `<li>${r.name || '—'}${r.relationship ? ` (${r.relationship})` : ''}${r.contact ? ` — ${r.contact}` : ''}</li>`).join('')
          : '<li>None provided</li>';
        const transporter = nodemailer.createTransport({
          host:   process.env.SMTP_HOST,
          port:   parseInt(process.env.SMTP_PORT || '587'),
          secure: parseInt(process.env.SMTP_PORT || '587') === 465,
          auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.sendMail({
          from:    process.env.SMTP_FROM || process.env.SMTP_USER,
          to:      adminEmail,
          subject: `✅ Applicant details received — ${appData.firstName || ''} ${appData.lastName || ''}`.trim(),
          html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:auto;">
            <div style="background:#1A1A2E;padding:22px 30px;"><span style="font-size:18px;color:#E8D5B0;">${siteName}</span></div>
            <div style="padding:24px 30px;color:#374151;font-size:14px;line-height:1.7;">
              <h2 style="font-size:20px;font-weight:400;color:#1A1A2E;margin:0 0 10px;">Applicant response received</h2>
              <p style="margin:0 0 6px;"><strong>${appData.firstName || ''} ${appData.lastName || ''}</strong> updated their application details.</p>
              <p style="margin:14px 0 4px;font-weight:600;">Prospective residents</p><ul style="margin:0 0 10px;padding-left:20px;">${occHtml}</ul>
              <p style="margin:10px 0 4px;font-weight:600;">Desired move-in</p><p style="margin:0 0 10px;">${cleanedMoveIn || '—'}</p>
              <p style="margin:10px 0 4px;font-weight:600;">References</p><ul style="margin:0 0 10px;padding-left:20px;">${refHtml}</ul>
              ${cleanedNotes ? `<p style="margin:10px 0 4px;font-weight:600;">Notes</p><p style="margin:0;white-space:pre-wrap;">${cleanedNotes}</p>` : ''}
              ${siteUrl ? `<a href="${siteUrl}/admin" style="display:inline-block;margin-top:18px;background:#C9903A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:2px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;">Review in Admin →</a>` : ''}
            </div></div>`,
        });
      } catch (e) { console.warn('admin notify failed:', e.message); }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('submit-application-response error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong saving your details. Please try again.' }) };
  }
};
