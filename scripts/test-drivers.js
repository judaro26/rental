#!/usr/bin/env node
// scripts/test-drivers.js
//
// The real drivers (scripts/lib/drivers.js) with the outside world faked: the Firebase CLI (`exec`),
// HTTP (`fetchImpl`) and Firebase itself. These check the EXACT commands and requests that would be made —
// the part that cannot be exercised without credentials — and the properties that keep a real run safe:
//   - nothing sensitive ever reaches a command line
//   - a failed lookup is never mistaken for "it does not exist"
//   - the authorized-domains write cannot drop existing domains
//
// What this CANNOT prove: that Google's services accept these calls. Run `workspace.js doctor`, then a
// plan-only `create`, then a throwaway workspace, before a real client.
//
// Usage: node scripts/test-drivers.js   (or: npm test)

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── a tiny fake Firestore + Admin SDK ───────────────────────────────────────
const DELETE = { __delete: true };
const store = new Map();     // `${db}/${path}` -> data
const writes = [];           // every write, in order
function fakeDb(id) {
  const docRef = p => ({
    get: async () => ({ exists: store.has(`${id}/${p}`), data: () => store.get(`${id}/${p}`) }),
    set: async (data, opts) => {
      writes.push({ db: id, path: p, data, opts });
      const prev = (opts && opts.merge && store.get(`${id}/${p}`)) || {};
      const next = { ...prev, ...data }; for (const k of Object.keys(next)) if (next[k] === DELETE) delete next[k];
      store.set(`${id}/${p}`, next);
    },
  });
  return {
    doc: docRef,
    collection: c => ({
      doc: d => docRef(`${c}/${d}`),
      add: async data => { writes.push({ db: id, path: `${c}/(auto)`, data }); store.set(`${id}/${c}/auto${store.size}`, data); },
      get: async () => ({ docs: [...store].filter(([k]) => k.startsWith(`${id}/${c}/`)).map(([k, v]) => ({ id: k.split('/').pop(), data: () => v })) }),
      where: (f, op, v) => ({ get: async () => ({ docs: [...store].filter(([k, d]) => k.startsWith(`${id}/${c}/`) && d[f] === v).map(([k, d]) => ({ id: k.split('/').pop(), data: () => d })) }) }),
    }),
  };
}
const dbs = new Map(); const dbFor = id => { if (!dbs.has(id)) dbs.set(id, fakeDb(id)); return dbs.get(id); };
const authCalls = [];
let tenantErr = null, userErr = null, tenantExists = true, existingUser = true;
const authForTenant = id => ({
  getUserByEmail: async email => { authCalls.push(['getUserByEmail', id, email]); if (userErr) throw userErr; if (existingUser) return { uid: 'u-existing' }; const e = new Error('nf'); e.code = 'auth/user-not-found'; throw e; },
  createUser: async o => { authCalls.push(['createUser', id, o]); return { uid: 'u-new' }; },
});
const tenantManager = {
  authForTenant,
  getTenant: async id => { authCalls.push(['getTenant', id]); if (tenantErr) throw tenantErr; if (!tenantExists) { const e = new Error('nf'); e.code = 'auth/tenant-not-found'; throw e; } return { tenantId: id }; },
  createTenant: async o => { authCalls.push(['createTenant', o]); return { tenantId: `${o.displayName}-zz9`, ...o }; },
  listTenants: async n => { authCalls.push(['listTenants', n]); if (tenantErr) throw tenantErr; return { tenants: [] }; },
};
let tokenCalls = 0, tokenValue = 'ya29.FAKE-ACCESS-TOKEN';
const fakeAdmin = {
  apps: [{}], initializeApp() {}, app: () => ({ options: { credential: { getAccessToken: async () => { tokenCalls++; return tokenValue ? { access_token: tokenValue } : null; } } } }),
  credential: { cert: () => ({}) }, auth: () => ({ tenantManager: () => tenantManager }),
  firestore: Object.assign(() => dbFor('(default)'), { FieldValue: { delete: () => DELETE, serverTimestamp: () => 'TS' } }),
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'firebase-admin') return fakeAdmin;
  if (req === 'firebase-admin/firestore') return { getFirestore: (_a, id) => dbFor(id || '(default)') };
  return origLoad.call(this, req, ...rest);
};

const D = require('./lib/drivers');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`\x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n  ' + String(detail).split('\n').join('\n  ') : ''}`); }
}
const rejects = async fn => { try { await fn(); return null; } catch (e) { return e; } };

// a recording fake of child_process.execFileSync
function makeExec(handler) {
  const calls = [];
  const exec = (bin, argv, opts = {}) => {
    calls.push({ bin, argv, opts });
    const r = handler ? handler(bin, argv, opts) : '';
    if (r instanceof Error) throw r;
    return r;
  };
  exec.calls = calls;
  return exec;
}
const cliError = (text, stderr = '') => Object.assign(new Error(text), { stdout: text, stderr });
const CREDS = { path: '/tmp/key.json', projectId: 'demo-project', json: {}, cleanup() {} };
const mk = (over = {}) => D.makeDrivers({ project: 'demo-project', admin: fakeAdmin, creds: CREDS, env: { FIREBASE_CLI: 'firebase' }, baseRules: 'RULES', fsImpl: fs, ...over });

(async () => {
  // ── credentials ──────────────────────────────────────────────────────────
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-test-'));
    const KEY = JSON.stringify({ type: 'service_account', project_id: 'demo-project', client_email: 'op@demo.iam', private_key: 'PRIVATE' });
    const c = D.loadCredentials({ env: { FIREBASE_SERVICE_ACCOUNT: KEY }, tmpdir: tmp });
    const mode = fs.statSync(c.path).mode & 0o777;
    check('a service account supplied as JSON is written to a PRIVATE file (owner-only) for the CLI', fs.readFileSync(c.path, 'utf8') === KEY && mode === 0o600, `mode ${mode.toString(8)}`);
    check('...it knows the project from the key', c.projectId === 'demo-project');
    c.cleanup();
    check('...and cleanup removes the key file from disk', !fs.existsSync(c.path));
    const keyFile = path.join(tmp, 'k.json'); fs.writeFileSync(keyFile, KEY);
    const c2 = D.loadCredentials({ env: { GOOGLE_APPLICATION_CREDENTIALS: keyFile } });
    check('a key FILE (GOOGLE_APPLICATION_CREDENTIALS) is used as is and never deleted by cleanup', c2.path === keyFile && c2.projectId === 'demo-project' && (c2.cleanup(), fs.existsSync(keyFile)));
    check('invalid JSON is refused with a clear message', /not valid JSON/.test((await rejects(async () => D.loadCredentials({ env: { FIREBASE_SERVICE_ACCOUNT: '{nope' }, tmpdir: tmp }))).message));
    check('a credential that is not a service account key is refused', /service account key/.test((await rejects(async () => D.loadCredentials({ env: { FIREBASE_SERVICE_ACCOUNT: '{"type":"authorized_user"}' }, tmpdir: tmp }))).message));
    check('no credentials at all is refused, naming both options', /FIREBASE_SERVICE_ACCOUNT.*GOOGLE_APPLICATION_CREDENTIALS/.test((await rejects(async () => D.loadCredentials({ env: {} }))).message));
    check('the error for a bad key does not echo the key', !(await rejects(async () => D.loadCredentials({ env: { FIREBASE_SERVICE_ACCOUNT: '{"type":"service_account","private_key":"SECRETKEY" nope' }, tmpdir: tmp }))).message.includes('SECRETKEY'));
  }

  // ── output parsing ───────────────────────────────────────────────────────
  {
    check('parseJson: bare object, wrapped {status,result}, and noise around the JSON all work',
      D.parseJson('{"a":1}').a === 1 && D.unwrap(D.parseJson('{"status":"success","result":{"a":2}}')).a === 2 && D.parseJson('warning: x\n{"a":3}\nDone').a === 3 && D.parseJson('log\n[{"a":4}]\n')[0].a === 4);
    check('parseJson: empty and malformed input give null instead of throwing', D.parseJson('') === null && D.parseJson('not json') === null && D.parseJson('{broken') === null && D.parseJson(undefined) === null);
  }

  // ── choosing the CLI ─────────────────────────────────────────────────────
  {
    const e1 = makeExec(); mk({ exec: e1, env: { FIREBASE_CLI: 'node /opt/fb.js' } }).cli.command();
    check('FIREBASE_CLI overrides everything', mk({ exec: e1, env: { FIREBASE_CLI: 'node /opt/fb.js' } }).cli.command() === 'node /opt/fb.js');
    const onPath = makeExec(); check('uses `firebase` if it is on PATH (as in CI)', mk({ exec: onPath, env: {} }).cli.command() === 'firebase');
    const noPath = makeExec((bin, argv) => (bin === 'firebase' ? new Error('ENOENT') : '')); const cmd = mk({ exec: noPath, env: {} }).cli.command();
    check(`otherwise the PINNED version through npx (${D.FIREBASE_TOOLS_VERSION}) — the same one CI uses`, cmd === `npx --yes firebase-tools@${D.FIREBASE_TOOLS_VERSION}`, cmd);
    const wf = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/deploy-firestore-rules.yml'), 'utf8');
    check('the pinned version matches the one in the CI workflow (they must not drift)', wf.includes(`firebase-tools@${D.FIREBASE_TOOLS_VERSION}`));
    check('makeDrivers refuses to run without a project', /no project id/.test((await rejects(async () => D.makeDrivers({ project: '', admin: fakeAdmin, creds: CREDS }))).message));
  }

  // ── databases ────────────────────────────────────────────────────────────
  {
    const ex = makeExec(); const d = mk({ exec: ex });
    await d.databases.create('ws-acme', { location: 'nam5', pitr: false });
    const c = ex.calls[0];
    check('create runs exactly: firestore:databases:create <id> --location <loc> --delete-protection ENABLED --project <p> --non-interactive',
      c.bin === 'firebase' && JSON.stringify(c.argv) === JSON.stringify(['firestore:databases:create', 'ws-acme', '--location', 'nam5', '--delete-protection', 'ENABLED', '--project', 'demo-project', '--non-interactive']), JSON.stringify(c.argv));
    check('it is run WITHOUT a shell (arguments passed as an array, so nothing can be injected through a name)', Array.isArray(c.argv) && c.opts.shell !== true);
    check('credentials go by FILE path in the environment, not on the command line', c.opts.env.GOOGLE_APPLICATION_CREDENTIALS === CREDS.path && !c.argv.join(' ').includes('key.json'));
    await d.databases.create('ws-b', { location: 'eur3', pitr: true });
    check('point-in-time recovery is added only when asked', ex.calls[1].argv.includes('--point-in-time-recovery') && ex.calls[1].argv.includes('ENABLED') && !c.argv.includes('--point-in-time-recovery'));
    await d.databases.setPitr('ws-b');
    check('setPitr uses firestore:databases:update', ex.calls[2].argv[0] === 'firestore:databases:update' && ex.calls[2].argv.includes('--point-in-time-recovery'));

    const got = makeExec(() => JSON.stringify({ status: 'success', result: { name: 'projects/p/databases/ws-acme', locationId: 'nam5', pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_ENABLED' } }));
    const r = await mk({ exec: got }).databases.get('ws-acme');
    check('get parses the CLI\'s JSON (wrapped form): exists, location, PITR', r.exists && r.locationId === 'nam5' && r.pitr === true);
    const bare = await mk({ exec: makeExec(() => JSON.stringify({ locationId: 'eur3' })) }).databases.get('x');
    check('get also parses the bare form', bare.exists && bare.locationId === 'eur3' && bare.pitr === false);
    const nf = await mk({ exec: makeExec(() => cliError('Error: database ws-x was not found')) }).databases.get('ws-x');
    check('a "not found" answer means the database does not exist', nf.exists === false);
    const notFound404 = await mk({ exec: makeExec(() => cliError('HTTP Error: 404, Not Found')) }).databases.get('ws-x');
    check('...also when it is reported as a 404', notFound404.exists === false);
    for (const msg of ['HTTP Error: 403, The caller does not have permission', 'Failed to authenticate, have you run firebase login?', 'ECONNRESET network error']) {
      const e = await rejects(() => mk({ exec: makeExec(() => cliError(msg)) }).databases.get('ws-x'));
      check(`any OTHER failure is an error, never "does not exist": ${msg.slice(0, 40)}`, !!e && e.name === 'DriverError');
    }
    check('get("(default)") passes the parentheses through untouched (no shell to mangle them)', (() => { const x = makeExec(() => '{}'); mk({ exec: x }).databases.get('(default)'); return x.calls[0].argv[1] === '(default)'; })());
    const list = await mk({ exec: makeExec(() => JSON.stringify({ result: [{ name: 'projects/p/databases/(default)' }, { name: 'projects/p/databases/platform' }] })) }).databases.list();
    check('list returns the short database ids', list.join() === '(default),platform', list.join());
  }

  // ── rules deployment ─────────────────────────────────────────────────────
  {
    let seen = null; const RULES = 'rules_version = \'2\'; // SENTINEL-RULES-TEXT';
    const ex = makeExec((bin, argv, opts) => {
      seen = { dir: opts.cwd, config: JSON.parse(fs.readFileSync(path.join(opts.cwd, 'firebase.json'), 'utf8')), rules: fs.readFileSync(path.join(opts.cwd, 'rules.rules'), 'utf8') };
      return '';
    });
    const d = mk({ exec: ex });
    await d.rules.deploy('ws-acme', RULES, { dryRun: false });
    check('deploy runs: deploy --only firestore:rules (no --dry-run) from a throwaway project directory', JSON.stringify(ex.calls[0].argv.slice(0, 3)) === JSON.stringify(['deploy', '--only', 'firestore:rules']) && !ex.calls[0].argv.includes('--dry-run'));
    check('...whose firebase.json targets exactly that ONE database and rules file', JSON.stringify(seen.config) === JSON.stringify({ firestore: [{ database: 'ws-acme', rules: 'rules.rules' }] }), JSON.stringify(seen.config));
    check('...and the rules text is written to the file, NOT passed on the command line', seen.rules === RULES && !ex.calls[0].argv.join(' ').includes('SENTINEL'));
    check('...and the temporary directory is removed afterwards', !fs.existsSync(seen.dir));
    await d.rules.deploy('(default)', RULES, { dryRun: true });
    check('dryRun adds --dry-run (a compile check that releases nothing)', ex.calls[1].argv.includes('--dry-run'));
    check('the default database is addressed as "(default)" in the config', JSON.stringify(seen.config.firestore[0].database) === '"(default)"');
    let dirSeen = null;
    const failing = makeExec((b, a, o) => { dirSeen = o.cwd; return cliError('Error: Compilation error in firestore.rules:L5'); });
    const e = await rejects(() => mk({ exec: failing }).rules.deploy('ws-acme', RULES, {}));
    check('a failing deployment surfaces the CLI\'s message, and still cleans up the temp directory', !!e && /Compilation error/.test(e.message) && !fs.existsSync(dirSeen));
  }

  // ── backups ──────────────────────────────────────────────────────────────
  {
    const ex = makeExec(); const d = mk({ exec: ex });
    await d.backups.createSchedule('ws-acme', { retention: '30d', recurrence: 'DAILY' });
    check('a daily schedule: schedules:create -d <db> --retention 30d --recurrence DAILY', JSON.stringify(ex.calls[0].argv.slice(0, 7)) === JSON.stringify(['firestore:backups:schedules:create', '-d', 'ws-acme', '--retention', '30d', '--recurrence', 'DAILY']) && !ex.calls[0].argv.includes('--day-of-week'));
    await d.backups.createSchedule('ws-acme', { retention: '84d', recurrence: 'WEEKLY' });
    check('a weekly schedule also names a day of the week', ex.calls[1].argv.includes('--day-of-week') && ex.calls[1].argv.includes('SUNDAY'));
    const arr = await mk({ exec: makeExec(() => JSON.stringify({ result: [{ name: 's1' }, { name: 's2' }] })) }).backups.listSchedules('ws-acme');
    const obj = await mk({ exec: makeExec(() => JSON.stringify({ backupSchedules: [{ name: 's1' }] })) }).backups.listSchedules('ws-acme');
    const none = await mk({ exec: makeExec(() => '{}') }).backups.listSchedules('ws-acme');
    check('listSchedules understands the array form, the {backupSchedules} form, and "none"', arr.length === 2 && obj.length === 1 && none.length === 0);
    check('listSchedules: "not found" is an empty list, but a permission error is an error', (await mk({ exec: makeExec(() => cliError('404 not found')) }).backups.listSchedules('x')).length === 0 && !!(await rejects(() => mk({ exec: makeExec(() => cliError('403 permission denied')) }).backups.listSchedules('x'))));
  }

  // ── authorized domains (REST) ────────────────────────────────────────────
  {
    const reqs = []; let current = ['rentbay.netlify.app', 'localhost', 'existing.example.com'];
    const fetchOk = async (url, init = {}) => {
      reqs.push({ url, init });
      if (init.method === 'PATCH') { current = JSON.parse(init.body).authorizedDomains; return { ok: true, text: async () => JSON.stringify({ authorizedDomains: current }) }; }
      return { ok: true, text: async () => JSON.stringify({ authorizedDomains: current }) };
    };
    const d = mk({ fetchImpl: fetchOk });
    check('list reads the project config', (await d.authDomains.list()).length === 3 && reqs[0].url === 'https://identitytoolkit.googleapis.com/admin/v2/projects/demo-project/config');
    check('...with the access token as a bearer credential', reqs[0].init.headers.Authorization === 'Bearer ya29.FAKE-ACCESS-TOKEN');
    reqs.length = 0; await d.authDomains.add('portal.acme.com');
    const patch = reqs.find(r => r.init.method === 'PATCH');
    check('add is a read-modify-write: it READS first, then PATCHes with updateMask=authorizedDomains', reqs[0].init.method === undefined && patch && patch.url.endsWith('/config?updateMask=authorizedDomains'));
    check('...and the PATCH body contains ALL the existing domains plus the new one (nothing is dropped)', JSON.stringify(JSON.parse(patch.init.body).authorizedDomains) === JSON.stringify(['rentbay.netlify.app', 'localhost', 'existing.example.com', 'portal.acme.com']));
    reqs.length = 0; await d.authDomains.add('portal.acme.com');
    check('adding a domain that is already present sends no PATCH at all', !reqs.some(r => r.init.method === 'PATCH'));
    const bad = mk({ fetchImpl: async () => ({ ok: false, status: 403, text: async () => '{"error":{"message":"The caller does not have permission"}}' }) });
    const e = await rejects(() => bad.authDomains.list());
    check('an HTTP error surfaces its status and Google\'s message', !!e && /403/.test(e.message) && /does not have permission/.test(e.message));
    tokenValue = null;
    check('a missing access token is a clear error, not a request without credentials', /access token/.test((await rejects(() => d.authDomains.list())).message));
    tokenValue = 'ya29.FAKE-ACCESS-TOKEN';
    const empty = mk({ fetchImpl: async () => ({ ok: true, text: async () => '{}' }) });
    check('a config with no authorizedDomains field reads as an empty list', (await empty.authDomains.list()).length === 0);
  }

  // ── tenants and users ────────────────────────────────────────────────────
  {
    const d = mk({});
    authCalls.length = 0; const id = await d.tenants.create('acme');
    const created = authCalls.find(c => c[0] === 'createTenant')[1];
    check('create tenant: email/password sign-in enabled, password required, and the id is returned', created.displayName === 'acme' && created.emailSignInConfig.enabled === true && created.emailSignInConfig.passwordRequired === true && id === 'acme-zz9');
    tenantExists = false;
    check('get: a missing tenant is null (not an error)', (await d.tenants.get('ghost-1')) === null);
    tenantExists = true; tenantErr = Object.assign(new Error('permission denied'), { code: 'auth/insufficient-permission' });
    check('get: any OTHER error is rethrown (a permissions problem is not "missing")', !!(await rejects(() => d.tenants.get('x'))));
    const probe = await rejects(() => d.tenants.probe());
    check('probe failure explains the likely cause: multi-tenancy not enabled', !!probe && /multi-tenancy/.test(probe.message) && /Allow tenants/.test(probe.message));
    tenantErr = null;

    existingUser = true; authCalls.length = 0;
    let u = await d.users.ensureInTenant('acme-zz9', { email: 'a@acme.com', displayName: 'Ann' });
    check('an existing user is found and NOT recreated', u.uid === 'u-existing' && u.created === false && !authCalls.some(c => c[0] === 'createUser'));
    existingUser = false;
    u = await d.users.ensureInTenant('acme-zz9', { email: 'b@acme.com', displayName: 'Bo' });
    const cu = authCalls.find(c => c[0] === 'createUser');
    check('a new user is created IN THAT TENANT with a random password nobody sees', u.created && cu[1] === 'acme-zz9' && cu[2].email === 'b@acme.com' && /^[0-9a-f-]{36}$/.test(cu[2].password));
    const p2 = []; for (let i = 0; i < 3; i++) { authCalls.length = 0; await d.users.ensureInTenant('t-1234', { email: `x${i}@a.com` }); p2.push(authCalls.find(c => c[0] === 'createUser')[2].password); }
    check('...a different password every time', new Set(p2).size === 3);
    userErr = Object.assign(new Error('boom'), { code: 'auth/internal-error' });
    check('any other lookup error is rethrown rather than creating a duplicate user', !!(await rejects(() => d.users.ensureInTenant('t-1234', { email: 'c@a.com' }))));
    userErr = null; existingUser = true;
  }

  // ── registry and seed documents (platform + workspace databases) ─────────
  {
    store.clear(); writes.length = 0; const d = mk({});
    await d.registry.upsertWorkspace('acme', { name: 'Acme', status: 'provisioning', tenant: undefined });
    const w = writes[0];
    check('the registry lives in the PLATFORM database, merged, with undefined fields dropped', w.db === 'platform' && w.path === 'workspaces/acme' && w.opts.merge === true && !('tenant' in w.data));
    await d.registry.setDomain('portal.acme.com', 'acme');
    check('a domain record maps host -> workspace in the platform database', writes[1].db === 'platform' && writes[1].path === 'workspaceDomains/portal.acme.com' && writes[1].data.workspaceId === 'acme');
    await d.registry.setSecret('acme', 'STRIPE_SECRET_KEY', 'sk_live_xyz'); await d.registry.setSecret('acme', 'SITE_NAME', 'Acme');
    check('secrets go to workspaceSecrets/<id> in the platform database', store.get('platform/workspaceSecrets/acme').STRIPE_SECRET_KEY === 'sk_live_xyz');
    check('getSecretKeys returns NAMES only', JSON.stringify(await d.registry.getSecretKeys('acme')) === JSON.stringify(['SITE_NAME', 'STRIPE_SECRET_KEY']));
    await d.registry.unsetSecret('acme', 'STRIPE_SECRET_KEY');
    check('unsetSecret removes just that key', JSON.stringify(await d.registry.getSecretKeys('acme')) === JSON.stringify(['SITE_NAME']));
    check('a workspace with no settings has no keys', (await d.registry.getSecretKeys('nobody')).length === 0);
    await d.registry.setPlatformState({ defaultRulesDeployedAt: new Date(0) });
    check('platform-wide state (e.g. "default database protected") lives in platformConfig/state', !!(await d.registry.getPlatformState()).defaultRulesDeployedAt && writes.pop().path === 'platformConfig/state');
    await d.workspaceDb.setDoc('ws-acme', 'settings/site', { siteName: 'Acme' }, { merge: true });
    check('seed documents are written to the WORKSPACE\'s own database', writes.pop().db === 'ws-acme');
    store.set('ws-acme/adminInviteTokens/a', { uid: 'u1', used: false, expiresAt: new Date(Date.now() + 1e6), token: 't-live' });
    store.set('ws-acme/adminInviteTokens/b', { uid: 'u1', used: true, expiresAt: new Date(Date.now() + 1e6), token: 't-used' });
    store.set('ws-acme/adminInviteTokens/c', { uid: 'u1', used: false, expiresAt: new Date(Date.now() - 1e6), token: 't-expired' });
    store.set('ws-acme/adminInviteTokens/d', { uid: 'u2', used: false, expiresAt: new Date(Date.now() + 1e6), token: 't-other' });
    check('findUnusedInvite returns only an unused, unexpired token for THAT user', (await d.workspaceDb.findUnusedInvite('ws-acme', 'u1', new Date())).token === 't-live' && (await d.workspaceDb.findUnusedInvite('ws-acme', 'nobody', new Date())) === null);
  }

  // ── nothing sensitive on any command line ────────────────────────────────
  {
    const ex = makeExec(() => '{}'); const d = mk({ exec: ex });
    await d.databases.get('ws-x'); await d.databases.create('ws-x', { location: 'nam5', pitr: true }); await d.databases.list();
    await d.rules.deploy('ws-x', 'TOP-SECRET-RULES', {}); await d.backups.listSchedules('ws-x'); await d.backups.createSchedule('ws-x', { retention: '7d', recurrence: 'DAILY' });
    const all = ex.calls.map(c => c.argv.join(' ')).join('\n');
    check('across every CLI call: no credential, token, key or rules text appears in any argument', !/TOP-SECRET|PRIVATE|ya29|sk_live|BEGIN/.test(all) && ex.calls.every(c => c.argv.includes('--non-interactive') && c.argv.includes('--project')));
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
