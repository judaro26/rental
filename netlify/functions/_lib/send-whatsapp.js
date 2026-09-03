// netlify/functions/_lib/send-whatsapp.js
// Shared WhatsApp-sending core, via Twilio only (the only provider this
// app supports for WhatsApp — unlike SMS, WhatsApp business messaging
// requires Meta business verification and pre-approved templates, so
// there's no equivalent to Telnyx/ClickSend's simple freeform-text model
// to also support here).
//
// Reuses Twilio's existing Programmable Messaging endpoint (the same one
// send-sms.js posts to), but WhatsApp business-initiated messages must use
// a pre-approved Content Template rather than arbitrary text — Body and
// MediaUrl are excluded entirely and replaced by ContentSid (the approved
// template) plus ContentVariables (the template's placeholder values).
// See: https://www.twilio.com/docs/content/send-templates-created-with-the-content-template-builder
//
// The one-time setup this depends on, all in the Twilio Console, none of
// which this app can do on the admin's behalf:
//   1. A WhatsApp Sender (a phone number enabled for WhatsApp business
//      messaging, via Meta Business Manager verification).
//   2. A Content Template built and submitted through Twilio's Content
//      Template Builder, approved by WhatsApp before it can be used for
//      any message sent outside a 24-hour customer-initiated window.

async function sendWhatsApp({ accountSid, authToken, fromNumber, contentSid, contentVariables, to }) {
  const params = new URLSearchParams({
    To: `whatsapp:${to}`,
    From: `whatsapp:${fromNumber}`,
    ContentSid: contentSid,
  });
  if (contentVariables) params.set('ContentVariables', JSON.stringify(contentVariables));

  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `Twilio rejected this WhatsApp message (HTTP ${res.status}).`);
  return { id: data.sid, status: data.status };
}

module.exports = { sendWhatsApp };
