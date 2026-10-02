#!/usr/bin/env node
// scripts/test-auth.js
//
// getAuth() — per-workspace sign-in — tested against the REAL firebase-admin classes.
// Only the JWT signature check is replaced (it needs Google's public keys, i.e. network);
// everything else, including the SDK's own tenant check, is the genuine code. That matters
// because the design rests on two facts about the SDK, which these tests pin down so a future
// SDK upgrade that changes either one is noticed:
//
//   1. a tenant-aware Auth rejects a token from any other tenant, but
//   2. the project-level Auth accepts a token from ANY tenant.
//
// Usage: node scripts/test-auth.js   (or: npm test)

const path = require('path');
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'demo-project' }); // no service account needed: nothing here touches the network

const LIB = path.resolve(__dirname, '../netlify/functions/_lib');
const W = require(path.join(LIB, 'workspace'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`\x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n  ' + String(detail).split('\n').join('\n  ') : ''}`); }
}
const throws = async fn => { try { await fn(); return null; } catch (e) { return e; } };
const tick = ms => new Promise(r => setTimeout(r, ms));

const TENANT_A = 'acme-t1abc', TENANT_B = 'beta-t2def';
const ACME = W._testing.normalizeWorkspace('acme', { status: 'active', authTenantId: TENANT_A, domains: ['portal.acme.com'] });
const BETA = W._testing.normalizeWorkspace('beta', { status: 'active', authTenantId: TENANT_B, domains: ['beta.example.org'] });
const DEF = W._testing.defaultWorkspace();

// Replace ONLY the signature check, on the real instances, so a token's claims are whatever we say.
let claims = null;
const forgeSignatureCheck = auth => { auth.idTokenVerifier = { verifyJWT: async () => claims }; };
const base = admin.auth();
forgeSignatureCheck(base);
forgeSignatureCheck(base.tenantManager().authForTenant(TENANT_A));
forgeSignatureCheck(base.tenantManager().authForTenant(TENANT_B));
const tokenIn = tenant => ({ uid: 'u1', sub: 'u1', firebase: { sign_in_provider: 'password', ...(tenant ? { tenant } : {}) } });
const verifyIn = (ws, tenant) => { claims = tokenIn(tenant); return W.runWithWorkspace(ws, () => W.getAuth().verifyIdToken('any-token')); };

(async () => {
  // ── the two SDK facts the design depends on ──────────────────────────────
  {
    claims = tokenIn(TENANT_A);
    const projectLevel = await throws(() => base.verifyIdToken('t'));
    check('SDK fact 1: the PROJECT-LEVEL Auth accepts a token that belongs to a tenant (this is the hole getAuth() closes)', projectLevel === null);
    const e = await throws(() => base.tenantManager().authForTenant(TENANT_B).verifyIdToken('t'));
    check('SDK fact 2: a tenant-aware Auth rejects a token from another tenant', !!e && /mismatching-tenant-id/.test(e.code || ''), e && e.code);
    claims = tokenIn(null);
    const e2 = await throws(() => base.tenantManager().authForTenant(TENANT_A).verifyIdToken('t'));
    check('...and rejects a token that has no tenant at all', !!e2 && /mismatching-tenant-id/.test(e2.code || ''));
  }

  // ── every Auth method the app uses exists on a tenant-aware Auth ─────────
  {
    const tenantAuth = base.tenantManager().authForTenant(TENANT_A);
    const used = ['verifyIdToken', 'createUser', 'getUserByEmail', 'getUser', 'updateUser', 'createCustomToken', 'generatePasswordResetLink', 'setCustomUserClaims'];
    const missing = used.filter(m => typeof tenantAuth[m] !== 'function');
    check(`the installed SDK's tenant-aware Auth provides all ${used.length} methods the server uses`, missing.length === 0, missing.join(', '));
    check('...and knows its tenant', tenantAuth.tenantId === TENANT_A);
  }

  // ── getAuth(): the right pool per workspace ──────────────────────────────
  {
    let defHasTenant, acmeTenant, betaTenant;
    await W.runWithWorkspace(DEF, async () => { defHasTenant = W.getAuth().tenantId; });
    await W.runWithWorkspace(ACME, async () => { acmeTenant = W.getAuth().tenantId; });
    await W.runWithWorkspace(BETA, async () => { betaTenant = W.getAuth().tenantId; });
    check('default workspace -> the project-level pool (no tenant)', defHasTenant === undefined);
    check('acme -> its own tenant; beta -> its own tenant', acmeTenant === TENANT_A && betaTenant === TENANT_B);
    check('outside a request there is no pool to guess: getAuth() throws', !!(await throws(async () => W.getAuth())));
    const noPool = Object.freeze({ id: 'orphan', isDefault: false, authTenantId: null, databaseId: 'ws-orphan' });
    check('a non-default workspace with no sign-in pool cannot authenticate anyone (fails closed)', !!(await W.runWithWorkspace(noPool, async () => throws(async () => W.getAuth()))));
  }

  // ── tokens are accepted only in the pool they came from ──────────────────
  {
    check('default workspace accepts a project-level token', (await throws(() => verifyIn(DEF, null))) === null);
    let e = await throws(() => verifyIn(DEF, TENANT_A));
    check('default workspace REJECTS a token from acme\'s pool (a client\'s user cannot act in the platform owner\'s workspace)', !!e && e.code === 'auth/mismatching-tenant-id', e && e.message);
    check('acme accepts a token from its own pool', (await throws(() => verifyIn(ACME, TENANT_A))) === null);
    e = await throws(() => verifyIn(ACME, TENANT_B));
    check('acme REJECTS a token from beta\'s pool', !!e && /mismatching-tenant-id/.test(e.code || ''), e && e.code);
    e = await throws(() => verifyIn(ACME, null));
    check('acme REJECTS a token from the platform\'s own pool', !!e && /mismatching-tenant-id/.test(e.code || ''), e && e.code);
    claims = tokenIn(TENANT_A); claims.firebase.tenant = undefined;
    e = await throws(() => W.runWithWorkspace(ACME, () => W.getAuth().verifyIdToken('t')));
    check('a token whose tenant claim is empty is treated as having none', !!e);
    claims = { uid: 'u1', sub: 'u1' }; // no firebase claim at all
    e = await throws(() => W.runWithWorkspace(ACME, () => W.getAuth().verifyIdToken('t')));
    check('a token with no firebase claim at all is rejected by a tenant workspace', !!e);
    claims = { uid: 'u1', sub: 'u1' };
    check('...and accepted as project-level by the default workspace', (await throws(() => W.runWithWorkspace(DEF, () => W.getAuth().verifyIdToken('t')))) === null);
  }

  // ── the wrapper changes nothing else ─────────────────────────────────────
  {
    let ok = true, ctx = null;
    await W.runWithWorkspace(ACME, async () => {
      const a = W.getAuth();
      ok = typeof a.createUser === 'function' && typeof a.createCustomToken === 'function' && typeof a.generatePasswordResetLink === 'function';
      ctx = a.tenantId;
    });
    check('other Auth methods pass straight through to the tenant-aware Auth (bound, so they keep working)', ok && ctx === TENANT_A);
    // Offline and deterministic: the SDK validates the address before any network call. Bound -> its own
    // 'auth/invalid-email'; unbound -> a TypeError from `this` being undefined.
    let detached;
    await W.runWithWorkspace(ACME, async () => { const f = W.getAuth().generatePasswordResetLink; detached = await throws(() => f('not-an-email')); });
    check('a method taken off getAuth() and called on its own still works (it is bound to the tenant-aware Auth)', !!detached && detached.code === 'auth/invalid-email', detached && `${detached.name}: ${detached.message}`);
  }

  // ── concurrency ──────────────────────────────────────────────────────────
  {
    const wss = [DEF, ACME, BETA]; const expect = [undefined, TENANT_A, TENANT_B];
    const seen = await Promise.all(Array.from({ length: 90 }, (_, i) => W.runWithWorkspace(wss[i % 3], async () => {
      await tick(Math.random() * 10); await Promise.resolve();
      return { i, tenant: W.getAuth().tenantId };
    })));
    const bad = seen.filter(x => x.tenant !== expect[x.i % 3]);
    check('90 interleaved requests across 3 workspaces: each always got its own pool', bad.length === 0, JSON.stringify(bad[0]));
  }

  // ── workspace records ────────────────────────────────────────────────────
  {
    const n = W._testing.normalizeWorkspace;
    check('an ACTIVE workspace without its own sign-in pool is rejected outright', !!(await throws(async () => n('acme', { status: 'active' }))));
    check('...but one that is still being provisioned may not have one yet', (await throws(async () => n('acme', { status: 'provisioning' }))) === null);
    check('a malformed tenant id (it is written into security rules) is rejected', !!(await throws(async () => n('acme', { status: 'active', authTenantId: "x'; allow read: if true; //" }))));
    check('the default workspace has no tenant', DEF.authTenantId === null);
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
