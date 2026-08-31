// shared/upload.js
// Centralized, backend-aware file upload helper. Handles both supported
// storage backends (Cloudinary and Cloudflare R2) behind a single,
// consistent interface — every call site in the app gets back a final
// public URL either way, without needing to know or care which backend is
// currently active. That decision is made server-side (sign-cloudinary-
// upload.js resolves whatever's configured in Settings → Integrations)
// and reflected in the `backend` field of its response.
//
// Usage:
//   const url = await uploadFile(file, 'properties/photos');
//
// Throws on failure — callers should wrap in their own try/catch to show
// an appropriate error in whatever UI they're part of.

async function uploadFile(file, folder) {
  const sigRes = await fetch('/api/sign-cloudinary-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, fileName: file.name, contentType: file.type }),
  });
  const sigData = await sigRes.json();
  if (!sigRes.ok) throw new Error(sigData.error || 'Could not prepare upload');

  if (sigData.backend === 'r2') {
    // R2: raw PUT of the file bytes directly to a presigned URL — no
    // FormData, no additional fields, just the file as the request body.
    const putRes = await fetch(sigData.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!putRes.ok) throw new Error('Upload to storage failed (HTTP ' + putRes.status + ').');
    return sigData.publicUrl;
  }

  // Cloudinary (default): signed FormData POST directly to Cloudinary.
  const fd = new FormData();
  fd.append('file', file);
  fd.append('folder', folder);
  fd.append('access_mode', 'public');
  fd.append('timestamp', sigData.timestamp);
  fd.append('api_key', sigData.apiKey);
  fd.append('signature', sigData.signature);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${sigData.cloudName}/image/upload`, { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Upload failed');
  return data.secure_url;
}
