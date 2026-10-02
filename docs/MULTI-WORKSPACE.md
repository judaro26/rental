# Multi-workspace (multi-client) architecture

RentBay can serve many clients — each a **workspace** — from **one deployment and one
Firebase project**. This document is the source of truth for how that works, what is done,
and what must be finished before a second client is switched on.

> **Status: foundation only. Nothing here changes how the current install behaves, and a
> second workspace cannot be activated yet.** See [Blockers](#blockers-before-a-second-workspace-is-enabled).

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

## Blockers before a second workspace is enabled

The seam makes the *data* isolated. These are the places that are still deployment-wide, found
by measurement, and each one must be closed before `ALLOW_MULTI_WORKSPACE` is turned on:

1. **Integration credentials are environment variables.** A non-default workspace must never
   inherit them, or it would charge the platform owner's Stripe and use their API keys.
   `STRIPE_SECRET_KEY` (4 files), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`,
   `CLOUDINARY_*`, `DOCUMENSO_*` (2), `SMARTMOVE_*`, `EMPLOYMENT_VERIFICATION_*`.
   *Mail is already isolated* (`apply-email-config.js` now resets on every call and gives a
   non-default workspace no SMTP unless it configured its own).
2. **Links and notices use deployment-wide values.** `SITE_URL` (35 files),
   `ADMIN_NOTIFY_EMAIL` (18), `SITE_NAME` (2). The workspace already carries `siteUrl`; the
   code does not use it yet.
3. **`generate-moveout-statement.js` sends mail without `apply-email-config`**, the only
   function that does.
4. **Sign-in is not per workspace.** Needs Firebase Identity Platform tenants (one user pool
   per client), the browser setting its tenant before sign-in, servers rejecting tokens from
   another tenant, and tenant-aware impersonation tokens. (Admin-SDK support for this exists.)
5. **Security rules are deployed to one database only** (`firebase.json`). Every workspace
   database and the `platform` database need rules deployed, automatically.
6. **Scheduled sweeps run workspaces one after another** inside the platform's time limit.
   Fine for a handful; they must fan out before the client count grows. (Parallel runs also
   need #1's explicit config objects instead of `process.env` mutation.)
7. **Backups.** Firestore export per database on a schedule; Netlify Blobs has none built in.
8. **Provisioning is manual.** Creating a database, deploying rules, writing the registry
   documents, seeding the first admin and attaching the domain should be one command.

## Roadmap

| Patch | Scope |
|---|---|
| **1 (this)** | Workspace seam, mail isolation, `/api/config` database, enforcement + tests, CI fix |
| 2 | Workspace-scoped config: credentials, `SITE_URL`, notify email; parallel-safe sweeps |
| 3 | Per-workspace sign-in (Identity Platform tenants) |
| 4 | Provisioning script, rules + backups per database, suspension |
| 5 | White-label branding (name, logo, manifests, emails) |
| 6 | SaaS billing and client onboarding |

## Testing

```
npm run verify   # static rules, incl. the three above
npm test         # behaviour: isolation, mail, receipts, invoice payment info, rent coverage
```
