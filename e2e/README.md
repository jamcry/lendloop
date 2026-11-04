# Browser (E2E) tests

Playwright tests that drive the real app: Clerk sessions, the Next.js proxy, the
Convex deployment, and the local n8n container. They are the counterpart to
`convex/*.test.ts`, which runs the functions in memory: these prove the wiring
between the pieces, including the HMAC handshake in both directions.

## What is covered

| Spec                   | Covers                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-loan-flow.spec.ts` | Create and edit a listing, request dates, approve, mark returned, decline, withdraw, remove a listing, the signed-in nav, and direct Convex calls that must be refused        |
| `02-admin.spec.ts`     | Admin panel, trusted-lender toggle, cross-account listing removal, all-loans view, self-demotion disabled, admin cannot approve                                               |
| `03-public.spec.ts`    | Brand and tagline, read-only board with no owner details, signed-out redirects, the exact key set returned to anonymous callers                                               |
| `04-n8n.spec.ts`       | 401 on unsigned/stale/tampered requests, 200 on valid ones, idempotent claim/confirm and failure write-backs, the request webhook's message, and the daily workflow run twice |

## Prerequisites

1. `npm install && npx playwright install chromium`
2. `.env.local` with Clerk and Convex keys (the app's normal setup).
3. A linked Convex dev deployment (`npx convex dev --once`).
4. For `04-n8n.spec.ts`: `cd n8n && docker compose up -d`, with the workflows
   imported and published.

The suite creates three throwaway Clerk users through the Backend API:

- `lendloop.e2e.lender@example.com`
- `lendloop.e2e.borrower@example.com`
- `lendloop.e2e.admin@example.com`

It appends the admin address to the deployment's `ADMIN_EMAILS` on first run, so
the admin path is exercised the same way an operator would enable it. The
original value is stored in `e2e/.state.json` (gitignored) if you need to restore
it.

> `example.com` is reserved documentation space and cannot receive mail. The
> users exist only in your Clerk **development** instance.

## Run

```bash
npm run test:e2e          # headless, serial
npm run test:e2e:ui       # interactive
```

To also assert that a request notification actually reaches n8n and comes back
as a visible `notification.sent` row, give Convex a public URL for the local n8n
and opt in:

```bash
# terminal 1
cloudflared tunnel --url http://localhost:5678
# (or: ngrok http 5678)

# terminal 2
npx convex env set N8N_WEBHOOK_URL https://<tunnel>/webhook/lendloop/request-event
E2E_EXPECT_N8N_DELIVERY=1 npm run test:e2e
```

Without the opt-in, that assertion is skipped; the outbox still exercises the
retry ladder, and the failure is visible in the admin Automation tab.

## What it writes

The tests deliberately write to the dev deployment: listings prefixed `E2E
<runId>`, loan requests, a reminder row with a run-specific idempotency key, and
a `workflow.failed` row. Nothing is written to production, and the seed mutation
is gated behind `SEED_ENABLED=true`.

The suite is serial (`workers: 1`) because the loan flow depends on rows created
earlier and all identities share one deployment.

## Notes

- `playwright.config.ts` loads `.env.local` with `@next/env`, exactly like Next.
  No test-only env file is needed.
- Playwright starts `next dev` itself unless a server is already listening on
  `localhost:3000`.
- Artifacts go to `e2e/.results` and `e2e/.report` (gitignored).
