// netlify/functions/_lib/apply-email-config.js
// NOT a deployed function — a shared helper required by other functions.
//
// Every email-sending function reads its mail settings with
// getConfig('SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS' | 'SMTP_FROM').
// This loads the CURRENT workspace's own email provider (configured by its admins via
// manage-integrations.js) into the current request, so those reads see it.
//
// Usage, as the first line inside exports.handler of anything that sends mail:
//   await require('./_lib/apply-email-config')();
//
// How it behaves (this is what makes it safe with more than one workspace):
//   - The settings live in this request's own context, NOT in process.env. Nothing is
//     shared between requests, so nothing can carry over from the previous one (the
//     old version overwrote process.env, which a warm instance kept — an override an
//     admin had switched off kept being used, and with several clients one client's mail
//     credentials would have reached another client's request), and workspaces can run
//     in parallel.
//   - Default workspace: a provider it configured wins, key by key (host is required,
//     port/user/pass/from only if provided); anything it did not provide still comes from
//     the deployment's SMTP_* — exactly as before. A failed lookup is a no-op, so the
//     deployment's settings keep being used.
//   - Any other workspace: ONLY its own provider. With none, it has no mail configuration
//     and the callers' existing "email is not configured" checks apply — it never sends
//     through the platform owner's account.
//
// It is safe to call more than once in a request.

const { getDb, currentWorkspace, setMailOverride } = require('./workspace');

module.exports = async function applyEmailConfigOverride() {
  if (!currentWorkspace()) return;
  setMailOverride(null); // start this request from nothing
  try {
    const db = getDb();
    const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
    const activeId = activeSnap.exists ? activeSnap.data().email : null;
    if (!activeId) return; // nothing active

    const snap = await db.collection('integrationSecrets').doc(activeId).get();
    if (!snap.exists) return;
    const cfg = snap.data();
    if (!cfg.host) return; // configured doc exists but incomplete — don't override with partial data

    const mail = { SMTP_HOST: String(cfg.host) };
    if (cfg.port) mail.SMTP_PORT = String(cfg.port);
    if (cfg.user) mail.SMTP_USER = String(cfg.user);
    if (cfg.pass) mail.SMTP_PASS = String(cfg.pass);
    if (cfg.fromAddress) mail.SMTP_FROM = String(cfg.fromAddress);
    setMailOverride(mail);
  } catch (err) {
    console.warn('apply-email-config: could not load override, using existing settings:', err.message);
  }
};
