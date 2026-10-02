# Multi-workspace (multi-client) architecture

RentBay can serve many clients — each a **workspace** — from **one deployment and one
Firebase project**. This document is the source of truth for how that works, what is done,
and what must be finished before a second client is switched on.

> **Status: everything needed to run clients is built — isolation, per-client settings and sign-in,
> provisioning, backups and suspension — and none of it changes how your current install behaves.**
> What is left is doing it once for real, carefully: see [Bringing up the first client](#bringing-up-the-first-client).
> The provisioning tool has been tested against fakes and against your real request handlers, but **not
> against live Google services** — so start with `doctor`, then a plan-only `create`, then a throwaway client.

## The model

| | Default workspace (today's install) | Every other workspace |
|---|---|---|
| Firestore | the `(default)` database | its own named database, `ws-<id>` |
| Blobs stores | original names (`documents`, `invoices`, …) | prefixed: `ws-<id>-documents`, … |
| Found by | any host not in the registry (e.g. `*.netlify.app`) | its registered domain(s) |
| Config | environment variables | its own settings (see blockers) |

Isolation is **structural**, not a filter: code holding workspace A's database handle has no
way to read workspace B's data, even if it forgets a `where()`. That is the whole point of
choosing a database per client over an `orgId` field on every document.

The registry (which domain belongs to which workspace) lives in a separate `platform`
database, apart from every client's data.

## How a request finds its workspace

`Host header → platform registry → workspace`, resolved once per request and held in
`AsyncLocalStorage`. Code just calls `getDb()` / `getWorkspaceStore()`; there is no parameter
to thread through, and calling them outside a request **throws** rather than guessing.

* The **Host** header is used, never `X-Forwarded-Host` (a caller can set that one).
* A client's own domain therefore also routes its webhooks (Stripe, Bold, …) automatically.
* **Fail closed.** With multi-workspace on: unknown host → `404`, suspended/provisioning →
  `403`, registry unreadable → `503`. It never falls back to the default workspace.
* The default workspace never depends on the registry, so a registry outage cannot take down
  the original install.
* Registry lookups are cached 60 s (so a suspension takes up to a minute to bite).

## Rules for writing code (enforced by `npm run verify`)

1. **Never open Firestore yourself.** Use `getDb()`. Not `admin.firestore()`, not `getFirestore()`.
2. **Never import `@netlify/blobs` yourself.** Use `getWorkspaceStore({ name, … })`.
3. **Every function wraps its handler** as its last line:
   `exports.handler = withWorkspace(exports.handler);` — or `withEachWorkspace` for scheduled
   functions (they have no request, so they run once per workspace), or `withoutWorkspace`
   only for a function that touches no workspace data.

4. **Never read a per-client setting from `process.env`.** Use `getConfig('KEY')` (below).
5. **Never create a Stripe client yourself**, and never write to `process.env`. Use `getStripe()`;
   put per-request values in the workspace context.

6. **Never reach Firebase Auth yourself.** Use `getAuth()`; a project-level `admin.auth()` accepts a token
   from *any* tenant and would create users in the wrong pool. Pages set `auth.tenantId` from `/api/config`.

`scripts/verify.js` fails the build if any rule is broken, and `scripts/test-handlers.js`
loads every function and checks that every database call and blob store lands in the caller's
workspace.

## Configuration

| Variable | Meaning |
|---|---|
| `ALLOW_MULTI_WORKSPACE` | `true` turns the registry on. Anything else: everything is the default workspace and the registry is never read. **Leave unset until the blockers are closed.** |
| `PLATFORM_DATABASE_ID` | Database holding the registry (default `platform`). |
| `DEFAULT_WORKSPACE_HOSTS` | Extra hostnames (comma-separated) that always mean the default workspace, e.g. your own custom domain. `*.netlify.app`, deploy previews and `localhost` already do. |
| `SWEEP_BUDGET_MS` | Time budget for a scheduled run across workspaces (default 22000). |
| `SWEEP_CONCURRENCY` | How many workspaces a scheduled run processes at once (default 4). |

Registry documents (in the `platform` database):

```
workspaces/{id}            id: 4–30 chars, [a-z0-9-], not reserved
  name: "Acme Rentals"
  databaseId: "ws-acme"    (defaults to ws-<id>)
  authTenantId: "acme-x1y2z"   (the workspace's Identity Platform tenant — REQUIRED once status is "active")
  status: "active" | "provisioning" | "suspended"
  domains: ["portal.acme.com"]
  primaryDomain: "portal.acme.com"      (optional; used to build links)

workspaceDomains/{host}    host lowercased, no port
  workspaceId: "acme"
```

Create the `platform` database and every workspace database in **production mode** (deny by
default). Never in test mode.

## Per-workspace settings

Anything that differs per client is read with `getConfig('KEY')` — a synchronous drop-in for
`process.env.KEY`:

* **Default workspace:** returns the environment variable, exactly as before.
* **Any other workspace:** returns only *its own* value and **never falls back to the
  deployment's**, so a client can never use (or be billed through) the platform owner's Stripe
  account, mail server, API keys or notification address. An unset value is `undefined`.
* An unknown name **throws** (a typo cannot silently read as "unset"), and platform secrets
  such as `FIREBASE_SERVICE_ACCOUNT` are not reachable through it.

Where a workspace's values come from:

| Setting | Source |
|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | the workspace's **own** email provider (its admins configure it in the app; `apply-email-config.js` loads it per request). None configured = no mail. |
| `SITE_URL` | `workspaceSecrets`, else the workspace's own domain from the registry. Never the deployment's. |
| `SITE_NAME` | `workspaceSecrets`, else the workspace's registered name. |
| every other key below | `workspaceSecrets/{workspaceId}` in the **platform** database |

```
workspaceSecrets/{workspaceId}      (platform database — operator-managed)
  SITE_URL, SITE_NAME, ADMIN_NOTIFY_EMAIL, ALLOWED_ORIGIN,
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PUBLISHABLE_KEY,
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_UPLOAD_PRESET,
  DOCUMENSO_API_KEY, DOCUMENSO_API_URL, DOCUMENSO_APP_URL, DOCUMENSO_TEMPLATE_ID, DOCUMENSO_WEBHOOK_SECRET,
  SMARTMOVE_API_KEY, SMARTMOVE_API_URL, SMARTMOVE_LANDING_PAGE,
  EMPLOYMENT_VERIFICATION_API_KEY, EMPLOYMENT_VERIFICATION_API_URL,
  APPLICATION_RETENTION_DAYS, APPLICATION_DELETE_DAYS
```

Anything else in that document is ignored (with a warning naming the key, never the value).
Values are cached for 60 s. If they cannot be read, requests for that workspace fail with
`503` rather than running without them.

> ⚠️ **The `platform` database now holds client secrets.** It must be created in
> **production mode** (deny by default) and must never have client-facing rules. Only the
> server (Admin SDK) may read or write it.

The platform-level settings every workspace shares are read directly from the environment:
`FIREBASE_*`, `NETLIFY_*`, `SITE_ID` and the switches in the table above.

## Sign-in: one user pool per workspace

Every non-default workspace has its own **Identity Platform tenant** — a separate pool of users inside
the same Firebase project. An active workspace without one is rejected outright.

* **Server:** all Auth access goes through `getAuth()`. For the default workspace that is the
  project-level pool; for any other it is that workspace's tenant. Users created, tokens minted
  (including impersonation sessions) and links generated all live in the right pool.
* **Tokens are checked in both directions.** The Admin SDK's tenant-aware `verifyIdToken` rejects a
  token from another tenant, but the **project-level** `verifyIdToken` accepts a token from *any*
  tenant — so, unchecked, a client's user could present their token to the default workspace. `getAuth()`
  closes that: a token is accepted only by the workspace whose pool issued it. `scripts/test-auth.js`
  pins both SDK behaviours against the real SDK classes, so a future SDK change that alters either is
  noticed.
* **Browser:** `/api/config` returns `authTenantId`; each page sets `auth.tenantId` right after creating
  its auth instance, before any sign-in, sign-up, password reset or custom-token sign-in.
* **Security rules:** the tenant is checked from the token, never trusted from the browser (a custom
  token can be exchanged for a session in a pool the client picks, so only the claim inside the token
  can be relied on). See below.
* Supported in tenants and used by this app: email/password and custom tokens. The app uses no
  anonymous, phone or popup sign-in. Tenants cannot disable sign-up from the console (API only), and
  this app needs sign-up open (invites, applications), exactly as today.

### Per-workspace security rules

The rules run in the browser, and several trust *any signed-in user* (`announcements` read; `invites`
read **and update**; `isAdmin()` and others begin with `request.auth != null`). `scripts/build-rules.js`
produces a copy of `firestore.rules` for one workspace, replacing every `request.auth != null` with
`inThisWorkspace()`:

```
npm run build-rules -- --tenant acme-x1y2z --out acme.rules   # that workspace's database
npm run build-rules -- --default --out default.rules            # the default workspace's database
```

* `--tenant`: signed in **and** `request.auth.token.firebase.tenant == '<id>'`.
* `--default`: signed in **and** the token has **no** tenant. Once any tenant exists its users must not
  be able to reach the default database either — they are signed in too.

`firestore.rules` itself is deliberately **not** changed: merging a change to it deploys it to the live
database (`deploy-firestore-rules.yml`). `verify.js` enforces that the committed file is the plain source.
The generator proves its output differs from the input only by the helper and the substitutions, and
refuses a malformed tenant id (it is written into rules text).

> ⚠️ The generated rules have **not** been evaluated by the Firebase rules engine (the emulator is not
> available in CI). Try them in the Firebase Emulator Suite — signed-in user of tenant A against database
> B, and the reverse — before deploying them anywhere.

## Operating workspaces: `scripts/workspace.js`

```
npm run workspace -- help
```

**Everything that changes something is plan-only unless you add `--apply`.** Run a command without it to
see exactly what it would do. Commands read their credentials from `FIREBASE_SERVICE_ACCOUNT` (the key's
JSON) or `GOOGLE_APPLICATION_CREDENTIALS` (a path).

### Use a separate operator service account

The runtime's key (in Netlify) never needs to create databases or tenants and should not be able to. Make a
second service account for operators, kept on your own machine (and a CI one if you use multi-workspace
rules deployment, below). Rather than guess role names, **run `doctor`**: it tries each capability read-only
and tells you which one is missing. The capabilities needed are: create and list Firestore databases
(`datastore.databases.create` is the permission for creating one), release Firestore rules, manage Identity
Platform tenants and read/write its config (for authorized domains), manage Firestore backup schedules, and
read/write the `platform` database.

### Commands

| Command | What it does |
|---|---|
| `doctor` | Read-only pre-flight: credentials, CLI, permissions, multi-tenancy, registry. Run it first, always. |
| `init` | Creates the `platform` database (holds client secrets) with deny-all rules. |
| `protect-default` | Changes **your own database's** rules so a client's users cannot reach it. Gated: needs `--i-have-tested-in-the-emulator`. |
| `create <id> --name … --domain …` | Builds a client end to end and leaves it **inactive**: tenant, database, scoped rules, domain records, authorized domain, seed data, first admin, backups. |
| `invite-admin <id> --email …` | A fresh activation link (also how you add more admins). Links last 72 hours. |
| `status [<id>]` | Health of every workspace, including rules drift. Exit code 2 if anything needs attention. |
| `activate <id>` | Go live — only if every readiness check passes. |
| `suspend <id>` / `resume <id>` | Lock a client out of the server **and** the browser, and lift it. |
| `deploy-rules [<id>…] [--all] [--default] [--platform] [--check]` | Redeploy generated rules; `--check` only compiles. CI runs this. |
| `set-secret <id> KEY` / `unset-secret` / `list-secrets` | Per-client settings. The value comes from stdin or a hidden prompt — there is deliberately no `--value`. |
| `backups [--all] [--retention 30d] [--recurrence daily] [--pitr]` | Make sure every database has a backup schedule. |
| `backup-blobs <id\|default> --out <dir>` / `restore-blobs` | Back up and restore documents and invoices (Netlify Blobs). |

### How it stays safe

* **Resumable and idempotent.** A failed run is simply run again; it never creates a second tenant or
  database. The tenant id is saved to the registry the moment it exists.
* **Inactive until verified.** `create` leaves a client in `provisioning`, which the runtime refuses to
  serve. `activate` re-checks everything first: tenant, database, rules deployed, domains registered **and**
  authorized, and — the important one — that **your own database is protected**.
* **Refuses before it changes anything.** An existing database or domain that is not that client's is
  refused, not adopted; so is a `.netlify.app` or `DEFAULT_WORKSPACE_HOSTS` domain (the runtime treats those
  as your default workspace, so a client on one would never be reached).
* **Rules are compile-checked before release,** and a client's rules cannot be loosened by a routine redeploy:
  a suspended client keeps its deny-all rules.
* **Authorized domains are never overwritten.** The domain list is read, extended, written back and then
  re-read; if any existing domain went missing it stops loudly.
* **Secrets never appear** in any output, plan, JSON or command line — only key names and lengths. Rules go to
  the Firebase CLI in a file, credentials by file path.
* **The first admin** is created exactly as the app's own invite flow creates one, so they activate through the
  app. Its link returns to the client's own domain, which is why that domain must be an authorized domain.

## Bringing up the first client

Do this once, in this order. The order matters: steps 4 and 5 protect **your** database before any client
user exists.

1. **Console, once:** upgrade the project to Identity Platform and enable multi-tenancy (Authentication →
   Settings; then Identity Platform → Settings → Security → *Allow tenants*). Review the pricing first; treat
   the upgrade as one-way until you have checked.
2. **Operator access:** create the operator service account; `export FIREBASE_SERVICE_ACCOUNT="$(cat key.json)"`.
3. `npm run workspace -- doctor` — fix whatever it says, until it passes.
4. `npm run workspace -- init` (look), then `init --apply`.
5. **Protect your own database.** `npm run build-rules -- --default --out default.rules`, **try those rules in the
   Firebase Emulator Suite** (a client's signed-in user against your database must be refused; your own admin,
   tenants and applicants must still work), then
   `npm run workspace -- protect-default --apply --i-have-tested-in-the-emulator`.
6. **Keep CI from undoing it:** set the repository variable `MULTI_WORKSPACE` to `true` (Settings → Secrets and
   variables → Actions → Variables). From then on `deploy-firestore-rules.yml` deploys the generated rules to
   every database instead of the plain `firestore.rules`.
7. `npm run workspace -- create acme --name "Acme Rentals" --domain portal.acme.com --admin-email owner@acme.com
   --backups daily:30d` (plan), review, then add `--apply`.
8. `npm run workspace -- set-secret acme STRIPE_SECRET_KEY --apply` (and the others the client needs).
9. **Attach the domain last:** add `portal.acme.com` to the Netlify site and point DNS at it. Until you do, the client
   is unreachable.
10. Set `ALLOW_MULTI_WORKSPACE=true` on the Netlify site (once, for the first client) and redeploy.
11. `npm run workspace -- status acme`, then `activate acme --apply`.
12. Mint the admin's link now (`invite-admin acme --email … --apply`; links last 72 hours), and check: sign in as the
    client's admin on the client's domain; the same login must be **refused on your own domain**; send a test
    invoice; follow a password-reset email.

Backups for what you already have: `npm run workspace -- backups --all --apply --pitr`, and
`npm run workspace -- backup-blobs default --out <folder>`. Both cost money (stored backups, PITR storage) — review first.

### Backups and restoring

* **Firestore:** a scheduled backup per database (default, platform and every client), and optionally
  point-in-time recovery. Restoring is a Firebase operation (`firebase firestore:databases:restore`), not part of
  this tool; practise it once on a throwaway database before you need it.
* **Netlify Blobs** (identity documents, leases, invoices) have no backup of their own. `backup-blobs` writes every
  blob with a SHA-256 manifest, verifies each file after writing, is incremental, and holds **sensitive client
  documents** — keep the folder encrypted. `restore-blobs` verifies every checksum before writing anything and
  never overwrites an existing blob unless asked.
* A new blob store added to the code must be added to `BLOB_STORES` in `_lib/workspace.js`; `verify.js` fails the
  build otherwise, so a store can never silently be left out of backups.

### Rules in CI

With `MULTI_WORKSPACE` unset the workflow does exactly what it always did. With it set to `true`, a change to
`firestore.rules` (or `scripts/build-rules.js`) deploys: the default variant to your database, each client's own
scoped rules to its database (a suspended client stays locked), and deny-all to the platform database. The CI
service account then also needs the capabilities above (read the registry; release rules) — `doctor` tells you.

## Still open

1. **Try the generated rules in the Firebase Emulator** before they go anywhere (the CI cannot evaluate rules). This is
   the one unverified piece of the isolation, and `protect-default` will not run without you confirming it.
2. **The tooling has not run against live Google services.** Its logic, its exact commands and requests, and its records
   (through your real handlers) are tested; Google's acceptance of them is not. Hence `doctor`, plan-only by default,
   and a throwaway client first. Some CLI output formats are parsed tolerantly for this reason.
3. **Card payments are not hidden for a client without Stripe.** `/api/config` returns `stripePk: null`, but the tenant
   portal still offers card payment and errors when used. Needs per-client feature flags (with branding).
4. **Suspension takes up to a minute** to reach the server (the registry cache), though the browser lock-out is as soon
   as the rules deploy.

**Closed:** data isolation; per-client credentials and settings; per-request Stripe clients; links and notification
addresses; mail isolation; parallel-safe scheduled runs; per-workspace sign-in; **provisioning, activation, suspension,
backups (Firestore and Blobs) and per-database rules deployment.**

## Roadmap

| Patch | Scope |
|---|---|
| 1 ✅ | Workspace seam, mail isolation, `/api/config` database, enforcement + tests, CI fix |
| 2 ✅ | Workspace-scoped settings and credentials, per-request Stripe, parallel-safe sweeps |
| 3 ✅ | Per-workspace sign-in (Identity Platform tenants), tenant-scoped rules generator |
| 4 ✅ | Provisioning tool, activation, suspension, backups (Firestore + Blobs), per-database rules in CI |
| 5 | White-label branding and per-workspace feature flags (incl. hiding card payments) |
| 6 | SaaS billing and client onboarding |

## Testing

```
npm run verify   # static rules, incl. the three above
npm test         # behaviour: isolation, settings, sign-in, rules generator, mail, receipts, invoice payment info, rent coverage
```
