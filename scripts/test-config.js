#!/usr/bin/env node
// scripts/test-config.js
//
// Per-workspace settings (getConfig, workspace secrets, per-request mail settings,
// per-request Stripe clients, parallel sweeps).
//
// The properties that matter, each tested directly:
//   - the default workspace sees exactly what process.env gave it (nothing changes today)
//   - any OTHER workspace never sees the deployment's value — for every key, not a sample
//   - concurrent requests for different workspaces never see each other's settings
//   - nothing mutates process.env any more
//
// Usage: node scripts/test-config.js   (or: npm test)

const Module = require('module');
const path = require('path');

const origLoad = Module._load;
const stripeCalls = [];
Module._load = function (req, ...rest) {
  if (req === 'stripe') return key => { const client = { __key: key, paymentIntents: { create: async () => ({ id: 'pi' }) } }; stripeCalls.push(key); return client; };
  return origLoad.call(this, req, ...rest);
};

const LIB = path.resolve(__dirname, '../netlify/functions/_lib');
const W = require(path.join(LIB, 'workspace'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`\x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n  ' + String(detail).split('\n').join('\n  ') : ''}`); }
}
const throws = async fn => { try { await fn(); return null; } catch (e) { return e; } };
const tick = ms => new Promise(r => setTimeout(r, ms));

// ── a registry whose operator settings we control ───────────────────────────
const WS = {
  acme: { id: 'acme', name: 'Acme Rentals', databaseId: 'ws-acme', status: 'active', domains: ['portal.acme.com'] },
  beta: { id: 'beta', name: 'Beta PM',      databaseId: 'ws-beta', status: 'active', domains: ['beta.example.org'] },
  bare: { id: 'bare', name: 'Bare Co',      databaseId: 'ws-bare', status: 'active', domains: ['bare.example.net'] },
  // Reachable through a workspaceDomains record, but its own domain list is empty: it has NO site URL to derive.
  nodom: { id: 'nodom', name: 'No Domain Co', databaseId: 'ws-nodom', status: 'active', domains: [] },
};
const ALIASES = { 'nodom.example.net': 'nodom' };
const SECRETS = {
  acme: { STRIPE_SECRET_KEY: 'sk_acme', STRIPE_WEBHOOK_SECRET: 'whsec_acme', ADMIN_NOTIFY_EMAIL: 'ops@acme.com', DOCUMENSO_API_KEY: 'doc_acme', SITE_NAME: 'Acme Portal' },
  beta: { STRIPE_SECRET_KEY: 'sk_beta', ADMIN_NOTIFY_EMAIL: 'ops@beta.org', SITE_URL: 'https://custom.beta.org' },
  bare: {},
  nodom: {},
};
let secretLoads = 0; let failSecrets = false;
const registry = {
  async lookupDomain(h) { const w = WS[ALIASES[h]] || Object.values(WS).find(x => x.domains.includes(h)); return w ? W._testing.normalizeWorkspace(w.id, w) : null; },
  async listActive() { return Object.values(WS).map(w => W._testing.normalizeWorkspace(w.id, w)); },
  async loadSecrets(id) { secretLoads++; if (failSecrets) throw new Error('platform db unavailable'); return SECRETS[id] || {}; },
};
const ev = host => ({ headers: { host } });
const DEPLOYMENT = k => `DEPLOYMENT-VALUE-OF-${k}`;

function reset() {
  W._testing.resetCaches(); secretLoads = 0; failSecrets = false; stripeCalls.length = 0;
  process.env.ALLOW_MULTI_WORKSPACE = 'true'; process.env.SITE_URL = 'https://deployment.example';
  for (const k of W.CLIENT_CONFIG_KEYS) process.env[k] = DEPLOYMENT(k);
  process.env.SITE_URL = 'https://deployment.example';
  delete process.env.SWEEP_BUDGET_MS; delete process.env.SWEEP_CONCURRENCY;
  W._testing.setRegistry(registry);
}
const inWs = (host, fn) => W.withWorkspace(async () => fn())(ev(host));
const DEF_HOST = 'rentbay.netlify.app';

(async () => {
  // ── default workspace: unchanged ─────────────────────────────────────────
  {
    reset(); const bad = [];
    await inWs(DEF_HOST, () => { for (const k of W.CLIENT_CONFIG_KEYS) if (W.getConfig(k) !== process.env[k]) bad.push(k); });
    check(`default workspace: all ${W.CLIENT_CONFIG_KEYS.length} settings read exactly what process.env holds (behaviour unchanged)`, bad.length === 0, bad.join(', '));
    check('default workspace: no registry/secrets read at all', secretLoads === 0);

    delete process.env.ADMIN_NOTIFY_EMAIL;
    let v; await inWs(DEF_HOST, () => { v = W.getConfig('ADMIN_NOTIFY_EMAIL'); });
    check('default workspace: an unset variable reads as undefined, like process.env', v === undefined);

    // partial mail override: provided keys win, the rest still come from the environment (old behaviour)
    process.env.SMTP_HOST = 'smtp.deployment'; process.env.SMTP_USER = 'deploy-user'; process.env.SMTP_PORT = '587';
    let got; await inWs(DEF_HOST, () => { W.setMailOverride({ SMTP_HOST: 'smtp.custom' }); got = [W.getConfig('SMTP_HOST'), W.getConfig('SMTP_USER'), W.getConfig('SMTP_PORT')]; });
    check('default workspace: partial mail override — host replaced, user/port still from the environment', got.join() === 'smtp.custom,deploy-user,587', got.join());
  }

  // ── other workspaces: NEVER the deployment's value ───────────────────────
  {
    reset(); const leaks = []; const own = {};
    await inWs('portal.acme.com', () => { for (const k of W.CLIENT_CONFIG_KEYS) { const v = W.getConfig(k); own[k] = v; if (typeof v === 'string' && v.includes('DEPLOYMENT-VALUE')) leaks.push(k); } });
    check(`acme: none of the ${W.CLIENT_CONFIG_KEYS.length} settings falls back to the deployment's value`, leaks.length === 0, leaks.join(', '));
    const bare = []; await inWs('bare.example.net', () => { for (const k of W.CLIENT_CONFIG_KEYS) { const v = W.getConfig(k); if (typeof v === 'string' && v.includes('DEPLOYMENT-VALUE')) bare.push(k); } });
    check('a workspace with NO settings at all also sees nothing of the deployment\'s', bare.length === 0, bare.join(', '));
    const nod = []; let nodUrl = 'unset', nodName;
    await inWs('nodom.example.net', () => { nodUrl = W.getConfig('SITE_URL'); nodName = W.getConfig('SITE_NAME'); for (const k of W.CLIENT_CONFIG_KEYS) { const v = W.getConfig(k); if (typeof v === 'string' && v.includes('DEPLOYMENT-VALUE')) nod.push(k); } });
    check('a workspace with no domain of its own has NO site URL — never the deployment\'s (its emails must not link to the platform owner\'s site)', nodUrl === undefined && nodName === 'No Domain Co' && nod.length === 0, `url=${nodUrl} leaks=${nod.join()}`);
    check('acme: gets its OWN values', own.STRIPE_SECRET_KEY === 'sk_acme' && own.STRIPE_WEBHOOK_SECRET === 'whsec_acme' && own.ADMIN_NOTIFY_EMAIL === 'ops@acme.com' && own.DOCUMENSO_API_KEY === 'doc_acme');
    check('acme: a setting it did not configure is undefined (not the deployment\'s)', own.CLOUDINARY_API_SECRET === undefined && own.SMARTMOVE_API_KEY === undefined);
    check('acme: SITE_URL defaults to its own domain, NAME to its registered name', own.SITE_URL === 'https://portal.acme.com' && own.SITE_NAME === 'Acme Portal');
    let beta; await inWs('beta.example.org', () => { beta = { url: W.getConfig('SITE_URL'), name: W.getConfig('SITE_NAME') }; });
    check('an explicit SITE_URL overrides the domain; SITE_NAME falls back to the workspace name', beta.url === 'https://custom.beta.org' && beta.name === 'Beta PM');
  }

  // ── what getConfig refuses ───────────────────────────────────────────────
  {
    reset();
    check('no workspace context -> throws', !!(await throws(async () => W.getConfig('SITE_URL'))));
    let errs = [];
    await inWs(DEF_HOST, async () => {
      for (const k of ['SITE_URLL', 'FIREBASE_SERVICE_ACCOUNT', 'NETLIFY_API_TOKEN', 'PATH', '']) errs.push(await throws(async () => W.getConfig(k)));
    });
    check('unknown names throw — typos can\'t silently read as "unset", and platform secrets are unreachable through it', errs.every(Boolean));
  }

  // ── operator secrets doc is filtered ─────────────────────────────────────
  {
    reset();
    SECRETS.acme = { ...SECRETS.acme, FIREBASE_SERVICE_ACCOUNT: 'x', SMTP_HOST: 'smtp.sneaky', NETLIFY_API_TOKEN: 't', EXTRA: 'y', CLOUDINARY_API_KEY: '' };
    const w = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(' '));
    let cfg; try { cfg = await W.loadWorkspaceConfig(W._testing.normalizeWorkspace('acme', WS.acme)); } finally { console.warn = w; }
    check('platform keys, mail keys and unknown keys in the secrets doc are ignored', !('FIREBASE_SERVICE_ACCOUNT' in cfg) && !('SMTP_HOST' in cfg) && !('NETLIFY_API_TOKEN' in cfg) && !('EXTRA' in cfg));
    check('...with a warning that names the key but never prints a value', warned.some(m => m.includes('FIREBASE_SERVICE_ACCOUNT')) && !warned.some(m => /sk_acme|whsec_|sneaky/.test(m)));
    check('empty values are dropped, real ones kept', !('CLOUDINARY_API_KEY' in cfg) && cfg.STRIPE_SECRET_KEY === 'sk_acme');
    check('the loaded settings are immutable', Object.isFrozen(cfg));
    SECRETS.acme = { STRIPE_SECRET_KEY: 'sk_acme', STRIPE_WEBHOOK_SECRET: 'whsec_acme', ADMIN_NOTIFY_EMAIL: 'ops@acme.com', DOCUMENSO_API_KEY: 'doc_acme', SITE_NAME: 'Acme Portal' };
  }

  // ── caching and failure ──────────────────────────────────────────────────
  {
    reset();
    for (let i = 0; i < 5; i++) await inWs('portal.acme.com', () => {});
    check('settings are cached (5 requests -> 1 load)', secretLoads === 1, `loads=${secretLoads}`);

    reset(); failSecrets = true; let ran = false;
    const res = await W.withWorkspace(async () => { ran = true; return { statusCode: 200 }; })(ev('portal.acme.com'));
    check('settings unavailable -> 503, handler NOT run (a workspace without its settings must not run)', res.statusCode === 503 && !ran && JSON.parse(res.body).error === 'workspace_config_unavailable');
    const ok = await W.withWorkspace(async () => ({ statusCode: 200 }))(ev(DEF_HOST));
    check('...while the default workspace is unaffected by that outage', ok.statusCode === 200);
    failSecrets = false;
    const again = await W.withWorkspace(async () => ({ statusCode: 200 }))(ev('portal.acme.com'));
    check('...and recovers as soon as the settings can be read again (failures are not cached)', again.statusCode === 200);
  }

  // ── the old bug class: interleaved requests must not see each other ──────
  {
    reset();
    const before = JSON.stringify(Object.fromEntries(W.MAIL_KEYS.map(k => [k, process.env[k]])));
    const MAIL = { acme: { SMTP_HOST: 'smtp.acme', SMTP_USER: 'u-acme' }, beta: { SMTP_HOST: 'smtp.beta', SMTP_USER: 'u-beta' }, bare: null };
    const applyFor = id => () => W.setMailOverride(MAIL[id]);
    const log = [];
    const hosts = { acme: 'portal.acme.com', beta: 'beta.example.org', bare: 'bare.example.net', def: DEF_HOST };
    await Promise.all(Array.from({ length: 80 }, (_, i) => {
      const id = ['acme', 'beta', 'bare', 'def'][i % 4];
      return W.withWorkspace(async () => {
        if (id !== 'def') applyFor(id)();
        await tick(Math.random() * 12);          // interleave with the others
        await Promise.resolve();
        log.push({ id, host: W.getConfig('SMTP_HOST'), user: W.getConfig('SMTP_USER'), notify: W.getConfig('ADMIN_NOTIFY_EMAIL'), stripe: W.getConfig('STRIPE_SECRET_KEY') });
        return { statusCode: 200 };
      })(ev(hosts[id]));
    }));
    const expect = { acme: ['smtp.acme', 'u-acme', 'ops@acme.com', 'sk_acme'], beta: ['smtp.beta', 'u-beta', 'ops@beta.org', 'sk_beta'],
                     bare: [undefined, undefined, undefined, undefined], def: [DEPLOYMENT('SMTP_HOST'), DEPLOYMENT('SMTP_USER'), DEPLOYMENT('ADMIN_NOTIFY_EMAIL'), DEPLOYMENT('STRIPE_SECRET_KEY')] };
    const bad = log.filter(l => JSON.stringify([l.host, l.user, l.notify, l.stripe]) !== JSON.stringify(expect[l.id]));
    check(`80 interleaved requests over 4 workspaces: every one saw only its own mail, notify address and Stripe key (${log.length} ran)`, log.length === 80 && bad.length === 0, JSON.stringify(bad[0]));
    check('process.env was never touched by any of it', JSON.stringify(Object.fromEntries(W.MAIL_KEYS.map(k => [k, process.env[k]]))) === before);
  }

  // ── Stripe: a client per request, from THIS workspace's key ──────────────
  {
    reset();
    const { getStripe } = require(path.join(LIB, 'stripe-client'));
    let k1, k2, k3, def, e;
    await inWs('portal.acme.com', () => { k1 = getStripe().__key; });
    await inWs('beta.example.org', () => { k2 = getStripe().__key; });
    await inWs('portal.acme.com', () => { k3 = getStripe().__key; });
    await inWs(DEF_HOST, () => { def = getStripe().__key; });
    check('each workspace gets a Stripe client built from its own key', k1 === 'sk_acme' && k2 === 'sk_beta' && def === DEPLOYMENT('STRIPE_SECRET_KEY'));
    check('...and a client is reused for the same key (3 workspaces\' calls -> 3 clients, not 4)', stripeCalls.length === 3 && k3 === 'sk_acme', stripeCalls.join());
    const before = stripeCalls.length; e = null;
    await inWs('bare.example.net', async () => { e = await throws(async () => getStripe()); });
    check('a workspace with no Stripe key gets an error and NO client is created — never the deployment\'s Stripe account', !!e && /not configured/i.test(e.message) && stripeCalls.length === before);
    check('...and the deployment\'s key was never handed to a non-default workspace', ![k1, k2].includes(DEPLOYMENT('STRIPE_SECRET_KEY')));
  }

  // ── scheduled sweeps: parallel, bounded, isolated ────────────────────────
  {
    reset(); process.env.SWEEP_CONCURRENCY = '2';
    let running = 0, peak = 0; const seen = {};
    const inner = async () => {
      running++; peak = Math.max(peak, running);
      const id = W.getWorkspace().id;
      W.setMailOverride({ SMTP_HOST: `smtp.${id}` });
      await tick(25);
      seen[id] = { smtp: W.getConfig('SMTP_HOST'), notify: W.getConfig('ADMIN_NOTIFY_EMAIL') };
      running--; return { statusCode: 200, body: '{}' };
    };
    const out = await W.withEachWorkspace(inner)({}, {});
    const r = JSON.parse(out.body).workspaces;
    check('sweep runs workspaces in parallel, but never more than SWEEP_CONCURRENCY at once', peak === 2, `peak=${peak}`);
    check('results are reported in the list\'s order, not in the order the runs happened to finish', Object.keys(r).join() === ['default', ...Object.keys(WS)].join(), Object.keys(r).join());
    check('parallel runs each saw their own settings (no bleed between concurrent workspaces)',
      seen.acme.smtp === 'smtp.acme' && seen.acme.notify === 'ops@acme.com' && seen.beta.smtp === 'smtp.beta' && seen.beta.notify === 'ops@beta.org' && seen.bare.smtp === 'smtp.bare' && seen.bare.notify === undefined && seen.default.smtp === 'smtp.default' && seen.default.notify === DEPLOYMENT('ADMIN_NOTIFY_EMAIL'), JSON.stringify(seen));

    reset(); failSecrets = true;
    const ranFor = [];
    const out2 = await W.withEachWorkspace(async () => { ranFor.push(W.getWorkspace().id); return { statusCode: 200, body: '{}' }; })({}, {});
    const r2 = JSON.parse(out2.body).workspaces;
    check('a workspace whose settings cannot be loaded is skipped and reported (500); the default still runs', out2.statusCode === 500 && ranFor.join() === 'default' && r2.acme.statusCode === 500 && /unavailable|settings/i.test(r2.acme.error), JSON.stringify(r2));
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
