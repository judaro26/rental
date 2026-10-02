#!/usr/bin/env node
// scripts/test-provision-contract.js
//
// The contract between PROVISIONING (what scripts/workspace.js writes) and the RUNTIME (what the real,
// unmodified request handlers expect). Provisioning is tested with fakes elsewhere; this proves the
// records it creates are the ones the live system accepts:
//
//   - the registry record passes the runtime's own validation, and resolves by the client's domain
//   - the first admin's activation link works through the REAL activate-admin-invite handler, in the
//     client's own sign-in pool, returning to the client's own domain
//   - the browser's view of the workspace (the REAL /api/config) names the right database and pool
//   - a workspace that is provisioning, suspended, or unknown is refused by the real runtime
//
// Only the Firebase SDK is faked. The handlers, the workspace resolution and the validation are real.
//
// Usage: node scripts/test-provision-contract.js   (or: npm test)

const Module = require('module');
const path = require('path');
const { makeWorld } = require('./lib/test-world');

// ── a Firestore/Auth fake that reads the SAME world provisioning wrote to ───
const world = makeWorld();
const { st } = world;
// The real handlers judge expiry with the real clock, so provisioning must use it too (the shared fake's clock is in the past).
world.deps.now = () => new Date();
const authCalls = [];
function fakeFirestore(databaseId) {
  const coll = name => {
    const rows = () => st.colls.get(`${databaseId}/${name}`) || [];
    const wrap = row => ({ data: () => row, ref: { update: async patch => { Object.assign(row, patch); } } });
    const q = { where: (f, op, v) => ({ limit: () => ({ get: async () => { const r = rows().filter(x => x[f] === v); return { empty: !r.length, docs: r.map(wrap) }; } }) }),
                doc: id => ({ get: async () => { const d = st.docs.get(`${databaseId}/${name}/${id}`); return { exists: !!d, data: () => d }; } }) };
    return q;
  };
  return { collection: coll };
}
const fakeAdmin = {
  apps: [{}], initializeApp() {}, credential: { cert: () => ({}) }, app: () => ({}),
  firestore: Object.assign(() => fakeFirestore('(default)'), { FieldValue: { serverTimestamp: () => 'TS' }, Timestamp: { fromDate: d => d } }),
  auth: () => ({ tenantManager: () => ({ authForTenant: id => ({
    tenantId: id,
    verifyIdToken: async () => { throw new Error('no session in this test'); },
    generatePasswordResetLink: async (email, opts) => { authCalls.push({ tenant: id, email, opts }); return `https://reset.example/${id}/${email}`; },
  }) }) }),
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'firebase-admin') return fakeAdmin;
  if (req === 'firebase-admin/firestore') return { getFirestore: (_a, id) => fakeFirestore(id) };
  return origLoad.call(this, req, ...rest);
};

Object.assign(process.env, { ALLOW_MULTI_WORKSPACE: 'true', SITE_URL: 'https://rentbay.netlify.app', FIREBASE_SERVICE_ACCOUNT: '{}',
  FIREBASE_API_KEY: 'k', FIREBASE_PROJECT_ID: 'demo-project', FIREBASE_SENDER_ID: '1', FIREBASE_APP_ID: 'a', STRIPE_PUBLISHABLE_KEY: 'pk_default' });
delete process.env.ALLOWED_ORIGIN;

const FN = path.resolve(__dirname, '../netlify/functions');
const W = require(path.join(FN, '_lib/workspace'));
const P = require('./lib/provision');
const activateInvite = require(path.join(FN, 'activate-admin-invite')).handler;
const config = require(path.join(FN, 'config')).handler;

// The runtime's registry, answering from the very records provisioning wrote — through the runtime's OWN validation.
W._testing.setRegistry({
  async lookupDomain(host) { const id = st.domains.get(host); if (!id) return null; return W.normalizeWorkspace(id, st.workspaces.get(id)); },
  async listActive() { return [...st.workspaces].filter(([, r]) => r.status === 'active').map(([id, r]) => W.normalizeWorkspace(id, r)); },
  async loadSecrets(id) { return st.secrets.get(id) || {}; },
});

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`\x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n  ' + String(detail).split('\n').join('\n  ') : ''}`); }
}
const get = (handler, host, extra = {}) => handler({ httpMethod: 'GET', headers: { host, origin: `https://${host}`, ...(extra.headers || {}) }, queryStringParameters: extra.query || {} });

(async () => {
  // provision a client end to end, exactly as the tool would
  await P.createWorkspace(world.deps, { id: 'acme', name: 'Acme Rentals', domains: ['portal.acme.com'], adminEmail: 'owner@acme.com', adminName: 'Pat', apply: true });
  await P.createWorkspace(world.deps, { id: 'beta', name: 'Beta PM', domains: ['beta.example.org'], apply: true });  // left provisioning
  const acme = st.workspaces.get('acme');
  const token = st.colls.get('ws-acme/adminInviteTokens')[0].token;

  // ── before it is live ────────────────────────────────────────────────────
  {
    W._testing.resetCaches();
    const r = await get(activateInvite, 'portal.acme.com', { query: { token } });
    check('while the workspace is still provisioning, the REAL runtime refuses it (403) — even with a valid invite link', r.statusCode === 403 && JSON.parse(r.body).error === 'workspace_unavailable', `${r.statusCode} ${r.body}`);
    check('...and consumed nothing', st.colls.get('ws-acme/adminInviteTokens')[0].used === false && authCalls.length === 0);
  }

  await P.protectDefault(world.deps, { apply: true });
  await P.activateWorkspace(world.deps, { id: 'acme', apply: true });
  W._testing.resetCaches();

  // ── the registry record, as the runtime reads it ─────────────────────────
  {
    const ws = await W.resolveWorkspace({ headers: { host: 'portal.acme.com' } });
    check('the REAL runtime resolves the client\'s domain to the provisioned workspace', ws.id === 'acme' && ws.status === 'active' && ws.databaseId === 'ws-acme' && ws.authTenantId === acme.authTenantId && ws.siteUrl === 'https://portal.acme.com');
    check('...and the Host header is matched case-insensitively with a port, as browsers send it', (await W.resolveWorkspace({ headers: { host: 'PORTAL.Acme.com:443' } })).id === 'acme');
    const e = await (async () => { try { await W.resolveWorkspace({ headers: { host: 'beta.example.org' } }); } catch (x) { return x; } })();
    check('a workspace that was created but never activated is refused by the runtime (403)', e && e.status === 403, e && e.message);
    const u = await (async () => { try { await W.resolveWorkspace({ headers: { host: 'unknown.example.org' } }); } catch (x) { return x; } })();
    check('a host nobody registered is refused (404), never routed to the default workspace', u && u.status === 404);
  }

  // ── the browser's view ───────────────────────────────────────────────────
  {
    const r = await get(config, 'portal.acme.com');
    const body = JSON.parse(r.body);
    check('the REAL /api/config tells the client\'s browser its own database and its own sign-in pool', r.statusCode === 200 && body.firestoreDatabaseId === 'ws-acme' && body.authTenantId === acme.authTenantId, r.body.slice(0, 200));
    check('...and does not require Stripe for a client that has none', body.stripePk === null);
    const other = await get(config, 'portal.acme.com', { headers: { origin: 'https://rentbay.netlify.app' } });
    check('...and refuses a page served from any other origin (403)', other.statusCode === 403);
  }

  // ── the first admin, through the REAL activation handler ─────────────────
  {
    authCalls.length = 0;
    const r = await get(activateInvite, 'portal.acme.com', { query: { token } });
    check('the REAL activate-admin-invite accepts the token provisioning created and redirects (302)', r.statusCode === 302, `${r.statusCode} ${String(r.body).slice(0, 160)}`);
    check('...the password-setup link is generated in the CLIENT\'S sign-in pool, for the admin\'s email', authCalls.length === 1 && authCalls[0].tenant === acme.authTenantId && authCalls[0].email === 'owner@acme.com');
    check('...returning to the CLIENT\'S own domain (which is why it had to be an authorized domain)', authCalls[0].opts.url === 'https://portal.acme.com/admin.html' && r.headers.Location === `https://reset.example/${acme.authTenantId}/owner@acme.com`, JSON.stringify(authCalls[0].opts));
    check('...and the token is marked used, so the link works exactly once', st.colls.get('ws-acme/adminInviteTokens')[0].used === true);
    const again = await get(activateInvite, 'portal.acme.com', { query: { token } });
    check('using the same link again is refused (410)', again.statusCode === 410);
    const wrong = await get(activateInvite, 'portal.acme.com', { query: { token: 'not-a-token' } });
    check('a made-up token is refused (404)', wrong.statusCode === 404);
  }

  // ── the invite cannot be used against another host ───────────────────────
  {
    await P.inviteAdmin(world.deps, { id: 'acme', email: 'second@acme.com', apply: true });
    const t2 = st.colls.get('ws-acme/adminInviteTokens').find(t => !t.used).token;
    const onDefault = await get(activateInvite, 'rentbay.netlify.app', { query: { token: t2 } });
    check('a client\'s invite token does not work on YOUR own domain (it lives in the client\'s database)', onDefault.statusCode === 404 && st.colls.get('ws-acme/adminInviteTokens').find(t => t.token === t2).used === false, `${onDefault.statusCode}`);
  }

  // ── suspension, as the runtime sees it ───────────────────────────────────
  {
    await P.suspendWorkspace(world.deps, { id: 'acme', apply: true });
    W._testing.resetCaches();
    const r = await get(config, 'portal.acme.com');
    check('after suspend, the REAL runtime refuses every request for that client (403)', r.statusCode === 403 && JSON.parse(r.body).error === 'workspace_unavailable');
    await P.resumeWorkspace(world.deps, { id: 'acme', apply: true });
    W._testing.resetCaches();
    check('after resume, it serves again', (await get(config, 'portal.acme.com')).statusCode === 200);
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
