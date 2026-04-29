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
    const store = getStore({ name: 'documents', consistency: 'strong' });

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
