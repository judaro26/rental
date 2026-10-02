// scripts/lib/test-world.js
//
// An in-memory fake of every driver provision.js uses (registry, tenants, databases, rules, authorized
// domains, a workspace's own database, users, backups), with failure injection and a call log. Shared by
// the provisioning tests and the contract test. It is a TEST helper: nothing in the real tooling uses it.

'use strict';

const fs = require('fs');
const path = require('path');

const BASE_RULES = fs.readFileSync(path.resolve(__dirname, '../../firestore.rules'), 'utf8');

function makeWorld(opts = {}) {
  const st = {
    workspaces: new Map(), domains: new Map(), secrets: new Map(), platform: {},
    tenants: new Map(), databases: new Map([['(default)', { locationId: 'nam5', pitr: false }]]),
    rules: [], authorized: ['rentbay.netlify.app', 'localhost', ...(opts.authorized || [])],
    docs: new Map(), colls: new Map(), users: new Map(), schedules: new Map(), fail: {}, calls: [],
  };
  if (opts.platformDb !== false) st.databases.set('platform', { locationId: 'nam5', pitr: false });
  let tenantN = 0, tokenN = 0, clock = 1700000000000;
  const log = (op, ...args) => st.calls.push([op, ...args]);
  const boom = key => { if (st.fail[key]) throw new Error(typeof st.fail[key] === 'string' ? st.fail[key] : `${key} failed`); };
  // Deep copy that keeps real Dates (JSON.stringify would turn them into strings before a replacer sees them,
  // so the replacer must look at the ORIGINAL value, `this[k]`). Firestore stores Dates as Timestamps.
  const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o, function (k, v) { return this[k] instanceof Date ? { __d: this[k].toISOString() } : v; }), (k, v) => (v && v.__d ? new Date(v.__d) : v)));

  const deps = {
    project: 'demo-project', baseRules: opts.baseRules || BASE_RULES, platformDatabaseId: 'platform', defaultHosts: opts.defaultHosts || [],
    now: () => new Date((clock += 1000)), token: () => `tok${++tokenN}`,
    cli: { command: () => 'firebase', version: () => '15.22.1' },
    registry: {
      async getWorkspace(id) { return st.workspaces.has(id) ? { id, ...clone(st.workspaces.get(id)) } : null; },
      async upsertWorkspace(id, patch) { log('registry.upsert', id, Object.keys(patch)); boom('registry'); st.workspaces.set(id, { ...(st.workspaces.get(id) || {}), ...clone(patch) }); },
      async getDomain(h) { return st.domains.has(h) ? { workspaceId: st.domains.get(h) } : null; },
      async setDomain(h, id) { log('registry.setDomain', h, id); st.domains.set(h, id); },
      async listWorkspaces() { return [...st.workspaces].map(([id, d]) => ({ id, ...clone(d) })).sort((a, b) => (a.id < b.id ? -1 : 1)); },
      async getSecretKeys(id) { return Object.keys(st.secrets.get(id) || {}).sort(); },
      async setSecret(id, k, v) { log('registry.setSecret', id, k); st.secrets.set(id, { ...(st.secrets.get(id) || {}), [k]: v }); },
      async unsetSecret(id, k) { log('registry.unsetSecret', id, k); const s = { ...(st.secrets.get(id) || {}) }; delete s[k]; st.secrets.set(id, s); },
      async getPlatformState() { return clone(st.platform); },
      async setPlatformState(p) { log('registry.setPlatformState', Object.keys(p)); st.platform = { ...st.platform, ...clone(p) }; },
    },
    tenants: {
      async get(id) { return st.tenants.has(id) ? { tenantId: id } : null; },
      async create(name) { log('tenants.create', name); boom('tenantCreate'); const id = st.badTenantId || `${name}-${String(++tenantN).padStart(5, 'a')}`; st.tenants.set(id, { displayName: name }); return id; },
      async probe() { boom('probe'); },
    },
    databases: {
      async get(id) { const d = st.databases.get(id); return d ? { exists: true, ...d } : { exists: false }; },
      async create(id, o) { log('databases.create', id, o); boom('dbCreate'); st.databases.set(id, { locationId: o.location, pitr: !!o.pitr }); },
      async setPitr(id) { log('databases.setPitr', id); st.databases.get(id).pitr = true; },
      async list() { return [...st.databases.keys()]; },
    },
    rules: {
      async deploy(databaseId, text, o = {}) {
        log(o.dryRun ? 'rules.dryRun' : 'rules.deploy', databaseId);
        if (st.fail.rulesDry && o.dryRun) throw new Error('rules failed to compile');
        if (st.fail.rulesDeploy && !o.dryRun && (st.fail.rulesDeploy === true || st.fail.rulesDeploy === databaseId)) throw new Error('rules deployment failed');
        st.rules.push({ databaseId, text, dryRun: !!o.dryRun });
      },
    },
    authDomains: {
      async list() { return [...st.authorized]; },
      async add(h) { log('authDomains.add', h); boom('authAdd'); if (st.dropDomains) st.authorized = [h]; else st.authorized.push(h); },
    },
    workspaceDb: {
      async getDoc(db, p) { return st.docs.has(`${db}/${p}`) ? clone(st.docs.get(`${db}/${p}`)) : null; },
      async setDoc(db, p, data, o) { log('workspaceDb.setDoc', db, p); st.docs.set(`${db}/${p}`, o && o.merge ? { ...(st.docs.get(`${db}/${p}`) || {}), ...clone(data) } : clone(data)); },
      async addDoc(db, c, data) { log('workspaceDb.addDoc', db, c); const k = `${db}/${c}`; st.colls.set(k, [...(st.colls.get(k) || []), clone(data)]); },
      async findUnusedInvite(db, uid, at) { return (st.colls.get(`${db}/adminInviteTokens`) || []).find(t => t.uid === uid && !t.used && new Date(t.expiresAt) > at) || null; },
    },
    users: {
      async ensureInTenant(tenantId, { email }) {
        log('users.ensure', tenantId, email);
        const m = st.users.get(tenantId) || new Map(); st.users.set(tenantId, m);
        if (m.has(email)) return { uid: m.get(email), created: false };
        const uid = `uid-${tenantId}-${m.size + 1}`; m.set(email, uid); return { uid, created: true };
      },
    },
    backups: {
      async listSchedules(db) { return st.schedules.get(db) || []; },
      async createSchedule(db, o) { log('backups.create', db, o); st.schedules.set(db, [...(st.schedules.get(db) || []), o]); },
    },
  };
  return { deps, st };
}
const MUTATING = ['registry.upsert', 'registry.setDomain', 'registry.setSecret', 'registry.unsetSecret', 'registry.setPlatformState', 'tenants.create', 'databases.create', 'databases.setPitr',
  'rules.deploy', 'authDomains.add', 'workspaceDb.setDoc', 'workspaceDb.addDoc', 'users.ensure', 'backups.create'];
const mutations = st => st.calls.filter(c => MUTATING.includes(c[0]));

module.exports = { makeWorld, MUTATING, mutations, BASE_RULES };
