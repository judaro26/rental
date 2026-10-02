# Multi-workspace (multi-client) architecture

RentBay can serve many clients — each a **workspace** — from **one deployment and one
Firebase project**. This document is the source of truth for how that works, what is done,
and what must be finished before a second client is switched on.

> **Status: isolation of data and settings is done. Nothing here changes how the current install
> behaves, and a second workspace still must not be activated** — sign-in, rules deployment and
> provisioning are open. See [Blockers](#blockers-before-a-second-workspace-is-enabled).

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

## Blockers before a second workspace is enabled

Data and settings are now isolated. These are still open, and each must be closed before
`ALLOW_MULTI_WORKSPACE` is turned on:

1. **Sign-in is not per workspace — a security blocker, not a nicety.** The server-side admin
   checks already hold (an admin is only an admin where their `admins` document lives; tested for
   all 17 admin endpoints). But the Firestore rules also run in the browser, and some trust *any*
   signed-in user: `announcements` (read) and `invites` (read **and update**). With one shared
   sign-in pool, anyone signed in to one client's portal could point the browser SDK at another
   client's database and read or modify those collections. Fix: Firebase Identity Platform
   tenants (one user pool per client), the browser setting its tenant before sign-in, rules and
   servers rejecting a token from another tenant, and tenant-aware impersonation tokens.
   (Admin-SDK support exists.) **Do not enable a second workspace before this.**
2. **Security rules are deployed to one database only** (`firebase.json`). Every workspace
   database and the `platform` database need rules deployed, automatically. *The `platform`
   database holds secrets; do not create it without deny-all rules.*
3. **Backups.** Firestore export per database on a schedule; Netlify Blobs has none built in.
4. **Provisioning is manual.** Creating a database, deploying rules, writing the registry
   documents and `workspaceSecrets`, seeding the first admin and attaching the domain should be
   one command.
5. **Card payments are not hidden for a client without Stripe.** `/api/config` returns
   `stripePk: null`, but the tenant portal still offers card payment and will error when used.
   Needs per-workspace feature flags (with branding).

**Closed:** per-client credentials and settings (`getConfig`, `workspaceSecrets`); per-request
Stripe clients; links and notification addresses (`SITE_URL`, `ADMIN_NOTIFY_EMAIL`); mail
isolation, including the one function that skipped it; scheduled runs that are parallel-safe.

## Roadmap

| Patch | Scope |
|---|---|
| 1 ✅ | Workspace seam, mail isolation, `/api/config` database, enforcement + tests, CI fix |
| 2 ✅ | Workspace-scoped settings and credentials, per-request Stripe, parallel-safe sweeps |
| 3 | Per-workspace sign-in (Identity Platform tenants) |
| 4 | Provisioning script, rules + backups per database, suspension |
| 5 | White-label branding and per-workspace feature flags |
| 6 | SaaS billing and client onboarding |

## Testing

```
npm run verify   # static rules, incl. the three above
npm test         # behaviour: isolation, settings, mail, receipts, invoice payment info, rent coverage
```
