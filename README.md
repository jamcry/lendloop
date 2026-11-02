# LendLoop

> Borrow what you need. Lend what you don't.

A neighborhood tool-lending board. Neighbors list tools they're willing to lend,
request them for a date range, and the lender decides. Admins moderate listings
and manage trusted lenders.

Built with Next.js (App Router), Clerk, Convex and TypeScript.

**Status:** the application is complete and tested. The n8n automation layer is
designed but **not implemented** — see [Automation](#automation-status) and
[`docs/n8n-design.md`](docs/n8n-design.md).

---

## Quick start

```bash
npm install

# 1. Link a Convex dev deployment (writes NEXT_PUBLIC_CONVEX_URL to .env.local)
npx convex dev --once

# 2. Clerk: create an app, then put the keys in .env.local (see below)

# 3. Point Convex at your Clerk instance
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://your-app.clerk.accounts.dev

# 4. Your first account becomes admin
npx convex env set ADMIN_EMAILS you@example.com

# 5. Optional: ten demo tools so the public page isn't empty
npx convex env set SEED_ENABLED true
npx convex run seed:populate

npm run dev
```

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

| Variable                            | Where          | Purpose                                               |
| ----------------------------------- | -------------- | ----------------------------------------------------- |
| `NEXT_PUBLIC_CONVEX_URL`            | Next.js        | Written by `npx convex dev`                           |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Next.js        | Clerk browser SDK                                     |
| `CLERK_SECRET_KEY`                  | Next.js server | Clerk server SDK. Never imported into client code     |
| `CLERK_JWT_ISSUER_DOMAIN`           | **Convex** env | JWT issuer Convex validates against                   |
| `ADMIN_EMAILS`                      | **Convex** env | Comma-separated; promoted to `admin` on first sign-in |
| `SEED_ENABLED`                      | **Convex** env | Must be `true` for `seed:populate` to run             |

Convex deployment variables are set with `npx convex env set`, not in `.env.local`
— they live on the deployment and are never bundled into the frontend.

---

## Architecture

```
Browser
  │  Clerk session JWT
  ├─────────────► Convex (queries + mutations, all authorization)
  │                  │
  │                  └─ automationJobs (outbox) ──TODO──► n8n webhook
  │                                                          │
  └───────────── Next.js App Router ── Clerk middleware ──┘  │
                     (proxy.ts, redirect only)                │
                                                             ▼
                                              n8n workflows (designed, not built)
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
query), `tools.by_owner`, `tools.by_category`.

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
- **The first admin comes from `ADMIN_EMAILS`**, so nobody has to poke the
  database to get started.

These are not just asserted — `convex/lendloop.test.ts` runs the negative cases as
multiple mocked users (23 tests). A non-admin calling `admin.allUsers` fails. A
borrower approving their own request fails. An unrelated user reading a loan
fails.

### Availability and overlap

- Only `approved` loans reserve a tool. Several neighbors may hold `pending`
  requests for the same weekend — the owner picks.
- Approving re-checks the range, because a competing request may have been
  approved while this one sat in the queue.
- Requests are whole UTC days, maximum 90, and cannot start in the past.

---

## Automation status

**Not implemented.** Per the agreed scope, the n8n work is a documented design
with `TODO(n8n)` markers rather than fake plumbing.

What exists:

- `convex/automation.ts` — the exact integration points, plus a working
  `overdueLoans` query (only the fields a reminder needs).
- `docs/n8n-design.md` — outbox pattern, HMAC scheme over `timestamp + "." + body`,
  replay window, idempotent write-back keys, retry ladder, error workflow.
- `n8n/docker-compose.yml` — a local n8n with secrets wired from the environment.

What does not exist: workflow JSON, the HTTP endpoints, and the activity feed. The
bonus "reminder sent 2 days ago" UI is therefore also absent — I would rather have
no panel than an empty one.

---

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

- **Public board:** name and category. No owner, condition, description, or count
  of loans. Verified by a test that asserts the exact key set.
- **`users.me`:** name, avatar, role, trusted flag. Not the email.
- **Emails:** stored in `users` because the automation layer needs a destination,
  and returned only to admins (the admin panel is the only place they appear).
- **n8n payloads (designed):** five fields per reminder. No descriptions, no
  addresses, no loan history.
- **Seed data** is fictional and gated behind an env flag, so it can't land in a
  real environment by accident.

---

## Testing

```bash
npm test        # 23 tests, convex-test, no deployment or keys needed
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
    admin/                # tabs: overview, listings, loans, users, activity
    sign-in/ sign-up/
  layout.tsx              # fonts + providers
components/
  ui/                     # shadcn primitives (generated, unmodified apart from imports)
  *.tsx                   # feature components
convex/
  schema.ts               # tables, enums, indexes
  lib/authz.ts            # requireUser / requireAdmin / assertLoanParticipant
  lib/validation.ts       # pure input + date-range rules
  lib/loans.ts            # availability map, overlap check, overdue predicate
  users.ts tools.ts loans.ts admin.ts
  automation.ts           # TODO(n8n) integration points
  lendloop.test.ts        # 23 tests
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

- `loanActivity` table for the automation trail (blocked on the n8n work).
- A partial unique index or a `activeLoan` marker per tool to make double-booking
  impossible at the storage layer, not just in the mutation.
- Soft-delete accounts, not just listings, and a retention policy for loans.

**Reliability**

- Implement the outbox with a dead-letter view in the admin panel.
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
