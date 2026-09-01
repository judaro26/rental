// netlify/functions/_lib/send-sms.js
// Shared SMS-sending core for both supported backends (Telnyx and
// Twilio), used by manage-integrations.js's test action and by the actual
// announcement-sending system — one implementation of "send an SMS
// through whichever provider is configured," not two that could drift
// apart the way the storage/Cloudinary-vs-R2 code was deliberately kept
// as one shared upload helper rather than duplicated per call site.
//
// Telnyx: POST https://api.telnyx.com/v2/messages, Bearer auth, JSON body.
// Twilio: POST .../Messages.json, HTTP Basic auth, form-encoded body —
// genuinely different shapes, not just different field names, which is
// why this is branched rather than templated.

async function sendSms({ provider, apiKey, fromNumber, accountSid, authToken, to, text }) {
  if (provider === 'twilio') {
    const params = new URLSearchParams({ To: to, From: fromNumber, Body: text });
    const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `Twilio rejected this (HTTP ${res.status}).`);
    return { id: data.sid, status: data.status };
  }

  // Telnyx (default)
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromNumber, to, text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errors?.[0]?.detail || `Telnyx rejected this (HTTP ${res.status}).`);
  return { id: data.data?.id, status: data.data?.to?.[0]?.status || 'queued', cost: data.data?.cost };
}

module.exports = { sendSms };
