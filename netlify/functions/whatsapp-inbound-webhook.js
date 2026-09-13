// netlify/functions/whatsapp-inbound-webhook.js
// Receives inbound WhatsApp replies from Twilio, for the two-way admin
// chat feature. Configure this function's URL as the "when a message
// comes in" webhook on the Twilio WhatsApp Sender, in the Twilio Console
// (a separate setting from the SMS phone number's own webhook, even
// though both may be the same underlying number).
//
// See sms-inbound-webhook.js for the parallel SMS version — this mirrors
// it closely, differing mainly in which provider's credentials are used
// (WhatsApp only ever supports Twilio in this app, so there's no
// "wrong provider" case to guard against here the way SMS has).

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

  let provider;
  try {
    const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
    const activeId = activeSnap.exists ? activeSnap.data().whatsapp : null;
    if (!activeId) throw new Error('no active WhatsApp provider configured');
    const providerSnap = await db.collection('integrationSecrets').doc(activeId).get();
    provider = providerSnap.exists ? providerSnap.data() : null;
    if (!provider) throw new Error('WhatsApp provider record missing');
  } catch (err) {
    console.error('whatsapp-inbound-webhook: could not resolve Twilio credentials —', err.message);
    return { statusCode: 200, body: '<Response/>' };
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const body = new URLSearchParams(rawBody);
  const params = Object.fromEntries(body.entries());
  const signature = event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature'];
  const webhookUrl = `${(process.env.SITE_URL || '').replace(/\/+$/, '')}/api/whatsapp-inbound-webhook`;

  const validRequest = twilio.validateRequest(provider.authToken, signature || '', webhookUrl, params);
  if (!validRequest) {
    console.warn('whatsapp-inbound-webhook: signature validation failed — request not accepted as genuinely from Twilio.');
    return { statusCode: 403, body: 'Invalid signature' };
  }

  const { handleInboundMessage } = require('./_lib/handle-inbound-message');
  try {
    await handleInboundMessage({
      a, db, channel: 'whatsapp',
      from: params.From, to: params.To, body: params.Body,
      twilioMessageSid: params.MessageSid,
    });
  } catch (err) {
    console.error('whatsapp-inbound-webhook: failed to store inbound message —', err);
  }

  return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: '<Response/>' };
};
