#!/usr/bin/env node
// scripts/test-provision.js
//
// The provisioning logic (scripts/lib/provision.js) against in-memory fake drivers. What is pinned down:
//   - plan mode changes NOTHING
//   - a run that fails half-way resumes without duplicating a tenant or database
//   - unsafe requests are refused (adopting someone else's database, stealing a domain, ...)
//   - nothing goes live until every readiness check passes — including protecting YOUR database
//   - suspension locks both the server and the browser, and a routine redeploy cannot undo it
//   - secrets never appear in any output
//
// Usage: node scripts/test-provision.js   (or: npm test)

const fs = require('fs');
const path = require('path');
const P = require('./lib/provision');
const W = require('../netlify/functions/_lib/workspace');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`\x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n  ' + String(detail).split('\n').join('\n  ') : ''}`); }
}
const rejects = async fn => { try { await fn(); return null; } catch (e) { return e; } };

const { BASE_RULES } = require('./lib/test-world');

const { makeWorld, MUTATING, mutations } = require('./lib/test-world');
const NEW = { id: 'acme', name: 'Acme Rentals', domains: ['portal.acme.com'], adminEmail: 'owner@acme.com', adminName: 'Pat' };
const status = (r, name) => (r.steps.find(s => s.name.startsWith(name)) || {}).status;

(async () => {
  // ── plan mode ────────────────────────────────────────────────────────────
  {
    const { deps, st } = makeWorld();
    const r = await P.createWorkspace(deps, { ...NEW, apply: false });
    check('create WITHOUT --apply changes nothing at all (no registry write, tenant, database, rules, domain or user)', mutations(st).length === 0, JSON.stringify(mutations(st)));
    check('...and reports what it would do', r.ok && r.applied === false && r.steps.some(s => s.status === 'planned') && r.steps.find(s => s.name.startsWith('sign-in pool')).detail.includes('acme'));
    check('...nothing exists afterwards', st.workspaces.size === 0 && st.tenants.size === 0 && !st.databases.has('ws-acme'));
  }

  // ── the happy path ───────────────────────────────────────────────────────
  const happy = makeWorld();
  let created;
  {
    const { deps, st } = happy;
    created = await P.createWorkspace(deps, { ...NEW, apply: true, backups: { retention: '30d', recurrence: 'DAILY' } });
    const ws = st.workspaces.get('acme');
    check('create --apply succeeds and the workspace is left INACTIVE (provisioning)', created.ok && ws.status === 'provisioning');
    check('the runtime itself would accept what was recorded (same validation the server uses)', (() => { try { W.normalizeWorkspace('acme', { ...ws, status: 'provisioning' }); return true; } catch (e) { return e.message; } })() === true);
    check('a tenant was created and its id persisted in the registry', st.tenants.size === 1 && ws.authTenantId === [...st.tenants.keys()][0]);
    check('the database was created in the default database\'s location', st.databases.get('ws-acme') && st.databases.get('ws-acme').locationId === 'nam5');
    const dry = st.rules.filter(x => x.databaseId === 'ws-acme' && x.dryRun), real = st.rules.filter(x => x.databaseId === 'ws-acme' && !x.dryRun);
    check('rules were compile-checked BEFORE the real deployment, and deployed once', dry.length === 1 && real.length === 1 && st.calls.findIndex(c => c[0] === 'rules.dryRun') < st.calls.findIndex(c => c[0] === 'rules.deploy'));
    check('the deployed rules are scoped to THIS tenant (not the plain rules)', real[0].text.includes(`request.auth.token.firebase.tenant == '${ws.authTenantId}'`) && !/allow read:\s*if request\.auth != null;/.test(real[0].text));
    check('the rules hash and tenant are recorded (so drift can be detected)', ws.rulesState === 'scoped' && ws.rulesTenant === ws.authTenantId && /^[0-9a-f]{64}$/.test(ws.rulesHash));
    check('the domain is registered to the workspace', st.domains.get('portal.acme.com') === 'acme' && ws.primaryDomain === 'portal.acme.com');
    check('the domain was added to Firebase Auth\'s authorized domains, keeping the existing ones', st.authorized.includes('portal.acme.com') && st.authorized.includes('rentbay.netlify.app') && st.authorized.includes('localhost'));
    check('site settings were seeded with the client\'s name', st.docs.get('ws-acme/settings/site').siteName === 'Acme Rentals');
    const uid = `uid-${ws.authTenantId}-1`; const admin = st.docs.get(`ws-acme/admins/${uid}`); const tok = st.colls.get('ws-acme/adminInviteTokens')[0];
    check('the first admin exists IN THE CLIENT\'S TENANT, with the app\'s own invite shape (role, status "invited")', st.users.get(ws.authTenantId).get('owner@acme.com') === uid && admin.role === 'super_admin' && admin.status === 'invited' && admin.allowedCountry === null && admin.email === 'owner@acme.com');
    check('...with an unused, expiring activation token for that user', tok.uid === uid && tok.used === false && tok.role === 'super_admin' && tok.expiresAt > deps.now() && tok.token === 'tok1');
    check('the activation link points at the CLIENT\'S domain and the app\'s own activation endpoint', created.data.activationUrl === 'https://portal.acme.com/api/activate-admin-invite?token=tok1');
    check('a backup schedule was created for the workspace database', st.schedules.get('ws-acme').length === 1 && st.schedules.get('ws-acme')[0].retention === '30d');
    check('it tells the operator the manual steps that remain (domain last, then activate)', created.next.some(n => /LAST/.test(n)) && created.next.some(n => /activate acme/.test(n)));
    const order = ['registry.upsert', 'tenants.create', 'databases.create', 'rules.deploy', 'registry.setDomain', 'authDomains.add', 'workspaceDb.setDoc', 'users.ensure', 'backups.create'].map(op => st.calls.findIndex(c => c[0] === op));
    check('steps run in a safe order: record, tenant, database, rules, domains, authorized domains, seed, admin, backups', order.every(i => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), order.join());
  }

  // ── re-running is a no-op ────────────────────────────────────────────────
  {
    const { deps, st } = happy; st.calls.length = 0;
    const r = await P.createWorkspace(deps, { ...NEW, apply: true, backups: { retention: '30d', recurrence: 'DAILY' } });
    const writes = mutations(st).filter(c => !['users.ensure', 'workspaceDb.setDoc'].includes(c[0]));
    check('running create again changes nothing (idempotent: no second tenant, database, rules deploy, domain or backup)', r.ok && writes.length === 0 && st.tenants.size === 1, JSON.stringify(writes));
    check('...and it reuses the unused activation link instead of minting another', st.colls.get('ws-acme/adminInviteTokens').length === 1);
  }

  // ── resuming after a failure ─────────────────────────────────────────────
  {
    const { deps, st } = makeWorld();
    st.fail.rulesDeploy = true;
    const e = await rejects(() => P.createWorkspace(deps, { ...NEW, apply: true }));
    const ws = st.workspaces.get('acme');
    check('a failure part-way stops with a clear error naming the step, and shows what had been done', !!e && /security rules/.test(e.message) && e.steps.some(s => s.status === 'done') && e.steps.some(s => s.status === 'failed'));
    check('...the workspace is still INACTIVE (never served half-built)', ws.status === 'provisioning');
    check('...and the tenant id was saved the moment it existed', st.tenants.size === 1 && ws.authTenantId);
    st.fail.rulesDeploy = false;
    const r = await P.createWorkspace(deps, { ...NEW, apply: true });
    check('re-running resumes: finishes, with exactly ONE tenant and ONE database (nothing duplicated)', r.ok && st.tenants.size === 1 && st.calls.filter(c => c[0] === 'databases.create').length === 1);
  }

  // ── refusals ─────────────────────────────────────────────────────────────
  {
    const attempt = async (name, o, setup, re) => {
      const { deps, st } = makeWorld({ defaultHosts: ['admin.mine.com'] }); if (setup) setup(st, deps);
      const e = await rejects(() => P.createWorkspace(deps, { ...NEW, apply: true, ...o }));
      check(`refuses ${name}`, !!e && re.test(e.message) && mutations(st).length === 0, e ? `${e.message} | mutations: ${mutations(st).length}` : 'did not refuse');
    };
    await attempt('a reserved or malformed id', { id: 'admin' }, null, /invalid workspace id/i);
    await attempt('a too-short id', { id: 'ab' }, null, /invalid workspace id/i);
    await attempt('a domain ending in .netlify.app (the runtime treats it as the default workspace)', { domains: ['acme.netlify.app'] }, null, /netlify\.app/);
    await attempt('a domain listed in DEFAULT_WORKSPACE_HOSTS', { domains: ['admin.mine.com'] }, null, /DEFAULT_WORKSPACE_HOSTS/);
    await attempt('an invalid hostname', { domains: ['not a host'] }, null, /not a valid hostname/);
    await attempt('an IP address as a domain', { domains: ['10.0.0.1'] }, null, /not a valid hostname/);
    await attempt('no domain', { domains: [] }, null, /at least one --domain/);
    await attempt('a missing name', { name: '' }, null, /--name is required/);
    await attempt('an invalid admin email', { adminEmail: 'nope' }, null, /not a valid email/);
    await attempt('a domain that already belongs to another workspace', {}, st => { st.domains.set('portal.acme.com', 'other'); }, /already belongs to workspace "other"/);
    await attempt('a workspace that already exists and is active', {}, st => { st.workspaces.set('acme', { status: 'active', databaseId: 'ws-acme' }); }, /already exists and is "active"/);
    await attempt('a record whose database id does not match', {}, st => { st.workspaces.set('acme', { status: 'provisioning', databaseId: 'ws-other' }); }, /expected "ws-acme"/);
    await attempt('adopting a database it did not create', {}, st => { st.databases.set('ws-acme', { locationId: 'nam5' }); }, /refusing to adopt/);
    await attempt('a registry that names a tenant that does not exist', {}, st => { st.workspaces.set('acme', { status: 'provisioning', databaseId: 'ws-acme', authTenantId: 'ghost-12345' }); }, /does not exist in Identity Platform/);
  }
  {
    const { deps, st } = makeWorld(); st.badTenantId = 'bad id!';
    const e = await rejects(() => P.createWorkspace(deps, { ...NEW, apply: true }));
    check('refuses a tenant id the runtime would reject (and stops before creating a database)', !!e && !st.databases.has('ws-acme'));
  }
  {
    const { deps, st } = makeWorld(); st.dropDomains = true;
    const e = await rejects(() => P.createWorkspace(deps, { ...NEW, apply: true }));
    check('if adding an authorized domain would DROP existing ones, it stops and says so loudly', !!e && /DOMAINS WERE LOST/.test(e.message), e && e.message);
  }
  {
    const { deps, st } = makeWorld(); st.fail.rulesDry = true;
    const e = await rejects(() => P.createWorkspace(deps, { ...NEW, apply: true }));
    check('rules that do not compile are never released, and no rules hash is recorded', !!e && !st.rules.some(r => !r.dryRun && r.databaseId === 'ws-acme') && !st.workspaces.get('acme').rulesHash);
  }

  // ── activation ───────────────────────────────────────────────────────────
  {
    const w = makeWorld();
    await P.createWorkspace(w.deps, { ...NEW, apply: true });
    let e = await rejects(() => P.activateWorkspace(w.deps, { id: 'acme', apply: true }));
    check('activate refuses until YOUR OWN database is protected against client users', !!e && /not been protected yet/.test(e.message) && w.st.workspaces.get('acme').status === 'provisioning', e && e.message);
    await P.protectDefault(w.deps, { apply: true });
    const plan = await P.activateWorkspace(w.deps, { id: 'acme', apply: false });
    check('activate WITHOUT --apply only reports; the status does not change', plan.applied === false && w.st.workspaces.get('acme').status === 'provisioning');
    const r = await P.activateWorkspace(w.deps, { id: 'acme', apply: true });
    check('once everything is in place, activate makes it live', r.ok && w.st.workspaces.get('acme').status === 'active');
    check('the runtime accepts the active record (an active workspace must have its own sign-in pool)', (() => { try { return W.normalizeWorkspace('acme', w.st.workspaces.get('acme')).status === 'active'; } catch (x) { return x.message; } })() === true);
    check('activating twice is harmless', (await P.activateWorkspace(w.deps, { id: 'acme', apply: true })).ok);

    const gaps = [
      ['the rules were never deployed', st => { delete st.workspaces.get('acme').rulesHash; }, /rules for this workspace have not been deployed/],
      ['the rules are for a different tenant', st => { st.workspaces.get('acme').rulesTenant = 'other-99999'; }, /different tenant/],
      ['the tenant is gone', st => { st.tenants.clear(); }, /does not exist/],
      ['the database is gone', st => { st.databases.delete('ws-acme'); }, /database ws-acme does not exist/],
      ['a domain is not registered', st => { st.domains.delete('portal.acme.com'); }, /not registered to this workspace/],
      ['a domain is not authorized in Firebase Auth', st => { st.authorized = st.authorized.filter(d => d !== 'portal.acme.com'); }, /not an authorized domain/],
    ];
    for (const [label, mutate, re] of gaps) {
      const x = makeWorld(); await P.createWorkspace(x.deps, { ...NEW, apply: true }); await P.protectDefault(x.deps, { apply: true }); mutate(x.st);
      const err = await rejects(() => P.activateWorkspace(x.deps, { id: 'acme', apply: true }));
      check(`activate refuses when ${label}`, !!err && re.test(err.message) && x.st.workspaces.get('acme').status === 'provisioning', err && err.message);
    }
    const susp = makeWorld(); await P.createWorkspace(susp.deps, { ...NEW, apply: true }); susp.st.workspaces.get('acme').status = 'suspended';
    check('activate refuses a suspended workspace (that is what resume is for)', /resume/.test((await rejects(() => P.activateWorkspace(susp.deps, { id: 'acme', apply: true }))).message));
  }

  // ── suspend and resume ───────────────────────────────────────────────────
  {
    const w = makeWorld(); await P.createWorkspace(w.deps, { ...NEW, apply: true }); await P.protectDefault(w.deps, { apply: true }); await P.activateWorkspace(w.deps, { id: 'acme', apply: true });
    const plan = await P.suspendWorkspace(w.deps, { id: 'acme', apply: false });
    check('suspend without --apply only reports', plan.applied === false && w.st.workspaces.get('acme').status === 'active');
    await P.suspendWorkspace(w.deps, { id: 'acme', apply: true });
    const ws = w.st.workspaces.get('acme'); const last = w.st.rules.filter(r => r.databaseId === 'ws-acme' && !r.dryRun).pop();
    check('suspend blocks the SERVER (status) and the BROWSER (deny-all rules) — a still-valid session token gets nothing', ws.status === 'suspended' && ws.rulesState === 'deny-all' && /if false/.test(last.text) && !/request\.auth/.test(last.text));
    check('the runtime refuses a suspended workspace', (() => { try { return W.normalizeWorkspace('acme', ws).status; } catch (x) { return x.message; } })() === 'suspended');

    const rd = await P.deployRules(w.deps, { all: true, apply: true });
    const afterCi = w.st.rules.filter(r => r.databaseId === 'ws-acme' && !r.dryRun).pop();
    check('a routine rules redeploy (what CI does) does NOT re-open a suspended workspace', rd.ok && /if false/.test(afterCi.text) && w.st.workspaces.get('acme').rulesState === 'deny-all');

    w.st.fail.rulesDeploy = 'ws-acme';
    const e = await rejects(() => P.resumeWorkspace(w.deps, { id: 'acme', apply: true }));
    check('if the scoped rules cannot be restored, resume stops and the workspace STAYS suspended', !!e && w.st.workspaces.get('acme').status === 'suspended');
    w.st.fail.rulesDeploy = false;
    await P.resumeWorkspace(w.deps, { id: 'acme', apply: true });
    const back = w.st.rules.filter(r => r.databaseId === 'ws-acme' && !r.dryRun).pop();
    check('resume restores the tenant-scoped rules FIRST, then goes live', w.st.workspaces.get('acme').status === 'active' && w.st.workspaces.get('acme').rulesState === 'scoped' && back.text.includes('request.auth.token.firebase.tenant'));
    check('resume refuses a workspace that is not suspended', !!(await rejects(() => P.resumeWorkspace(w.deps, { id: 'acme', apply: true }))));

    const w2 = makeWorld(); await P.createWorkspace(w2.deps, { ...NEW, apply: true }); w2.st.fail.rulesDeploy = 'ws-acme';
    const e2 = await rejects(() => P.suspendWorkspace(w2.deps, { id: 'acme', apply: true }));
    check('if the deny-all rules cannot be deployed, suspend says the browser is still reachable and how to retry', !!e2 && /browsers may still reach/.test(e2.message) && /suspend acme --apply/.test(e2.message) && w2.st.workspaces.get('acme').status === 'suspended');
  }

  // ── rules for many databases ─────────────────────────────────────────────
  {
    const w = makeWorld();
    for (const [id, d] of [['acme', NEW], ['beta', { ...NEW, id: 'beta', name: 'Beta PM', domains: ['beta.example.org'], adminEmail: null }]]) await P.createWorkspace(w.deps, { ...d, apply: true });
    w.st.workspaces.set('bare', { name: 'Bare', databaseId: 'ws-bare', status: 'provisioning' }); // no tenant
    w.st.workspaces.get('beta').status = 'suspended';
    w.st.rules.length = 0; w.st.calls.length = 0;

    const planned = await P.deployRules(w.deps, { all: true, apply: false });
    check('deploy-rules without --apply releases nothing', planned.ok && !w.st.rules.length && planned.steps.some(s => s.status === 'planned'));
    const checked = await P.deployRules(w.deps, { all: true, check: true });
    check('deploy-rules --check only compiles (dry run), releases nothing', checked.ok && w.st.rules.length === 2 && w.st.rules.every(r => r.dryRun));
    w.st.rules.length = 0;
    const done = await P.deployRules(w.deps, { all: true, includePlatform: true, apply: true });
    const real = w.st.rules.filter(r => !r.dryRun);
    check('--all: each workspace gets its OWN tenant\'s rules; a suspended one gets deny-all; the platform gets deny-all',
      done.ok && real.find(r => r.databaseId === 'ws-acme').text.includes(w.st.workspaces.get('acme').authTenantId) && /if false/.test(real.find(r => r.databaseId === 'ws-beta').text) && /if false/.test(real.find(r => r.databaseId === 'platform').text));
    check('a workspace with no sign-in pool yet is skipped, not given rules', !real.some(r => r.databaseId === 'ws-bare') && done.steps.find(s => s.name === 'bare').status === 'skipped');
    check('one workspace\'s failure does not stop the others, and the run is reported as failed', await (async () => {
      w.st.fail.rulesDeploy = 'ws-acme'; w.st.rules.length = 0;
      const r = await P.deployRules(w.deps, { all: true, apply: true });
      return !r.ok && r.failed === 1 && w.st.rules.some(x => x.databaseId === 'ws-beta' && !x.dryRun);
    })());
    w.st.fail.rulesDeploy = false;

    const e = await rejects(() => P.deployRules(w.deps, { includeDefault: true, apply: true }));
    check('deploy-rules --default refuses to be the FIRST time your own rules change (that is protect-default, deliberately)', !!e && /protect-default/.test(e.message));
    await P.protectDefault(w.deps, { apply: true });
    const prot = w.st.rules.filter(r => r.databaseId === '(default)' && !r.dryRun).pop();
    check('protect-default deploys the DEFAULT variant (rejects any tenant\'s users) and records that it happened', /!\('tenant' in request\.auth\.token\.firebase\)/.test(prot.text) && !!w.st.platform.defaultRulesDeployedAt);
    w.st.rules.length = 0;
    const again = await P.deployRules(w.deps, { includeDefault: true, apply: true });
    check('...after which deploy-rules --default (CI) may redeploy it', again.ok && w.st.rules.some(r => r.databaseId === '(default)' && !r.dryRun));
    const plain = await P.protectDefault(makeWorld().deps, { apply: false });
    check('protect-default without --apply deploys nothing', plain.applied === false);
  }

  // ── one-time platform setup ──────────────────────────────────────────────
  {
    const w = makeWorld({ platformDb: false });
    const plan = await P.initPlatform(w.deps, { apply: false });
    check('init without --apply creates nothing', plan.applied === false && !w.st.databases.has('platform'));
    await P.initPlatform(w.deps, { apply: true });
    check('init creates the platform database and gives it deny-all rules', w.st.databases.has('platform') && /if false/.test(w.st.rules.filter(r => r.databaseId === 'platform' && !r.dryRun).pop().text));
    w.st.calls.length = 0; await P.initPlatform(w.deps, { apply: true });
    check('init is idempotent (does not create the database twice)', !w.st.calls.some(c => c[0] === 'databases.create'));
    const x = makeWorld({ platformDb: false }); x.st.fail.probe = 'multi-tenancy is not enabled';
    const e = await rejects(() => P.initPlatform(x.deps, { apply: true }));
    check('init stops first if multi-tenancy is not enabled, before creating anything', !!e && /not enabled/.test(e.message) && !x.st.databases.has('platform'));
  }

  // ── status ───────────────────────────────────────────────────────────────
  {
    const w = makeWorld(); await P.createWorkspace(w.deps, { ...NEW, apply: true, backups: { retention: '30d', recurrence: 'DAILY' } });
    let s = await P.workspaceStatus(w.deps, {});
    check('status flags that your own database is not yet protected', s.platform.defaultProtected === false && s.platform.issues.length === 1 && !s.ok);
    await P.protectDefault(w.deps, { apply: true });
    s = await P.workspaceStatus(w.deps, { id: 'acme' });
    check('a healthy workspace reports no issues', s.ok && s.rows[0].issues.length === 0 && s.rows[0].backups === 1 && s.rows[0].tenant, JSON.stringify(s.rows[0].issues));
    const drift = { ...w.deps, baseRules: BASE_RULES + '\n// a later edit to the rules\nfunction x() { return request.auth != null; }\n' };
    s = await P.workspaceStatus(drift, { id: 'acme' });
    check('status detects rules drift: firestore.rules changed since they were deployed', s.rows[0].issues.some(i => /OUT OF DATE/.test(i)));
    w.st.databases.delete('ws-acme'); w.st.authorized = w.st.authorized.filter(d => d !== 'portal.acme.com'); w.st.domains.clear();
    s = await P.workspaceStatus(w.deps, { id: 'acme' });
    check('status reports a missing database, an unregistered domain and an unauthorized domain', ['database ws-acme missing', 'not registered', 'not authorized'].every(t => s.rows[0].issues.some(i => i.includes(t))));
    check('status of a workspace that does not exist is an error', !!(await rejects(() => P.workspaceStatus(w.deps, { id: 'nope' }))));
    const nb = makeWorld(); await P.createWorkspace(nb.deps, { ...NEW, apply: true });
    check('a database with no backup schedule is flagged', (await P.workspaceStatus(nb.deps, { id: 'acme' })).rows[0].issues.includes('no backup schedule'));
  }

  // ── secrets ──────────────────────────────────────────────────────────────
  {
    const w = makeWorld(); await P.createWorkspace(w.deps, { ...NEW, apply: true });
    const SECRET = 'sk_live_SUPER_SECRET_VALUE_123';
    const plan = await P.setSecret(w.deps, { id: 'acme', key: 'STRIPE_SECRET_KEY', value: SECRET, apply: false });
    check('set-secret without --apply stores nothing', plan.applied === false && !w.st.secrets.has('acme'));
    const r = await P.setSecret(w.deps, { id: 'acme', key: 'STRIPE_SECRET_KEY', value: `  ${SECRET}\n`, apply: true });
    check('set-secret stores the (trimmed) value', w.st.secrets.get('acme').STRIPE_SECRET_KEY === SECRET);
    check('the value appears NOWHERE in the result, the plan, or the listing — only its name and length', !JSON.stringify([plan, r, await P.listSecrets(w.deps, { id: 'acme' })]).includes(SECRET) && r.steps[0].detail.includes(String(SECRET.length)));
    const refused = await Promise.all(['FIREBASE_SERVICE_ACCOUNT', 'NETLIFY_API_TOKEN', 'SMTP_PASS', 'NOPE'].map(k => rejects(() => P.setSecret(w.deps, { id: 'acme', key: k, value: 'x', apply: true }))));
    check('refuses a key that is not a per-workspace setting (platform secrets and mail passwords cannot be set this way)', refused.every(Boolean) && !w.st.secrets.get('acme').FIREBASE_SERVICE_ACCOUNT && !w.st.secrets.get('acme').SMTP_PASS);
    check('refuses an empty or oversized value, and an unknown workspace', !!(await rejects(() => P.setSecret(w.deps, { id: 'acme', key: 'SITE_NAME', value: '  ', apply: true }))) && !!(await rejects(() => P.setSecret(w.deps, { id: 'acme', key: 'SITE_NAME', value: 'x'.repeat(5000), apply: true }))) && !!(await rejects(() => P.setSecret(w.deps, { id: 'ghost', key: 'SITE_NAME', value: 'x', apply: true }))));
    const accepted = [];
    for (const k of W.SECRET_KEYS) { if (!(await rejects(() => P.setSecret(w.deps, { id: 'acme', key: k, value: 'x', apply: false })))) accepted.push(k); }
    check(`every one of the runtime's ${W.SECRET_KEYS.length} per-workspace settings can be set (one shared list, so the two cannot drift)`, accepted.length === W.SECRET_KEYS.length, W.SECRET_KEYS.filter(k => !accepted.includes(k)).join());
    await P.unsetSecret(w.deps, { id: 'acme', key: 'STRIPE_SECRET_KEY', apply: true });
    check('unset removes it', (await P.listSecrets(w.deps, { id: 'acme' })).keys.length === 0);
  }

  // ── backups for existing databases ───────────────────────────────────────
  {
    const w = makeWorld(); await P.createWorkspace(w.deps, { ...NEW, apply: true });
    const plan = await P.ensureBackups(w.deps, { all: true, retention: '30d', recurrence: 'DAILY', apply: false });
    check('backups without --apply creates nothing', !w.st.schedules.size && plan.steps.every(s => s.status === 'planned'));
    await P.ensureBackups(w.deps, { all: true, retention: '30d', recurrence: 'DAILY', pitr: true, apply: true });
    check('backups: your default database, the platform database and every workspace get a schedule', ['(default)', 'platform', 'ws-acme'].every(d => (w.st.schedules.get(d) || []).length === 1));
    check('...and point-in-time recovery is enabled where asked', ['(default)', 'platform', 'ws-acme'].every(d => w.st.databases.get(d).pitr));
    w.st.calls.length = 0; await P.ensureBackups(w.deps, { all: true, retention: '30d', recurrence: 'DAILY', pitr: true, apply: true });
    check('re-running creates no duplicate schedules', !w.st.calls.some(c => c[0] === 'backups.create' || c[0] === 'databases.setPitr'));
  }

  // ── inviting admins ──────────────────────────────────────────────────────
  {
    const w = makeWorld(); await P.createWorkspace(w.deps, { ...NEW, adminEmail: null, apply: true });
    const plan = await P.inviteAdmin(w.deps, { id: 'acme', email: 'a@acme.com', apply: false });
    check('invite-admin without --apply writes nothing', plan.planned && !w.st.users.size && !w.st.colls.size);
    const a = await P.inviteAdmin(w.deps, { id: 'acme', email: 'A@Acme.com', name: 'Ann', apply: true });
    const b = await P.inviteAdmin(w.deps, { id: 'acme', email: 'a@acme.com', apply: true });
    check('invite-admin normalises the email, and a second call reuses the unused link', a.userCreated && !b.userCreated && b.reusedInvite && a.activationUrl === b.activationUrl);
    const uid = a.uid; w.st.docs.get(`ws-acme/admins/${uid}`).status = 'active';
    await P.inviteAdmin(w.deps, { id: 'acme', email: 'a@acme.com', apply: true });
    check('an admin who has already activated is never downgraded back to "invited"', w.st.docs.get(`ws-acme/admins/${uid}`).status === 'active');
    w.st.colls.get('ws-acme/adminInviteTokens').forEach(t => { t.used = true; });
    const c = await P.inviteAdmin(w.deps, { id: 'acme', email: 'a@acme.com', apply: true });
    check('once a link is used, the next invite mints a fresh one', !c.reusedInvite && c.activationUrl !== a.activationUrl);
    check('refuses a workspace with no sign-in pool yet, and an invalid email', !!(await rejects(() => P.inviteAdmin(w.deps, { id: 'ghost', email: 'a@b.co', apply: true }))) && !!(await rejects(() => P.inviteAdmin(w.deps, { id: 'acme', email: 'nope', apply: true }))));
  }

  // ── doctor ───────────────────────────────────────────────────────────────
  {
    const healthy = makeWorld(); const ok = await P.doctor(healthy.deps);
    check('doctor passes on a healthy setup (and only reads)', ok.ok && ok.checks.length >= 8 && mutations(healthy.st).length === 0);
    const cases = [
      ['multi-tenancy is off', w => { w.st.fail.probe = 'not enabled'; }, /multi-tenancy/i],
      ['the platform database is missing', w => { w.st.databases.delete('platform'); }, /platform/],
      ['databases cannot be listed', w => { w.deps.databases.list = async () => { throw new Error('permission denied'); }; }, /list Firestore databases/],
    ];
    for (const [label, mutate, re] of cases) {
      const w = makeWorld(); mutate(w); const r = await P.doctor(w.deps); const bad = r.checks.filter(c => !c.ok);
      check(`doctor reports when ${label}, with a way to fix it`, !r.ok && bad.some(c => re.test(c.name)) && bad.every(c => c.hint || c.detail), JSON.stringify(bad.map(c => c.name)));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
