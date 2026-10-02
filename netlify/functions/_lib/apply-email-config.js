// netlify/functions/_lib/apply-email-config.js
// NOT a deployed function — a shared helper required by other functions.
//
// Every email-sending function in this app reads process.env.SMTP_HOST /
// SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM directly via nodemailer.
// Rather than rewriting each one's sending logic, this sets those same
// process.env values for the current invocation — BEFORE the calling
// function's existing code reads them — from the current workspace's own
// email provider (configured via manage-integrations.js), if it has one.
//
// Usage, as the very first line inside exports.handler:
//   await require('./_lib/apply-email-config')();
//
// Guarantees (this is what makes it safe with more than one workspace):
//   1. RESET FIRST. Every call starts from the deployment's own SMTP settings
//      (captured when this module loads). A warm function instance used to keep
//      whatever the previous invocation applied — so an override an admin had
//      since switched off kept being used, and with several workspaces one
//      client's mail credentials would have carried into another client's request.
//   2. NO INHERITANCE. A non-default workspace never falls back to the
//      deployment's SMTP account: with no provider of its own it has NO mail
//      configuration, and the callers' existing "no email configuration" checks
//      apply, rather than silently sending a client's mail from the platform
//      owner's account.
//   3. A lookup failure for the default workspace is a no-op, as before: the
//      deployment's environment variables keep being used.
//
// Relies on a function instance handling one invocation at a time, which
// Netlify Functions guarantee, and on workspaces within one scheduled sweep
// running sequentially (see withEachWorkspace). Replacing this process.env
// mutation with an explicit per-call config object is what will allow sweeps
// to run workspaces in parallel.

const { getDb, currentWorkspace } = require('./workspace');

const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

// The deployment's own mail settings, captured once, before anything can overwrite them.
const BASELINE = {};
for (const k of KEYS) BASELINE[k] = process.env[k];

function resetMailEnv(inheritDeployment) {
  for (const k of KEYS) {
    const v = inheritDeployment ? BASELINE[k] : undefined;
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

module.exports = async function applyEmailConfigOverride() {
  const ws = currentWorkspace();
  resetMailEnv(!ws || ws.isDefault);
  try {
    const db = getDb();
    const activeSnap = await db.collection('integrationSecrets').doc('_active').get();
    const activeId = activeSnap.exists ? activeSnap.data().email : null;
    if (!activeId) return; // nothing active — stay on the reset values above

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
    console.warn('apply-email-config: could not load override, using existing settings:', err.message);
  }
};
