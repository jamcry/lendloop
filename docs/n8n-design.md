# n8n integration — design (not implemented)

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
await ctx.scheduler.runAfter(0, internal.automation.dispatchJob, { jobId });
```

Backoff: 30s → 2m → 10m → 1h → 4h, then `failed`. `failed` is visible in the app
(loan activity and admin panel), which is the whole point — silent failure is the
default outcome of most webhook code and it is the thing I would be judged on.

## 2. Outbound payloads

Only what the notification needs. No emails of the other party, no tool
description, no full user records.

`request.created` / `request.status_changed`:

```json
{
  "eventId": "evt_01J...",
  "kind": "loan.status_changed",
  "occurredAt": 1767225600000,
  "data": {
    "loanId": "k17f...",
    "toolName": "DeWalt cordless drill",
    "status": "approved",
    "startDate": 1767225600000,
    "endDate": 1767484800000,
    "borrowerEmail": "borrower@example.com",
    "ownerEmail": "owner@example.com"
  }
}
```

The workflow decides who to message from `status`, so the app never has to
explain notification policy to itself.

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
- Secret lives in an n8n **credential** and in Convex deployment env, never in
  the workflow JSON. Exported workflows reference `$env` / credentials only.

## 4. Inbound (n8n → app)

Two HTTP endpoints on Convex's `httpRouter`:

| Endpoint                | Method | Purpose                                        |
| ----------------------- | ------ | ---------------------------------------------- |
| `/automation/overdue`   | GET    | Scheduled workflow polls overdue loans         |
| `/automation/reminders` | POST   | Workflow records that a reminder was delivered |

`GET /overdue` is already implemented as the internal query
`automation.overdueLoans`; only the HTTP wrapper is missing. It returns
`loanId`, `toolName`, `borrowerEmail`, `dueDate`, `daysOverdue` — five fields,
because a reminder needs five fields.

### Write-back idempotency

```
POST /automation/reminders
Idempotency-Key: reminder:<loanId>:<dueDate>:<daystamp>
```

- `idempotencyKeys` table with a unique index on `key`.
- First call inserts the key and the activity row in one transaction.
- A replay hits the unique constraint and returns `200 {duplicate: true}` with the
  original result — not a 409, because n8n should treat a retry as success.
- The key is derived from data, not random, so a _retried workflow run_ and a
  _duplicate schedule run_ collapse to the same key.

Inbound requests authenticate the same way (HMAC + timestamp), so n8n cannot be
spoofed either. That is the "secure in both directions" requirement.

## 5. Workflows

### `request-notification.json`

(single Code node rather than a Switch — fewer places to get JSON wrong, and the
message routing is three lines of JS)

```
Webhook (POST, responds immediately)
  → Code: verify HMAC + 5-min window → 401 on failure
  → Switch on status
      pending  → Email (owner): "X wants your drill, Mar 4–6"
      approved → Email (borrower): "Approved — collect it Mar 4"
      declined → Email (borrower): "Not this time"
      returned → Email (borrower): "Thanks for returning it"
  → error branch → error workflow
```

The webhook responds `202` before doing work, so a slow SMTP server cannot cause
the app's dispatch action to time out and retry into a duplicate send. Duplicate
sends are prevented anyway by the outbox job id, but responding fast is cheaper
than relying on that.

### `overdue-reminders.json`

```
Schedule Trigger (daily 08:00)
  → HTTP Request: GET /automation/overdue (signed)
  → Split In Batches (1)
      → IF daysOverdue <= 0 → skip
      → Email: "Your loan of <tool> was due <date>"
      → HTTP Request: POST /automation/reminders
          Idempotency-Key: reminder:<loanId>:<dueDate>:<today>
      → on failure: retry 3x with backoff, then continue-on-fail
  → Summary node → log counts
```

`continue-on-fail` matters: one broken email address must not stop reminders for
everyone else.

### `error-handler.json`

Registered as the n8n **Error Workflow** for both. Receives the failed execution,
posts to `/automation/reminders` with `kind: "workflow.failed"`, and the admin
panel surfaces it. If the app is unreachable too, the workflow writes to a
dead-letter webhook (Slack) — but the last resort is n8n's own execution history,
which is why the error workflow is a notification, not the only record.

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
