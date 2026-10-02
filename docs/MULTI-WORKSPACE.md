# Multi-workspace (multi-client) architecture

RentBay can serve many clients — each a **workspace** — from **one deployment and one
Firebase project**. This document is the source of truth for how that works, what is done,
and what must be finished before a second client is switched on.

> **Status: data, settings and sign-in are isolated in code. Nothing here changes how the current
> install behaves, and a second workspace still must not be activated** until the
> [first-client runbook](#first-client-runbook) has been done — it needs steps in the Firebase console
> and a rules deployment that cannot be automated yet.

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

## First-client runbook

Until provisioning is automated, bringing up the first client is manual, **in this order** (the order
matters: step 3 protects your own database before any client user exists):

1. **Upgrade the Firebase project to Identity Platform** (Console → Authentication → Settings). Review
   the pricing first; on the Blaze plan a free tier of monthly active users applies, and the free Spark
   plan is limited after upgrading. Treat the upgrade as one-way until you have checked.
2. **Enable multi-tenancy** (Identity Platform → Settings → Security → *Allow tenants*).
3. **Protect the default database first.** Build `--default` rules, try them in the emulator, then deploy
   them to the `(default)` database. Do this *before* creating any tenant, while no client user exists.
4. **Create the `platform` database** (production mode, deny-all rules; it holds client secrets) and
   the client's database `ws-<id>` (production mode). Build `--tenant <id>` rules, try them in the
   emulator, deploy them to the client's database.
5. **Create the tenant** (Identity Platform → Tenants), enable *Email/Password*, note its id.
6. **Write the registry** in the `platform` database: `workspaces/<id>` (with `authTenantId`, status
   `provisioning`), `workspaceDomains/<host>`, and `workspaceSecrets/<id>` (Stripe etc.).
7. **Attach the domain**: add it to the Netlify site and to Firebase Authentication's *Authorized
   domains* (password-reset and invite links return to it).
8. **Create the first admin** in the client's tenant, and its `admins/<uid>` document in the client's
   database.
9. Set the workspace `status` to `active`, and only then set `ALLOW_MULTI_WORKSPACE=true`.

Check each of: sign in as the client's admin on the client's domain; confirm the same login is refused on
your own domain; send a test invoice; send a password-reset email and follow the link.

## Still open before a second workspace is enabled

1. **The runbook above is manual** — creating the tenant and databases, deploying the scoped rules to
   every database, writing the registry, adding the domain, seeding the first admin. Provisioning script
   (Patch 4). **Generated rules must be tried in the Firebase Emulator before being deployed.**
2. **Backups.** Firestore export per database on a schedule; Netlify Blobs has none built in.
3. **Card payments are not hidden for a client without Stripe.** `/api/config` returns `stripePk: null`,
   but the tenant portal still offers card payment and will error when used. Needs per-workspace feature
   flags (with branding).

**Closed:** data isolation (a database per workspace); per-client credentials and settings
(`getConfig`, `workspaceSecrets`); per-request Stripe clients; links and notification addresses; mail
isolation; parallel-safe scheduled runs; **per-workspace sign-in** (a pool per workspace, tokens checked
in both directions, rules scoped per workspace, impersonation tokens minted in the right pool).

## Roadmap

| Patch | Scope |
|---|---|
| 1 ✅ | Workspace seam, mail isolation, `/api/config` database, enforcement + tests, CI fix |
| 2 ✅ | Workspace-scoped settings and credentials, per-request Stripe, parallel-safe sweeps |
| 3 ✅ | Per-workspace sign-in (Identity Platform tenants), tenant-scoped rules generator |
| 4 | Provisioning script (tenant, databases, rules, registry, domain, first admin), backups, suspension |
| 5 | White-label branding and per-workspace feature flags |
| 6 | SaaS billing and client onboarding |

## Testing

```
npm run verify   # static rules, incl. the three above
npm test         # behaviour: isolation, settings, sign-in, rules generator, mail, receipts, invoice payment info, rent coverage
```
