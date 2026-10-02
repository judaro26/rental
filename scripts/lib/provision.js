// scripts/lib/provision.js
//
// Workspace operations — create, activate, suspend, resume, status, rules, secrets, backups —
// as plain logic over injected "drivers" (see drivers.js for the real ones). Nothing in here
// touches Google, which is what lets scripts/test-provision.js check every behaviour below
// with fakes.
//
// Principles:
//   * PLAN BY DEFAULT. Every mutating operation takes `apply`; without it, it only reads and reports
//     what it WOULD do.
//   * IDEMPOTENT AND RESUMABLE. Each step checks whether it is already done, so a run that failed
//     half-way is simply run again. Progress that later steps depend on (the tenant id) is written
//     to the registry the moment it exists.
//   * INACTIVE UNTIL VERIFIED. `create` leaves a workspace in "provisioning", which the runtime
//     refuses to serve. Going live is a separate, checked step (`activate`).
//   * NEVER OVERWRITE WHAT IT DID NOT CREATE. An existing database or domain that is not this
//     workspace's is refused, not adopted.
//   * SECRETS ARE NEVER PRINTED. Only key names and lengths appear in results.

'use strict';

const crypto = require('crypto');
const { buildRules } = require('../build-rules');
const W = require('../../netlify/functions/_lib/workspace');

const PLATFORM_DB_DEFAULT = 'platform';
const INVITE_HOURS_DEFAULT = 72;

// Closed to every client request. Used for the platform database (which holds client secrets) and for
// a suspended workspace's database.
const DENY_ALL_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;

class ProvisionError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'ProvisionError'; Object.assign(this, extra); }
}

// ── validation ──────────────────────────────────────────────────────────────
const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateDomains(list, defaultHosts = []) {
  const domains = [...new Set((list || []).map(d => String(d).trim().toLowerCase()).filter(Boolean))];
  if (!domains.length) throw new ProvisionError('at least one --domain is required (the client\'s own hostname, e.g. portal.acme.com)');
  for (const d of domains) {
    if (!HOST_RE.test(d) || /^\d+\.\d+\.\d+\.\d+$/.test(d)) throw new ProvisionError(`"${d}" is not a valid hostname`);
    // The runtime treats these as the DEFAULT workspace without consulting the registry
    // (isDefaultHost in _lib/workspace.js), so a client registered on one would never be reached.
    if (d.endsWith('.netlify.app')) throw new ProvisionError(`"${d}" ends in .netlify.app, which always means the default workspace — give the client its own domain`);
    if (defaultHosts.map(h => h.toLowerCase()).includes(d)) throw new ProvisionError(`"${d}" is listed in DEFAULT_WORKSPACE_HOSTS, which always means the default workspace`);
  }
  return domains;
}
function validateEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new ProvisionError(`"${email}" is not a valid email address`);
  return e;
}
const deriveDatabaseId = id => `ws-${id}`;
// Identity Platform requires 4-20 characters: letters, digits, hyphens, starting with a letter.
const deriveTenantName = id => id.slice(0, 20).replace(/-+$/, '');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const sanitizeLabel = s => String(s || '').slice(0, 200);

// Runs the runtime's own validation, so provisioning can never create what the runtime would reject.
function validateRecord(id, record) {
  try { return W.normalizeWorkspace(id, record); }
  catch (e) { throw new ProvisionError(e.message); }
}

// ── step runner ─────────────────────────────────────────────────────────────
// check() reads only and returns { done, detail?, plan? }. run() mutates and returns a detail string.
function makeRunner(apply) {
  const steps = [];
  return {
    steps,
    async step(name, { check, run }) {
      let state;
      try { state = await check(); }
      catch (e) { steps.push({ name, status: 'failed', detail: e.message }); throw new ProvisionError(`${name}: ${e.message}`, { steps }); }
      if (state.done) { steps.push({ name, status: 'ok', detail: state.detail || '' }); return state; }
      if (!apply) { steps.push({ name, status: 'planned', detail: state.plan || '' }); return { ...state, planned: true }; }
      try {
        const detail = await run(state);
        steps.push({ name, status: 'done', detail: detail || '' });
        return { ...state, done: true, ran: true };
      } catch (e) {
        steps.push({ name, status: 'failed', detail: e.message });
        throw new ProvisionError(`${name} failed: ${e.message}`, { steps });
      }
    },
    skip(name, detail) { steps.push({ name, status: 'skipped', detail }); },
  };
}

// ── first admin ─────────────────────────────────────────────────────────────
// Creates the same records the app's own invite flow creates (manage-admin.js `invite`), so the
// admin then activates through the app exactly as any invited admin does.
async function inviteAdmin(deps, { id, email, name, hours = INVITE_HOURS_DEFAULT, apply }) {
  const ws = await deps.registry.getWorkspace(id);
  if (!ws) throw new ProvisionError(`workspace "${id}" does not exist`);
  if (!ws.authTenantId) throw new ProvisionError(`workspace "${id}" has no sign-in pool yet — run create first`);
  const host = ws.primaryDomain || (ws.domains || [])[0];
  if (!host) throw new ProvisionError(`workspace "${id}" has no domain`);
  email = validateEmail(email);
  const databaseId = ws.databaseId || deriveDatabaseId(id);
  if (!apply) return { planned: true, email, databaseId, tenantId: ws.authTenantId };

  const { uid, created } = await deps.users.ensureInTenant(ws.authTenantId, { email, displayName: sanitizeLabel(name) });
  const now = deps.now();
  const existing = await deps.workspaceDb.getDoc(databaseId, `admins/${uid}`);
  await deps.workspaceDb.setDoc(databaseId, `admins/${uid}`, {
    email, displayName: sanitizeLabel(name), role: 'super_admin', allowedCountry: null,
    // never downgrade an admin who has already activated
    status: existing && existing.status && existing.status !== 'invited' ? existing.status : 'invited',
    invitedBy: 'provisioning', invitedAt: now,
    createdAt: existing && existing.createdAt ? existing.createdAt : now, updatedAt: now,
  }, { merge: true });

  let invite = await deps.workspaceDb.findUnusedInvite(databaseId, uid, now);
  const reused = !!invite;
  if (!invite) {
    invite = { token: deps.token(), uid, email, role: 'super_admin', allowedCountry: null,
               expiresAt: new Date(now.getTime() + Math.max(1, Math.min(168, hours)) * 3600 * 1000), used: false, createdAt: now };
    await deps.workspaceDb.addDoc(databaseId, 'adminInviteTokens', invite);
  }
  return { uid, userCreated: created, reusedInvite: reused, activationUrl: `https://${host}/api/activate-admin-invite?token=${invite.token}`, expiresAt: invite.expiresAt };
}

// ── backups ─────────────────────────────────────────────────────────────────
async function ensureBackupSchedule(deps, databaseId, { retention, recurrence }, apply, runner, label) {
  return runner.step(`backups: ${label}`, {
    check: async () => {
      const existing = await deps.backups.listSchedules(databaseId);
      return existing.length ? { done: true, detail: `${existing.length} schedule(s) already exist` } : { done: false, plan: `create a ${recurrence.toLowerCase()} backup, kept ${retention}` };
    },
    run: async () => { await deps.backups.createSchedule(databaseId, { retention, recurrence }); return `${recurrence.toLowerCase()} backup, kept ${retention}`; },
  });
}

// ── create ──────────────────────────────────────────────────────────────────
async function createWorkspace(deps, opts) {
  const apply = !!opts.apply;
  const id = String(opts.id || '').trim();
  const name = String(opts.name || '').trim();
  if (!name || name.length > 80) throw new ProvisionError('--name is required (at most 80 characters)');
  const domains = validateDomains(opts.domains, deps.defaultHosts);
  const adminEmail = opts.adminEmail ? validateEmail(opts.adminEmail) : null;
  const databaseId = deriveDatabaseId(id);
  validateRecord(id, { databaseId, status: 'provisioning', domains, name });

  const existing = await deps.registry.getWorkspace(id);
  if (existing && existing.status && existing.status !== 'provisioning') {
    throw new ProvisionError(`workspace "${id}" already exists and is "${existing.status}". create only resumes a workspace that is still provisioning (use activate / suspend / resume / status)`);
  }
  if (existing && existing.databaseId && existing.databaseId !== databaseId) {
    throw new ProvisionError(`workspace "${id}" is registered with database "${existing.databaseId}", expected "${databaseId}"`);
  }
  for (const host of domains) {
    const d = await deps.registry.getDomain(host);
    if (d && d.workspaceId !== id) throw new ProvisionError(`domain "${host}" already belongs to workspace "${d.workspaceId}"`);
  }
  const defaultDb = await deps.databases.get('(default)');
  const location = opts.location || (defaultDb && defaultDb.locationId);
  if (!location) throw new ProvisionError('--location is required (the default database\'s location could not be read)');

  // Every reason to REFUSE is checked here, before anything is changed — a refusal half-way through would
  // leave behind records, or a tenant nobody asked for.
  if (existing && existing.authTenantId && !(await deps.tenants.get(existing.authTenantId))) {
    throw new ProvisionError(`the registry names tenant "${existing.authTenantId}" for "${id}" but it does not exist in Identity Platform — fix or clear authTenantId in the registry`);
  }
  const dbBefore = await deps.databases.get(databaseId);
  if (dbBefore && dbBefore.exists && !existing) {
    throw new ProvisionError(`a database named "${databaseId}" already exists but workspace "${id}" was not registered before — refusing to adopt a database this tool did not create`);
  }

  const run = makeRunner(apply);
  const ctx = { tenantId: existing && existing.authTenantId ? existing.authTenantId : null, dbExists: false };

  // 1. the registry record (inactive)
  await run.step('registry record', {
    check: async () => {
      const same = existing && existing.name === name && existing.databaseId === databaseId && existing.primaryDomain === domains[0]
        && JSON.stringify(existing.domains || []) === JSON.stringify(domains);
      return same ? { done: true, detail: 'already recorded' } : { done: false, plan: `record "${name}" as ${id} (database ${databaseId}), status provisioning` };
    },
    run: async () => {
      const now = deps.now();
      await deps.registry.upsertWorkspace(id, { name, databaseId, domains, primaryDomain: domains[0], status: 'provisioning',
        createdAt: existing && existing.createdAt ? existing.createdAt : now, updatedAt: now });
      return 'recorded as provisioning (not served until activated)';
    },
  });

  // 2. the workspace's own sign-in pool
  await run.step('sign-in pool (Identity Platform tenant)', {
    check: async () => {
      if (ctx.tenantId) {
        if (!(await deps.tenants.get(ctx.tenantId))) throw new Error(`the registry names tenant "${ctx.tenantId}" but it does not exist in Identity Platform — fix or clear authTenantId in the registry`);
        return { done: true, detail: `tenant ${ctx.tenantId}` };
      }
      return { done: false, plan: `create tenant "${deriveTenantName(id)}" with email/password sign-in` };
    },
    run: async () => {
      const tenantId = await deps.tenants.create(deriveTenantName(id));
      validateRecord(id, { databaseId, status: 'provisioning', authTenantId: tenantId }); // the runtime must accept what we got back
      ctx.tenantId = tenantId;
      await deps.registry.upsertWorkspace(id, { authTenantId: tenantId, updatedAt: deps.now() }); // persist NOW so a re-run reuses it
      if (!(await deps.tenants.get(tenantId))) throw new Error(`tenant ${tenantId} was created but cannot be read back`);
      return `created tenant ${tenantId}`;
    },
  });

  // 3. the workspace's own database
  await run.step(`database (${databaseId})`, {
    check: async () => {
      const db = await deps.databases.get(databaseId);
      if (db && db.exists) {
        if (!existing) throw new Error(`a database named "${databaseId}" already exists but this workspace was not registered before — refusing to adopt a database this tool did not create`);
        ctx.dbExists = true;
        return { done: true, detail: 'exists' };
      }
      return { done: false, plan: `create in ${location}, production mode, delete protection on${opts.pitr ? ', point-in-time recovery on' : ''}` };
    },
    run: async () => {
      await deps.databases.create(databaseId, { location, pitr: !!opts.pitr });
      const db = await deps.databases.get(databaseId);
      if (!db || !db.exists) throw new Error('created but cannot be read back');
      ctx.dbExists = true;
      return `created in ${location}`;
    },
  });

  // 4. rules scoped to this workspace's tenant
  if (!ctx.tenantId || (!ctx.dbExists && !apply)) {
    run.skip('security rules', 'depends on the tenant and database above');
  } else {
    const { text } = buildRules(deps.baseRules, { tenantId: ctx.tenantId });
    const hash = sha(text);
    await run.step('security rules (scoped to this tenant)', {
      check: async () => {
        const rec = existing || {};
        return rec.rulesHash === hash && rec.rulesState === 'scoped' && rec.rulesTenant === ctx.tenantId
          ? { done: true, detail: 'already deployed and current' }
          : { done: false, plan: `deploy rules for tenant ${ctx.tenantId} (${hash.slice(0, 8)})` };
      },
      run: async () => {
        await deps.rules.deploy(databaseId, text, { dryRun: true });  // compile check first: a rules error must not reach the database
        await deps.rules.deploy(databaseId, text, { dryRun: false });
        await deps.registry.upsertWorkspace(id, { rulesHash: hash, rulesState: 'scoped', rulesTenant: ctx.tenantId, rulesDeployedAt: deps.now(), updatedAt: deps.now() });
        return `deployed (${hash.slice(0, 8)})`;
      },
    });
  }

  // 5. domains in the registry
  await run.step('domains in the registry', {
    check: async () => {
      const missing = [];
      for (const h of domains) { const d = await deps.registry.getDomain(h); if (!d || d.workspaceId !== id) missing.push(h); }
      return missing.length ? { done: false, plan: `register ${missing.join(', ')}`, missing } : { done: true, detail: domains.join(', ') };
    },
    run: async state => { for (const h of state.missing) await deps.registry.setDomain(h, id); return `registered ${state.missing.join(', ')}`; },
  });

  // 6. Firebase Auth authorized domains (invite and password-reset links return to the client's domain)
  await run.step('authorized domains (Firebase Auth)', {
    check: async () => {
      const have = await deps.authDomains.list();
      const missing = domains.filter(h => !have.includes(h));
      return missing.length ? { done: false, plan: `add ${missing.join(', ')}`, missing, before: have } : { done: true, detail: 'all present' };
    },
    run: async state => {
      for (const h of state.missing) await deps.authDomains.add(h);
      const after = await deps.authDomains.list();
      const lost = state.before.filter(h => !after.includes(h));
      if (lost.length) throw new Error(`DOMAINS WERE LOST while adding: ${lost.join(', ')} — restore them in the Firebase console immediately`);
      if (state.missing.some(h => !after.includes(h))) throw new Error('a domain was not added');
      return `added ${state.missing.join(', ')} (${state.before.length} existing domains preserved)`;
    },
  });

  // 7. seed data and the first admin
  if (!ctx.tenantId || !ctx.dbExists) {
    run.skip('seed data', 'depends on the tenant and database above');
  } else {
    await run.step('site settings', {
      check: async () => (await deps.workspaceDb.getDoc(databaseId, 'settings/site')) ? { done: true, detail: 'present' } : { done: false, plan: `create settings/site with the name "${name}"` },
      run: async () => { await deps.workspaceDb.setDoc(databaseId, 'settings/site', { siteName: name, createdAt: deps.now() }, { merge: true }); return 'created'; },
    });
  }
  let invite = null;
  if (adminEmail) {
    if (!ctx.tenantId || !ctx.dbExists) run.skip('first admin', 'depends on the tenant and database above');
    else {
      await run.step(`first admin (${adminEmail})`, {
        check: async () => ({ done: false, plan: `create the user in the tenant, an admin record, and a ${INVITE_HOURS_DEFAULT}-hour activation link` }),
        run: async () => {
          invite = await inviteAdmin(deps, { id, email: adminEmail, name: opts.adminName, apply: true });
          return invite.reusedInvite ? 'admin exists; reused the unused activation link' : 'admin and activation link created';
        },
      });
    }
  }

  // 8. backups
  if (opts.backups && ctx.dbExists) await ensureBackupSchedule(deps, databaseId, opts.backups, apply, run, databaseId);

  const next = [
    `Attach ${domains.join(', ')} to the Netlify site and point DNS at it — do this LAST: until you do, the workspace is not reachable.`,
    'Make sure ALLOW_MULTI_WORKSPACE=true is set on the Netlify site (once, for the first client) — see "Turning it on" in docs/MULTI-WORKSPACE.md.',
    `Check everything: node scripts/workspace.js status ${id}`,
    `Go live: node scripts/workspace.js activate ${id} --apply`,
  ];
  if (invite) next.push(`Send the first admin their link (expires in ${INVITE_HOURS_DEFAULT} h; it works once the workspace is active): ${invite.activationUrl}`);
  return { ok: true, applied: apply, steps: run.steps, data: { id, databaseId, tenantId: ctx.tenantId, domains, activationUrl: invite ? invite.activationUrl : null }, next };
}

// ── activate ────────────────────────────────────────────────────────────────
async function checkReadiness(deps, id, ws) {
  const issues = [];
  const databaseId = ws.databaseId || deriveDatabaseId(id);
  if (!ws.authTenantId) issues.push('no sign-in pool (authTenantId)');
  else if (!(await deps.tenants.get(ws.authTenantId))) issues.push(`tenant ${ws.authTenantId} does not exist`);
  const db = await deps.databases.get(databaseId);
  if (!db || !db.exists) issues.push(`database ${databaseId} does not exist`);
  if (!ws.rulesHash || ws.rulesState !== 'scoped') issues.push('security rules for this workspace have not been deployed');
  else if (ws.authTenantId && ws.rulesTenant !== ws.authTenantId) issues.push('the deployed rules are for a different tenant');
  // The most important gate: once a client is live its users are signed in to this project, so YOUR
  // database must already refuse them. Not optional, and not something to discover afterwards.
  const platform = await deps.registry.getPlatformState();
  if (!platform.defaultRulesDeployedAt) issues.push('your own (default) database has not been protected yet — run: node scripts/workspace.js protect-default --apply --i-have-tested-in-the-emulator');
  const domains = ws.domains || [];
  if (!domains.length) issues.push('no domains');
  for (const h of domains) { const d = await deps.registry.getDomain(h); if (!d || d.workspaceId !== id) issues.push(`domain ${h} is not registered to this workspace`); }
  const have = await deps.authDomains.list();
  for (const h of domains) if (!have.includes(h)) issues.push(`domain ${h} is not an authorized domain in Firebase Auth`);
  return issues;
}

async function activateWorkspace(deps, { id, apply }) {
  const ws = await deps.registry.getWorkspace(id);
  if (!ws) throw new ProvisionError(`workspace "${id}" does not exist`);
  if (ws.status === 'active') return { ok: true, steps: [{ name: 'activate', status: 'ok', detail: 'already active' }], next: [] };
  if (ws.status !== 'provisioning') throw new ProvisionError(`workspace "${id}" is "${ws.status}". activate is only for a workspace that is still provisioning (use resume for a suspended one)`);
  const issues = await checkReadiness(deps, id, ws);
  if (issues.length) throw new ProvisionError(`workspace "${id}" is not ready to go live:\n  - ${issues.join('\n  - ')}`, { issues });
  if (!apply) return { ok: true, applied: false, steps: [{ name: 'activate', status: 'planned', detail: 'all readiness checks pass; would set status to active' }], next: [] };
  await deps.registry.upsertWorkspace(id, { status: 'active', activatedAt: deps.now(), updatedAt: deps.now() });
  return { ok: true, applied: true, steps: [{ name: 'activate', status: 'done', detail: 'status is now active (the runtime picks this up within about a minute)' }],
    next: ['Confirm sign-in on the client\'s domain, and that the same login is refused on your own domain.'] };
}

// ── suspend / resume ────────────────────────────────────────────────────────
// Suspending blocks BOTH layers: the server (status -> 403 within a minute) and the browser (the
// database is switched to deny-all rules, so a still-valid session token cannot read or write).
async function suspendWorkspace(deps, { id, apply }) {
  const ws = await deps.registry.getWorkspace(id);
  if (!ws) throw new ProvisionError(`workspace "${id}" does not exist`);
  const databaseId = ws.databaseId || deriveDatabaseId(id);
  const run = makeRunner(apply);
  await run.step('stop serving requests (registry status)', {
    check: async () => ws.status === 'suspended' ? { done: true, detail: 'already suspended' } : { done: false, plan: `set status ${ws.status} -> suspended` },
    run: async () => { await deps.registry.upsertWorkspace(id, { status: 'suspended', suspendedAt: deps.now(), updatedAt: deps.now() }); return 'status is suspended (effective within about a minute)'; },
  });
  await run.step('lock the database against browsers (deny-all rules)', {
    check: async () => ws.rulesState === 'deny-all' ? { done: true, detail: 'already deny-all' } : { done: false, plan: `deploy deny-all rules to ${databaseId}` },
    run: async () => {
      try { await deps.rules.deploy(databaseId, DENY_ALL_RULES, { dryRun: false }); }
      catch (e) { throw new Error(`${e.message}\n  The workspace is suspended for the SERVER but browsers may still reach its database until this succeeds. Re-run: node scripts/workspace.js suspend ${id} --apply`); }
      await deps.registry.upsertWorkspace(id, { rulesState: 'deny-all', rulesHash: sha(DENY_ALL_RULES), updatedAt: deps.now() });
      return 'deny-all rules deployed';
    },
  });
  return { ok: true, applied: apply, steps: run.steps, next: [`To restore: node scripts/workspace.js resume ${id} --apply`] };
}

async function resumeWorkspace(deps, { id, apply }) {
  const ws = await deps.registry.getWorkspace(id);
  if (!ws) throw new ProvisionError(`workspace "${id}" does not exist`);
  if (ws.status !== 'suspended') throw new ProvisionError(`workspace "${id}" is "${ws.status}", not suspended`);
  if (!ws.authTenantId) throw new ProvisionError(`workspace "${id}" has no sign-in pool`);
  const databaseId = ws.databaseId || deriveDatabaseId(id);
  const { text } = buildRules(deps.baseRules, { tenantId: ws.authTenantId });
  const hash = sha(text);
  const run = makeRunner(apply);
  // Rules FIRST, status second: if the rules cannot be restored the workspace must stay suspended.
  await run.step('restore the scoped rules', {
    check: async () => ({ done: false, plan: `deploy rules for tenant ${ws.authTenantId} to ${databaseId}` }),
    run: async () => {
      await deps.rules.deploy(databaseId, text, { dryRun: true });
      await deps.rules.deploy(databaseId, text, { dryRun: false });
      await deps.registry.upsertWorkspace(id, { rulesState: 'scoped', rulesHash: hash, rulesTenant: ws.authTenantId, rulesDeployedAt: deps.now(), updatedAt: deps.now() });
      return 'deployed';
    },
  });
  await run.step('start serving requests (registry status)', {
    check: async () => ({ done: false, plan: 'set status suspended -> active' }),
    run: async () => { await deps.registry.upsertWorkspace(id, { status: 'active', suspendedAt: null, resumedAt: deps.now(), updatedAt: deps.now() }); return 'status is active'; },
  });
  return { ok: true, applied: apply, steps: run.steps, next: [] };
}

// ── rules for many databases (what CI runs after firestore.rules changes) ───
// check: compile only (CLI --dry-run), release nothing. apply: release. Neither: just say what would happen.
async function deployRules(deps, { ids, all, includeDefault, includePlatform, check, apply }) {
  const results = []; let failed = 0;
  const targets = [];
  const workspaces = await deps.registry.listWorkspaces();
  for (const ws of workspaces) {
    if (ids && ids.length && !ids.includes(ws.id)) continue;
    if (!all && !(ids && ids.length)) continue;
    if (!ws.authTenantId) { results.push({ target: ws.id, status: 'skipped', detail: 'no sign-in pool yet' }); continue; }
    const databaseId = ws.databaseId || deriveDatabaseId(ws.id);
    // A suspended workspace must STAY locked: never let a routine redeploy re-open it.
    const suspended = ws.status === 'suspended';
    const text = suspended ? DENY_ALL_RULES : buildRules(deps.baseRules, { tenantId: ws.authTenantId }).text;
    targets.push({ target: ws.id, databaseId, text, state: suspended ? 'deny-all' : 'scoped', ws, label: suspended ? 'deny-all (suspended)' : `scoped to ${ws.authTenantId}` });
  }
  if (includeDefault && apply && !check) {
    const platform = await deps.registry.getPlatformState();
    if (!platform.defaultRulesDeployedAt) throw new ProvisionError('the default database\'s rules have never been changed by protect-default. Do that first, deliberately (it changes your live rules): node scripts/workspace.js protect-default --apply --i-have-tested-in-the-emulator');
  }
  if (includeDefault) targets.push({ target: '(default)', databaseId: '(default)', text: buildRules(deps.baseRules, { tenantId: null }).text, state: 'default-variant', label: 'default variant (rejects any tenant\'s users)' });
  if (includePlatform) targets.push({ target: deps.platformDatabaseId, databaseId: deps.platformDatabaseId, text: DENY_ALL_RULES, state: 'deny-all', label: 'deny-all (holds client secrets)' });

  for (const t of targets) {
    const hash = sha(t.text);
    const current = t.ws && t.ws.rulesHash === hash && t.ws.rulesState === t.state;
    try {
      if (check) { await deps.rules.deploy(t.databaseId, t.text, { dryRun: true }); results.push({ target: t.target, status: 'ok', detail: `compiles — ${t.label}` }); continue; }
      if (!apply) { results.push({ target: t.target, status: 'planned', detail: `${t.label}${current ? ' (already current)' : ''}` }); continue; }
      await deps.rules.deploy(t.databaseId, t.text, { dryRun: true });
      await deps.rules.deploy(t.databaseId, t.text, { dryRun: false });
      if (t.ws) await deps.registry.upsertWorkspace(t.target, { rulesHash: hash, rulesState: t.state, rulesTenant: t.ws.authTenantId, rulesDeployedAt: deps.now(), updatedAt: deps.now() });
      results.push({ target: t.target, status: 'done', detail: t.label });
    } catch (e) { failed++; results.push({ target: t.target, status: 'failed', detail: e.message }); }
  }
  return { ok: failed === 0, steps: results.map(r => ({ name: r.target, status: r.status, detail: r.detail })), failed };
}

// ── the protected default database ──────────────────────────────────────────
// Once any tenant exists its users are signed in too, so the default database must refuse them.
// This changes the LIVE database's rules, so it is its own gated step.
async function protectDefault(deps, { apply }) {
  const { text } = buildRules(deps.baseRules, { tenantId: null });
  const run = makeRunner(apply);
  await run.step('default database rules (reject any tenant\'s users)', {
    check: async () => ({ done: false, plan: `deploy the default-variant rules to (default) (${sha(text).slice(0, 8)})` }),
    run: async () => {
      await deps.rules.deploy('(default)', text, { dryRun: true });
      await deps.rules.deploy('(default)', text, { dryRun: false });
      await deps.registry.setPlatformState({ defaultRulesDeployedAt: deps.now(), defaultRulesHash: sha(text) });
      return 'deployed';
    },
  });
  return { ok: true, applied: apply, steps: run.steps, next: ['Set the repository variable MULTI_WORKSPACE=true so CI keeps deploying THIS variant, not the plain firestore.rules (see docs/MULTI-WORKSPACE.md).'] };
}

// ── one-time platform setup ─────────────────────────────────────────────────
async function initPlatform(deps, { apply, location, pitr }) {
  const run = makeRunner(apply);
  const platform = deps.platformDatabaseId;
  await run.step('multi-tenancy is enabled in Identity Platform', {
    check: async () => { await deps.tenants.probe(); return { done: true, detail: 'tenants can be listed' }; },
    run: async () => '',
  });
  const defaultDb = await deps.databases.get('(default)');
  const loc = location || (defaultDb && defaultDb.locationId);
  if (!loc) throw new ProvisionError('--location is required (the default database\'s location could not be read)');
  await run.step(`platform database (${platform})`, {
    check: async () => { const db = await deps.databases.get(platform); return db && db.exists ? { done: true, detail: 'exists' } : { done: false, plan: `create in ${loc}, delete protection on` }; },
    run: async () => { await deps.databases.create(platform, { location: loc, pitr: !!pitr }); const db = await deps.databases.get(platform); if (!db || !db.exists) throw new Error('created but cannot be read back'); return `created in ${loc}`; },
  });
  await run.step('platform database rules (deny everything to browsers)', {
    check: async () => ({ done: false, plan: `deploy deny-all rules to ${platform}` }),
    run: async () => { await deps.rules.deploy(platform, DENY_ALL_RULES, { dryRun: false }); return 'deployed'; },
  });
  return { ok: true, applied: apply, steps: run.steps, next: ['Protect your own database before any client exists: node scripts/workspace.js protect-default --apply --i-have-tested-in-the-emulator'] };
}

// ── status ──────────────────────────────────────────────────────────────────
async function workspaceStatus(deps, { id }) {
  const all = await deps.registry.listWorkspaces();
  const list = id ? all.filter(w => w.id === id) : all;
  if (id && !list.length) throw new ProvisionError(`workspace "${id}" does not exist`);
  const have = await deps.authDomains.list();
  const rows = [];
  for (const ws of list) {
    const issues = [];
    const databaseId = ws.databaseId || deriveDatabaseId(ws.id);
    let tenantOk = false, dbOk = false;
    if (!ws.authTenantId) issues.push('no sign-in pool'); else { tenantOk = !!(await deps.tenants.get(ws.authTenantId)); if (!tenantOk) issues.push(`tenant ${ws.authTenantId} missing`); }
    const db = await deps.databases.get(databaseId); dbOk = !!(db && db.exists); if (!dbOk) issues.push(`database ${databaseId} missing`);
    for (const h of ws.domains || []) {
      const d = await deps.registry.getDomain(h);
      if (!d || d.workspaceId !== ws.id) issues.push(`domain ${h} not registered to it`);
      if (!have.includes(h)) issues.push(`domain ${h} not authorized in Firebase Auth`);
    }
    // rules drift: the deployed rules should be exactly what the current firestore.rules produces for this workspace
    if (ws.authTenantId) {
      const expectText = ws.status === 'suspended' ? DENY_ALL_RULES : buildRules(deps.baseRules, { tenantId: ws.authTenantId }).text;
      const expectState = ws.status === 'suspended' ? 'deny-all' : 'scoped';
      if (!ws.rulesHash) issues.push('rules never deployed');
      else if (ws.rulesState !== expectState) issues.push(`rules state is "${ws.rulesState}", expected "${expectState}"`);
      else if (ws.rulesHash !== sha(expectText)) issues.push('rules are OUT OF DATE (firestore.rules changed since they were deployed) — run deploy-rules');
    }
    const schedules = dbOk ? (await deps.backups.listSchedules(databaseId)).length : 0;
    if (dbOk && !schedules) issues.push('no backup schedule');
    const secretKeys = await deps.registry.getSecretKeys(ws.id);
    rows.push({ id: ws.id, name: ws.name, status: ws.status, tenant: ws.authTenantId || null, database: databaseId, domains: ws.domains || [], backups: schedules, secrets: secretKeys, issues });
  }
  // The runtime refuses an active workspace with these gaps; surface them before a client notices.
  const platform = await deps.registry.getPlatformState();
  const platformIssues = [];
  if (list.length && !platform.defaultRulesDeployedAt) platformIssues.push('your own (default) database is NOT protected against client users — run protect-default before any client goes live');
  return { ok: rows.every(r => !r.issues.length) && !platformIssues.length, rows, platform: { defaultProtected: !!platform.defaultRulesDeployedAt, issues: platformIssues } };
}

// ── secrets (names and lengths only — never values) ─────────────────────────
async function setSecret(deps, { id, key, value, apply }) {
  if (!W.SECRET_KEYS.includes(key)) throw new ProvisionError(`"${key}" is not a per-workspace setting. Valid keys: ${W.SECRET_KEYS.join(', ')}`);
  if (typeof value !== 'string' || !value.trim()) throw new ProvisionError('the value is empty');
  if (value.length > 4096) throw new ProvisionError('the value is too long (4096 characters at most)');
  if (!(await deps.registry.getWorkspace(id))) throw new ProvisionError(`workspace "${id}" does not exist`);
  if (!apply) return { ok: true, applied: false, steps: [{ name: `set ${key}`, status: 'planned', detail: `${value.length} characters` }] };
  await deps.registry.setSecret(id, key, value.trim());
  return { ok: true, applied: true, steps: [{ name: `set ${key}`, status: 'done', detail: `${value.trim().length} characters stored (takes effect within about a minute)` }] };
}
async function unsetSecret(deps, { id, key, apply }) {
  if (!W.SECRET_KEYS.includes(key)) throw new ProvisionError(`"${key}" is not a per-workspace setting`);
  if (!(await deps.registry.getWorkspace(id))) throw new ProvisionError(`workspace "${id}" does not exist`);
  if (!apply) return { ok: true, applied: false, steps: [{ name: `unset ${key}`, status: 'planned', detail: '' }] };
  await deps.registry.unsetSecret(id, key);
  return { ok: true, applied: true, steps: [{ name: `unset ${key}`, status: 'done', detail: 'removed' }] };
}
async function listSecrets(deps, { id }) {
  if (!(await deps.registry.getWorkspace(id))) throw new ProvisionError(`workspace "${id}" does not exist`);
  return { ok: true, keys: await deps.registry.getSecretKeys(id) };
}

// ── backups for existing databases ──────────────────────────────────────────
async function ensureBackups(deps, { ids, all, retention, recurrence, pitr, apply }) {
  const run = makeRunner(apply);
  const targets = [{ label: '(default)', databaseId: '(default)' }, { label: deps.platformDatabaseId, databaseId: deps.platformDatabaseId }];
  for (const ws of await deps.registry.listWorkspaces()) {
    if (all || (ids && ids.includes(ws.id))) targets.push({ label: ws.id, databaseId: ws.databaseId || deriveDatabaseId(ws.id) });
  }
  const seen = new Set();
  for (const t of targets) {
    if (seen.has(t.databaseId)) continue; seen.add(t.databaseId);
    const db = await deps.databases.get(t.databaseId);
    if (!db || !db.exists) { run.skip(`backups: ${t.label}`, 'database does not exist'); continue; }
    await ensureBackupSchedule(deps, t.databaseId, { retention, recurrence }, apply, run, t.label);
    if (pitr) {
      await run.step(`point-in-time recovery: ${t.label}`, {
        check: async () => db.pitr ? { done: true, detail: 'already enabled' } : { done: false, plan: 'enable (7-day window; billed for the extra storage)' },
        run: async () => { await deps.databases.setPitr(t.databaseId); return 'enabled'; },
      });
    }
  }
  return { ok: true, applied: apply, steps: run.steps };
}

// ── doctor: read-only pre-flight ────────────────────────────────────────────
// Run this before anything real. Each check only READS, and a failure says which permission or setting to fix.
async function doctor(deps) {
  const checks = [];
  const check = async (name, fn, hint) => {
    try { const detail = await fn(); checks.push({ name, ok: true, detail: detail || '' }); }
    catch (e) { checks.push({ name, ok: false, detail: String(e.message || e).split('\n')[0].slice(0, 220), hint }); }
  };
  await check('credentials and project', async () => `project ${deps.project}`);
  await check('Firebase CLI', async () => `${deps.cli.command()} (version ${deps.cli.version()})`, 'install firebase-tools, or set FIREBASE_CLI');
  let dbs = null;
  await check('can list Firestore databases', async () => { dbs = await deps.databases.list(); return `${dbs.length} database(s): ${dbs.join(', ')}`; },
    'the service account needs permission to list/create Firestore databases (e.g. role "Cloud Datastore Owner")');
  await check('default database location is readable', async () => { const d = await deps.databases.get('(default)'); if (!d.locationId) throw new Error('no location returned'); return d.locationId; });
  await check(`platform database "${deps.platformDatabaseId}" exists`, async () => {
    const d = await deps.databases.get(deps.platformDatabaseId); if (!d.exists) throw new Error('not created yet'); return 'exists';
  }, 'run: node scripts/workspace.js init --apply');
  await check('registry is readable', async () => `${(await deps.registry.listWorkspaces()).length} workspace(s) registered`, 'needs the platform database (see above) and read access to it');
  await check('Identity Platform multi-tenancy is enabled', async () => { await deps.tenants.probe(); return 'tenants can be listed'; },
    'upgrade the project to Identity Platform, then Settings → Security → "Allow tenants"; the account needs Identity Platform admin permission');
  await check('Firebase Auth authorized domains are readable', async () => `${(await deps.authDomains.list()).length} domain(s)`,
    'the service account needs permission to read Identity Platform config');
  await check('rules generator works on the committed firestore.rules', async () => {
    buildRules(deps.baseRules, { tenantId: 'doctor-check' }); buildRules(deps.baseRules, { tenantId: null }); return 'tenant and default variants build';
  });
  return { ok: checks.every(c => c.ok), checks };
}

module.exports = {
  createWorkspace, activateWorkspace, suspendWorkspace, resumeWorkspace, deployRules, protectDefault,
  initPlatform, doctor, workspaceStatus, setSecret, unsetSecret, listSecrets, ensureBackups, inviteAdmin,
  ProvisionError, DENY_ALL_RULES, validateDomains, deriveDatabaseId, deriveTenantName, PLATFORM_DB_DEFAULT, INVITE_HOURS_DEFAULT,
};
