// netlify/functions/_lib/send-whatsapp.js
// Shared WhatsApp-sending core, via Twilio only (the only provider this
// app supports for WhatsApp — unlike SMS, WhatsApp business messaging
// requires Meta business verification and pre-approved templates, so
// there's no equivalent to Telnyx/ClickSend's simple freeform-text model
// to also support here, for business-initiated sends).
//
// Two distinct send modes, matching WhatsApp's own two message
// categories:
//   - Template mode (contentSid/contentVariables): business-initiated —
//     announcements, reminders, anything sent without the tenant having
//     messaged first. Must use a pre-approved Content Template; Body and
//     MediaUrl are excluded entirely and replaced by ContentSid plus
//     ContentVariables (the template's placeholder values). See:
//     https://www.twilio.com/docs/content/send-templates-created-with-the-content-template-builder
//   - Free-form mode (body): conversational replies within the 24-hour
//     window after a tenant's own inbound message — the ordinary case
//     for send-chat-message.js. Just a plain Body string, no template
//     needed, the same as a normal SMS. Sending this outside that window
//     is rejected by Twilio (error 63016) — send-chat-message.js checks
//     the tenant's last inbound message time before attempting this mode,
//     rather than letting the admin hit that error blind.
// Exactly one of contentSid or body should be passed, never both.
//
// The one-time setup this depends on, all in the Twilio Console, none of
// which this app can do on the admin's behalf:
//   1. A WhatsApp Sender (a phone number enabled for WhatsApp business
//      messaging, via Meta Business Manager verification).
//   2. A Content Template built and submitted through Twilio's Content
//      Template Builder, approved by WhatsApp before it can be used for
//      any message sent outside a 24-hour customer-initiated window.

// Strips everything but digits — including invisible Unicode directional-
// formatting marks that iOS/macOS sometimes embed when a phone number is
// copied from Messages, Contacts, or a tel: link (they render as nothing
// but get sent to Twilio's API literally, producing a "not a valid phone
// number" rejection that looks fine to the eye). Always re-adds a leading
// "+", since E.164 requires one and a pasted number is more likely to be
// missing it than to have accidentally included a real country-code digit.
// This can't fix a genuinely wrong digit count (e.g. a duplicated country
// code) — Twilio will still reject that, just with a cleaner error.
function toE164(num) {
  if (!num) return num;
  return '+' + String(num).replace(/\D/g, '');
}

async function sendWhatsApp({ accountSid, authToken, fromNumber, contentSid, contentVariables, body, to }) {
  const params = new URLSearchParams({
    To: `whatsapp:${toE164(to)}`,
    From: `whatsapp:${toE164(fromNumber)}`,
  });
  if (contentSid) {
    params.set('ContentSid', contentSid);
    if (contentVariables) params.set('ContentVariables', JSON.stringify(contentVariables));
  } else if (body) {
    params.set('Body', body);
  } else {
    throw new Error('sendWhatsApp requires either contentSid (template mode) or body (free-form mode).');
  }

  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message ? `${data.message}${data.code ? ` (Twilio error ${data.code})` : ''}` : `Twilio rejected this WhatsApp message (HTTP ${res.status}).`);
  return { id: data.sid, status: data.status };
}

module.exports = { sendWhatsApp };
