// netlify/functions/upload-qr.js
// Stores the Zelle QR code image in Netlify Blobs and returns a view URL.
// Called from the admin Settings panel.

const Busboy = require('busboy');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_API_TOKEN;
  if (!siteID || !token) {
    return { statusCode: 500, body: JSON.stringify({ error: 'NETLIFY_SITE_ID and NETLIFY_API_TOKEN are required.' }) };
  }

  try {
    // Parse multipart
    const bb = Busboy({ headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] || '' } });
    const result = await new Promise((resolve, reject) => {
      let fileBuffer = null, mimeType = 'image/png';
      bb.on('file', (name, stream, info) => {
        mimeType = info.mimeType;
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end',  ()  => { fileBuffer = Buffer.concat(chunks); });
      });
      bb.on('finish', () => resolve({ fileBuffer, mimeType }));
      bb.on('error',  reject);
      const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body || '');
      bb.write(body); bb.end();
    });

    if (!result.fileBuffer?.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No file received' }) };
    }

    const { getStore } = require('@netlify/blobs');
    const store   = getStore({ name: 'settings', consistency: 'strong', siteID, token });
    const blobKey = 'zelle-qr';
    await store.set(blobKey, result.fileBuffer, { metadata: { contentType: result.mimeType } });

    const siteUrl  = (process.env.SITE_URL || '').replace(/\/+$/, '');
    const viewUrl  = `${siteUrl}/api/view-qr`;

    return { statusCode: 200, body: JSON.stringify({ success: true, url: viewUrl }) };
  } catch (err) {
    console.error('upload-qr error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
