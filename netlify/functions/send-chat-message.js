// netlify/functions/send-chat-message.js
// Sends an admin's reply to a tenant via SMS or WhatsApp, for the two-way
// chat feature — the outbound counterpart to sms-inbound-webhook.js /
// whatsapp-inbound-webhook.js. Every send is stored in chatMessages
// alongside the inbound messages it's replying to, so the full
// conversation reconstructs in one chronological list.
//
// POST body: { tenantId, channel: 'sms' | 'whatsapp', body }
// Header: Authorization: Bearer <Firebase ID token, from an admin>

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let requestBody;
  try { requestBody = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenantId, channel, body: messageBody } = requestBody;
  if (channel !== 'sms' && channel !== 'whatsapp') {
    return { statusCode: 400, body: JSON.stringify({ error: 'channel must be "sms" or "whatsapp".' }) };
  }
  if (!tenantId || !messageBody || !messageBody.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'tenantId and a non-empty body are required.' }) };
  }

  const a = getAdmin();
  const db = a.firestore();
  const { verifyAdmin } = require('./_lib/verify-admin');
  const authResult = await verifyAdmin(event, db, a);
  if (authResult.error) return authResult.error;
  const { decoded } = authResult;

  const tenantSnap = await db.collection('tenants').doc(tenantId).get();
  if (!tenantSnap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Tenant not found.' }) };
  const tenant = tenantSnap.data();
  if (!tenant.phone) return { statusCode: 400, body: JSON.stringify({ error: 'This tenant has no phone number on file.' }) };

  const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
  const activeId = activeSnap.exists ? activeSnap.data()[channel] : null;
  if (!activeId) return { statusCode: 400, body: JSON.stringify({ error: `No ${channel} provider configured. Set one up under Settings → Integrations.` }) };
  const providerSnap = await db.collection('integrationSecrets').doc(activeId).get();
  const provider = providerSnap.exists ? providerSnap.data() : null;
  if (!provider) return { statusCode: 400, body: JSON.stringify({ error: `No ${channel} provider configured.` }) };

  if (channel === 'whatsapp') {
    // Free-form WhatsApp replies are only allowed within 24 hours of the
    // tenant's own last inbound message — outside it, Twilio rejects with
    // error 63016 (the same error this app's own template-based
    // announcements exist to work around for business-initiated sends,
    // but a chat reply is inherently free-form, not a template). Checked
    // here against this app's own chatMessages record rather than letting
    // the admin discover this from a raw Twilio error after the fact.
    const lastInboundSnap = await db.collection('chatMessages')
      .where('tenantId', '==', tenantId)
      .where('channel', '==', 'whatsapp')
      .where('direction', '==', 'inbound')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const lastInboundAt = lastInboundSnap.empty ? null : lastInboundSnap.docs[0].data().createdAt?.toDate();
    const hoursSinceLastInbound = lastInboundAt ? (Date.now() - lastInboundAt.getTime()) / 36e5 : Infinity;
    if (hoursSinceLastInbound > 24) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This tenant has not messaged on WhatsApp in the last 24 hours, so a free-form reply is not allowed — WhatsApp only permits template messages outside that window. Send an SMS instead, or wait for them to message in again.' }) };
    }
  }

  try {
    let result;
    if (channel === 'sms') {
      const { sendSms } = require('./_lib/send-sms');
      result = await sendSms({
        provider: provider.provider, apiKey: provider.apiKey, fromNumber: provider.fromNumber,
        accountSid: provider.accountSid, authToken: provider.authToken, username: provider.username,
        to: tenant.phone, text: messageBody.trim(),
      });
    } else {
      const { sendWhatsApp } = require('./_lib/send-whatsapp');
      result = await sendWhatsApp({
        accountSid: provider.accountSid, authToken: provider.authToken, fromNumber: provider.fromNumber,
        body: messageBody.trim(), to: tenant.phone,
      });
    }

    await db.collection('chatMessages').add({
      tenantId, tenantName: `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim(),
      fromNumber: null, toNumber: tenant.phone,
      channel, direction: 'outbound',
      body: messageBody.trim(),
      twilioMessageSid: result.id || null,
      status: result.status || 'sent',
      sentByAdminUid: decoded.uid,
      createdAt: a.firestore.FieldValue.serverTimestamp(),
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('send-chat-message error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Failed to send message.' }) };
  }
};
