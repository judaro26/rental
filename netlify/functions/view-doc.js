// netlify/functions/view-doc.js
// Serves a document stored in Netlify Blobs directly to the browser.
// No external service, no auth restrictions, works for all file types.
//
// GET /api/view-doc?key={blobKey}
//
// No extra env vars needed — Netlify Blobs uses built-in Netlify context.

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { key } = event.queryStringParameters || {};
  if (!key) return { statusCode: 400, body: 'Missing key parameter' };

  try {
    const { getStore } = require('@netlify/blobs');
    // Netlify injects SITE_ID automatically; NETLIFY_API_TOKEN must be set manually
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token  = process.env.NETLIFY_API_TOKEN;
    if (!siteID || !token) {
      const missing = [!siteID && 'NETLIFY_SITE_ID (or SITE_ID)', !token && 'NETLIFY_API_TOKEN'].filter(Boolean);
      throw new Error(`Netlify Blobs: missing env vars: ${missing.join(', ')}. Add them in Netlify → Site → Environment variables.`);
    }
    const store = getStore({ name: 'documents', consistency: 'strong', siteID, token });

    const blob = await store.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!blob) return { statusCode: 404, body: 'Document not found' };

    const { data, metadata } = blob;
    const contentType = metadata?.contentType || 'application/octet-stream';
    const buffer      = Buffer.from(data);

    return {
      statusCode:      200,
      headers: {
        'Content-Type':        contentType,
        'Content-Disposition': 'inline',
        'Cache-Control':       'private, max-age=3600',
      },
      body:            buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('view-doc error:', err);
    return { statusCode: 500, body: err.message };
  }
};
