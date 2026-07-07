// netlify/functions/documenso-webhook.js
// Receives Documenso webhook events and updates the matching application's
// lease status (sent → opened → signed/completed).
//
// Configure in Documenso → Settings → Webhooks:
//   URL:    https://<your-site>/api/documenso-webhook
//   Events: document.opened, document.signed, document.completed (+ any others)
//   Secret (optional): set the same value as DOCUMENSO_WEBHOOK_SECRET
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT
// Optional: DOCUMENSO_WEBHOOK_SECRET, SMTP_*, ADMIN_NOTIFY_EMAIL

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

// Map a Documenso event/status to our lease status.
function mapStatus(evtRaw, docStatusRaw) {
  const evt = String(evtRaw || '').toLowerCase();
  const st  = String(docStatusRaw || '').toLowerCase();
  if (evt.includes('complet') || st === 'completed') return 'completed';
  if (evt.includes('sign'))    return 'signed';
  if (evt.includes('open') || evt.includes('view')) return 'opened';
  if (evt.includes('sent'))    return 'sent';
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Optional shared-secret check (Documenso can send a configured secret).
  const expected = process.env.DOCUMENSO_WEBHOOK_SECRET;
  if (expected) {
    const got = event.headers['x-documenso-secret'] || event.headers['X-Documenso-Secret'] || event.headers['authorization'];
    if (got && got !== expected && got !== `Bearer ${expected}`) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid webhook secret' }) };
    }
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Documenso payload shapes vary slightly by version — be defensive.
  const evtType = body.event || body.eventType || body.type || '';
  const payload = body.payload || body.data || body.document || body;
  const documentId = payload.id || payload.documentId || payload.document?.id;
  const docStatus  = payload.status || payload.document?.status;
  if (documentId == null) {
    return { statusCode: 200, body: JSON.stringify({ ignored: true, reason: 'no document id' }) };
  }

  const mapped = mapStatus(evtType, docStatus);
  if (!mapped) return { statusCode: 200, body: JSON.stringify({ ignored: true, reason: 'unmapped event', evtType }) };

  const a  = getAdmin();
  const db = a.firestore();

  try {
    const q = await db.collection('applications')
      .where('leaseAgreement.documentId', '==', String(documentId))
      .limit(1).get();
    if (q.empty) {
      return { statusCode: 200, body: JSON.stringify({ ignored: true, reason: 'no matching application' }) };
    }
    const docSnap = q.docs[0];
    const app = docSnap.data();
    const current = app.leaseAgreement || {};

    // Never downgrade a completed lease.
    const rank = { sent: 0, opened: 1, signed: 2, completed: 3 };
    if ((rank[mapped] ?? -1) < (rank[current.status] ?? -1)) {
      return { statusCode: 200, body: JSON.stringify({ ignored: true, reason: 'stale status' }) };
    }

    const updates = { 'leaseAgreement.status': mapped, updatedAt: a.firestore.FieldValue.serverTimestamp() };
    if (mapped === 'completed') {
      updates['leaseAgreement.completedAt'] = new Date().toISOString();
      const signedUrl = payload.signedDocumentUrl || payload.documentDataUrl || payload.downloadUrl || (Array.isArray(payload.documents) && payload.documents[0]?.url);
      if (signedUrl) updates['leaseAgreement.signedDocumentUrl'] = signedUrl;
    }
    await docSnap.ref.update(updates);

    try {
      await db.collection('applicationAuditLog').add({
        applicationId: docSnap.id, shortId: app.applicationId || docSnap.id.substring(0, 8).toUpperCase(),
        action: `lease_${mapped}`, applicantEmail: app.email || 'unknown',
        documentId: String(documentId), timestamp: a.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) { console.warn('lease webhook audit failed:', e.message); }

    // Notify admin when fully signed.
    if (mapped === 'completed' && process.env.SMTP_HOST && process.env.ADMIN_NOTIFY_EMAIL) {
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'),
          secure: parseInt(process.env.SMTP_PORT || '587') === 465,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: process.env.ADMIN_NOTIFY_EMAIL,
          subject: `✅ Lease fully signed — ${app.firstName || ''} ${app.lastName || ''}`.trim(),
          html: `<p>The lease agreement for <strong>${app.firstName || ''} ${app.lastName || ''}</strong> (${app.email || ''}) has been fully signed in Documenso.</p>`,
        });
      } catch (e) { console.warn('lease completed notify failed:', e.message); }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, status: mapped }) };
  } catch (err) {
    console.error('documenso-webhook error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
