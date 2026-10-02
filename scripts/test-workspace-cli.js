#!/usr/bin/env node
// scripts/test-workspace-cli.js
//
// The command-line layer (scripts/workspace.js): argument handling, the plan-only default, the gate on
// changing your own database's rules, exit codes, and that a secret never appears in any output.
// Drives main() with the in-memory fake drivers; nothing real is touched.
//
// Usage: node scripts/test-workspace-cli.js   (or: npm test)

const { main, parseArgs, parseBackups } = require('./workspace');
const { makeWorld, mutations } = require('./lib/test-world');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`\x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n  ' + String(detail).split('\n').join('\n  ') : ''}`); }
}

// run the CLI against a world; returns { code, out, err, world, cleaned }
async function cli(argv, { world = makeWorld(), secret } = {}) {
  const out = [], err = []; let cleaned = 0;
  const code = await main(argv, {
    out: s => out.push(s), err: s => err.push(s),
    makeDeps: async () => ({ ...world.deps, cleanup: () => { cleaned++; } }),
    readSecret: async () => secret,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), world, cleaned };
}
const CREATE = ['create', 'acme', '--name', 'Acme Rentals', '--domain', 'portal.acme.com', '--admin-email', 'owner@acme.com'];

(async () => {
  // ── argument handling ────────────────────────────────────────────────────
  {
    const a = parseArgs(['create', 'acme', '--name', 'A B', '--domain', 'x.com', '--domain=y.com', '--apply', '--pitr']);
    check('parseArgs: positional arguments, valued flags, repeatable --domain, --flag=value and boolean flags', a.command === 'create' && a.positional[0] === 'acme' && a.flags.name === 'A B' && a.flags.domain.join() === 'x.com,y.com' && a.flags.apply === true && a.flags.pitr === true);
    check('parseArgs: an unknown option is an error (a typo must not silently run)', (() => { try { parseArgs(['create', '--aply']); return false; } catch (e) { return /unknown option --aply/.test(e.message); } })());
    check('parseArgs: a valued option with no value is an error', (() => { try { parseArgs(['create', '--name']); return false; } catch (e) { return /needs a value/.test(e.message); } })());
    check('parseArgs: a valued option does not swallow the next flag as its value', (() => { try { parseArgs(['create', '--name', '--apply']); return false; } catch (e) { return /needs a value/.test(e.message); } })());
    check('there is NO --value option: a secret cannot be given on the command line', (() => { try { parseArgs(['set-secret', 'acme', 'STRIPE_SECRET_KEY', '--value', 'sk_x']); return false; } catch (e) { return /unknown option --value/.test(e.message); } })());
    check('parseBackups: daily:30d, weekly:12w (converted to days), and bad input', JSON.stringify(parseBackups('daily:30d')) === '{"recurrence":"DAILY","retention":"30d"}' && parseBackups('weekly:12w').retention === '84d' && parseBackups('') === null && (() => { try { parseBackups('every:week'); return false; } catch (e) { return /daily:30d/.test(e.message); } })() && (() => { try { parseBackups('daily:0d'); return false; } catch (e) { return /greater than zero/.test(e.message); } })());
  }

  // ── help and usage errors ────────────────────────────────────────────────
  {
    const none = await cli([]); const help = await cli(['help']);
    check('no command: prints the help and exits 2; "help" prints it and exits 0', none.code === 2 && help.code === 0 && /Usage:/.test(none.out) && ['doctor', 'create', 'activate', 'suspend', 'deploy-rules', 'set-secret', 'backup-blobs'].every(c => help.out.includes(c)));
    const r = await cli(['frobnicate']);
    check('an unknown command exits 2 and says so', r.code === 2 && /unknown command "frobnicate"/.test(r.err));
    const u = await cli(['create']);
    check('missing arguments exit 2 with the usage line', u.code === 2 && /usage: create/.test(u.err));
    const bad = await cli(['create', 'acme', '--bogus']);
    check('a bad option exits 2 BEFORE anything is read or changed', bad.code === 2 && mutations(bad.world.st).length === 0);
  }

  // ── plan only unless --apply ─────────────────────────────────────────────
  {
    const r = await cli(CREATE);
    check('create without --apply: exits 0, says PLAN ONLY, and changes NOTHING', r.code === 0 && /PLAN ONLY/.test(r.out) && mutations(r.world.st).length === 0 && /→ sign-in pool/.test(r.out));
    const a = await cli([...CREATE, '--domain', 'www.acme.com', '--apply']);
    check('create --apply: does it, registers EVERY --domain, and prints the next steps', a.code === 0 && !/PLAN ONLY/.test(a.out) && a.world.st.domains.get('www.acme.com') === 'acme' && a.world.st.domains.get('portal.acme.com') === 'acme' && /Next:/.test(a.out) && /activate acme/.test(a.out));
    check('...including the activation link for the first admin', /activate-admin-invite\?token=/.test(a.out));
    check('the temporary credentials are always cleaned up (also when nothing was done)', a.cleaned === 1 && r.cleaned === 1);
    const j = await cli([...CREATE, '--apply', '--json']);
    check('--json prints parseable JSON', (() => { try { return JSON.parse(j.out).ok === true; } catch { return false; } })());
  }
  {
    const r = await cli(['create', 'acme', '--name', 'A', '--domain', 'acme.netlify.app', '--apply']);
    check('a refused request exits 1 with the reason, no stack trace, and changes nothing', r.code === 1 && /netlify\.app/.test(r.err) && !/at .*\.js:\d+/.test(r.err) && mutations(r.world.st).length === 0);
    const failing = makeWorld(); failing.st.fail.rulesDeploy = true;
    const f = await cli([...CREATE, '--apply'], { world: failing });
    check('a failure part-way exits 1, shows the steps that did run and the one that failed, and still cleans up', f.code === 1 && /✓ sign-in pool/.test(f.out) && /✗ security rules/.test(f.out) && f.cleaned === 1);
    const credErrs = [];
    const noCreds = await main(['status'], { out() {}, err: s => credErrs.push(s), makeDeps: async () => { throw new Error('no credentials: set FIREBASE_SERVICE_ACCOUNT'); } });
    check('missing credentials exit 1 with a plain message', noCreds === 1 && /no credentials/.test(credErrs.join('\n')));
  }

  // ── protecting your own database ─────────────────────────────────────────
  {
    const plan = await cli(['protect-default']);
    check('protect-default without --apply is just a plan (no gate needed to LOOK)', plan.code === 0 && /PLAN ONLY/.test(plan.out) && mutations(plan.world.st).length === 0);
    const denied = await cli(['protect-default', '--apply']);
    check('protect-default --apply is REFUSED unless you say you tested the rules in the emulator', denied.code === 2 && /Emulator/.test(denied.err) && mutations(denied.world.st).length === 0);
    const ok = await cli(['protect-default', '--apply', '--i-have-tested-in-the-emulator']);
    check('...and goes ahead once you do', ok.code === 0 && ok.world.st.rules.some(r => r.databaseId === '(default)' && !r.dryRun) && /MULTI_WORKSPACE/.test(ok.out));
  }

  // ── going live ───────────────────────────────────────────────────────────
  {
    const w = makeWorld(); await cli([...CREATE, '--apply'], { world: w });
    const early = await cli(['activate', 'acme', '--apply'], { world: w });
    check('activate before your database is protected exits 1, lists what is missing, and does not go live', early.code === 1 && /not ready to go live/.test(early.err) && /protect-default/.test(early.err) && w.st.workspaces.get('acme').status === 'provisioning');
    await cli(['protect-default', '--apply', '--i-have-tested-in-the-emulator'], { world: w });
    const plan = await cli(['activate', 'acme'], { world: w });
    check('activate without --apply only reports', plan.code === 0 && /PLAN ONLY/.test(plan.out) && w.st.workspaces.get('acme').status === 'provisioning');
    const live = await cli(['activate', 'acme', '--apply'], { world: w });
    check('activate --apply goes live', live.code === 0 && w.st.workspaces.get('acme').status === 'active');
  }

  // ── status ───────────────────────────────────────────────────────────────
  {
    const w = makeWorld(); await cli([...CREATE, '--backups', 'daily:30d', '--apply'], { world: w });
    const bad = await cli(['status'], { world: w });
    check('status exits 2 and shows ✗ when something needs attention (your database not protected yet)', bad.code === 2 && /NO/.test(bad.out) && /✗/.test(bad.out));
    await cli(['protect-default', '--apply', '--i-have-tested-in-the-emulator'], { world: w });
    const good = await cli(['status', 'acme'], { world: w });
    check('status exits 0 when everything is in order', good.code === 0 && /Everything is in order/.test(good.out) && /portal\.acme\.com/.test(good.out));
    const j = await cli(['status', '--json'], { world: w });
    check('status --json is parseable', (() => { try { return JSON.parse(j.out).rows[0].id === 'acme'; } catch { return false; } })());
    const none = await cli(['status', 'ghost'], { world: w });
    check('status of an unknown workspace exits 1', none.code === 1 && /does not exist/.test(none.err));
  }

  // ── secrets never appear ─────────────────────────────────────────────────
  {
    const w = makeWorld(); await cli([...CREATE, '--apply'], { world: w });
    const SECRET = 'sk_live_TOPSECRET_VALUE_999';
    const set = await cli(['set-secret', 'acme', 'STRIPE_SECRET_KEY', '--apply'], { world: w, secret: SECRET });
    check('set-secret --apply stores the value read from stdin/prompt', set.code === 0 && w.st.secrets.get('acme').STRIPE_SECRET_KEY === SECRET);
    const dry = await cli(['set-secret', 'acme', 'STRIPE_SECRET_KEY'], { world: w, secret: 'sk_other' });
    const js = await cli(['set-secret', 'acme', 'STRIPE_SECRET_KEY', '--apply', '--json'], { world: w, secret: SECRET });
    const list = await cli(['list-secrets', 'acme'], { world: w });
    const status = await cli(['status', 'acme'], { world: w });
    check('the value appears in NO output — not in the plan, the result, --json, the listing or status', ![set, dry, js, list, status].some(r => (r.out + r.err).includes(SECRET)) && !dry.out.includes('sk_other'));
    check('list-secrets shows the name, and status shows it too, but never the value', list.out.trim() === 'STRIPE_SECRET_KEY' && /STRIPE_SECRET_KEY/.test(status.out));
    check('set-secret without --apply stores nothing new', !w.st.secrets.get('acme').STRIPE_SECRET_KEY.includes('other'));
    const wrong = await cli(['set-secret', 'acme', 'FIREBASE_SERVICE_ACCOUNT', '--apply'], { world: w, secret: 'x' });
    check('a platform secret cannot be set through this command', wrong.code === 1 && /not a per-workspace setting/.test(wrong.err));
    const missing = await cli(['set-secret', 'acme'], { world: w });
    check('set-secret without a key is a usage error', missing.code === 2);
    const un = await cli(['unset-secret', 'acme', 'STRIPE_SECRET_KEY', '--apply'], { world: w });
    check('unset-secret removes it', un.code === 0 && !w.st.secrets.get('acme').STRIPE_SECRET_KEY);
  }

  // ── rules, backups, suspension, invitations ──────────────────────────────
  {
    const w = makeWorld(); await cli([...CREATE, '--apply'], { world: w }); w.st.rules.length = 0;
    const chk = await cli(['deploy-rules', '--all', '--check'], { world: w });
    check('deploy-rules --check compiles and releases nothing', chk.code === 0 && w.st.rules.length === 1 && w.st.rules[0].dryRun && !/PLAN ONLY/.test(chk.out));
    const rel = await cli(['deploy-rules', '--all', '--apply'], { world: w });
    check('deploy-rules --all --apply releases the scoped rules', rel.code === 0 && w.st.rules.some(r => !r.dryRun && r.databaseId === 'ws-acme'));
    const noDefault = await cli(['deploy-rules', '--default', '--apply'], { world: w });
    check('deploy-rules --default is refused until protect-default has been done deliberately', noDefault.code === 1 && /protect-default/.test(noDefault.err));
    const bk = await cli(['backups', '--all', '--retention', '7d', '--recurrence', 'weekly', '--apply'], { world: w });
    check('backups maps --retention/--recurrence onto the schedule', bk.code === 0 && w.st.schedules.get('ws-acme')[0].recurrence === 'WEEKLY' && w.st.schedules.get('ws-acme')[0].retention === '7d');
    const inv = await cli(['invite-admin', 'acme', '--email', 'second@acme.com', '--name', 'Sam', '--apply'], { world: w });
    check('invite-admin prints a link on the client\'s own domain', inv.code === 0 && /https:\/\/portal\.acme\.com\/api\/activate-admin-invite\?token=/.test(inv.out));
    const invPlan = await cli(['invite-admin', 'acme', '--email', 'third@acme.com'], { world: w });
    check('invite-admin without --apply writes nothing', /PLAN ONLY/.test(invPlan.out) && ![...w.st.users.get(w.st.workspaces.get('acme').authTenantId).keys()].includes('third@acme.com'));
    const noEmail = await cli(['invite-admin', 'acme'], { world: w });
    check('invite-admin without --email is a usage error', noEmail.code === 2);
    const sus = await cli(['suspend', 'acme', '--apply'], { world: w });
    check('suspend --apply reports both layers and how to undo it', sus.code === 0 && /deny-all/.test(sus.out) && /resume acme/.test(sus.out) && w.st.workspaces.get('acme').status === 'suspended');
    const rsm = await cli(['resume', 'acme', '--apply'], { world: w });
    check('resume --apply restores it', rsm.code === 0 && w.st.workspaces.get('acme').status === 'active');
    const doc = await cli(['doctor'], { world: w });
    check('doctor exits 0 when healthy', doc.code === 0 && /All checks passed/.test(doc.out));
    const sick = makeWorld(); sick.st.fail.probe = 'multi-tenancy is not enabled';
    const sd = await cli(['doctor'], { world: sick });
    check('doctor exits 1 and prints a fix when something is wrong', sd.code === 1 && /fix:/.test(sd.out) && /Allow tenants/.test(sd.out));
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
