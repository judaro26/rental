// scripts/lib/drivers.js
//
// The real implementations behind provision.js's "drivers". Three kinds of thing, each the
// documented way to do the job:
//   * the Firebase CLI (pinned to the version CI uses) — databases, rules deployment, backup schedules
//   * the Admin SDK                                    — the registry, tenants, users, seed documents
//   * one REST call                                    — Firebase Auth's authorized domains (no CLI for it)
//
// Everything that touches the outside world is injected (`exec`, `fetchImpl`, `admin`), so
// scripts/test-drivers.js can check the exact commands and requests without running any of them.
//
// Credentials: FIREBASE_SERVICE_ACCOUNT (the key's JSON) or GOOGLE_APPLICATION_CREDENTIALS (a path).
// Use an OPERATOR service account for this, not the runtime one in Netlify: the runtime never needs
// to create databases or tenants and should not be able to.

'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep in step with .github/workflows/deploy-firestore-rules.yml (scripts/verify.js checks).
const FIREBASE_TOOLS_VERSION = '15.22.1';
const CLI_TIMEOUT_MS = 10 * 60 * 1000;

class DriverError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'DriverError'; Object.assign(this, extra); }
}

// ── credentials ─────────────────────────────────────────────────────────────
// The Firebase CLI reads GOOGLE_APPLICATION_CREDENTIALS from a FILE; a service account supplied as
// JSON text is written to a private temp file for the run and removed afterwards.
function loadCredentials({ env = process.env, fsImpl = fs, tmpdir = os.tmpdir() } = {}) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS && fsImpl.existsSync(env.GOOGLE_APPLICATION_CREDENTIALS)) {
    let projectId = null;
    try { projectId = JSON.parse(fsImpl.readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')).project_id || null; } catch { /* not JSON: fine */ }
    return { path: env.GOOGLE_APPLICATION_CREDENTIALS, projectId, json: null, cleanup() {} };
  }
  if (env.FIREBASE_SERVICE_ACCOUNT) {
    let json;
    try { json = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); }
    catch (e) { throw new DriverError('FIREBASE_SERVICE_ACCOUNT is not valid JSON: ' + e.message); }
    if (json.type !== 'service_account') throw new DriverError(`FIREBASE_SERVICE_ACCOUNT must be a service account key (type "service_account"), not "${json.type}"`);
    const dir = fsImpl.mkdtempSync(path.join(tmpdir, 'ws-cred-'));
    const file = path.join(dir, 'key.json');
    fsImpl.writeFileSync(file, env.FIREBASE_SERVICE_ACCOUNT, { mode: 0o600 });
    return { path: file, projectId: json.project_id || null, json, cleanup() { try { fsImpl.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
  }
  throw new DriverError('no credentials: set FIREBASE_SERVICE_ACCOUNT (the key JSON) or GOOGLE_APPLICATION_CREDENTIALS (a path to it)');
}

// ── output parsing ──────────────────────────────────────────────────────────
// The CLI's --json output is either the bare result or wrapped as { status, result }. Be tolerant of both
// and of log lines around it; never trust a parsed field for anything that matters for safety.
function parseJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.search(/[[{]/);
  if (a < 0) return null;
  const open = s[a], close = open === '{' ? '}' : ']';
  const b = s.lastIndexOf(close);
  if (b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
const unwrap = j => (j && typeof j === 'object' && !Array.isArray(j) && 'result' in j ? j.result : j);

// ── the drivers ─────────────────────────────────────────────────────────────
function makeDrivers({ project, admin, creds, env = process.env, exec = execFileSync, fetchImpl = globalThis.fetch,
                       tmpdir = os.tmpdir(), fsImpl = fs, baseRules, now = () => new Date(), token = () => crypto.randomBytes(24).toString('hex') }) {
  if (!project) throw new DriverError('no project id (use --project, or a service account key that names its project)');
  const W = require('../../netlify/functions/_lib/workspace');

  // Which CLI to run: an explicit FIREBASE_CLI, else `firebase` on PATH (CI installs it), else the pinned version via npx.
  let cli;
  const resolveCli = () => {
    if (cli) return cli;
    if (env.FIREBASE_CLI) return (cli = env.FIREBASE_CLI.split(/\s+/).filter(Boolean));
    try { exec('firebase', ['--version'], { stdio: 'ignore' }); return (cli = ['firebase']); }
    catch { return (cli = ['npx', '--yes', `firebase-tools@${FIREBASE_TOOLS_VERSION}`]); }
  };

  // Secrets are NEVER put on a command line (visible in process lists and shell history): only database ids,
  // locations and similar travel as arguments. Rules text goes in a temp file; credentials go by file path.
  function runCli(args, { cwd } = {}) {
    const [bin, ...prefix] = resolveCli();
    const argv = [...prefix, ...args, '--project', project, '--non-interactive'];
    try {
      return exec(bin, argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CLI_TIMEOUT_MS,
                               env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: creds.path } });
    } catch (e) {
      const output = `${e.stdout || ''}\n${e.stderr || ''}\n${e.message || ''}`.trim();
      throw new DriverError(`firebase ${args[0]} failed: ${output.split('\n').filter(Boolean).slice(-6).join(' | ')}`, { output });
    }
  }

  const pdb = () => W.getPlatformDb();
  const strip = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  return {
    project,
    baseRules,
    now,
    token,
    platformDatabaseId: env.PLATFORM_DATABASE_ID || 'platform',
    defaultHosts: (env.DEFAULT_WORKSPACE_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean),

    // ── registry (platform database) ──
    registry: {
      async getWorkspace(id) { const s = await pdb().collection('workspaces').doc(id).get(); return s.exists ? { id, ...s.data() } : null; },
      async upsertWorkspace(id, patch) { await pdb().collection('workspaces').doc(id).set(strip(patch), { merge: true }); },
      async getDomain(host) { const s = await pdb().collection('workspaceDomains').doc(host).get(); return s.exists ? s.data() : null; },
      async setDomain(host, workspaceId) { await pdb().collection('workspaceDomains').doc(host).set({ workspaceId, createdAt: now() }, { merge: true }); },
      async listWorkspaces() { const s = await pdb().collection('workspaces').get(); return s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.id < b.id ? -1 : 1)); },
      // Platform-wide facts that are not about one workspace, e.g. when the default database was protected.
      async getPlatformState() { const s = await pdb().collection('platformConfig').doc('state').get(); return s.exists ? (s.data() || {}) : {}; },
      async setPlatformState(patch) { await pdb().collection('platformConfig').doc('state').set(strip(patch), { merge: true }); },
      async getSecretKeys(id) { const s = await pdb().collection('workspaceSecrets').doc(id).get(); return s.exists ? Object.keys(s.data() || {}).sort() : []; },
      async setSecret(id, key, value) { await pdb().collection('workspaceSecrets').doc(id).set({ [key]: value }, { merge: true }); },
      async unsetSecret(id, key) { await pdb().collection('workspaceSecrets').doc(id).set({ [key]: admin.firestore.FieldValue.delete() }, { merge: true }); },
    },

    // ── Identity Platform tenants ──
    tenants: {
      async get(tenantId) {
        try { return await admin.auth().tenantManager().getTenant(tenantId); }
        catch (e) { if (e && e.code === 'auth/tenant-not-found') return null; throw e; }
      },
      async create(displayName) {
        const t = await admin.auth().tenantManager().createTenant({ displayName, emailSignInConfig: { enabled: true, passwordRequired: true } });
        return t.tenantId;
      },
      async probe() {
        try { await admin.auth().tenantManager().listTenants(1); }
        catch (e) { throw new DriverError(`could not list Identity Platform tenants — multi-tenancy is probably not enabled yet (upgrade to Identity Platform, then Settings → Security → "Allow tenants"): ${e.message}`); }
      },
    },

    // ── Firestore databases (Firebase CLI) ──
    databases: {
      async get(id) {
        let out;
        try { out = runCli(['firestore:databases:get', id, '--json']); }
        catch (e) { if (/not.?found|404|does not exist/i.test(e.output || '')) return { exists: false }; throw e; }
        const db = unwrap(parseJson(out)) || {};
        return { exists: true, locationId: db.locationId, pitr: /ENABLED/i.test(String(db.pointInTimeRecoveryEnablement || '')), raw: db };
      },
      async create(id, { location, pitr }) {
        runCli(['firestore:databases:create', id, '--location', location, '--delete-protection', 'ENABLED', ...(pitr ? ['--point-in-time-recovery', 'ENABLED'] : [])]);
      },
      async setPitr(id) { runCli(['firestore:databases:update', id, '--point-in-time-recovery', 'ENABLED']); },
      async list() {
        const j = unwrap(parseJson(runCli(['firestore:databases:list', '--json'])));
        const arr = Array.isArray(j) ? j : (j && Array.isArray(j.databases) ? j.databases : []);
        return arr.map(d => String(d.name || d).split('/databases/').pop());
      },
    },

    // the CLI that will be used, and its version (for `doctor`)
    cli: {
      version() { const [bin, ...prefix] = resolveCli(); return String(exec(bin, [...prefix, '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...env } })).trim().split('\n').pop(); },
      command() { return resolveCli().join(' '); },
    },

    // ── security rules (Firebase CLI, from a throwaway project directory) ──
    rules: {
      async deploy(databaseId, text, { dryRun } = {}) {
        const dir = fsImpl.mkdtempSync(path.join(tmpdir, 'ws-rules-'));
        try {
          fsImpl.writeFileSync(path.join(dir, 'rules.rules'), text);
          fsImpl.writeFileSync(path.join(dir, 'firebase.json'), JSON.stringify({ firestore: [{ database: databaseId, rules: 'rules.rules' }] }));
          runCli(['deploy', '--only', 'firestore:rules', ...(dryRun ? ['--dry-run'] : [])], { cwd: dir });
        } finally { try { fsImpl.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
      },
    },

    // ── Firebase Auth authorized domains (REST: read, add, write back) ──
    authDomains: (() => {
      const base = `https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(project)}/config`;
      const accessToken = async () => {
        const t = await admin.app().options.credential.getAccessToken();
        if (!t || !t.access_token) throw new DriverError('could not obtain an access token from the credentials');
        return t.access_token;
      };
      const call = async (url, init = {}) => {
        const res = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
        const body = await res.text();
        if (!res.ok) throw new DriverError(`Identity Toolkit ${init.method || 'GET'} failed (${res.status}): ${body.slice(0, 300)}`);
        return body ? JSON.parse(body) : {};
      };
      const list = async () => (await call(base)).authorizedDomains || [];
      return {
        list,
        // Read-modify-write, so existing domains are never dropped; the caller re-reads to verify.
        async add(host) {
          const current = await list();
          if (current.includes(host)) return;
          await call(`${base}?updateMask=authorizedDomains`, { method: 'PATCH', body: JSON.stringify({ authorizedDomains: [...current, host] }) });
        },
      };
    })(),

    // ── a workspace's own database (seed documents) ──
    workspaceDb: {
      async getDoc(databaseId, docPath) { const s = await W.getDatabase(databaseId).doc(docPath).get(); return s.exists ? s.data() : null; },
      async setDoc(databaseId, docPath, data, opts) { await W.getDatabase(databaseId).doc(docPath).set(strip(data), opts); },
      async addDoc(databaseId, collection, data) { await W.getDatabase(databaseId).collection(collection).add(strip(data)); },
      // single-field query + in-memory filter: no composite index needed
      async findUnusedInvite(databaseId, uid, at) {
        const s = await W.getDatabase(databaseId).collection('adminInviteTokens').where('uid', '==', uid).get();
        const live = s.docs.map(d => d.data()).filter(t => !t.used && (t.expiresAt && (t.expiresAt.toDate ? t.expiresAt.toDate() : new Date(t.expiresAt))) > at);
        return live[0] || null;
      },
    },

    // ── users inside a workspace's tenant ──
    users: {
      async ensureInTenant(tenantId, { email, displayName }) {
        const auth = admin.auth().tenantManager().authForTenant(tenantId);
        try { return { uid: (await auth.getUserByEmail(email)).uid, created: false }; }
        catch (e) { if (!e || e.code !== 'auth/user-not-found') throw e; }
        // The password is random and never shown: the admin sets their own through the activation link.
        const u = await auth.createUser({ email, password: crypto.randomUUID(), displayName: displayName || '' });
        return { uid: u.uid, created: true };
      },
    },

    // ── Firestore scheduled backups (Firebase CLI) ──
    backups: {
      async listSchedules(databaseId) {
        let out;
        try { out = runCli(['firestore:backups:schedules:list', '-d', databaseId, '--json']); }
        catch (e) { if (/not.?found|404/i.test(e.output || '')) return []; throw e; }
        const j = unwrap(parseJson(out));
        if (Array.isArray(j)) return j;
        if (j && Array.isArray(j.backupSchedules)) return j.backupSchedules;
        return [];
      },
      async createSchedule(databaseId, { retention, recurrence }) {
        runCli(['firestore:backups:schedules:create', '-d', databaseId, '--retention', retention, '--recurrence', recurrence,
                ...(recurrence === 'WEEKLY' ? ['--day-of-week', 'SUNDAY'] : [])]);
      },
    },
  };
}

module.exports = { makeDrivers, loadCredentials, parseJson, unwrap, DriverError, FIREBASE_TOOLS_VERSION };
