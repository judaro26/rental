// netlify/functions/view-doc.js
// Generates a short-lived signed Cloudinary URL and redirects to it.
// Called by the admin and tenant viewers instead of using the raw Cloudinary URL.
// Works even when "Require signed URLs" is enabled at the account level.
//
// GET /api/view-doc?id={storagePath}&type={image|raw|auto}
//
// Required env vars: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET

const cloudinary = require('cloudinary').v2;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { id, type: resourceType = 'auto' } = event.queryStringParameters || {};
  if (!id) {
    return { statusCode: 400, body: 'Missing id parameter' };
  }

  const missing = ['CLOUDINARY_CLOUD_NAME','CLOUDINARY_API_KEY','CLOUDINARY_API_SECRET'].filter(k => !process.env[k]);
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
    // Generate signed URL valid for 2 hours
    // sign_url: true works for both upload and authenticated delivery types
    const signedUrl = cloudinary.url(id, {
      resource_type: resourceType === 'pdf' ? 'image' : resourceType,
      type:          'upload',
      sign_url:      true,
      secure:        true,
      expires_at:    Math.round(Date.now() / 1000) + 7200,
    });

    return {
      statusCode: 302,
      headers: {
        Location:       signedUrl,
        'Cache-Control': 'no-store',
      },
      body: '',
    };
  } catch (err) {
    console.error('view-doc error:', err);
    return { statusCode: 500, body: err.message };
  }
};
