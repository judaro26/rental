// netlify/functions/_lib/apply-email-config.js
// NOT a deployed function — a shared helper required by other functions.
//
// Every email-sending function in this app reads process.env.SMTP_HOST /
// SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM directly via nodemailer.
// Rather than rewriting each one's sending logic (20 functions, none of
// which need to change), this overrides those same process.env values for
// the current invocation — BEFORE the calling function's existing code
// reads them — if a super_admin has configured a custom provider via
// manage-integrations.js. If nothing is configured, or the lookup fails for
// any reason, this is a silent no-op and the existing environment variables
// keep being used exactly as before.
//
// Usage, as the very first line inside exports.handler:
//   await require('./_lib/apply-email-config')();
//
// This works because SendGrid, Mailgun, Postmark, and Amazon SES all offer
// SMTP-compatible endpoints alongside their REST APIs — "the email
// provider" can mean "which SMTP server" without needing a different
// sending mechanism per provider.

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

module.exports = async function applyEmailConfigOverride() {
  try {
    const a = getAdmin();
    const db = a.firestore();
    const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
    const activeId = activeSnap.exists ? activeSnap.data().email : null;
    if (!activeId) return; // nothing active — env vars stay as-is

    const snap = await db.collection('integrationSecrets').doc(activeId).get();
    if (!snap.exists) return;
    const cfg = snap.data();
    if (!cfg.host) return; // configured doc exists but incomplete — don't override with partial data

    process.env.SMTP_HOST = cfg.host;
    if (cfg.port) process.env.SMTP_PORT = String(cfg.port);
    if (cfg.user) process.env.SMTP_USER = cfg.user;
    if (cfg.pass) process.env.SMTP_PASS = cfg.pass;
    if (cfg.fromAddress) process.env.SMTP_FROM = cfg.fromAddress;
  } catch (err) {
    console.warn('apply-email-config: could not load override, using existing env vars:', err.message);
  }
};
