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
// KNOWN LIMITS (tracked in docs/MULTI-WORKSPACE.md, do not enable a second
// workspace until they are closed)
//   - Integration credentials are still process-wide env vars (Stripe, Cloudinary,
//     Documenso, ...). Non-default workspaces must not inherit them. SMTP is
//     already isolated (see apply-email-config.js); the rest is the next patch.
//   - Sign-in is not yet per-workspace (Firebase Identity Platform tenants).
//   - Scheduled sweeps run workspaces one after another inside the platform's
//     time limit for scheduled functions, with a budget guard; they need to fan
//     out before the client count grows.

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const REGISTRY_CACHE_MS = 60 * 1000;   // a suspension takes up to this long to bite
const NEGATIVE_CACHE_MS = 30 * 1000;   // unknown hosts are remembered briefly
const CACHE_MAX_ENTRIES = 500;         // Host is attacker-controlled: bound the cache

const WORKSPACE_ID_RE = /^[a-z][a-z0-9-]{2,28}[a-z0-9]$/;        // 4-30 chars
const DATABASE_ID_RE  = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;        // 4-63 chars (Firestore)
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
  return Object.freeze({
    id,
    isDefault: false,
    name: data.name || id,
    databaseId,
    storePrefix: `ws-${id}-`,
    status: data.status || 'provisioning',
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
const runWithWorkspace = (ws, fn) => als.run({ workspace: ws }, fn);
const currentWorkspace = () => { const s = als.getStore(); return s ? s.workspace : null; };

function getWorkspace() {
  const ws = currentWorkspace();
  if (!ws) {
    throw new Error('No workspace context. Wrap the handler: exports.handler = withWorkspace(exports.handler) ' +
                    '(or withEachWorkspace for scheduled functions).');
  }
  return ws;
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
    let ws;
    try { ws = await resolveWorkspace(event); }
    catch (err) { return errorResponse(err); }
    return runWithWorkspace(ws, () => handler(event, context));
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

    const results = {}; let failed = registryFailed ? 1 : 0;
    for (const ws of list) {
      if (Date.now() - startedAt > budgetMs) {
        failed++;
        results[ws.id] = { statusCode: 500, error: 'skipped: sweep time budget exhausted' };
        console.error(`workspace: sweep budget exhausted, skipped "${ws.id}"`);
        continue;
      }
      try {
        const res = await runWithWorkspace(ws, () => handler(event, context));
        const code = (res && res.statusCode) || 200;
        if (code >= 500) failed++;
        results[ws.id] = { statusCode: code, body: res && res.body };
      } catch (err) {
        failed++;
        results[ws.id] = { statusCode: 500, error: err && err.message };
        console.error(`workspace: sweep failed for "${ws.id}":`, err && err.message);
      }
    }
    return { statusCode: failed ? 500 : 200, body: JSON.stringify({ workspaces: results }) };
  };
}

// Explicit opt-out for the rare function that touches no workspace data at all
// (scripts/verify.js requires every handler to declare one of the three).
const withoutWorkspace = handler => handler;

module.exports = {
  withWorkspace, withEachWorkspace, withoutWorkspace,
  getWorkspace, currentWorkspace, runWithWorkspace,
  getDb, getWorkspaceStore, getPlatformDb,
  resolveWorkspace, listActiveWorkspaces, hostFromEvent,
  WorkspaceError,
  // Test hooks only.
  _testing: {
    setRegistry(r) { _registry = r || defaultRegistry; },
    resetCaches() { _cache.clear(); _handles.clear(); },
    normalizeWorkspace, defaultWorkspace,
  },
};
