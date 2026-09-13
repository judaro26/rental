// netlify/functions/sms-inbound-webhook.js
// Receives inbound SMS replies from Twilio, for the two-way admin chat
// feature. Configure this function's URL as the "when a message comes
// in" webhook on the Twilio phone number used for SMS, in the Twilio
// Console.
//
// Twilio-specific by necessity — this app's SMS system also supports
// Telnyx and ClickSend, but neither of those is wired up here. Two-way
// chat requires whichever provider actually receives the tenant's reply,
// and this webhook only understands Twilio's inbound payload shape and
// signature scheme. If the active SMS provider isn't Twilio, inbound
// replies won't reach this at all — only outbound sends would still work
// through that other provider.
//
// Signature validation uses Twilio's own SDK helper rather than a manual
// HMAC implementation — Twilio's own documentation strongly discourages
// rolling this by hand, since subtle parsing/URL-reconstruction
// differences are an easy, hard-to-notice way to end up either rejecting
// every genuine request or accepting forged ones. The webhook URL used
// for validation is built from SITE_URL (the same, already-established
// pattern used elsewhere in this app for constructing absolute URLs)
// rather than reconstructed from request headers, which is exactly where
// Twilio's docs warn proxies/load balancers can cause a mismatch.

const twilio = require('twilio');

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
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const a = getAdmin();
  const db = a.firestore();

  // The active SMS provider's own Twilio auth token is the signing key —
  // not an app-wide secret, since this app supports multiple SMS
  // providers and this endpoint is meaningless unless the active one
  // actually is Twilio.
  let provider;
  try {
    const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
    const activeId = activeSnap.exists ? activeSnap.data().sms : null;
    if (!activeId) throw new Error('no active SMS provider configured');
    const providerSnap = await db.collection('integrationSecrets').doc(activeId).get();
    provider = providerSnap.exists ? providerSnap.data() : null;
    if (!provider || provider.provider !== 'twilio') throw new Error('active SMS provider is not Twilio');
  } catch (err) {
    console.error('sms-inbound-webhook: could not resolve Twilio credentials —', err.message);
    return { statusCode: 200, body: '<Response/>' }; // 200 regardless — see note on Twilio retries below
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const body = new URLSearchParams(rawBody);
  const params = Object.fromEntries(body.entries());
  const signature = event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature'];
  const webhookUrl = `${(process.env.SITE_URL || '').replace(/\/+$/, '')}/api/sms-inbound-webhook`;

  const validRequest = twilio.validateRequest(provider.authToken, signature || '', webhookUrl, params);
  if (!validRequest) {
    console.warn('sms-inbound-webhook: signature validation failed — request not accepted as genuinely from Twilio.');
    return { statusCode: 403, body: 'Invalid signature' };
  }

  const { handleInboundMessage } = require('./_lib/handle-inbound-message');
  try {
    await handleInboundMessage({
      a, db, channel: 'sms',
      from: params.From, to: params.To, body: params.Body,
      twilioMessageSid: params.MessageSid,
    });
  } catch (err) {
    console.error('sms-inbound-webhook: failed to store inbound message —', err);
    // Still respond 200 — Twilio doesn't need to know this failed, and
    // retrying an already-delivered SMS wouldn't help recover it; the
    // message itself is gone either way, only our own record of it failed.
  }

  // Empty TwiML response — this app never auto-replies to an inbound
  // text; a real, human reply happens through the chat UI itself, sent
  // via send-chat-message.js on the admin's own action, not automatically
  // here.
  return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: '<Response/>' };
};
