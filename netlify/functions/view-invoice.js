// netlify/functions/view-invoice.js
// Serves an invoice/receipt HTML page stored in Netlify Blobs.
// GET /api/view-invoice?key={blobKey}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const { key } = event.queryStringParameters || {};
  if (!key) return { statusCode: 400, body: 'Missing key parameter' };

  try {
    const { getStore } = require('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token  = process.env.NETLIFY_API_TOKEN;
    if (!siteID || !token) return { statusCode: 500, body: 'Storage not configured' };

    const store = getStore({ name: 'invoices', consistency: 'strong', siteID, token });
    const blob  = await store.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!blob) return { statusCode: 404, body: 'Invoice not found' };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=3600' },
      body: Buffer.from(blob.data).toString('utf8'),
    };
  } catch (err) {
    console.error('view-invoice error:', err);
    return { statusCode: 500, body: err.message };
  }
};
