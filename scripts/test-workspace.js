#!/usr/bin/env node
// scripts/test-workspace.js
//
// Behavioural tests for the workspace seam (netlify/functions/_lib/workspace.js)
// and the pieces built on it. Uses the real firebase-admin (no network: handles
// are only constructed, never read) and in-memory fakes for the registry.
//
// Usage: node scripts/test-workspace.js   (or: npm test)

const Module = require('module');
const path = require('path');
const admin = require('firebase-admin');

admin.initializeApp({ projectId: 'demo-project' }); // so workspace.js never needs a service account

// ── stub @netlify/blobs so store naming can be observed ─────────────────────
const storeCalls = [];
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === '@netlify/blobs') return { getStore: opts => { storeCalls.push(opts); return { opts }; } };
  return origLoad.call(this, req, ...rest);
};

const LIB = path.resolve(__dirname, '../netlify/functions/_lib');
const W = require(path.join(LIB, 'workspace'));

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`\x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n  ' + detail : ''}`); }
}
async function throws(fn) { try { await fn(); return null; } catch (e) { return e; } }

// ── fake registry (counts reads so "never consulted" is provable) ───────────
function makeRegistry(workspaces, { failLookup = false, failList = false } = {}) {
  const reg = { lookups: 0, lists: 0,
    async lookupDomain(host) {
      reg.lookups++;
      if (failLookup) throw new Error('registry unavailable');
      const ws = workspaces.find(w => w.domains.includes(host));
      return ws ? W._testing.normalizeWorkspace(ws.id, ws) : null;
    },
    async loadSecrets() { return {}; },
    async listActive() {
      reg.lists++;
      if (failList) throw new Error('registry unavailable');
      return workspaces.filter(w => w.status === 'active').map(w => W._testing.normalizeWorkspace(w.id, w));
    } };
  return reg;
}
const ACME  = { id: 'acme',  name: 'Acme Rentals', databaseId: 'ws-acme',  status: 'active',       domains: ['portal.acme.com', 'acme.rentbay.app'] };
const BETA  = { id: 'beta',  name: 'Beta PM',      databaseId: 'ws-beta',  status: 'active',       domains: ['beta.rentbay.app'] };
const GONE  = { id: 'gamma', name: 'Gamma',        databaseId: 'ws-gamma', status: 'suspended',    domains: ['gamma.rentbay.app'] };
const NEW   = { id: 'delta', name: 'Delta',        databaseId: 'ws-delta', status: 'provisioning', domains: ['delta.rentbay.app'] };
const ev = host => ({ headers: { host } });
const dbName = db => db.formattedName;

function reset({ flag = 'true', registry } = {}) {
  W._testing.resetCaches(); storeCalls.length = 0;
  if (flag == null) delete process.env.ALLOW_MULTI_WORKSPACE; else process.env.ALLOW_MULTI_WORKSPACE = flag;
  delete process.env.DEFAULT_WORKSPACE_HOSTS; delete process.env.SWEEP_BUDGET_MS; delete process.env.SWEEP_CONCURRENCY;
  process.env.SITE_URL = 'https://rentbay.netlify.app';
  W._testing.setRegistry(registry || makeRegistry([ACME, BETA, GONE, NEW]));
}

(async () => {
  // ── 1. dormant by default ────────────────────────────────────────────────
  {
    const reg = makeRegistry([ACME]); reset({ flag: null, registry: reg });
    const a = await W.resolveWorkspace(ev('portal.acme.com'));
    check('flag OFF: even a registered host resolves to the default workspace', a.isDefault && a.databaseId === '(default)');
    check('flag OFF: registry is never read', reg.lookups === 0 && reg.lists === 0);
    reset({ flag: 'false', registry: reg });
    check('flag set to "false" is OFF too', (await W.resolveWorkspace(ev('portal.acme.com'))).isDefault);
  }

  // ── 2. default hosts never need the registry ─────────────────────────────
  {
    const reg = makeRegistry([ACME]); reset({ registry: reg });
    process.env.DEFAULT_WORKSPACE_HOSTS = 'rentbay.example.com, Admin.Example.com';
    for (const h of ['rentbay.netlify.app', 'deploy-preview-4--rentbay.netlify.app', 'localhost:8888', 'rentbay.example.com', 'admin.example.com:443', '']) {
      const ws = await W.resolveWorkspace(ev(h));
      check(`flag ON: "${h || '(no host)'}" -> default workspace`, ws.isDefault);
    }
    check('flag ON: default hosts resolved without touching the registry', reg.lookups === 0);
  }

  // ── 3. registered hosts ──────────────────────────────────────────────────
  {
    const reg = makeRegistry([ACME, BETA]); reset({ registry: reg });
    const ws = await W.resolveWorkspace(ev('Portal.ACME.com:443'));
    check('registered host (case/port normalised) -> its workspace', ws.id === 'acme' && ws.databaseId === 'ws-acme' && ws.storePrefix === 'ws-acme-' && !ws.isDefault);
    check('workspace siteUrl comes from its own domain, not the deployment env', ws.siteUrl === 'https://portal.acme.com');
    const spoof = await W.resolveWorkspace({ headers: { host: 'beta.rentbay.app', 'x-forwarded-host': 'portal.acme.com' } });
    check('Host wins over a caller-supplied X-Forwarded-Host (cannot pick its own workspace)', spoof.id === 'beta');
    const before = reg.lookups;
    await W.resolveWorkspace(ev('portal.acme.com')); await W.resolveWorkspace(ev('portal.acme.com'));
    check('registry lookups are cached', reg.lookups === before);
  }

  // ── 4. fail closed ───────────────────────────────────────────────────────
  {
    reset();
    let e = await throws(() => W.resolveWorkspace(ev('nobody.example.org')));
    check('unknown host -> 404 unknown_workspace (NOT the default workspace)', e instanceof W.WorkspaceError && e.status === 404);
    e = await throws(() => W.resolveWorkspace(ev('gamma.rentbay.app')));
    check('suspended workspace -> 403', e && e.status === 403);
    e = await throws(() => W.resolveWorkspace(ev('delta.rentbay.app')));
    check('workspace still provisioning -> 403', e && e.status === 403);

    reset({ registry: makeRegistry([ACME], { failLookup: true }) });
    const handler = W.withWorkspace(async () => ({ statusCode: 200, body: 'ran' }));
    const res = await handler(ev('portal.acme.com'));
    check('registry unreadable -> 503, handler not run, no fallback to default', res.statusCode === 503 && res.body.includes('workspace_lookup_failed'));
    const okDefault = await handler(ev('rentbay.netlify.app'));
    check('...while the default workspace keeps working through a registry outage', okDefault.statusCode === 200);

    reset();
    const r404 = await W.withWorkspace(async () => ({ statusCode: 200 }))(ev('nobody.example.org'));
    check('wrapped handler returns the 404 JSON body for an unknown host', r404.statusCode === 404 && JSON.parse(r404.body).error === 'unknown_workspace');
  }

  // ── 5. the database / store handles actually point at the right place ────
  {
    reset();
    check('no workspace context -> getDb() throws (never guesses)', !!(await throws(async () => W.getDb())));
    check('no workspace context -> getWorkspaceStore() throws', !!(await throws(async () => W.getWorkspaceStore({ name: 'documents' }))));

    const seen = {};
    await W.withWorkspace(async () => { seen.def = dbName(W.getDb()); })(ev('rentbay.netlify.app'));
    await W.withWorkspace(async () => { seen.acme = dbName(W.getDb()); })(ev('portal.acme.com'));
    await W.withWorkspace(async () => { seen.beta = dbName(W.getDb()); })(ev('beta.rentbay.app'));
    check('default workspace -> projects/demo-project/databases/(default)', seen.def === 'projects/demo-project/databases/(default)', seen.def);
    check('acme -> databases/ws-acme', seen.acme === 'projects/demo-project/databases/ws-acme', seen.acme);
    check('beta -> databases/ws-beta', seen.beta === 'projects/demo-project/databases/ws-beta', seen.beta);

    await W.withWorkspace(async () => { W.getWorkspaceStore({ name: 'documents', consistency: 'strong', siteID: 'S', token: 'T' }); })(ev('rentbay.netlify.app'));
    await W.withWorkspace(async () => { W.getWorkspaceStore({ name: 'documents', consistency: 'strong', siteID: 'S', token: 'T' }); })(ev('portal.acme.com'));
    check('default workspace keeps the ORIGINAL store name (existing data stays reachable)', storeCalls[0].name === 'documents');
    check('other workspaces get a prefixed store; other options pass through untouched',
      storeCalls[1].name === 'ws-acme-documents' && storeCalls[1].consistency === 'strong' && storeCalls[1].siteID === 'S' && storeCalls[1].token === 'T');
  }

  // ── 6. concurrent requests cannot see each other's workspace ─────────────
  {
    reset();
    const tick = ms => new Promise(r => setTimeout(r, ms));
    const log = [];
    const handler = W.withWorkspace(async (event) => {
      const mine = W.getWorkspace().id;
      await tick(Math.random() * 15);                 // interleave with the others
      await Promise.resolve();
      const after = W.getWorkspace().id;
      const db = dbName(W.getDb());
      log.push({ host: event.headers.host, mine, after, db });
      return { statusCode: 200 };
    });
    const hosts = ['portal.acme.com', 'beta.rentbay.app', 'rentbay.netlify.app'];
    await Promise.all(Array.from({ length: 60 }, (_, i) => handler(ev(hosts[i % 3]))));
    const expect = { 'portal.acme.com': ['acme', 'ws-acme'], 'beta.rentbay.app': ['beta', 'ws-beta'], 'rentbay.netlify.app': ['default', '(default)'] };
    const bad = log.filter(l => l.mine !== expect[l.host][0] || l.after !== expect[l.host][0] || !l.db.endsWith('/databases/' + expect[l.host][1]));
    check(`60 interleaved requests across 3 workspaces: every one kept its own workspace and database (${log.length} ran)`, log.length === 60 && bad.length === 0, JSON.stringify(bad[0]));
  }

  // ── 7. registry data is validated ────────────────────────────────────────
  {
    reset();
    const n = W._testing.normalizeWorkspace;
    const bad = [
      ['reserved id',            () => n('admin',  { databaseId: 'ws-admin' })],
      ['reserved id "default"',  () => n('default', {})],
      ['uppercase id',           () => n('Acme',   {})],
      ['too-short id',           () => n('ab',     {})],
      ['database "(default)"',   () => n('acme',   { databaseId: '(default)' })],
      ['database = platform db', () => n('acme',   { databaseId: 'platform' })],
      ['database with spaces',   () => n('acme',   { databaseId: 'my db' })],
    ];
    for (const [label, fn] of bad) check(`rejects ${label}`, (await throws(async () => fn())) instanceof W.WorkspaceError);
    const ok = n('acme', { domains: ['A.com:80'], primaryDomain: 'portal.A.com' });
    check('derives databaseId "ws-<id>", lowercases domains, honours primaryDomain', ok.databaseId === 'ws-acme' && ok.domains[0] === 'a.com' && ok.siteUrl === 'https://portal.a.com');
  }

  // ── 8. cache is bounded against Host flooding ────────────────────────────
  {
    const reg = makeRegistry([ACME]); reset({ registry: reg });
    for (let i = 0; i < 700; i++) await throws(() => W.resolveWorkspace(ev(`junk${i}.example.org`)));
    const ws = await W.resolveWorkspace(ev('portal.acme.com'));
    check('700 junk hosts later, a real workspace still resolves (cache bounded, not poisoned)', ws.id === 'acme');
  }

  // ── 9. scheduled functions ───────────────────────────────────────────────
  {
    const reg = makeRegistry([ACME, BETA, GONE]); reset({ flag: null, registry: reg });
    const seen = [];
    const inner = async () => { seen.push(W.getWorkspace().id); return { statusCode: 200, body: JSON.stringify({ invoicesGenerated: 3 }) }; };
    let out = await W.withEachWorkspace(inner)({}, {});
    check('flag OFF: scheduled fn runs once, for default, result returned UNCHANGED', seen.join() === 'default' && out.body === '{"invoicesGenerated":3}' && reg.lists === 0);

    seen.length = 0; reset({ registry: reg });
    out = await W.withEachWorkspace(inner)({}, {});
    check('flag ON: runs for default + every ACTIVE workspace (suspended skipped), in order', seen.join() === 'default,acme,beta', seen.join());
    check('flag ON: all succeeded -> 200 with per-workspace results', out.statusCode === 200 && Object.keys(JSON.parse(out.body).workspaces).join() === 'default,acme,beta');

    seen.length = 0;
    const flaky = async () => { const id = W.getWorkspace().id; seen.push(id); if (id === 'acme') throw new Error('acme exploded'); return { statusCode: 200, body: '{}' }; };
    out = await W.withEachWorkspace(flaky)({}, {});
    const r = JSON.parse(out.body).workspaces;
    check('one workspace throwing does not stop the others, and the run is reported as failed (500)',
      seen.join() === 'default,acme,beta' && out.statusCode === 500 && r.acme.statusCode === 500 && r.beta.statusCode === 200 && r.default.statusCode === 200);

    const soft = async () => ({ statusCode: W.getWorkspace().id === 'beta' ? 500 : 200, body: '{}' });
    out = await W.withEachWorkspace(soft)({}, {});
    check('a handler RETURNING 500 for one workspace also fails the run', out.statusCode === 500);

    process.env.SWEEP_BUDGET_MS = '20'; process.env.SWEEP_CONCURRENCY = '1'; seen.length = 0;
    const slow = async () => { seen.push(W.getWorkspace().id); await new Promise(r => setTimeout(r, 40)); return { statusCode: 200, body: '{}' }; };
    out = await W.withEachWorkspace(slow)({}, {});
    const rb = JSON.parse(out.body).workspaces;
    check('time budget (one at a time): remaining workspaces are skipped LOUDLY (500), not silently dropped',
      seen.join() === 'default' && out.statusCode === 500 && /budget/.test(rb.acme.error) && /budget/.test(rb.beta.error), JSON.stringify(rb));

    process.env.SWEEP_CONCURRENCY = '2'; seen.length = 0;
    out = await W.withEachWorkspace(slow)({}, {});
    const rc = JSON.parse(out.body).workspaces;
    check('time budget (2 slots, 3 workspaces): the two that started finish, the one still waiting is skipped loudly',
      seen.length === 2 && out.statusCode === 500 && Object.values(rc).filter(x => /budget/.test(x.error || '')).length === 1, JSON.stringify(rc));

    process.env.SWEEP_BUDGET_MS = '5000'; process.env.SWEEP_CONCURRENCY = '4'; seen.length = 0;
    out = await W.withEachWorkspace(slow)({}, {});
    check('with the default parallelism all three workspaces start together and all succeed', seen.length === 3 && out.statusCode === 200);
    delete process.env.SWEEP_BUDGET_MS; delete process.env.SWEEP_CONCURRENCY;

    reset({ registry: makeRegistry([ACME], { failList: true }) }); seen.length = 0;
    out = await W.withEachWorkspace(inner)({}, {});
    check('registry unreadable during a sweep: default still runs, run reported failed', seen.join() === 'default' && out.statusCode === 500);
  }

  //__INTEGRATION_SECTIONS__

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
