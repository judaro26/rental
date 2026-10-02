// netlify/functions/view-qr.js
// Serves the Zelle or Cash App QR code image stored in Netlify Blobs.
// GET /api/view-qr?method=zelle|cashapp   (defaults to zelle)

const { getWorkspaceStore, withWorkspace } = require('./_lib/workspace');
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };

  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_API_TOKEN;
  if (!siteID || !token) return { statusCode: 500, body: 'Storage not configured' };

  try {
    const store = getWorkspaceStore({ name: 'settings', consistency: 'strong', siteID, token });
    // upload-qr.js stores each QR as `${method}-qr`. Whitelist the method so the
    // query string can never select an arbitrary blob key.
    const method = event.queryStringParameters?.method === 'cashapp' ? 'cashapp' : 'zelle';
    const blob  = await store.getWithMetadata(`${method}-qr`, { type: 'arrayBuffer' });
    if (!blob) return { statusCode: 404, body: 'QR code not found' };

    const contentType = blob.metadata?.contentType || 'image/png';
    return {
      statusCode:      200,
      // NEVER cached by a shared cache (the CDN) or held for a day by a browser. This is a PAYMENT QR code: after
      // an admin uploads a corrected one, every tenant must see the new one straight away, not the old one for up to
      // 24 hours. It is a few KB and rarely requested, so revalidating each time costs nothing.
      headers: { 'Content-Type': contentType, 'Cache-Control': 'private, no-cache, must-revalidate' },
      body:            Buffer.from(blob.data).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: err.message };
  }
};

// Resolves which workspace (client) this invocation belongs to — see _lib/workspace.js
exports.handler = withWorkspace(exports.handler);
