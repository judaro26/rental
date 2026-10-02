// netlify/functions/_lib/workspace.js
// NOT a deployed function — the multi-client ("workspace") seam. Required by
// every function.
//
// MODEL
//   One deployment, one Firebase project, many clients. Each client is a
//   "workspace" with its OWN Firestore database and its OWN Blobs stores, so
//   isolation is structural: code holding workspace A's database handle has no
//   way to read workspace B's data, even if it forgets a filter. (Contrast with
//   an orgId column on every document, where one missed filter is a data leak.)
//
//   The existing install is the "default" workspace: the (default) Firestore
//   database and un-prefixed Blobs store names, exactly as before. Every other
//   workspace lives in a named database and prefixed store names.
//
// HOW A REQUEST FINDS ITS WORKSPACE
//   By hostname (Host header) -> platform registry -> workspace. A client's own
//   domain therefore also routes its webhooks (Stripe, Bold, ...) with no extra
//   plumbing. The workspace is held in AsyncLocalStorage for the whole request,
//   so call sites just say getDb() — no parameter threading through 85 files —
//   and a call made OUTSIDE a request context throws instead of guessing.
//
//     exports.handler = withWorkspace(exports.handler);      // HTTP functions
//     exports.handler = withEachWorkspace(exports.handler);  // scheduled sweeps
//
// SAFE BY DEFAULT
//   Everything below the flag is dormant. Unless ALLOW_MULTI_WORKSPACE=true the
//   registry is never read and every request is the default workspace, which is
//   byte-for-byte the pre-workspace behaviour.
//
// FAIL CLOSED
//   Once the flag is on, a host that is not the default workspace's must match
//   an ACTIVE registry entry. Unknown host -> 404, suspended -> 403, registry
//   unreadable -> 503. It never falls back to the default workspace, because
//   that would show one client the wrong client's data.
//
// PER-WORKSPACE SIGN-IN
//   Every non-default workspace has its own Identity Platform tenant (a separate pool of
//   users). Server code reaches Auth only through getAuth(), which returns that pool and
//   rejects tokens from any other; browsers set auth.tenantId from /api/config; and the
//   security rules (scripts/build-rules.js) refuse a token from another tenant.
//
// PER-WORKSPACE SETTINGS
//   Anything that differs per client (Stripe, mail, site URL, notification address, API
//   keys) is read with getConfig('KEY'), never process.env. The default workspace gets the
//   environment variable; every other workspace gets only its own value, loaded from the
//   platform database (workspaceSecrets/{id}) or, for mail, its own email provider. See
//   getConfig below. The context is one object per request and nothing in it is shared, so
//   scheduled sweeps run workspaces in parallel.
//
// KNOWN LIMITS (docs/MULTI-WORKSPACE.md has the full list; do not enable a second
// workspace until they are closed)
//   - Security rules are deployed to one database only; every workspace database and the
//     platform database (which now holds client settings) need them.
//   - No automated provisioning, and no per-database backups.

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const REGISTRY_CACHE_MS = 60 * 1000;   // a suspension takes up to this long to bite
const NEGATIVE_CACHE_MS = 30 * 1000;   // unknown hosts are remembered briefly
const CACHE_MAX_ENTRIES = 500;         // Host is attacker-controlled: bound the cache

// ── per-workspace settings ───────────────────────────────────────────────────
// Everything that differs per client and used to be a deployment-wide environment
// variable. Code reads these ONLY through getConfig(); scripts/verify.js fails the
// build on a raw process.env read of any of them. For the default workspace
// getConfig() returns exactly what the environment variable did; for every other
// workspace it returns only that workspace's own value and NEVER falls back to the
// deployment's, so a client can never use (or be billed through) the platform
// owner's Stripe account, mail server, API keys or notification address.
//
// Not listed on purpose (platform-level, shared by every workspace, read from env
// directly): FIREBASE_*, NETLIFY_*, SITE_ID and the switches in this file.
const MAIL_KEYS = Object.freeze(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
// Operator-managed: stored in the platform database (workspaceSecrets/{id}), which no
// client can read or write.
const SECRET_KEYS = Object.freeze([
  'SITE_URL', 'SITE_NAME', 'ADMIN_NOTIFY_EMAIL', 'ALLOWED_ORIGIN',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PUBLISHABLE_KEY',
  'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_UPLOAD_PRESET',
  'DOCUMENSO_API_KEY', 'DOCUMENSO_API_URL', 'DOCUMENSO_APP_URL', 'DOCUMENSO_TEMPLATE_ID', 'DOCUMENSO_WEBHOOK_SECRET',
  'SMARTMOVE_API_KEY', 'SMARTMOVE_API_URL', 'SMARTMOVE_LANDING_PAGE',
  'EMPLOYMENT_VERIFICATION_API_KEY', 'EMPLOYMENT_VERIFICATION_API_URL',
  'APPLICATION_RETENTION_DAYS', 'APPLICATION_DELETE_DAYS',
]);
const MAIL_KEY_SET = new Set(MAIL_KEYS);
const SECRET_KEY_SET = new Set(SECRET_KEYS);
const CLIENT_CONFIG_KEYS = Object.freeze([...MAIL_KEYS, ...SECRET_KEYS]);
const CLIENT_KEY_SET = new Set(CLIENT_CONFIG_KEYS);

const WORKSPACE_ID_RE = /^[a-z][a-z0-9-]{2,28}[a-z0-9]$/;        // 4-30 chars
const DATABASE_ID_RE  = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;        // 4-63 chars (Firestore)
const AUTH_TENANT_RE  = /^[A-Za-z0-9_-]{4,64}$/;                 // Identity Platform tenant id (it is also written into security rules, so keep it strict)
const RESERVED_IDS = new Set(['default', 'platform', 'admin', 'api', 'www', 'app', 'system', 'netlify']);

class WorkspaceError extends Error {
  constructor(status, code, detail) {
    super(detail || code);
    this.name = 'WorkspaceError';
    this.status = status;
    this.code = code;
  }
}

// ── configuration ────────────────────────────────────────────────────────────
const multiEnabled = () => process.env.ALLOW_MULTI_WORKSPACE === 'true';
const platformDbId = () => process.env.PLATFORM_DATABASE_ID || 'platform';

function normalizeHost(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

// The Host header, NOT x-forwarded-host: Host is what the edge actually routed
// on, whereas a forwarded header can be supplied by the caller. Picking the
// workspace from a caller-controlled value would let a request choose its own
// database.
function hostFromEvent(event) {
  const h = (event && event.headers) || {};
  const raw = h.host || h.Host || h['x-forwarded-host'] || '';
  return normalizeHost(String(raw).split(',')[0]);
}

function defaultWorkspace() {
  return Object.freeze({
    id: 'default',
    isDefault: true,
    name: process.env.SITE_NAME || null,
    databaseId: '(default)',
    authTenantId: null,          // the project-level sign-in pool, as before
    storePrefix: '',
    status: 'active',
    domains: Object.freeze([]),
    siteUrl: (process.env.SITE_URL || '').replace(/\/+$/, '') || null,
  });
}

// Hosts that always mean "the default workspace" without consulting the
// registry, so the original install keeps working even if the registry is down.
function isDefaultHost(host) {
  if (!host) return true;
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (host.endsWith('.netlify.app')) return true; // the site's own subdomain and its deploy previews
  const configured = (process.env.DEFAULT_WORKSPACE_HOSTS || '').split(',').map(normalizeHost).filter(Boolean);
  return configured.includes(host);
}

function normalizeWorkspace(id, data) {
  data = data || {};
  if (!WORKSPACE_ID_RE.test(id) || RESERVED_IDS.has(id)) {
    throw new WorkspaceError(500, 'invalid_workspace_config', `invalid workspace id "${id}"`);
  }
  const databaseId = String(data.databaseId || `ws-${id}`);
  if (!DATABASE_ID_RE.test(databaseId) || databaseId === platformDbId()) {
    throw new WorkspaceError(500, 'invalid_workspace_config', `invalid database id "${databaseId}" for workspace "${id}"`);
  }
  const domains = (Array.isArray(data.domains) ? data.domains : []).map(normalizeHost).filter(Boolean);
  const primary = normalizeHost(data.primaryDomain) || domains[0] || null;
  const status = data.status || 'provisioning';
  const authTenantId = data.authTenantId == null || data.authTenantId === '' ? null : String(data.authTenantId);
  if (authTenantId !== null && !AUTH_TENANT_RE.test(authTenantId)) {
    throw new WorkspaceError(500, 'invalid_workspace_config', `invalid authTenantId for workspace "${id}"`);
  }
  // Every active workspace has its OWN sign-in pool. Without one it would share the platform's
  // login system with every other client, which is exactly what must never happen.
  if (status === 'active' && !authTenantId) {
    throw new WorkspaceError(500, 'invalid_workspace_config', `workspace "${id}" is active but has no authTenantId (it needs its own sign-in pool)`);
  }
  return Object.freeze({
    id,
    isDefault: false,
    name: data.name || id,
    databaseId,
    authTenantId,
    storePrefix: `ws-${id}-`,
    status,
    domains: Object.freeze(domains),
    siteUrl: primary ? `https://${primary}` : null,
  });
}

// ── Firebase handles ─────────────────────────────────────────────────────────
let _admin;
function adminNamespace() {
  if (!_admin) {
    _admin = require('firebase-admin');
    if (!_admin.apps.length) {
      _admin.initializeApp({ credential: _admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
  }
  return _admin;
}

const _handles = new Map();
function firestoreFor(databaseId) {
  const a = adminNamespace();
  if (!databaseId || databaseId === '(default)') return a.firestore();
  let db = _handles.get(databaseId);
  if (!db) {
    db = require('firebase-admin/firestore').getFirestore(a.app(), databaseId);
    _handles.set(databaseId, db);
  }
  return db;
}

// The registry (workspaces + their domains) lives in its own database, kept
// apart from every client's data. Client-side access is denied by default.
const getPlatformDb = () => firestoreFor(platformDbId());

const defaultRegistry = {
  // null  = no such domain (unknown host)
  // throw = the registry could not be read (the caller must fail closed)
  async lookupDomain(host) {
    const pdb = getPlatformDb();
    const dom = await pdb.collection('workspaceDomains').doc(host).get();
    if (!dom.exists) return null;
    const workspaceId = String((dom.data() || {}).workspaceId || '');
    if (!workspaceId) return null;
    const snap = await pdb.collection('workspaces').doc(workspaceId).get();
    if (!snap.exists) return null;
    return normalizeWorkspace(workspaceId, snap.data());
  },
  // The operator-managed settings of one workspace. {} when none have been set.
  async loadSecrets(workspaceId) {
    const snap = await getPlatformDb().collection('workspaceSecrets').doc(workspaceId).get();
    return snap.exists ? (snap.data() || {}) : {};
  },
  async listActive() {
    const snap = await getPlatformDb().collection('workspaces').where('status', '==', 'active').get();
    const out = [];
    for (const d of snap.docs) {
      try { out.push(normalizeWorkspace(d.id, d.data())); }
      catch (err) { console.error(`workspace: skipping invalid registry entry "${d.id}":`, err.message); }
    }
    return out.sort((x, y) => (x.id < y.id ? -1 : 1));
  },
};
let _registry = defaultRegistry;

// ── resolution ───────────────────────────────────────────────────────────────
const _cache = new Map();
function cacheGet(key) {
  const e = _cache.get(key);
  if (e && e.exp > Date.now()) return e;
  _cache.delete(key);
  return null;
}
function cacheSet(key, value, ms) {
  if (_cache.size >= CACHE_MAX_ENTRIES) _cache.clear();
  _cache.set(key, { value, exp: Date.now() + ms });
}

// Loaded once per cache window, not per request. A failure is NOT swallowed: without
// its own settings a workspace must not run (it would have no Stripe key, mail, etc.).
const _secretsCache = new Map();
async function loadWorkspaceConfig(ws) {
  if (ws.isDefault) return null; // the default workspace's settings are the environment, as before
  const hit = _secretsCache.get(ws.id);
  if (hit && hit.exp > Date.now()) return hit.value;
  let raw;
  try { raw = await _registry.loadSecrets(ws.id); }
  catch (err) { throw new WorkspaceError(503, 'workspace_config_unavailable', `could not load settings for "${ws.id}": ${err && err.message}`); }
  const cfg = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (!SECRET_KEY_SET.has(k)) { console.warn(`workspace "${ws.id}": ignoring setting "${k}" (not a per-workspace setting, or managed elsewhere)`); continue; }
    if (v == null || v === '') continue;
    cfg[k] = String(v);
  }
  Object.freeze(cfg);
  if (_secretsCache.size >= CACHE_MAX_ENTRIES) _secretsCache.clear();
  _secretsCache.set(ws.id, { value: cfg, exp: Date.now() + REGISTRY_CACHE_MS });
  return cfg;
}

async function resolveWorkspace(event) {
  if (!multiEnabled()) return defaultWorkspace();
  const host = hostFromEvent(event);
  if (isDefaultHost(host)) return defaultWorkspace();

  let hit = cacheGet(host);
  if (!hit) {
    const ws = await _registry.lookupDomain(host); // may throw -> caller fails closed
    cacheSet(host, ws, ws ? REGISTRY_CACHE_MS : NEGATIVE_CACHE_MS);
    hit = { value: ws };
  }
  const ws = hit.value;
  if (!ws) throw new WorkspaceError(404, 'unknown_workspace', `no workspace for host "${host}"`);
  if (ws.status !== 'active') throw new WorkspaceError(403, 'workspace_unavailable', `workspace "${ws.id}" is ${ws.status}`);
  return ws;
}

async function listActiveWorkspaces() {
  const list = [defaultWorkspace()];
  if (multiEnabled()) list.push(...await _registry.listActive());
  return list;
}

// ── request context ──────────────────────────────────────────────────────────
// The context is one object PER REQUEST: { workspace, config, mail }. Nothing in it is shared
// between requests, which is what lets scheduled sweeps run workspaces in parallel.
const runWithWorkspace = (ws, fn, config) => als.run({ workspace: ws, config: config || null, mail: null }, fn);
const currentWorkspace = () => { const s = als.getStore(); return s ? s.workspace : null; };

function getWorkspace() {
  const ws = currentWorkspace();
  if (!ws) {
    throw new Error('No workspace context. Wrap the handler: exports.handler = withWorkspace(exports.handler) ' +
                    '(or withEachWorkspace for scheduled functions).');
  }
  return ws;
}

// A per-workspace setting. Synchronous (a drop-in for process.env.KEY): the workspace's
// settings were loaded before the handler started. Unknown names THROW, so a typo cannot
// silently read as "not configured", and platform secrets (FIREBASE_SERVICE_ACCOUNT, ...)
// cannot be reached through this accessor at all.
function getConfig(key) {
  if (!CLIENT_KEY_SET.has(key)) throw new Error(`getConfig: "${key}" is not a per-workspace setting`);
  const store = als.getStore();
  if (!store) throw new Error('No workspace context. Wrap the handler: exports.handler = withWorkspace(exports.handler).');
  const ws = store.workspace;

  if (MAIL_KEY_SET.has(key)) {
    // From the workspace's own email provider, loaded by apply-email-config. Provided keys win;
    // the default workspace falls back to the deployment's SMTP_* (as it always has).
    const m = store.mail ? store.mail[key] : undefined;
    return ws.isDefault ? (m !== undefined ? m : process.env[key]) : m;
  }
  if (ws.isDefault) return process.env[key];

  const c = store.config || {};
  if (key === 'SITE_URL') return c.SITE_URL || ws.siteUrl || undefined;
  if (key === 'SITE_NAME') return c.SITE_NAME || ws.name || undefined;
  return c[key];
}

// Called by apply-email-config with this request's mail settings (or null).
function setMailOverride(mail) {
  const store = als.getStore();
  if (store) store.mail = mail ? Object.freeze({ ...mail }) : null;
}

// The Firestore database of the current workspace.
const getDb = () => firestoreFor(getWorkspace().databaseId);

// Drop-in for @netlify/blobs getStore({ name, ... }): same options, but the
// store name gets the current workspace's prefix ('' for the default workspace,
// so existing stores keep their names).
function getWorkspaceStore(opts) {
  const { getStore } = require('@netlify/blobs');
  return getStore({ ...opts, name: getWorkspace().storePrefix + opts.name });
}

// ── sign-in ──────────────────────────────────────────────────────────────────
// The Admin-SDK Auth for the current workspace — the ONLY way server code reaches Auth.
//   default workspace   -> the project-level pool, exactly as before
//   any other workspace -> ITS OWN pool (an Identity Platform tenant), so users it creates
//                          and tokens it mints live only there
//
// verifyIdToken additionally checks the token's tenant in BOTH directions. The tenant-aware
// Auth already rejects a token from another tenant, but the project-level Auth accepts a
// token from ANY tenant — so without this check, a user of one client could present their
// token to the default workspace. A token must come from this workspace's pool, and from
// no other. (It is also checked here rather than trusted from the browser: a custom token
// can be exchanged for a session in a pool the client chooses, so the claim in the token
// is the only thing that can be relied on.)
function getAuth() {
  const ws = getWorkspace();
  const base = adminNamespace().auth();
  let scoped = base;
  if (!ws.isDefault) {
    if (!ws.authTenantId) throw new Error(`workspace "${ws.id}" has no sign-in pool (authTenantId)`);
    scoped = base.tenantManager().authForTenant(ws.authTenantId);
  }
  const expected = ws.isDefault ? null : ws.authTenantId;
  const verifyIdToken = async (idToken, checkRevoked) => {
    const decoded = await scoped.verifyIdToken(idToken, checkRevoked);
    const tenant = (decoded && decoded.firebase && decoded.firebase.tenant) || null;
    if (tenant !== expected) {
      const err = new Error('ID token belongs to a different workspace');
      err.code = 'auth/mismatching-tenant-id';
      throw err;
    }
    return decoded;
  };
  return new Proxy(scoped, {
    get(target, prop) {
      if (prop === 'verifyIdToken') return verifyIdToken;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// ── handler wrappers ─────────────────────────────────────────────────────────
function errorResponse(err) {
  if (err instanceof WorkspaceError) {
    if (err.status >= 500) console.error('workspace:', err.message);
    return { statusCode: err.status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.code }) };
  }
  console.error('workspace: could not resolve workspace, refusing the request:', err && err.message);
  return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'workspace_lookup_failed' }) };
}

// HTTP functions: resolve the workspace from the request, then run the handler inside it.
function withWorkspace(handler) {
  return async function workspaceHandler(event, context) {
    let ws, config;
    try { ws = await resolveWorkspace(event); config = await loadWorkspaceConfig(ws); }
    catch (err) { return errorResponse(err); }
    return runWithWorkspace(ws, () => handler(event, context), config);
  };
}

// Scheduled functions have no request, so run the handler once per active
// workspace. One workspace failing never stops the others; any failure turns the
// overall result into a 500 so it shows up in the platform's function logs.
function withEachWorkspace(handler) {
  return async function eachWorkspaceHandler(event, context) {
    const startedAt = Date.now();
    const budgetMs = Number(process.env.SWEEP_BUDGET_MS) || 22000;

    let list; let registryFailed = false;
    try { list = await listActiveWorkspaces(); }
    catch (err) {
      console.error('workspace: could not list workspaces; running the default workspace only:', err && err.message);
      list = [defaultWorkspace()]; registryFailed = true;
    }

    // Only the default workspace: behave exactly like the pre-workspace function.
    if (list.length === 1 && !registryFailed) return runWithWorkspace(list[0], () => handler(event, context));

    // Workspaces run in parallel (bounded). This is safe because nothing is shared between
    // runs: each gets its own context and settings, and no code mutates process.env.
    const concurrency = Math.max(1, Number(process.env.SWEEP_CONCURRENCY) || 4);
    const results = {}; for (const ws of list) results[ws.id] = null; // keeps the list's order
    let failed = registryFailed ? 1 : 0; let next = 0;

    async function runOne(ws) {
      if (Date.now() - startedAt > budgetMs) {
        failed++;
        results[ws.id] = { statusCode: 500, error: 'skipped: sweep time budget exhausted' };
        console.error(`workspace: sweep budget exhausted, skipped "${ws.id}"`);
        return;
      }
      try {
        const config = await loadWorkspaceConfig(ws);
        const res = await runWithWorkspace(ws, () => handler(event, context), config);
        const code = (res && res.statusCode) || 200;
        if (code >= 500) failed++;
        results[ws.id] = { statusCode: code, body: res && res.body };
      } catch (err) {
        failed++;
        results[ws.id] = { statusCode: 500, error: err && err.message };
        console.error(`workspace: sweep failed for "${ws.id}":`, err && err.message);
      }
    }
    async function worker() { while (next < list.length) { await runOne(list[next++]); } }
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    return { statusCode: failed ? 500 : 200, body: JSON.stringify({ workspaces: results }) };
  };
}

// Explicit opt-out for the rare function that touches no workspace data at all
// (scripts/verify.js requires every handler to declare one of the three).
const withoutWorkspace = handler => handler;

module.exports = {
  withWorkspace, withEachWorkspace, withoutWorkspace,
  getWorkspace, currentWorkspace, runWithWorkspace,
  getDb, getAuth, getWorkspaceStore, getPlatformDb,
  getConfig, setMailOverride, loadWorkspaceConfig, CLIENT_CONFIG_KEYS, MAIL_KEYS, SECRET_KEYS,
  resolveWorkspace, listActiveWorkspaces, hostFromEvent,
  WorkspaceError,
  // Test hooks only.
  _testing: {
    setRegistry(r) { _registry = r || defaultRegistry; },
    resetCaches() { _cache.clear(); _secretsCache.clear(); _handles.clear(); },
    normalizeWorkspace, defaultWorkspace,
  },
};
