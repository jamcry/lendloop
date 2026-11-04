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

# 5. Start the app and sign up at http://localhost:3000 with that address.
npm run dev

# 6. In a second terminal, after signing in once, optionally seed ten demo tools
#    under YOUR account. Passing ownerEmail is what makes them usable: you can
#    approve and return requests against them. Without it they belong to a demo
#    account that cannot sign in, so they are read-only in practice.
npx convex env set SEED_ENABLED true
npx convex run seed:populate '{"ownerEmail":"you@example.com"}'

# 7. Optional: one already-overdue loan for the reminder workflow. That tool is
#    hidden from the public board until you mark the loan returned.
npx convex run seed:createDemoOverdueLoan

# 8. Only if you want the automation to run. The webhook URL must be reachable from
#    Convex's cloud, so local n8n needs a tunnel — see n8n/README.md.
npx convex env set LENDLOOP_SHARED_SECRET "$(openssl rand -hex 32)"
npx convex env set N8N_WEBHOOK_URL https://<your-tunnel>/webhook/lendloop/request-event
```

See [`n8n/README.md`](n8n/README.md) for the n8n side. Without the shared secret and
webhook URL, every loan event records a visible `notification.failed` rather than
failing silently.

The seeded tools are owned by the address you passed to `ownerEmail`. To exercise
the borrow flow end to end, sign in with a second account and request one of them;
the first account can then approve, decline, and mark it returned.

### Clerk setup

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com).
2. **API keys** → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`.
3. **JWT Templates → New → "convex"** → copy the **Issuer** URL. This template is
   what makes Convex trust Clerk's tokens; without it Convex rejects every
   request.
4. The template must include the `email`, `name`, and `picture` claims. Without
   `email`, the `users` row is created with an empty address, notifications have
   no recipient, and `ADMIN_EMAILS` never matches. The stock "convex" template
   includes all three; if you build the claims by hand, do not omit them.

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
users           clerkId (unique), name, email, imageUrl?, role, trustedLender, createdAt
tools           ownerId, name, category, condition, description, archivedAt?, timestamps
loans           toolId, ownerId, borrowerId, startDate, endDate, status,
                message?, decidedAt?, returnedAt?, timestamps
automationJobs  eventKey, kind, loanId, payload, status, attempts, nextAttemptAt,
                lastError?, timestamps
loanActivity    loanId?, kind, channel, detail, dedupeKey?, confirmedAt?, createdAt
auditEvents     actorId, action, targetType, targetId, summary, createdAt
```

**Indexes that correspond to real queries:** `users.by_clerk_id` (every request
resolves an identity), `loans.by_tool` (overlap checks), `loans.by_owner` and
`loans.by_borrower` (the two inbox views), `loans.by_status_end` (the overdue
query), `loans.by_status_start` (what is currently out, including overdue),
`automationJobs.by_status_next` (retrying and failed delivery views),
`loanActivity.by_dedupe` (idempotency lookups), `tools.by_owner`,
`tools.by_category`, `tools.by_archived`, `loanActivity.by_created` and
`loanActivity.by_loan_created`, plus `automationJobs.by_loan`, which only the
tests read. Indexes with no reader at all were removed rather than kept for
appearance.

Three decisions worth defending:

- **`clerkId` is in the users table, and roles come from there.** Not from a JWT
  claim, and never from an argument. One table lookup per request, and admin
  promotion is possible without reissuing tokens.
- **Deletes are soft.** `tools.archivedAt` keeps loan history and audit records
  pointing at something real. A hard delete would orphan every past loan.
- **Availability is derived, never stored.** A tool is "lent" if an `approved`
  loan has started and has not been marked returned. There is no status column to
  drift out of sync, and an overdue loan keeps the tool out of the board until the
  lender closes it. The next future booking is reported alongside, so "available
  today" does not hide "booked for the weekend".

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

Five things this does deliberately:

- **The caller is identified by `identity.tokenIdentifier`**, derived from the
  verified JWT. A user id in an argument is only ever a _target_, never proof of
  who is calling.
- **The first write provisions the caller's row.** A mutation that finds no
  `users` row creates one from the verified identity before checking permissions.
  `users.sync` still refreshes name/email/avatar and applies `ADMIN_EMAILS`, but it
  is no longer a prerequisite for acting, so a brand-new user cannot race it and
  get "You must be signed in." on their first click.
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
multiple mocked users (34 tests). A non-admin calling `admin.allUsers` fails. A
borrower approving their own request fails. An unrelated user reading a loan
fails. A first-time caller is provisioned but still cannot archive someone
else's listing.

### Availability and overlap

- Only `approved` loans reserve a tool. Several neighbors may hold `pending`
  requests for the same weekend — the owner picks.
- An approved loan keeps the tool reserved until it is marked returned, including
  after its return date. An overdue tool is hidden from the public board and new
  requests are refused with a clear message rather than promised against a tool
  that is still out.
- The board also shows the next future booking, so a tool that is free today but
  taken next weekend is not presented as simply "available".
- The request form checks the picked range against approved bookings before
  submitting; the mutation re-checks the same rule.
- Approving re-checks the range, because a competing request may have been
  approved while this one sat in the queue.
- Requests are whole UTC days, maximum 90, and cannot start in the past.

---

## Automation

Three n8n workflows, all in [`n8n/workflows/`](n8n/workflows/):

| Workflow                    | Trigger           | What it does                                                                              |
| --------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `request-notification.json` | Convex webhook    | Verifies the HMAC, renders the right message for lender or borrower, returns it           |
| `overdue-reminders.json`    | Daily 08:00       | Fetches overdue loans, claims a reminder, sends it, then confirms the send back to Convex |
| `error-handler.json`        | n8n error trigger | Reports failed runs to the app so they are visible to admins                              |

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
`notification.failed` activity row is written. Jobs that are still retrying are
listed in the admin Automation tab with their attempt count, last error, and next
attempt time, so a broken webhook is visible on the first failure rather than
after the ladder exhausts.

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

All four HTTP endpoints fail closed with `503` if the secret is unset.

### Idempotent write-backs

```
POST /automation/reminders          claim
POST /automation/reminders/confirm  after the send
Idempotency-Key: reminder:<loanId>:<dueDate>:<daystamp>
```

The key is derived from data, so a retried delivery and a duplicate schedule run
collapse onto the same row. The lookup and insert happen in one serializable
mutation. A replay returns `200 { duplicate: true }` rather than a conflict,
because for n8n a retry that already succeeded is a success.

The write-back is two-phase because claiming and sending are different facts. The
claim row is written **before** the notification so a retry cannot create a
second reminder, but it is stored without `confirmedAt` and the app labels it
"Reminder queued". Only after the send succeeds does the workflow call
`/automation/reminders/confirm`, which patches `confirmedAt` and turns the label
into "Reminder sent". If the send or the confirmation fails, the claim stays
queued and the workflow fails into the error workflow rather than reporting a
delivery that never happened. Confirming a reminder that was never claimed is a
`404`, so n8n cannot invent activity for an arbitrary loan.

### What n8n can and cannot do

The endpoints can only append activity to a loan that already exists. n8n cannot
change loan status, reassign ownership, or touch any other table. An attacker
with full control of the n8n instance can claim and confirm a reminder for an
existing loan — that is the entire blast radius.

### Verified end to end

Against the real deployment and a real n8n container (v2.46.4):

| Check                               | Result                                   |
| ----------------------------------- | ---------------------------------------- |
| Unsigned request                    | `401`                                    |
| Signed request                      | `200`                                    |
| Stale timestamp (10 min)            | `401`                                    |
| Tampered body                       | `401`                                    |
| POST without idempotency key        | `400`                                    |
| Reminder claim                      | `{ duplicate: false, confirmed: false }` |
| Replay of the same key              | `{ duplicate: true }`                    |
| Confirmation                        | `{ duplicate: false }`                   |
| Replay of the confirmation          | `{ duplicate: true }`                    |
| Confirming an unclaimed reminder    | `404`                                    |
| Unknown loan id                     | `404`                                    |
| Signed event from n8n's perspective | `200`, correct recipient and message     |
| Forged signature at n8n webhook     | `401`                                    |
| Daily workflow run twice            | **one** reminder row, confirmed once     |

77 automated tests cover the signature scheme (including a known-answer vector
computed independently in Python), the HTTP endpoints through `t.fetch`, the
outbox and its retry ladder, the claim/confirm protocol, retry visibility,
idempotency, availability (including overdue loans), and the overdue query.

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
- **`users.me`:** id, name, avatar, role, trusted flag. Not the email.
- **Emails:** stored in `users` because the automation layer needs a destination,
  and returned only to admins (the admin panel is the only place they appear).
- **n8n payloads:** the request event carries only the recipient's email, plus
  the tool name, dates, and status — never the other party's contact details. The
  overdue payload is six fields. No descriptions, no addresses, no loan history.
- **Seed data** is fictional and gated behind an env flag, so it can't land in a
  real environment by accident. Passing `ownerEmail` assigns it to a real account,
  so the demo listings can be approved and returned instead of dead-ending on a
  demo owner that cannot sign in.

---

## Testing

```bash
npm test          # 77 unit/integration tests, convex-test, no deployment or keys needed
npm run test:e2e  # 29 Playwright tests against the dev deployment (see e2e/README.md)
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

The Playwright suite takes the other half: real Clerk sessions, the Next.js proxy,
and the n8n hop. It creates three throwaway users, drives the full borrow
lifecycle in two browsers, proves the negative authorization cases by calling
Convex directly with each user's own token, and runs the scheduled workflow twice
to show the write-back is idempotent. Setup and caveats: [`e2e/README.md`](e2e/README.md).

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
  lib/viewer.ts           # identity → users row (lazy provisioning + bootstrap)
  lib/validation.ts       # pure input + date-range rules
  lib/loans.ts            # availability map, next booking, overlap, overdue
  users.ts tools.ts loans.ts admin.ts
  http.ts                 # signed inbound endpoints (overdue, claim, confirm, failures)
  automation.ts           # outbox, delivery with retries, idempotent write-back
  lib/signing.ts          # HMAC + canonical JSON
  lendloop.test.ts        # 34 tests
  automation.test.ts      # 22 tests
  http.test.ts            # 15 tests
  seed.test.ts            # 6 tests
  seed.ts
docs/n8n-design.md
n8n/                      # compose + compose README
e2e/                      # Playwright suite + its README
playwright.config.ts
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
- A dedicated CI Clerk instance with ephemeral test users (the browser suite
  currently creates them in the shared dev instance).

## Deliberate omissions

- No notifications beyond the designed n8n layer.
- No image uploads on listings — it would have added a storage dependency for
  little evaluation value.
- No pagination; the board is small by design.
- Light mode only.

---

## Scripts

| Command                        | What it does                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `npm run dev`                  | Next.js dev server                                                                                 |
| `npx convex dev`               | Push functions and stream logs                                                                     |
| `npm run build` / `start`      | Production build / serve                                                                           |
| `npm test`                     | Vitest + convex-test                                                                               |
| `npm run test:e2e`             | Playwright against the dev deployment                                                              |
| `npm run typecheck`            | `tsc --noEmit`                                                                                     |
| `npm run lint`                 | ESLint                                                                                             |
| `npm run format`               | Prettier, including Tailwind class sorting                                                         |
| `npx convex run seed:populate` | Insert demo tools (needs `SEED_ENABLED=true`; pass `{"ownerEmail":"you@example.com"}` to own them) |
