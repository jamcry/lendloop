# n8n integration — design notes

**Status: implemented.** This document records the design and the reasoning
behind it. The as-built summary, setup steps, and verification results live in
the [README](../README.md#automation); the workflows themselves are in
[`n8n/workflows/`](../n8n/workflows/).

One thing changed between design and build, and it is the interesting part — see
[Signing](#3-signing-app--n8n).

---

## 1. Why n8n is not called directly from a mutation

A Convex mutation is a serializable transaction with no network access. It also
may be retried. Calling a webhook from inside one would either fail to compile or
produce duplicate notifications on retry.

So the outbound path is an **outbox**:

```
mutation (transactional)                    action (retryable, has fetch)
├─ write loan status change                 ├─ read job row
└─ insert automationJobs row  ──────────────┤─ sign payload
   {kind, loanId, payload, status: pending} │─ POST to n8n
                                            ├─ success → status: sent
                                            └─ failure → attempts++, nextAttemptAt,
                                                          status: failed (after 5)
```

The state change and the intent to notify commit together or not at all. A crash
between them cannot lose a notification, and a retried mutation cannot create a
second one because the job row is keyed to the loan event.

```ts
await ctx.scheduler.runAfter(0, internal.automation.deliver, { jobId });
```

Backoff: 30s → 2m → 10m → 1h → 4h, then `failed`. `failed` is visible in the app
(loan activity and admin panel), which is the whole point — silent failure is the
default outcome of most webhook code and it is the thing I would be judged on.

## 2. Outbound payloads

Only what the notification needs: one recipient, and nothing about the other
party's contact details. No tool description, no full user records.

`loan.requested` / `loan.status_changed`:

```json
{
  "eventId": "loan.status_changed:k17f...:approved:1767225600000",
  "kind": "loan.status_changed",
  "occurredAt": 1767225600000,
  "data": {
    "loanId": "k17f...",
    "toolName": "DeWalt cordless drill",
    "toolCategory": "power-tools",
    "status": "approved",
    "startDate": 1767225600000,
    "endDate": 1767484800000,
    "audience": "borrower",
    "recipientName": "Bob",
    "recipientEmail": "bob@example.com",
    "counterpartyName": "Alice"
  }
}
```

The app decides the audience, not the workflow: a new request or a cancellation
addresses the lender, a decision addresses the borrower. `audience` is carried
explicitly so the workflow has no notification policy to get wrong, and the
non-recipient's email never leaves the database.

## 3. Signing (app → n8n)

```
X-LendLoop-Timestamp: 1767225600
X-LendLoop-Signature: <hex hmac-sha256>
```

Signature is `HMAC_SHA256(secret, timestamp + "." + canonicalJson(body))`.

**Why canonical JSON and not raw bytes:** the original design signed the raw body.
That verified perfectly from `curl` and failed from n8n, because n8n parses the
JSON and hands the Code node an object — re-serializing it does not reproduce the
sender's bytes. Signing a canonical form (object keys sorted, no whitespace, no
`undefined`) removes the dependency on byte-identity: both sides compute the same
string from the same data. The first live test against n8n returned
`401 Invalid signature` and this was the cause.

- Timestamp is inside the signed string, so a captured body cannot be replayed
  with a fresh timestamp.
- n8n's first node rejects anything older than 5 minutes.
- Comparison must be constant-time.
- The secret lives in Convex deployment env and in `n8n/.env`, never in the
  workflow JSON. Workflows reference `$env.LENDLOOP_SHARED_SECRET`.
- Honest note: this is `$env`, not an n8n credential. That requires
  `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, which lets _any_ imported Code node read
  the container's environment — including `N8N_ENCRYPTION_KEY`. A credential with
  a `$credentials` lookup would be tighter; `$env` is what the compose file uses.

## 4. Inbound (n8n → app)

Three HTTP endpoints on Convex's `httpRouter`:

| Endpoint                | Method | Purpose                                 |
| ----------------------- | ------ | --------------------------------------- |
| `/automation/overdue`   | GET    | Scheduled workflow polls overdue loans  |
| `/automation/reminders` | POST   | Workflow claims a reminder (idempotent) |
| `/automation/failures`  | POST   | Error workflow reports a failed run     |

`GET /overdue` wraps the internal query
`automation.overdueLoans`. It returns six fields — `loanId`, `toolName`,
`borrowerName`, `borrowerEmail`, `dueDate`, `daysOverdue` — because that is what a
reminder needs and nothing more.

### Write-back idempotency

```
POST /automation/reminders
Idempotency-Key: reminder:<loanId>:<dueDate>:<daystamp>
```

- The key is stored on the activity row (`loanActivity.dedupeKey`). Convex has no
  unique indexes, so the lookup and the insert happen in **one mutation** — which
  is serializable, making the read-then-insert safe.
- First call inserts; a replay returns `200 {duplicate: true}` rather than a 409,
  because for n8n a retry that already succeeded is a success.
- Reusing a key for a _different_ loan returns `409`, since that is a caller bug,
  not a retry.
- The key is derived from data, not random, so a _retried workflow run_ and a
  _duplicate schedule run_ collapse to the same key.

### Claim before sending

The reminder is **claimed first, then sent**. The workflow posts the idempotent
write-back, and only items where the response says `duplicate: false` proceed to
the notification node. Ordering it the other way — send, then record — makes "run
twice, get one reminder" true of the database and false of the borrower's inbox.
Verified: 3 overdue loans, 3 claims, 1 notification sent.

Inbound requests authenticate the same way (HMAC + timestamp), so n8n cannot be
spoofed either. That is the "secure in both directions" requirement.

## 5. Workflows

### `request-notification.json`

One Code node rather than a Switch: the payload already names the single person
to notify, so routing is three lines of JS and there is no branch wiring to get
wrong.

```
Webhook (POST, responds via a Respond node)
  → Code: verify HMAC + 5-min window, render message → 401 on failure
  → Respond: 200 with the rendered notification, or the rejection reason
```

The webhook returns `200` after rendering, not `202` before — delivery here is a
`console.log`, so there is nothing slow to wait for.

**Known limitation:** if Convex times out (10s) after n8n has already handled the
event, the retry delivers it a second time. The workflow does not dedupe on
`eventId`. Closing that needs an `eventId` claim endpoint, the same shape as the
reminder claim; for a logged mock the duplicate is a log line, but with real email
it would be a second email.

### `overdue-reminders.json`

```
Daily 08:00 (plus a manual trigger for `n8n execute`)
  → Code: sign the GET
  → HTTP GET /automation/overdue (signed)
  → Code: one item per overdue loan, each with its own signature + idempotency key
  → HTTP POST /automation/reminders (per item, retry 3x, continue on error)
  → Code: notify only where duplicate === false
```

No loop node: the HTTP Request node already runs once per input item, so fanning
out is a Code node that returns an array.

`continue-on-fail` on the write-back matters — one bad item must not stop
reminders for everyone else.

### `error-handler.json`

Set as the `errorWorkflow` on both workflows. Receives the failed execution and
posts `{ workflow, detail }` to `/automation/failures`, which records a
`workflow.failed` row — surfaced in the admin Automation tab.

Two things that cost time to discover: the error workflow must be **published**
like any other, or n8n logs "cannot be executed"; and `errorWorkflow` holds a
workflow **ID**, which is instance-specific. The exported JSON contains the ID
from the machine it was exported on — on a fresh instance, re-select it in the
workflow settings after import. If the app is unreachable too, the workflow writes to a
n8n's own execution history — which is why the error workflow is a notification,
not the only record.

## 6. Why the app never trusts n8n

n8n is an external system with its own credentials and its own bugs. Everything it
sends is treated as untrusted input:

- HMAC verified before parsing.
- The endpoint can only append an activity row for a loan that already exists.
- It cannot change loan status, reassign ownership, or touch any other table.
- Payload fields are validated with the same Convex validators as client calls.

An attacker with full control of the n8n instance can mark a reminder as sent for
an existing loan. That is the complete blast radius, which is the correct size.

## 7. Verification actually performed

1. Replay outside the window → `401 Signature stale`. ✅
2. Replay within the window → `{ duplicate: true }`, one row. ✅
3. Dead host → five attempts with backoff, then `notification.failed` visible in
   the admin Automation tab. ✅ (covered by test, since the live deployment's
   webhook URL points at a local port it cannot reach)
4. Daily workflow run twice → one reminder row. ✅
5. Grep the exported JSON for the secret → no hits. ✅

See the README's "Verified end to end" table for the full list.
