# LendLoop

> Borrow what you need. Lend what you don't.

A neighborhood tool-lending board. Neighbors list tools they're willing to lend,
request them for a date range, and the lender decides. Admins moderate listings
and manage trusted lenders.

Built with Next.js (App Router), Clerk, Convex and TypeScript.

**Status:** complete. The app, the role-based access control, and the n8n
automation layer (signed webhooks, scheduled reminders, idempotent write-backs,
retries and an error workflow) are implemented and tested. See
[Automation](#automation) for what was verified and how.

---

## Quick start

```bash
npm install

# 1. Link a Convex dev deployment (writes NEXT_PUBLIC_CONVEX_URL to .env.local)
npx convex dev --once

# 2. Clerk: create an app, then put the keys in .env.local (see below)

# 3. Point Convex at your Clerk instance
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://your-app.clerk.accounts.dev

# 4. This address becomes admin (add it before or after signing up — either works)
npx convex env set ADMIN_EMAILS you@example.com

# 5. Optional: ten demo tools so the public page isn't empty
npx convex env set SEED_ENABLED true
npx convex run seed:populate

# 6. Optional but required for automation: a shared secret, and a reachable n8n
npx convex env set LENDLOOP_SHARED_SECRET "$(openssl rand -hex 32)"
npx convex env set N8N_WEBHOOK_URL http://localhost:5678/webhook/lendloop/request-event

npm run dev
```

See [`n8n/README.md`](n8n/README.md) for the n8n side. Without these two, every
loan event records a visible `notification.failed` rather than failing silently.

Open http://localhost:3000, sign up with the email you put in `ADMIN_EMAILS`, and
the Admin tab appears.

### Clerk setup

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com).
2. **API keys** → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`.
3. **JWT Templates → New → "convex"** → copy the **Issuer** URL. This template is
   what makes Convex trust Clerk's tokens; without it Convex rejects every
   request.

### Environment variables

Everything is optional except the first three.

| Variable                            | Where                | Purpose                                                                                       |
| ----------------------------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_CONVEX_URL`            | Next.js              | Written by `npx convex dev`                                                                   |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Next.js              | Clerk browser SDK                                                                             |
| `CLERK_SECRET_KEY`                  | Next.js server       | Clerk server SDK. Never imported into client code                                             |
| `CLERK_JWT_ISSUER_DOMAIN`           | **Convex** env       | JWT issuer Convex validates against                                                           |
| `ADMIN_EMAILS`                      | **Convex** env       | Comma-separated; these addresses are made `admin` on sync                                     |
| `SEED_ENABLED`                      | **Convex** env       | Must be `true` for `seed:populate` to run                                                     |
| `LENDLOOP_SHARED_SECRET`            | **Convex** env + n8n | HMAC key, both directions. Must be identical on both sides                                    |
| `N8N_WEBHOOK_URL`                   | **Convex** env       | n8n webhook. Convex is cloud-hosted, so local n8n needs a public tunnel (see `n8n/README.md`) |

Convex deployment variables are set with `npx convex env set`, not in `.env.local`
— they live on the deployment and are never bundled into the frontend. Putting
the last two in `.env.local` does nothing; the deployment will keep reporting
"n8n is not configured".

---

## Architecture

```
Browser
  │  Clerk session JWT
  ├─────────────► Convex (queries + mutations, all authorization)
  │                  │
  │                  └─ automationJobs (outbox) ──signed──► n8n webhook
  │                                                          │
  └───────────── Next.js App Router ── Clerk middleware ──┘  │
                     (proxy.ts, redirect only)                │
                                                             ▼
                                                 n8n workflows (published)
                                                             │
                                              signed write-back ──► Convex HTTP
```

Two rules shape the whole codebase:

1. **The browser talks to Convex directly.** There is no Next.js API layer holding
   the business rules. Clerk's JWT is the credential, and Convex verifies it.
2. **Next.js only does routing and rendering.** `proxy.ts` redirects signed-out
   visitors as a convenience. It is not the security boundary — deleting it would
   leak nothing but a redirect.

### Why Convex for this

The interesting logic here is a state machine with invariants: you cannot approve
a request twice, cannot approve two overlapping loans, cannot borrow your own
tool. In Convex each mutation is a serializable transaction, so those checks are
correct under concurrency without a separate locking story. The same transaction
writes the outbox row, which is what makes the notification path reliable.

---

## Data model

```ts
users          clerkId (unique), name, email, imageUrl?, role, trustedLender, createdAt
tools          ownerId, name, category, condition, description, archivedAt?, timestamps
loans          toolId, ownerId, borrowerId, startDate, endDate, status,
               message?, decidedAt?, returnedAt?, timestamps
auditEvents    actorId, action, targetType, targetId, summary, createdAt
```

**Indexes that correspond to real queries:** `users.by_clerk_id` (every request
resolves an identity), `loans.by_tool` (overlap checks), `loans.by_owner` and
`loans.by_borrower` (the two inbox views), `loans.by_status_end` (the overdue
query), `automationJobs.by_status_next` (failed-delivery view),
`loanActivity.by_dedupe` (idempotency lookups), `tools.by_owner`,
`tools.by_category`. Indexes with no reader were removed rather than kept for
appearance.

Three decisions worth defending:

- **`clerkId` is in the users table, and roles come from there.** Not from a JWT
  claim, and never from an argument. One table lookup per request, and admin
  promotion is possible without reissuing tokens.
- **Deletes are soft.** `tools.archivedAt` keeps loan history and audit records
  pointing at something real. A hard delete would orphan every past loan.
- **Availability is derived, never stored.** A tool is "lent" if an `approved`
  loan covers today. There is no status column to drift out of sync.

Loan states:

```
pending ──approve──> approved ──return──> returned
   ├──decline──> declined
   └──cancel───> cancelled
```

Every transition asserts the status it expects, so a replayed request fails
rather than corrupting state.

---

## Authorization

Enforced in `convex/lib/authz.ts`, called by every function. The UI hides controls
for convenience only.

| Action                                                | Who                                          |
| ----------------------------------------------------- | -------------------------------------------- |
| View the public board (name + category)               | Anyone, including signed out                 |
| Browse with owner, condition, availability            | Any signed-in user                           |
| Create a listing                                      | Any signed-in user                           |
| Edit a listing                                        | Its owner                                    |
| Remove a listing                                      | Its owner **or** any admin                   |
| Request a loan                                        | Any signed-in user, never for their own tool |
| Approve / decline                                     | The lender only — **not** admins             |
| Cancel                                                | The borrower, while pending                  |
| Mark returned                                         | The lender                                   |
| Mark a loan returned early / reassign                 | Nobody                                       |
| View any loan                                         | Its lender, its borrower, or an admin        |
| Remove any listing, see all loans, set trusted lender | Admin only                                   |
| Change roles                                          | Admin, but never their own                   |

Four things this does deliberately:

- **The caller is identified by `identity.tokenIdentifier`**, derived from the
  verified JWT. A user id in an argument is only ever a _target_, never proof of
  who is calling.
- **Admins cannot approve loans.** They can see every loan, but the decision to
  lend a real object belongs to the person who owns it. This is a product
  judgement, and it's the kind of thing that matters more than a role check.
- **Admins cannot change their own role**, which prevents accidental lockout.
- **Bootstrap admins come from `ADMIN_EMAILS`**, applied on every sync, so nobody
  has to poke the database to get started and adding a second admin later is a
  one-line env change. Note the consequence: an address listed there is re-promoted
  after any demotion, so removing someone from `ADMIN_EMAILS` _is_ the demotion
  path. Admins who are not in the env var are managed normally from the panel.

These are not just asserted — `convex/lendloop.test.ts` runs the negative cases as
multiple mocked users (30 tests). A non-admin calling `admin.allUsers` fails. A
borrower approving their own request fails. An unrelated user reading a loan
fails.

### Availability and overlap

- Only `approved` loans reserve a tool. Several neighbors may hold `pending`
  requests for the same weekend — the owner picks.
- Approving re-checks the range, because a competing request may have been
  approved while this one sat in the queue.
- Requests are whole UTC days, maximum 90, and cannot start in the past.

---

## Automation

Three n8n workflows, all in [`n8n/workflows/`](n8n/workflows/):

| Workflow                    | Trigger           | What it does                                                                    |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `request-notification.json` | Convex webhook    | Verifies the HMAC, renders the right message for lender or borrower, returns it |
| `overdue-reminders.json`    | Daily 08:00       | Fetches overdue loans, notifies each borrower, writes the reminder back         |
| `error-handler.json`        | n8n error trigger | Reports failed runs to the app so they are visible to admins                    |

### Reliability: the outbox

A loan mutation writes the state change and an `automationJobs` row **in one
transaction**, then schedules delivery:

```
mutation                                  action (can use fetch)
├─ write loan status change               ├─ read job
└─ insert automationJobs (pending) ───────┤─ sign, POST to n8n
                                          ├─ ok      → sent + activity row
                                          └─ failure → retry 30s→2m→10m→1h→4h
                                                       then failed + visible row
```

The state change and the intent to notify commit together or not at all. Convex
retries a failed mutation by rolling it back, so a retry cannot insert a second
job. After the last attempt the job is marked `failed` **and** a
`notification.failed` activity row is written, which shows up in the admin
Automation tab — nothing fails silently.

### Security: signing in both directions

`signature = HMAC_SHA256(secret, timestamp + "." + canonicalJson(body))`

- The timestamp is inside the signed string, so a captured body can't be replayed
  with a fresh timestamp; receivers reject anything older than 5 minutes.
- **Canonical JSON** (sorted keys, no whitespace) is used because n8n receives
  _parsed_ JSON, not our original bytes. Both sides compute the same canonical
  form, so the signature is independent of key order and pretty-printing. This
  was a real bug the first time: signing raw bytes verified fine from `curl` and
  failed from n8n.
- Comparison is constant-time.
- Incremental parsing never happens before verification.
- Secrets live in Convex deployment env and `n8n/.env`; the exported JSON contains
  only `{{ $env.LENDLOOP_SHARED_SECRET }}` references.

All three HTTP endpoints fail closed with `503` if the secret is unset.

### Idempotent write-backs

```
POST /automation/reminders
Idempotency-Key: reminder:<loanId>:<dueDate>:<daystamp>
```

The key is derived from data, so a retried delivery and a duplicate schedule run
collapse onto the same row. The lookup and insert happen in one serializable
mutation. A replay returns `200 { duplicate: true }` rather than a conflict,
because for n8n a retry that already succeeded is a success.

### What n8n can and cannot do

The endpoints can only append activity to a loan that already exists. n8n cannot
change loan status, reassign ownership, or touch any other table. An attacker
with full control of the n8n instance can mark a reminder as sent for an existing
loan — that is the entire blast radius.

### Verified end to end

Against the real deployment and a real n8n container (v2.46.4):

| Check                               | Result                               |
| ----------------------------------- | ------------------------------------ |
| Unsigned request                    | `401`                                |
| Signed request                      | `200`                                |
| Stale timestamp (10 min)            | `401`                                |
| Tampered body                       | `401`                                |
| POST without idempotency key        | `400`                                |
| Reminder write-back                 | `{ duplicate: false }`               |
| Replay of the same key              | `{ duplicate: true }`                |
| Unknown loan id                     | `404`                                |
| Signed event from n8n's perspective | `200`, correct recipient and message |
| Forged signature at n8n webhook     | `401`                                |
| Daily workflow run twice            | **one** reminder row                 |

49 automated tests cover the signature scheme (including a known-answer vector
computed independently in Python), the outbox, the retry ladder, idempotency, and
the overdue query.

### Local n8n

```bash
cd n8n && cp .env.example .env    # then fill in the three values
docker compose up -d
```

Then import and publish the workflows — see [`n8n/README.md`](n8n/README.md).

**One caveat worth stating plainly:** Convex runs in the cloud, so it cannot reach
`localhost:5678`. For real webhook delivery in local development you need a
tunnel (e.g. `ngrok http 5678`) and must set `N8N_WEBHOOK_URL` to it. Without
that, outbound jobs fail loudly and visibly — which is the designed behaviour,
not a bug.

## Security decisions

| Decision                                                     | Reason                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Role read from the database, never from args or client state | A client cannot claim to be an admin, and admin promotion needs no token reissue           |
| Every function re-checks identity                            | The Next.js middleware is a redirect, not an authorization layer                           |
| Soft delete for listings                                     | Preserves loan and audit history; hard deletes orphan references                           |
| `ConvexError` for user-facing messages                       | Plain `Error` text is redacted in production, turning validation into "Server Error"       |
| Non-participants get a generic refusal                       | `assertLoanParticipant` doesn't reveal whether a loan exists                               |
| Public query returns two fields                              | The signed-out payload is the smallest thing that satisfies the requirement                |
| Audit events for every privileged write                      | Admin actions are reviewable after the fact                                                |
| Secrets only in deployment env                               | `CLERK_SECRET_KEY` never reaches the client bundle; Convex env vars live on the deployment |

### Data minimization

- **Public board:** name and category, and only for tools that are actually
  available — a tool that is out on loan is not listed. No owner, condition,
  description, or count of loans. Verified by tests that assert the exact key set
  and that a lent tool disappears and reappears.
- **`users.me`:** name, avatar, role, trusted flag. Not the email.
- **Emails:** stored in `users` because the automation layer needs a destination,
  and returned only to admins (the admin panel is the only place they appear).
- **n8n payloads:** the request event carries only the recipient's email, plus
  the tool name, dates, and status — never the other party's contact details. The
  overdue payload is six fields. No descriptions, no addresses, no loan history.
- **Seed data** is fictional and gated behind an env flag, so it can't land in a
  real environment by accident.

---

## Testing

```bash
npm test        # 49 tests, convex-test, no deployment or keys needed
npm run typecheck
npm run lint
npm run build
```

`convex-test` runs the real functions against an in-memory Convex backend — same
schema validation, same indexes, same transaction semantics — with
`t.withIdentity()` standing in for Clerk. So the authorization matrix and the loan
state machine are executed, not merely written down.

The suite covers: identity sync and its idempotency, argument-injection
resistance, validation limits, public payload shape, owner-vs-stranger edits,
every admin-only function, the full request → approve → return flow, self-approval,
overlap rejection, double-approval races, cancellation rules, and the label/schema
consistency guard.

---

## Project structure

```
app/
  (site)/                 # everything with the shared header
    page.tsx              # public landing + read-only board
    browse/ tools/[id]/   # authenticated board, details, request form
    my-listings/ my-requests/ incoming/
    admin/                # tabs: overview, listings, loans, users, activity, automation
    sign-in/ sign-up/
  layout.tsx              # fonts + providers
components/
  ui/                     # shadcn primitives (generated, unmodified apart from imports)
  *.tsx                   # feature components
convex/
  schema.ts               # tables, enums, indexes
  lib/authz.ts            # requireViewer / requireAdmin / assertLoanParticipant
  lib/validation.ts       # pure input + date-range rules
  lib/loans.ts            # availability map, overlap check, overdue predicate
  users.ts tools.ts loans.ts admin.ts
  http.ts                 # signed inbound endpoints (overdue, reminders, failures)
  automation.ts           # outbox, delivery with retries, idempotent write-back
  lib/signing.ts          # HMAC + canonical JSON
  lendloop.test.ts        # 30 tests
  automation.test.ts      # 19 tests
  seed.ts
docs/n8n-design.md
n8n/                      # compose + compose README
proxy.ts                  # Clerk middleware (Next 16 renamed middleware → proxy)
```

---

## What I'd change for production

**Auth and identity**

- Move roles to Clerk `publicMetadata` _or_ keep the database as the source of
  truth but add a Clerk webhook for user deletion, so a deleted Clerk account stops
  being a live row here.
- Add a Clerk webhook to keep name/email in sync instead of syncing on page load.
- Enforce a minimum session lifetime / re-auth before destructive admin actions.

**Data model**

- A partial unique index or a `activeLoan` marker per tool to make double-booking
  impossible at the storage layer, not just in the mutation.
- Soft-delete accounts, not just listings, and a retention policy for loans.

**Reliability**

- Add a dead-letter retry button to the admin Automation tab, so a failed job can
  be replayed without touching the database.
- Add idempotency keys to borrow requests so a double-tap on a flaky connection
  cannot create two pending requests.
- Rate-limit `loans.request` per user to stop request spam against one lender.

**Scale**

- The browse query loads all live tools and does one owner lookup per distinct
  owner. Fine to a few thousand listings; past that, denormalize `ownerName` onto
  the tool and paginate by `createdAt`.
- Add a search index (`searchIndex` on tools) to replace the client-side filter.

**Operations**

- Preview deployments per PR, with a seeded dataset.
- Structured logging and alerting on mutation error rate.
- A real test-user flow with `@clerk/testing` for browser tests.

## Deliberate omissions

- No notifications beyond the designed n8n layer.
- No image uploads on listings — it would have added a storage dependency for
  little evaluation value.
- No pagination; the board is small by design.
- Light mode only.

---

## Scripts

| Command                        | What it does                                  |
| ------------------------------ | --------------------------------------------- |
| `npm run dev`                  | Next.js dev server                            |
| `npx convex dev`               | Push functions and stream logs                |
| `npm run build` / `start`      | Production build / serve                      |
| `npm test`                     | Vitest + convex-test                          |
| `npm run typecheck`            | `tsc --noEmit`                                |
| `npm run lint`                 | ESLint                                        |
| `npm run format`               | Prettier, including Tailwind class sorting    |
| `npx convex run seed:populate` | Insert demo tools (needs `SEED_ENABLED=true`) |
