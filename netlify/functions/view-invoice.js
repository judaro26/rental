// netlify/functions/view-invoice.js
// Serves an invoice/receipt HTML page stored in Netlify Blobs.
// GET /api/view-invoice?key={blobKey}
//
// Also handles malformed URLs where the key was URL-encoded inside a broken
// http:/// URL — Google's link wrapper passes the raw query string through,
// so the function still receives ?key=... correctly even if the domain was missing.

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };

  const params = event.queryStringParameters || {};
  let key = params.key;

  // Fallback: some broken URLs encode the entire original URL as the key value.
  // e.g. key = "http:///api/view-invoice?key=receipt_REC-..."
  // Extract the real key if this happened.
  if (key && key.includes('view-invoice?key=')) {
    try {
      const inner = new URL(key.replace(/^http:\/\/\//, 'https://placeholder/'));
      key = inner.searchParams.get('key') || key;
    } catch {
      const match = key.match(/[?&]key=([^&]+)/);
      if (match) key = decodeURIComponent(match[1]);
    }
  }

  if (!key) return { statusCode: 400, body: 'Missing key parameter' };

  try {
    const { getStore } = require('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token  = process.env.NETLIFY_API_TOKEN;
    if (!siteID || !token) return { statusCode: 500, body: 'Storage not configured' };

    const store = getStore({ name: 'invoices', consistency: 'strong', siteID, token });
    const blob  = await store.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!blob) return { statusCode: 404, body: notFoundHtml(key) };

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'text/html; charset=utf-8',
        'Cache-Control': 'private, max-age=3600',
      },
      body: Buffer.from(blob.data).toString('utf8'),
    };
  } catch (err) {
    console.error('view-invoice error:', err);
    return { statusCode: 500, body: err.message };
  }
};

function notFoundHtml(key) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Invoice Not Found</title>
<style>body{font-family:'Helvetica Neue',Arial,sans-serif;background:#F7F4EF;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;max-width:440px;width:100%;border-radius:4px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.1);}
.hdr{background:#1A1A2E;padding:20px 28px;color:#E8D5B0;font-size:18px;font-weight:300;}
.body{padding:28px;}.body h2{margin:0 0 10px;color:#1A1A2E;font-size:18px;font-weight:400;}
.body p{font-size:13px;color:#6B7280;line-height:1.7;margin:0 0 16px;}
.btn{display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:10px 24px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;}
</style></head>
<body><div class="card">
  <div class="hdr">Tenant Portal</div>
  <div class="body">
    <h2>Invoice Not Found</h2>
    <p>This invoice link may have expired or the file could not be located. Please contact your property manager to request a new copy.</p>
    <a href="/" class="btn">Back to Portal</a>
  </div>
</div></body></html>`;
}
