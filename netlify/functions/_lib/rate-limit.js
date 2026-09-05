// netlify/functions/_lib/rate-limit.js
// Simple, fixed-window rate limiting for public-facing endpoints that
// have no auth to lean on — submit-application.js, send-support.js, and
// similar. The honeypot field on apply.html stops simple bots, but does
// nothing against a determined caller hitting an endpoint directly and
// repeatedly; this limits how many times a given IP can call a given
// endpoint within a time window, regardless of how the request looks.
//
// Netlify functions are stateless between invocations — there's no
// reliable in-memory counter that survives from one call to the next, so
// this uses Firestore (the app's existing store) as the persistent
// tracker, keyed by `${endpoint}_${ip}`.
//
// This is deliberately a fixed window, not a sliding one, and uses a
// Firestore transaction to avoid an obvious race under genuine burst
// traffic (two near-simultaneous requests both reading the same stale
// count and both under-counting). The goal here is stopping abuse, not
// billing-grade precision — a fixed window can allow a short burst right
// at the boundary between two windows, and that's an accepted trade for
// the simplicity of not needing a sorted list of per-request timestamps.
//
// Usage:
//   const { checkRateLimit } = require('./_lib/rate-limit');
//   const rl = await checkRateLimit(event, db, { endpoint: 'submit-application', limit: 10, windowMinutes: 60 });
//   if (rl.limited) return rl.error;

function getCallerIp(event) {
  return (event.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim()
    || event.headers?.['x-real-ip']
    || event.requestContext?.http?.sourceIp
    || 'unknown';
}

async function checkRateLimit(event, db, { endpoint, limit, windowMinutes }) {
  const ip = getCallerIp(event);
  // Not enough information to rate-limit a request with no discoverable
  // origin, but that's a poor reason to fail closed and turn away every
  // undeterminable caller either — fail open here on the same "don't
  // let extra hardening for one problem create a new, different outage"
  // principle used throughout this codebase's other defensive checks.
  if (ip === 'unknown') return { limited: false };

  const docId = `${endpoint}_${ip}`;
  const ref = db.collection('rateLimits').doc(docId);
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : null;

      if (!data || (now - data.windowStart) > windowMs) {
        tx.set(ref, { windowStart: now, count: 1, endpoint, ip });
        return { count: 1 };
      }

      const newCount = (data.count || 0) + 1;
      tx.set(ref, { windowStart: data.windowStart, count: newCount, endpoint, ip });
      return { count: newCount };
    });

    if (result.count > limit) {
      return {
        limited: true,
        error: {
          statusCode: 429,
          body: JSON.stringify({ error: 'Too many requests. Please try again later.' }),
        },
      };
    }
    return { limited: false };
  } catch (e) {
    // Same fail-open reasoning as the unknown-IP case above — a rate
    // limiter that's itself unreliable shouldn't be the reason a
    // legitimate request fails.
    console.warn('rate-limit check failed, allowing request:', e.message);
    return { limited: false };
  }
}

module.exports = { checkRateLimit, getCallerIp };
