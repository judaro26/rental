// netlify/functions/geo.js
// Returns the visitor's country using Netlify's built-in edge geolocation.
// Netlify's CDN attaches an `x-nf-geo` header (base64-encoded JSON) to every
// request it proxies in production — no external API or API key needed.
//
// GET /api/geo  ->  { country: 'US' | 'CO' | null, source: 'nf-geo'|'unknown' }
//
// Note: locally (netlify dev) this header is usually absent unless you pass
// `netlify dev --geo=cache` / `--geo=mock`, so `country` will come back null
// in local dev. That's expected — the front end falls back to showing all
// properties when country is null.

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let country = null;
  let raw = null;

  try {
    const geoHeader = event.headers?.['x-nf-geo'] || event.headers?.['X-Nf-Geo'];
    if (geoHeader) {
      const decoded = Buffer.from(geoHeader, 'base64').toString('utf8');
      raw = JSON.parse(decoded);
      country = raw?.country?.code || null;
    }
  } catch (err) {
    console.warn('geo.js: failed to parse x-nf-geo header:', err.message);
  }

  // Manual override for local testing / QA, e.g. /api/geo?debugCountry=CO
  // Harmless in production: a visitor can only ever see their own request,
  // and this never touches Firestore or any admin data.
  const debugCountry = event.queryStringParameters?.debugCountry;
  if (debugCountry) country = debugCountry.toUpperCase();

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, max-age=0, no-store',
    },
    body: JSON.stringify({
      country,
      city: raw?.city || null,
      source: country ? 'nf-geo' : 'unknown',
    }),
  };
};
