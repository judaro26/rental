#!/usr/bin/env node
// scripts/workspace.js — operate client workspaces: provision, activate, suspend, back up.
//
//   node scripts/workspace.js help
//
// EVERYTHING THAT CHANGES SOMETHING IS PLAN-ONLY UNLESS YOU PASS --apply. Run it once without
// --apply to see exactly what it would do, then again with --apply.
//
// Credentials: FIREBASE_SERVICE_ACCOUNT (the key JSON) or GOOGLE_APPLICATION_CREDENTIALS (a path).
// Use an OPERATOR service account — not the runtime one in Netlify. See docs/MULTI-WORKSPACE.md.

'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./lib/provision');

const HELP = `
Usage: node scripts/workspace.js <command> [options]

Setup (once)
  doctor                       Read-only pre-flight: credentials, CLI, permissions, multi-tenancy, registry.
  init                         Create the platform database (holds client secrets) with deny-all rules.
  protect-default              Change YOUR OWN database's rules so a client's users cannot reach it.
                               Needs --i-have-tested-in-the-emulator.

A client
  create <id> --name "Acme Rentals" --domain portal.acme.com [--domain ...]
         [--admin-email a@b.com] [--admin-name "Pat"] [--location nam5] [--pitr] [--backups daily:30d]
                               Builds everything for a client and leaves it INACTIVE.
  invite-admin <id> --email a@b.com [--name "Pat"]
                               A fresh activation link for an admin (also the way to add more admins).
  status [<id>]                Health of every workspace; exits 2 if anything needs attention.
  activate <id>                Go live (only after every readiness check passes).
  suspend <id>                 Lock a client out of the server AND the browser.
  resume <id>                  Lift a suspension.

Rules, secrets, backups
  deploy-rules [<id>...] [--all] [--default] [--platform] [--check]
                               Redeploy scoped rules (what CI runs after firestore.rules changes).
                               --check only compiles them; releases nothing.
  set-secret <id> <KEY>        Store one setting (e.g. STRIPE_SECRET_KEY). The value is read from stdin
                               or a hidden prompt — never from the command line.
  unset-secret <id> <KEY>      Remove one.
  list-secrets <id>            Names only; values are never shown.
  backups [<id>...] [--all] [--retention 30d] [--recurrence daily|weekly] [--pitr]
                               Make sure every database has a backup schedule.
  backup-blobs <id|default> [--all] --out <dir>     Back up documents/invoices (Netlify Blobs) to a folder.
  restore-blobs <id> --from <dir> [--overwrite]     Restore them (verifies every checksum first).

Options
  --apply                      Actually do it (otherwise: plan only).
  --project <id>               Firebase project (default: the credentials' project).
  --json                       Machine-readable output.
`;

class UsageError extends Error {}

const BOOLEAN = new Set(['apply', 'json', 'pitr', 'check', 'all', 'default', 'platform', 'overwrite', 'help', 'i-have-tested-in-the-emulator']);
const VALUED = new Set(['name', 'domain', 'admin-email', 'admin-name', 'email', 'location', 'backups', 'project', 'out', 'from', 'retention', 'recurrence']);

function parseArgs(argv) {
  const positional = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (BOOLEAN.has(name)) { flags[name] = eq > 0 ? a.slice(eq + 1) !== 'false' : true; continue; }
    if (!VALUED.has(name)) throw new UsageError(`unknown option --${name} (run "help" for the list)`);
    const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (val === undefined || (eq < 0 && String(val).startsWith('--'))) throw new UsageError(`--${name} needs a value`);
    if (name === 'domain') (flags.domain = flags.domain || []).push(val); else flags[name] = val;
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

// "daily:30d" -> { recurrence: 'DAILY', retention: '30d' }
function parseBackups(spec, defaults = {}) {
  if (!spec) return null;
  const m = /^(daily|weekly):(\d+)([hdw])$/i.exec(String(spec));
  if (!m) throw new UsageError(`--backups must look like daily:30d or weekly:12w (got "${spec}")`);
  const n = Number(m[2]); const unit = m[3].toLowerCase();
  if (!n) throw new UsageError('the backup retention must be greater than zero');
  return { recurrence: m[1].toUpperCase(), retention: unit === 'w' ? `${n * 7}d` : `${n}${unit}` };
}

const ICON = { ok: '✓', done: '✓', planned: '→', failed: '✗', skipped: '–' };
function renderSteps(steps, out) { for (const s of steps) out(`  ${ICON[s.status] || '?'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`); }

function present(result, flags, out) {
  if (flags.json) return out(JSON.stringify(result, null, 2));
  if (result.steps) renderSteps(result.steps, out);
  if (result.applied === false) out('\nPLAN ONLY — nothing was changed. Run again with --apply to do it.');
  if (result.next && result.next.length) { out('\nNext:'); result.next.forEach((n, i) => out(`  ${i + 1}. ${n}`)); }
}

// ── reading a secret without putting it on the command line ─────────────────
async function readSecretValue(io) {
  if (io.readSecret) return io.readSecret();
  if (process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      process.stdout.write('Value (input is hidden): ');
      let value = '';
      process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
      const onData = ch => {
        for (const c of ch) {
          if (c === '\u0003') { process.stdin.setRawMode(false); process.stdout.write('\n'); return reject(new UsageError('cancelled')); }
          if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); return resolve(value); }
          if (c === '\u007f' || c === '\b') value = value.slice(0, -1); else value += c;
        }
      };
      process.stdin.on('data', onData);
    });
  }
  let data = ''; process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

// ── real dependencies ───────────────────────────────────────────────────────
async function realMakeDeps(flags, env = process.env) {
  const { loadCredentials, makeDrivers } = require('./lib/drivers');
  const creds = loadCredentials({ env });
  const admin = require('firebase-admin');
  const project = flags.project || env.FIREBASE_PROJECT_ID || creds.projectId;
  admin.initializeApp({ credential: admin.credential.cert(creds.json || creds.path), projectId: project });
  const baseRules = fs.readFileSync(path.resolve(__dirname, '../firestore.rules'), 'utf8');
  const deps = makeDrivers({ project, admin, creds, env, baseRules });
  deps.cleanup = creds.cleanup;
  deps.openBlobStore = prefix => base => {
    const siteID = env.NETLIFY_SITE_ID || env.SITE_ID, token = env.NETLIFY_API_TOKEN;
    if (!siteID || !token) throw new UsageError('NETLIFY_SITE_ID and NETLIFY_API_TOKEN are needed to reach the Blobs stores');
    return require('@netlify/blobs').getStore({ name: prefix + base, consistency: 'strong', siteID, token });
  };
  return deps;
}

// ── commands ────────────────────────────────────────────────────────────────
const need = (positional, n, usage) => { if (positional.length < n) throw new UsageError(`usage: ${usage}`); };

async function run(command, positional, flags, deps, io, out) {
  const apply = !!flags.apply;
  switch (command) {
    case 'doctor': {
      const r = await P.doctor(deps);
      if (flags.json) out(JSON.stringify(r, null, 2));
      else { for (const c of r.checks) { out(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`); if (!c.ok && c.hint) out(`      fix: ${c.hint}`); } out(r.ok ? '\nAll checks passed.' : '\nSome checks failed — fix them before running anything with --apply.'); }
      return r.ok ? 0 : 1;
    }
    case 'init': { const r = await P.initPlatform(deps, { apply, location: flags.location, pitr: flags.pitr }); present(r, flags, out); return 0; }
    case 'protect-default': {
      if (apply && !flags['i-have-tested-in-the-emulator']) throw new UsageError('protect-default changes the LIVE rules of your own database. Test the generated rules in the Firebase Emulator first (docs/MULTI-WORKSPACE.md), then pass --i-have-tested-in-the-emulator.');
      const r = await P.protectDefault(deps, { apply }); present(r, flags, out); return 0;
    }
    case 'create': {
      need(positional, 1, 'create <id> --name "..." --domain host [--domain host] [--admin-email e]');
      const r = await P.createWorkspace(deps, { id: positional[0], name: flags.name, domains: flags.domain, adminEmail: flags['admin-email'], adminName: flags['admin-name'],
        location: flags.location, pitr: flags.pitr, backups: parseBackups(flags.backups), apply });
      present(r, flags, out); return 0;
    }
    case 'invite-admin': {
      need(positional, 1, 'invite-admin <id> --email a@b.com [--name "..."]');
      if (!flags.email) throw new UsageError('--email is required');
      const r = await P.inviteAdmin(deps, { id: positional[0], email: flags.email, name: flags.name, apply });
      if (flags.json) out(JSON.stringify(r, null, 2));
      else if (r.planned) out(`PLAN ONLY — would create ${r.email} in tenant ${r.tenantId} and a ${P.INVITE_HOURS_DEFAULT}-hour activation link. Run again with --apply.`);
      else out(`${r.userCreated ? 'Created' : 'Found'} the user.${r.reusedInvite ? ' Reusing the unused link.' : ''}\nActivation link (works once, expires ${r.expiresAt.toISOString()}):\n  ${r.activationUrl}`);
      return 0;
    }
    case 'activate': { need(positional, 1, 'activate <id>'); const r = await P.activateWorkspace(deps, { id: positional[0], apply }); present(r, flags, out); return 0; }
    case 'suspend': { need(positional, 1, 'suspend <id>'); const r = await P.suspendWorkspace(deps, { id: positional[0], apply }); present(r, flags, out); return 0; }
    case 'resume': { need(positional, 1, 'resume <id>'); const r = await P.resumeWorkspace(deps, { id: positional[0], apply }); present(r, flags, out); return 0; }
    case 'status': {
      const r = await P.workspaceStatus(deps, { id: positional[0] });
      if (flags.json) { out(JSON.stringify(r, null, 2)); return r.ok ? 0 : 2; }
      out(`Your own (default) database protected against client users: ${r.platform.defaultProtected ? 'yes' : 'NO'}`);
      r.platform.issues.forEach(i => out(`  ✗ ${i}`));
      if (!r.rows.length) out('\nNo workspaces yet.');
      for (const w of r.rows) {
        out(`\n${w.id}  "${w.name}"  [${w.status}]`);
        out(`  tenant ${w.tenant || '—'}  |  database ${w.database}  |  backups ${w.backups}`);
        out(`  domains: ${w.domains.join(', ') || '—'}`);
        out(`  settings stored: ${w.secrets.length ? w.secrets.join(', ') : '(none)'}`);
        w.issues.forEach(i => out(`  ✗ ${i}`));
      }
      out(r.ok ? '\nEverything is in order.' : '\nSomething needs attention (see ✗ above).');
      return r.ok ? 0 : 2;
    }
    case 'deploy-rules': {
      const r = await P.deployRules(deps, { ids: positional, all: flags.all, includeDefault: flags.default, includePlatform: flags.platform, check: flags.check, apply });
      present({ ...r, applied: flags.check ? undefined : apply }, flags, out);
      return r.ok ? 0 : 1;
    }
    case 'set-secret': {
      need(positional, 2, 'set-secret <id> <KEY>   (the value is read from stdin or a hidden prompt)');
      const value = await readSecretValue(io);
      const r = await P.setSecret(deps, { id: positional[0], key: positional[1], value, apply }); present(r, flags, out); return 0;
    }
    case 'unset-secret': { need(positional, 2, 'unset-secret <id> <KEY>'); const r = await P.unsetSecret(deps, { id: positional[0], key: positional[1], apply }); present(r, flags, out); return 0; }
    case 'list-secrets': { need(positional, 1, 'list-secrets <id>'); const r = await P.listSecrets(deps, { id: positional[0] }); out(flags.json ? JSON.stringify(r, null, 2) : (r.keys.length ? r.keys.join('\n') : '(none)')); return 0; }
    case 'backups': {
      const spec = parseBackups(`${(flags.recurrence || 'daily')}:${flags.retention || '30d'}`);
      const r = await P.ensureBackups(deps, { ids: positional, all: flags.all, ...spec, pitr: flags.pitr, apply }); present(r, flags, out); return 0;
    }
    case 'backup-blobs': {
      need(positional, 1, 'backup-blobs <id|default> --out <dir>   (or --all)');
      if (!flags.out) throw new UsageError('--out <dir> is required');
      const { backupWorkspaceBlobs } = require('./lib/blobs');
      const ids = flags.all ? ['default', ...(await deps.registry.listWorkspaces()).map(w => w.id)] : [positional[0]];
      let ok = true;
      for (const id of ids) {
        if (id !== 'default' && !(await deps.registry.getWorkspace(id))) throw new UsageError(`workspace "${id}" does not exist`);
        const r = await backupWorkspaceBlobs({ openStore: deps.openBlobStore(id === 'default' ? '' : `ws-${id}-`), workspaceId: id, outDir: path.resolve(flags.out) });
        ok = ok && r.ok;
        out(flags.json ? JSON.stringify(r) : `${r.ok ? '✓' : '✗'} ${id}: ${r.blobs} blob(s), ${r.written} written, ${r.skipped} unchanged, ${r.failed.length} failed, ${(r.bytes / 1048576).toFixed(1)} MB → ${r.manifestPath}`);
        r.failed.forEach(f => out(`    ✗ ${f.store}/${f.key}: ${f.error}`));
      }
      out('\nThis folder holds sensitive client documents. Keep it encrypted and access-controlled.');
      return ok ? 0 : 1;
    }
    case 'restore-blobs': {
      need(positional, 1, 'restore-blobs <id> --from <dir> [--overwrite]');
      if (!flags.from) throw new UsageError('--from <dir> is required');
      const id = positional[0];
      if (id !== 'default' && !(await deps.registry.getWorkspace(id))) throw new UsageError(`workspace "${id}" does not exist`);
      const { restoreWorkspaceBlobs } = require('./lib/blobs');
      const r = await restoreWorkspaceBlobs({ openStore: deps.openBlobStore(id === 'default' ? '' : `ws-${id}-`), workspaceId: id, fromDir: path.resolve(flags.from), apply, overwrite: flags.overwrite });
      if (flags.json) out(JSON.stringify(r, null, 2));
      else if (!r.ok) out(`✗ ${r.error}\n${r.corrupt.map(c => `    ${c.store}/${c.key}`).join('\n')}`);
      else out(apply ? `✓ restored ${r.restored} blob(s); ${r.skippedExisting} already existed and were left alone.` : `PLAN ONLY — would restore ${r.planned} blob(s); ${r.skippedExisting} already exist and would be left alone. Run again with --apply.`);
      return r.ok ? 0 : 1;
    }
    default: throw new UsageError(`unknown command "${command}" (run "help")`);
  }
}

async function main(argv, io = {}) {
  const out = io.out || (s => process.stdout.write(s + '\n'));
  const err = io.err || (s => process.stderr.write(s + '\n'));
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { err(`${e.message}`); return 2; }
  const { command, positional, flags } = parsed;
  if (!command || command === 'help' || flags.help) { out(HELP.trim()); return command || flags.help ? 0 : 2; }

  let deps;
  try { deps = await (io.makeDeps || realMakeDeps)(flags); }
  catch (e) { err(`✗ ${e.message}`); return 1; }
  try { return await run(command, positional, flags, deps, io, out); }
  catch (e) {
    if (e instanceof UsageError) { err(`✗ ${e.message}`); return 2; }
    if (e && e.steps) { renderSteps(e.steps, out); }
    err(`✗ ${e.message || e}`);
    return 1;
  } finally { if (deps && deps.cleanup) deps.cleanup(); }
}

module.exports = { main, parseArgs, parseBackups, UsageError, HELP };

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e); process.exit(1); });
