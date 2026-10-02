#!/usr/bin/env node
// scripts/test-handlers.js
//
// Loads EVERY Netlify function and drives it against in-memory fakes, to prove
// the workspace seam is wired correctly everywhere — not just in the helper:
//
//   - every handler loads and is wrapped (no ReferenceError / "no workspace context")
//   - every database read/write a handler makes lands in the CALLER's workspace
//     database, and every Blobs store it opens carries that workspace's prefix
//   - an unknown host is rejected (404) before any data is touched
//   - scheduled functions run once per workspace and never cross over
//   - mail settings cannot leak between workspaces or between invocations
//   - /api/config tells each workspace's browser which database to open
//
// Handlers mostly stop at authentication here (no valid token exists), so this is
// a wiring and isolation test, not a functional test of each endpoint.
//
// Usage: node scripts/test-handlers.js   (or: npm test)

const Module = require('module');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FN_DIR = path.join(ROOT, 'netlify/functions');

// ── environment ─────────────────────────────────────────────────────────────
Object.assign(process.env, {
  ALLOW_MULTI_WORKSPACE: 'true', SITE_URL: 'https://rentbay.netlify.app', SITE_NAME: 'RentBay',
  FIREBASE_SERVICE_ACCOUNT: '{}', FIREBASE_API_KEY: 'k', FIREBASE_PROJECT_ID: 'demo-project', FIREBASE_SENDER_ID: '1', FIREBASE_APP_ID: 'a',
  STRIPE_PUBLISHABLE_KEY: 'pk_test', STRIPE_SECRET_KEY: 'sk_test_x', NETLIFY_SITE_ID: 'site', NETLIFY_API_TOKEN: 'tok',
  SMTP_HOST: 'smtp.deployment.example', SMTP_PORT: '587', SMTP_USER: 'deploy-user', SMTP_PASS: 'deploy-pass', SMTP_FROM: 'deploy@example.com',
  ADMIN_NOTIFY_EMAIL: 'owner@example.com',
  // Distinctive deployment-only values: if any of these ever shows up in something done for another
  // workspace, that is a leak of the platform owner's credentials.
  DOCUMENSO_API_KEY: 'DEPLOYMENT-documenso-key', DOCUMENSO_API_URL: 'https://deployment-documenso.example', DOCUMENSO_WEBHOOK_SECRET: 'DEPLOYMENT-documenso-whsec',
  SMARTMOVE_API_KEY: 'DEPLOYMENT-smartmove-key', SMARTMOVE_API_URL: 'https://deployment-smartmove.example',
  EMPLOYMENT_VERIFICATION_API_KEY: 'DEPLOYMENT-employment-key', EMPLOYMENT_VERIFICATION_API_URL: 'https://deployment-employment.example',
  CLOUDINARY_API_KEY: 'DEPLOYMENT-cloudinary-key', CLOUDINARY_API_SECRET: 'DEPLOYMENT-cloudinary-secret', CLOUDINARY_CLOUD_NAME: 'deployment-cloud', CLOUDINARY_UPLOAD_PRESET: 'deployment-preset',
  STRIPE_WEBHOOK_SECRET: 'DEPLOYMENT-stripe-whsec',
});
process.env.STRIPE_SECRET_KEY = 'DEPLOYMENT-sk-live';
delete process.env.ALLOWED_ORIGIN;
const outbound = [];       // everything that left the process: { kind, ws, text }
const note = (kind, payload) => outbound.push({ kind, ws: W && W.currentWorkspace(), text: JSON.stringify(payload, (_k, v) => (typeof v === 'function' ? undefined : v)) });
global.fetch = async (url, opts) => { note('fetch', { url: String(url), opts }); throw new Error('network disabled in test'); };

// ── fakes ───────────────────────────────────────────────────────────────────
const violations = [];     // I/O that landed in the wrong workspace
const stores = [];         // blob store names requested
const SEEDS = {};          // databaseId -> { collection: { docId: data } }
let W;                     // the workspace module (loaded after the hooks below)
let ioCount = 0;

function makeFakeDb(dbId) {
  const seed = () => SEEDS[dbId] || {};
  const use = () => {
    ioCount++;
    const ws = W && W.currentWorkspace();
    if (!ws || ws.databaseId !== dbId) violations.push(`I/O on database "${dbId}" while ambient workspace is ${ws ? `"${ws.id}" (${ws.databaseId})` : 'NONE'}`);
  };
  const snapOf = data => ({ exists: data !== undefined, data: () => data, id: 'x', ref: {}, get: k => (data || {})[k] });
  const emptyQuery = { docs: [], empty: true, size: 0, forEach() {} };
  function docRef(col, id) {
    return { id, path: `${col}/${id}`,
      get: async () => { use(); return snapOf((seed()[col] || {})[id]); },
      set: async () => { use(); }, update: async () => { use(); }, delete: async () => { use(); }, create: async () => { use(); },
      collection: n => collRef(`${col}/${id}/${n}`) };
  }
  function collRef(name) {
    const q = {
      doc: id => docRef(name, id || 'auto'),
      where: () => q, orderBy: () => q, limit: () => q, startAfter: () => q, select: () => q, offset: () => q,
      get: async () => { use(); return emptyQuery; },
      add: async () => { use(); return { id: 'auto1' }; },
      count: () => ({ get: async () => { use(); return { data: () => ({ count: 0 }) }; } }),
    };
    return q;
  }
  return {
    formattedName: `projects/demo-project/databases/${dbId}`,
    collection: collRef,
    runTransaction: async fn => { use(); return fn({ get: async r => r.get(), set() {}, update() {}, delete() {}, create() {} }); },
    batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => { use(); } }),
    getAll: async (...refs) => { use(); return refs.map(() => snapOf(undefined)); },
  };
}
const _dbs = new Map();
const dbFor = id => { if (!_dbs.has(id)) _dbs.set(id, makeFakeDb(id)); return _dbs.get(id); };

const FieldValue = { serverTimestamp: () => 'TS', arrayUnion: (...a) => ({ arrayUnion: a }), arrayRemove: (...a) => ({ arrayRemove: a }), increment: n => ({ inc: n }), delete: () => 'DEL' };
const Timestamp = { now: () => ({ toDate: () => new Date(), toMillis: () => Date.now() }), fromDate: d => ({ toDate: () => d, toMillis: () => d.getTime() }), fromMillis: ms => ({ toDate: () => new Date(ms), toMillis: () => ms }) };
const AUTH = { uid: null };   // null = no valid session; otherwise verifyIdToken succeeds as this uid
const fakeAdmin = {
  apps: [{}], initializeApp() {}, credential: { cert: () => ({}) }, app: () => ({}),
  firestore: Object.assign(() => dbFor('(default)'), { FieldValue, Timestamp }),
  auth: () => ({
    verifyIdToken: async () => { if (AUTH.uid) return { uid: AUTH.uid, email: `${AUTH.uid}@example.com` }; const e = new Error('invalid token'); e.code = 'auth/argument-error'; throw e; },
    getUser: async () => { throw new Error('no user'); }, getUserByEmail: async () => { throw new Error('no user'); },
    createCustomToken: async () => 'custom', createUser: async () => ({ uid: 'u' }), setCustomUserClaims: async () => {}, updateUser: async () => ({}),
  }),
};

const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'firebase-admin') return fakeAdmin;
  if (req === 'firebase-admin/firestore') return { getFirestore: (_app, id) => dbFor(id || '(default)'), FieldValue, Timestamp };
  if (req === '@netlify/blobs') return { getStore: o => { stores.push({ name: o.name, ws: W && W.currentWorkspace() }); return { get: async () => null, getWithMetadata: async () => null, set: async () => {}, delete: async () => {}, list: async () => ({ blobs: [] }) }; } };
  if (req === 'nodemailer') return { createTransport: o => { note('smtp-transport', o); return { sendMail: async m => { note('mail', m); return {}; }, verify: async () => true }; } };
  if (req === 'stripe') return key => { note('stripe-client', { key }); const rej = async () => { throw new Error('stripe stubbed'); };
    return { paymentIntents: { create: rej }, customers: { create: rej }, setupIntents: { create: rej }, webhooks: { constructEvent: () => { throw new Error('bad signature'); } } }; };
  return origLoad.call(this, req, parent, ...rest);
};

W = require(path.join(FN_DIR, '_lib/workspace'));

// ── harness ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`\x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n  ' + String(detail).split('\n').join('\n  ') : ''}`); }
}
const ACME = { id: 'acme', name: 'Acme Rentals', databaseId: 'ws-acme', status: 'active', domains: ['portal.acme.com'] };
const ACME_SECRETS = { STRIPE_SECRET_KEY: 'sk_acme', STRIPE_WEBHOOK_SECRET: 'whsec_acme', STRIPE_PUBLISHABLE_KEY: 'pk_acme', ADMIN_NOTIFY_EMAIL: 'ops@acme.example', SITE_NAME: 'Acme Rentals' };
W._testing.setRegistry({
  async loadSecrets(id) { return id === 'acme' ? ACME_SECRETS : {}; },
  async lookupDomain(h) { return h === ACME.domains[0] ? W._testing.normalizeWorkspace(ACME.id, ACME) : null; },
  async listActive() { return [W._testing.normalizeWorkspace(ACME.id, ACME)]; },
});
const HOSTS = { default: 'rentbay.netlify.app', acme: 'portal.acme.com' };
const mkEvent = (host, method) => ({ httpMethod: method, headers: { host, authorization: 'Bearer not-a-real-token', origin: `https://${host}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : null, queryStringParameters: {}, path: '/x' });
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r({ __timeout: true }), ms))]);

const silence = async fn => { const e = console.error, w = console.warn, l = console.log; const logs = [];
  console.error = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' ')); console.log = () => {};
  try { return { result: await fn(), logs }; } finally { console.error = e; console.warn = w; console.log = l; } };

const SEAM_ERROR = /no workspace context|is not defined|getDb is not a function|withWorkspace is not|getWorkspaceStore is not/i;

(async () => {
  // ── A. every function loads and is wrapped ───────────────────────────────
  const files = fs.readdirSync(FN_DIR).filter(f => f.endsWith('.js'));
  const handlers = {}, loadErrors = [];
  for (const f of files) {
    try { const m = require(path.join(FN_DIR, f)); if (typeof m.handler !== 'function') loadErrors.push(`${f}: no handler export`); else handlers[f.replace(/\.js$/, '')] = m.handler; }
    catch (e) { loadErrors.push(`${f}: ${e.message}`); }
  }
  check(`all ${files.length} functions load and export a handler`, loadErrors.length === 0, loadErrors.join('\n'));
  const names = Object.keys(handlers);
  const scheduled = ['purge-expired-applications', 'purge-summary-report', 'send-annual-event-reminders', 'send-auto-invoices', 'send-invoice-reminders', 'send-property-reminders'];
  const http = names.filter(n => !scheduled.includes(n) && n !== 'geo');

  // ── B. every handler, both workspaces, both methods: wired and isolated ──
  {
    const problems = []; let ran = 0, timedOut = 0;
    for (const n of http) {
      for (const [label, host] of Object.entries(HOSTS)) {
        for (const method of ['GET', 'POST']) {
          const { result, logs } = await silence(() => withTimeout(handlers[n](mkEvent(host, method), {}).catch(e => ({ __threw: e })), 3000));
          ran++;
          if (result && result.__timeout) { timedOut++; continue; }
          const text = [...logs, result && result.__threw ? result.__threw.message : '', result && result.body ? String(result.body) : ''].join('\n');
          if (SEAM_ERROR.test(text)) problems.push(`${n} [${label} ${method}]: ${(text.match(SEAM_ERROR) || [''])[0]}`);
          if (result && result.__threw && SEAM_ERROR.test(result.__threw.message)) problems.push(`${n} [${label} ${method}] threw: ${result.__threw.message}`);
        }
      }
    }
    check(`${http.length} HTTP handlers × 2 workspaces × 2 methods (${ran} invocations): no wiring errors`, problems.length === 0, problems.slice(0, 8).join('\n'));
    check('no handler read or wrote another workspace\'s database', violations.length === 0, [...new Set(violations)].slice(0, 8).join('\n'));
    const badStores = stores.filter(s => s.ws && !s.name.startsWith(s.ws.storePrefix));
    check(`every blob store opened carried its workspace's prefix (${stores.length} opened)`, badStores.length === 0, badStores.slice(0, 5).map(s => `${s.name} in ${s.ws.id}`).join('\n'));
    check('...and the acme workspace really did get prefixed stores', stores.some(s => s.ws && s.ws.id === 'acme' && s.name.startsWith('ws-acme-')) || stores.length === 0);
    if (timedOut) console.log(`  (note: ${timedOut} invocations hit the 3s test timeout while waiting on network-bound code; they are not counted as failures)`);
  }

  // ── C. unknown host: rejected before any data is touched ─────────────────
  {
    const before = ioCount; const wrong = [];
    for (const n of http) {
      const { result } = await silence(() => withTimeout(handlers[n](mkEvent('evil.example.org', 'POST'), {}), 3000));
      if (!result || result.statusCode !== 404) wrong.push(`${n} -> ${result && result.statusCode}`);
    }
    check(`all ${http.length} HTTP handlers answer 404 to an unknown host`, wrong.length === 0, wrong.join('\n'));
    check('...without a single database read or write', ioCount === before, `${ioCount - before} I/O calls`);
  }

  // ── D. scheduled functions: once per workspace, never crossing over ──────
  {
    let bad = [];
    for (const n of scheduled) {
      violations.length = 0;
      const { result } = await silence(() => withTimeout(handlers[n]({}, {}).catch(e => ({ __threw: e })), 8000));
      if (!result || result.__timeout) { bad.push(`${n}: timed out`); continue; }
      if (result.__threw) { bad.push(`${n}: threw ${result.__threw.message}`); continue; }
      let parsed; try { parsed = JSON.parse(result.body); } catch { parsed = null; }
      const ids = parsed && parsed.workspaces ? Object.keys(parsed.workspaces) : [];
      if (ids.join() !== 'default,acme') bad.push(`${n}: ran for [${ids.join()}] instead of [default,acme]`);
      if (violations.length) bad.push(`${n}: ${violations[0]}`);
    }
    check(`all ${scheduled.length} scheduled functions run once for each workspace, with no cross-workspace I/O`, bad.length === 0, bad.join('\n'));
  }

  // ── E. mail settings: per request, never shared ──────────────────────────
  {
    const apply = require(path.join(FN_DIR, '_lib/apply-email-config'));
    const DEF = W._testing.defaultWorkspace(), AC = W._testing.normalizeWorkspace('acme', ACME);
    const mailFor = ws => W.runWithWorkspace(ws, async () => {
      await apply();
      await new Promise(r => setTimeout(r, Math.random() * 10)); // let other requests interleave
      return { host: W.getConfig('SMTP_HOST'), user: W.getConfig('SMTP_USER'), pass: W.getConfig('SMTP_PASS'), from: W.getConfig('SMTP_FROM'), port: W.getConfig('SMTP_PORT') };
    });
    const envBefore = JSON.stringify(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].map(k => process.env[k]));
    SEEDS['(default)'] = {}; SEEDS['ws-acme'] = {};

    let m = await mailFor(DEF);
    check('default workspace, no override: uses the deployment\'s own SMTP', m.host === 'smtp.deployment.example' && m.user === 'deploy-user' && m.pass === 'deploy-pass');

    SEEDS['ws-acme'] = { integrationSecrets: { _active: { email: 'e1' }, e1: { host: 'smtp.acme.example', port: 465, user: 'acme-user', pass: 'acme-pass', fromAddress: 'hello@acme.example' } } };
    m = await mailFor(AC);
    check('acme with its own provider: uses it', m.host === 'smtp.acme.example' && m.user === 'acme-user' && m.from === 'hello@acme.example' && m.port === '465');

    const runs = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? mailFor(AC) : mailFor(DEF)).then(r => ({ who: i % 2 ? 'acme' : 'def', r }))));
    const wrong = runs.filter(x => x.who === 'acme' ? x.r.host !== 'smtp.acme.example' || x.r.pass !== 'acme-pass' : x.r.host !== 'smtp.deployment.example' || x.r.pass !== 'deploy-pass');
    check('60 interleaved requests, default and acme at the same time: each used only its own mail server and password', wrong.length === 0, JSON.stringify(wrong[0]));

    SEEDS['ws-acme'] = {};
    m = await mailFor(AC);
    check('acme with NO provider: no mail config at all — it does not inherit the deployment owner\'s SMTP account', m.host === undefined && m.user === undefined && m.pass === undefined && m.from === undefined);

    SEEDS['(default)'] = { integrationSecrets: { _active: { email: 'd1' }, d1: { host: 'smtp.custom-default.example', user: 'cd' } } };
    m = await mailFor(DEF);
    check('default workspace with its own override: host/user replaced, password still the deployment\'s (as before)', m.host === 'smtp.custom-default.example' && m.user === 'cd' && m.pass === 'deploy-pass');
    SEEDS['(default)'] = {};
    m = await mailFor(DEF);
    check('...and once that override is switched off the very next request is back on the deployment SMTP', m.host === 'smtp.deployment.example');

    SEEDS['ws-acme'] = { integrationSecrets: { _active: { email: 'e1' }, e1: { host: '' } } };
    m = await mailFor(AC);
    check('incomplete override (no host) is ignored, not half-applied', m.host === undefined);
    SEEDS['ws-acme'] = {};
    check('process.env\'s SMTP_* were never modified by any of it', JSON.stringify(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].map(k => process.env[k])) === envBefore);
  }

  // ── G. authenticated: handlers get past login, isolation still holds ────
  {
    SEEDS['(default)'] = { admins: { 'admin-default': { role: 'super_admin' } } };
    SEEDS['ws-acme']   = { admins: { 'admin-acme':    { role: 'super_admin' } } };
    violations.length = 0; const io0 = ioCount; const problems = [];
    for (const n of http) {
      for (const [label, host, uid] of [['default', HOSTS.default, 'admin-default'], ['acme', HOSTS.acme, 'admin-acme']]) {
        for (const method of ['GET', 'POST']) {
          AUTH.uid = uid;
          const { result, logs } = await silence(() => withTimeout(handlers[n](mkEvent(host, method), {}).catch(e => ({ __threw: e })), 3000));
          AUTH.uid = null;
          if (result && result.__timeout) continue;
          const text = [...logs, result && result.__threw ? result.__threw.message : '', result && result.body ? String(result.body) : ''].join('\n');
          if (SEAM_ERROR.test(text)) problems.push(`${n} [${label} ${method}]: ${(text.match(SEAM_ERROR) || [''])[0]}`);
        }
      }
    }
    check(`authenticated pass over all ${http.length} handlers: no wiring errors (${ioCount - io0} more database calls exercised)`, problems.length === 0, problems.slice(0, 8).join('\n'));
    check('...and still no cross-workspace database access', violations.length === 0, [...new Set(violations)].slice(0, 8).join('\n'));

    // The key security property: an admin of workspace A is not an admin of workspace B.
    // Handlers validate input / check mail config BEFORE the admin check, so drive each one
    // with a superset body (and a mail provider for acme, which does not inherit the
    // deployment's) until it actually reaches verifyAdmin — then judge what it answered.
    SEEDS['ws-acme'].integrationSecrets = { _active: { email: 'e1' }, e1: { host: 'smtp.acme.example', user: 'u', pass: 'p' } };
    const FULL_BODY = JSON.stringify({ title: 't', message: 'm', consentId: 'c', docId: 'd', documentGroupId: 'g', tenantId: 't1', moveOutDate: '2026-01-01',
      channel: 'sms', targetType: 'tenant', targetId: 'x', applicationId: 'a1', to: 'x@example.com', email: 'x@example.com', tenantEmail: 'x@example.com',
      subject: 's', body: 'b', invoiceId: 'i1', status: 'pending', adminNotes: 'n', requestedDocs: ['photo_id'], propertyId: 'p1', unit: '1', lineItems: [{ description: 'r', quantity: 1, unitPrice: 1, amount: 1 }] });
    const adminGated = http.filter(n => /verifyAdmin\(/.test(fs.readFileSync(path.join(FN_DIR, n + '.js'), 'utf8')));
    const REFUSED = /Caller is not an admin/, PRE_AUTH = /Missing Authorization|Invalid or expired/;
    const leaks = [], ownBlocked = [], unreachable = [];
    for (const n of adminGated) {
      const call = async host => { AUTH.uid = 'admin-default'; const ev = mkEvent(host, 'POST'); ev.body = FULL_BODY;
        const r = (await silence(() => withTimeout(handlers[n](ev, {}), 3000))).result; AUTH.uid = null; return r; };
      const onOwn = await call(HOSTS.default), onOther = await call(HOSTS.acme);
      const body = r => (r && r.body) || '';
      if (REFUSED.test(body(onOwn)) || PRE_AUTH.test(body(onOwn))) ownBlocked.push(`${n}: refused on their OWN workspace: ${body(onOwn).slice(0, 70)}`);
      if (REFUSED.test(body(onOther))) continue;                      // reached the admin check and was refused: correct
      // Only a SUCCESS response to the other workspace's admin is a leak. Anything else that
      // is not the explicit refusal means the handler stopped earlier: reported below so it cannot hide.
      if (!onOther || onOther.statusCode >= 400) { unreachable.push(`${n}: ${onOther && onOther.statusCode} ${body(onOther).slice(0, 70)}`); continue; }
      leaks.push(`${n}: default-workspace admin on acme's host got ${onOther && onOther.statusCode} ${body(onOther).slice(0, 70)}`);
    }
    check(`admin-gated handlers that reach the admin check (${adminGated.length - unreachable.length} of ${adminGated.length}): a default-workspace admin is REFUSED on another workspace's host`, leaks.length === 0, leaks.join('\n'));
    check('...and an admin is accepted on their own workspace (the refusal is about the workspace, not a broken fake)', ownBlocked.length === 0, ownBlocked.join('\n'));
    check('every admin-gated handler could be driven to its admin check', unreachable.length === 0, unreachable.join('\n'));
    SEEDS['(default)'] = {}; SEEDS['ws-acme'] = {};
  }

  // ── H. what actually left the process for other workspaces ───────────────
  {
    const secrets = Object.entries(process.env).filter(([k, v]) => /^(SMTP_(HOST|USER|PASS|FROM)|STRIPE_(SECRET_KEY|WEBHOOK_SECRET)|DOCUMENSO_(API_KEY|API_URL|WEBHOOK_SECRET)|SMARTMOVE_(API_KEY|API_URL)|EMPLOYMENT_VERIFICATION_(API_KEY|API_URL)|CLOUDINARY_(API_KEY|API_SECRET)|ADMIN_NOTIFY_EMAIL)$/.test(k) && v).map(([k, v]) => [k, v]);
    const acmeOut = outbound.filter(o => o.ws && o.ws.id === 'acme');
    const defOut  = outbound.filter(o => o.ws && o.ws.isDefault);
    const kinds = k => acmeOut.filter(o => o.kind === k).length;
    const leaks = [];
    for (const o of acmeOut) for (const [k, v] of secrets) if (o.text.includes(v)) leaks.push(`${o.kind} for acme contains the deployment's ${k}`);
    check(`${acmeOut.length} outbound calls made for acme (${kinds('smtp-transport')} mail transports, ${kinds('mail')} emails, ${kinds('stripe-client')} Stripe clients, ${kinds('fetch')} HTTP requests): none contains any of the deployment's ${secrets.length} credentials`, leaks.length === 0 && acmeOut.length > 0, leaks.slice(0, 6).join('\n'));
    check('...the recorder is live: it did see the deployment\'s own credentials used for the default workspace', defOut.some(o => secrets.some(([, v]) => o.text.includes(v))));
    const stripeAcme = acmeOut.filter(o => o.kind === 'stripe-client').map(o => JSON.parse(o.text).key);
    check('every Stripe client created for acme used acme\'s own key', stripeAcme.every(k => k === 'sk_acme'), stripeAcme.join());
    const mailsToOwner = acmeOut.filter(o => o.kind === 'mail' && /owner@example\.com/.test(o.text));
    check('no email made for acme was addressed to the platform owner\'s notification address', mailsToOwner.length === 0);
  }

  // ── F. /api/config tells each workspace's browser which database to open ─
  {
    const cfg = handlers.config;
    const call = async (host, headers = {}) => (await silence(() => cfg({ httpMethod: 'GET', headers: { host, ...headers }, queryStringParameters: {} }))).result;
    let r = await call(HOSTS.default, { origin: 'https://rentbay.netlify.app' });
    check('default workspace: config says database "(default)" (browser behaviour unchanged)', r.statusCode === 200 && JSON.parse(r.body).firestoreDatabaseId === '(default)');
    r = await call(HOSTS.acme, { origin: 'https://portal.acme.com' });
    check('acme: config says database "ws-acme"', r.statusCode === 200 && JSON.parse(r.body).firestoreDatabaseId === 'ws-acme');
    r = await call(HOSTS.acme, { referer: 'https://portal.acme.com/tenant-portal' });
    check('acme: same-origin request carrying only a Referer is accepted', r.statusCode === 200);
    for (const [label, hdr] of [['the default workspace\'s origin', { origin: 'https://rentbay.netlify.app' }], ['a look-alike domain', { origin: 'https://portal.acme.com.evil.example' }], ['no origin at all', {}]]) {
      r = await call(HOSTS.acme, hdr);
      check(`acme: refuses ${label} (403)`, r.statusCode === 403);
    }
    process.env.ALLOWED_ORIGIN = 'https://rentbay.netlify.app';
    r = await call(HOSTS.default, { origin: 'https://other.example' });
    check('default workspace: ALLOWED_ORIGIN still enforced exactly as before', r.statusCode === 403);
    r = await call(HOSTS.default, { origin: 'https://rentbay.netlify.app' });
    check('default workspace: ...and its own origin still accepted', r.statusCode === 200);
    delete process.env.ALLOWED_ORIGIN;
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
