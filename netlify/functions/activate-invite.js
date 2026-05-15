// netlify/functions/activate-invite.js
// Validates a custom invite token stored in Firestore and redirects the tenant
// to a freshly-generated Firebase password-reset link (valid for 1 hr from click).
//
// GET /api/activate-invite?token={uuid}
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, SITE_URL

let admin;
function getAdmin() {
  if (!admin) {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      });
    }
  }
  return admin;
}

function errorPage(title, message, siteUrl, showForgotPassword = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #F7F4EF; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; max-width: 480px; width: 100%; border-radius: 4px; overflow: hidden; box-shadow: 0 4px 24px rgba(26,26,46,0.1); }
    .header { background: #1A1A2E; padding: 24px 32px; }
    .header span { font-size: 20px; font-weight: 300; color: #E8D5B0; letter-spacing: 0.06em; }
    .body { padding: 32px; }
    h2 { font-size: 22px; font-weight: 400; color: #1A1A2E; margin-bottom: 12px; }
    p { font-size: 14px; color: #6B7280; line-height: 1.7; margin-bottom: 16px; }
    .alert { background: #FEF2F2; border: 1px solid #FECACA; border-radius: 3px; padding: 12px 16px; font-size: 13px; color: #DC2626; margin-bottom: 20px; }
    .btn { display: inline-block; background: #C9903A; color: #fff; text-decoration: none; padding: 12px 28px; font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; border-radius: 2px; margin-top: 4px; }
    .hint { font-size: 12px; color: #9CA3AF; margin-top: 20px; padding-top: 16px; border-top: 1px solid #F3F4F6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header"><span>Tenant Portal</span></div>
    <div class="body">
      <h2>${title}</h2>
      <div class="alert">${message}</div>
      ${showForgotPassword && siteUrl ? `
        <p>You can get a fresh activation link yourself — no need to contact your property manager:</p>
        <ol style="font-size:14px;color:#374151;line-height:2;padding-left:20px;margin-bottom:20px;">
          <li>Visit the <a href="${siteUrl}" style="color:#C9903A;">tenant portal</a> and click your property tile.</li>
          <li>Click <strong>"Forgot password?"</strong> on the login screen.</li>
          <li>Enter your email address and a new link will be sent instantly.</li>
        </ol>
        <a href="${siteUrl}" class="btn">Go to Portal →</a>
      ` : siteUrl ? `<a href="${siteUrl}" class="btn">Back to Portal →</a>` : ''}
      <p class="hint">If you continue having issues, please contact your property manager directly.</p>
    </div>
  </div>
</body>
</html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { token } = event.queryStringParameters || {};
  const siteUrl   = (process.env.SITE_URL || '').replace(/\/+$/, '');

  if (!token) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html' },
      body: errorPage('Invalid Link', 'This activation link is missing required information.', siteUrl, true),
    };
  }

  const a  = getAdmin();
  const db = a.firestore();

  try {
    // Look up the token
    const snap = await db.collection('inviteTokens').where('token', '==', token).limit(1).get();

    if (snap.empty) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html' },
        body: errorPage(
          'Link Not Found',
          'This activation link is invalid or was never issued. It may have been replaced by a newer link.',
          siteUrl, true
        ),
      };
    }

    const tokenDoc  = snap.docs[0];
    const tokenData = tokenDoc.data();

    // Check if already used
    if (tokenData.used) {
      return {
        statusCode: 410,
        headers: { 'Content-Type': 'text/html' },
        body: errorPage(
          'Link Already Used',
          'This activation link has already been used. If you need to reset your password, use the "Forgot password?" link on the login screen.',
          siteUrl, true
        ),
      };
    }

    // Check expiry
    const expiresAt = tokenData.expiresAt?.toDate ? tokenData.expiresAt.toDate() : new Date(tokenData.expiresAt);
    if (new Date() > expiresAt) {
      // Mark as expired so repeated hits don't hit Firestore repeatedly
      await tokenDoc.ref.update({ used: true, expiredAt: a.firestore.FieldValue.serverTimestamp() });
      const expiredStr = expiresAt.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      return {
        statusCode: 410,
        headers: { 'Content-Type': 'text/html' },
        body: errorPage(
          'Link Expired',
          `This activation link expired on ${expiredStr}. Please request a new one or use "Forgot password?" on the login screen.`,
          siteUrl, true
        ),
      };
    }

    // Token is valid — generate a fresh Firebase password-reset link (1-hr window)
    const continueUrl   = `${siteUrl}/tenant-portal.html`;
    const activationUrl = await a.auth().generatePasswordResetLink(
      tokenData.email,
      { url: continueUrl, handleCodeInApp: false }
    );

    // Mark token as used immediately (one-time use)
    await tokenDoc.ref.update({
      used:      true,
      usedAt:    a.firestore.FieldValue.serverTimestamp(),
      usedFrom:  event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown',
    });

    // Redirect to the fresh Firebase link
    return {
      statusCode: 302,
      headers: { Location: activationUrl },
      body: '',
    };

  } catch (err) {
    console.error('activate-invite error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html' },
      body: errorPage(
        'Something Went Wrong',
        `We encountered an error processing your link: ${err.message}. Please try again or contact your property manager.`,
        siteUrl, true
      ),
    };
  }
};
