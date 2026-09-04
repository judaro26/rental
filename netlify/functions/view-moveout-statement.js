// netlify/functions/view-moveout-statement.js
// Serves a move-out statement (security deposit itemization, or a
// Colombia move-out/condition record) stored in Netlify Blobs.
// GET /api/view-moveout-statement?key={blobKey}
//
// Intentionally login-free, same as view-invoice.js — meant to open
// straight from an email link. Security here rests entirely on the blob
// key being unguessable (crypto.randomBytes, set at generation time in
// generate-moveout-statement.js), not on authentication.
//
// Also handles the same malformed-URL fallback as view-invoice.js: some
// email link-wrapping services pass the entire original URL through as
// the key value.

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };

  const params = event.queryStringParameters || {};
  let key = params.key;

  if (key && key.includes('view-moveout-statement?key=')) {
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

    const store = getStore({ name: 'moveout-statements', consistency: 'strong', siteID, token });
    const blob  = await store.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!blob) return { statusCode: 404, body: notFoundHtml() };

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'text/html; charset=utf-8',
        'Cache-Control': 'private, max-age=3600',
      },
      body: Buffer.from(blob.data).toString('utf8'),
    };
  } catch (err) {
    console.error('view-moveout-statement error:', err);
    return { statusCode: 500, body: err.message };
  }
};

function notFoundHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Statement Not Found</title>
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
    <h2>Statement Not Found</h2>
    <p>This link may have expired or the file could not be located. Please contact your property manager to request a new copy.</p>
    <a href="/" class="btn">Back to Portal</a>
  </div>
</div></body></html>`;
}
