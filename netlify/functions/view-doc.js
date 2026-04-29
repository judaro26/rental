// netlify/functions/view-doc.js
// Fetches a Cloudinary asset server-side (using the private download API)
// and proxies it to the browser — bypasses all account-level delivery restrictions.
//
// GET /api/view-doc?id={storagePath}&type={pdf|image|auto}
//
// Required env vars: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET

const cloudinary = require('cloudinary').v2;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { id, type: fileType = 'auto' } = event.queryStringParameters || {};
  if (!id) return { statusCode: 400, body: 'Missing id parameter' };

  const missing = ['CLOUDINARY_CLOUD_NAME','CLOUDINARY_API_KEY','CLOUDINARY_API_SECRET']
    .filter(k => !process.env[k]);
  if (missing.length) {
    return { statusCode: 500, body: `Missing env vars: ${missing.join(', ')}` };
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure:     true,
  });

  try {
    // Determine resource type
    const resourceType = fileType === 'image' ? 'image' : 'image'; // PDFs are resource_type:image in Cloudinary

    // Generate a private download URL (signed, works regardless of delivery restrictions)
    const ext         = id.split('.').pop()?.toLowerCase();
    const format      = fileType === 'pdf' || ext === 'pdf' ? 'pdf' : ext || 'jpg';
    const downloadUrl = cloudinary.utils.private_download_url(id, format, {
      resource_type: resourceType,
      expires_at:    Math.round(Date.now() / 1000) + 7200,
      attachment:    false, // serve inline, not as download
    });

    // Fetch from Cloudinary server-to-server (no delivery restrictions apply here)
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      console.error(`Cloudinary fetch failed: ${res.status} for ${downloadUrl}`);
      return { statusCode: res.status, body: `Failed to fetch document (${res.status})` };
    }

    const buffer      = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || (
      fileType === 'pdf' ? 'application/pdf' :
      fileType === 'image' ? 'image/jpeg' : 'application/octet-stream'
    );

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
