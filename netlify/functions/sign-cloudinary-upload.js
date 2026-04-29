// netlify/functions/sign-cloudinary-upload.js
// Generates a Cloudinary signed upload signature so the browser can upload
// directly with access_mode=public — without exposing the API secret.
//
// Required env vars:
//   CLOUDINARY_API_KEY     — from Cloudinary Dashboard → Settings → API Keys
//   CLOUDINARY_API_SECRET  — from Cloudinary Dashboard → Settings → API Keys

const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!apiKey || !apiSecret) {
    return { statusCode: 500, body: JSON.stringify({ error: 'CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET env vars are required for signed uploads.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { folder } = body;
  const timestamp  = Math.round(Date.now() / 1000);

  // Build the string to sign — must be alphabetically sorted params
  // access_mode and folder are the params we're signing
  const paramsToSign = [
    `access_mode=public`,
    `folder=${folder || 'documents'}`,
    `timestamp=${timestamp}`,
  ].sort().join('&');

  const signature = crypto
    .createHash('sha256')
    .update(paramsToSign + apiSecret)
    .digest('hex');

  return {
    statusCode: 200,
    body: JSON.stringify({ signature, timestamp, apiKey }),
  };
};
