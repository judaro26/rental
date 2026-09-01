// netlify/functions/_lib/send-sms.js
// Shared SMS-sending core for all three supported backends (Telnyx,
// Twilio, ClickSend), used by manage-integrations.js's test action and by
// the actual announcement-sending system — one implementation of "send an
// SMS through whichever provider is configured," not several that could
// drift apart.
//
// Telnyx:    POST /v2/messages, Bearer auth, JSON body, requires a
//            purchased+assigned fromNumber.
// Twilio:    POST .../Messages.json, HTTP Basic auth, form-encoded body,
//            requires a purchased fromNumber.
// ClickSend: POST /v3/sms/send, HTTP Basic auth, JSON body — genuinely
//            different sender model: no fromNumber is sent per-message at
//            all. The sender is whatever's configured as the default in
//            the ClickSend dashboard for each destination country, unless
//            explicitly overridden via a separate `senders` array (not
//            implemented here, since its exact schema isn't something
//            this integration has verified — omitting it and relying on
//            the account's own configured default is the safe choice).

async function sendSms({ provider, apiKey, fromNumber, accountSid, authToken, username, to, text }) {
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

  if (provider === 'clicksend') {
    const basicAuth = Buffer.from(`${username}:${apiKey}`).toString('base64');
    const res = await fetch('https://rest.clicksend.com/v3/sms/send', {
      method: 'POST',
      headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ source: 'rentbay', to, body: text }] }),
    });
    const data = await res.json();
    if (!res.ok || data.response_code !== 'SUCCESS') throw new Error(data.response_msg || `ClickSend rejected this (HTTP ${res.status}).`);
    const msg = data.data?.messages?.[0];
    return { id: msg?.message_id, status: msg?.status || 'queued', cost: msg?.message_price ? { amount: msg.message_price, currency: data.data?._currency?.currency_name_short || 'USD' } : undefined };
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
