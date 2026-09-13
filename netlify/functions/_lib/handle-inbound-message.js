// netlify/functions/_lib/handle-inbound-message.js
// Shared core for sms-inbound-webhook.js and whatsapp-inbound-webhook.js —
// both receive the same Twilio form-encoded payload shape (From, To,
// Body, MessageSid), differing only in the whatsapp: prefix on phone
// numbers, so the actual tenant-matching and Firestore-writing logic is
// one implementation, not two that could drift apart.
//
// Matches the inbound From number against tenants by normalizing both
// sides to digits-only before comparing, rather than an exact-match
// Firestore query on the stored phone field. Twilio's From is always
// strict E.164, but phone numbers have been entered here in varying
// formats over time — a query requiring an exact string match would
// silently miss real matches. Fetching all tenants and comparing
// client-side is the robust choice at this app's scale (a landlord's own
// portfolio, not a multi-tenant SaaS with thousands of records).
function digitsOnly(num) {
  return String(num || '').replace(/\D/g, '');
}

async function handleInboundMessage({ a, db, channel, from, to, body, twilioMessageSid }) {
  const normalizedFrom = digitsOnly(from.replace(/^whatsapp:/, ''));

  const tenantsSnap = await db.collection('tenants').get();
  const matched = tenantsSnap.docs.find(d => {
    const phone = d.data().phone;
    return phone && digitsOnly(phone).endsWith(normalizedFrom.slice(-10)); // last-10-digit match tolerates a stored number missing a country code
  });

  await db.collection('chatMessages').add({
    tenantId: matched ? matched.id : null,
    tenantName: matched ? `${matched.data().firstName || ''} ${matched.data().lastName || ''}`.trim() : null,
    // Kept even when matched, so an admin can see exactly what number
    // this came from — useful if a tenant texts from a different phone
    // than the one on file, which is exactly the case where matched
    // ends up null and this becomes the only way to identify them.
    fromNumber: normalizedFrom,
    channel, // 'sms' | 'whatsapp'
    direction: 'inbound',
    body: body || '',
    twilioMessageSid: twilioMessageSid || null,
    status: 'received',
    read: false,
    createdAt: a.firestore.FieldValue.serverTimestamp(),
  });

  return { matched: !!matched, tenantId: matched ? matched.id : null };
}

module.exports = { handleInboundMessage, digitsOnly };
