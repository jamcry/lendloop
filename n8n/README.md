# n8n — local instance

Not required to browse LendLoop. Required if you want to see the automation work.

## Run it

```bash
cd n8n
cp .env.example .env        # fill in LENDLOOP_SHARED_SECRET, LENDLOOP_SITE_URL, N8N_ENCRYPTION_KEY
docker compose up -d
open http://localhost:5678
```

Data persists in the `n8n_data` volume. To reset, `docker compose down -v`.

**If the container crash-loops and `compose ps` stays on `health: starting`
indefinitely**, read `docker compose logs`: a `Mismatching encryption keys`
error means the volume predates your `N8N_ENCRYPTION_KEY` — an earlier `up`
without the key let n8n generate and persist its own. The reset above is the
fix: `docker compose down -v`, then `docker compose up -d` with the key set.

## Import the workflows

n8n 2.x distinguishes draft from published workflows, so importing is not enough —
you have to publish.

```bash
docker compose exec -T n8n n8n import:workflow --input=/workflows/request-notification.json
docker compose exec -T n8n n8n import:workflow --input=/workflows/overdue-reminders.json
docker compose exec -T n8n n8n import:workflow --input=/workflows/error-handler.json

# publish each (id from the listing) — including the error workflow
docker compose exec -T n8n n8n list:workflow
docker compose exec -T n8n n8n publish:workflow --id=<id>
docker compose exec -T n8n n8n publish:workflow --id=<id>
docker compose exec -T n8n n8n publish:workflow --id=<id>

# publishing does not take effect until the process reloads
docker compose restart
```

You should see `Processed 0 draft workflows, 3 published workflows`.

All three need publishing, including the error workflow. An unpublished error
workflow is invoked and then refused — n8n logs `Workflow "<id>" is not active
and cannot be executed`, and the failure goes unreported. That is worth knowing
because it looks like wiring that works.

The exported JSON stores the error workflow's **ID**, and IDs are
instance-specific. On your machine the reference will point at a workflow that
does not exist, so re-select it in each workflow's **Settings → Error Workflow**
after importing.

The `workflows/` directory is mounted read-only, so a running instance can never
rewrite the exported JSON in the repository.

## Try the reminder workflow by hand

The overdue workflow has both a schedule trigger and a manual trigger, so it can be
executed without waiting for 08:00:

```bash
docker compose run --rm --no-deps --entrypoint n8n -T n8n execute --id=<overdue-workflow-id>
```

Use `docker compose run` (a one-off container), not `docker exec` into the running
one: the CLI starts its own task broker on port 5679 and refuses to start when the
live container already holds it.

Run it twice. Each run claims the reminder, sends it, then confirms it. The second
run claims nothing, so it sends nothing — exactly one row, confirmed once:

```bash
cd .. && npx convex data loanActivity
```

With a local deployment the backend is not left running by `--once`, so keep
`npx convex dev` running in another terminal first; the CLI will ask for exactly
that if you forget.

A row with `kind: "reminder.sent"` but no `confirmedAt` is a queued reminder whose
send or confirmation failed. The app labels it "Reminder queued", not "sent", and
the failed execution is reported to the admin Automation tab by the error
workflow.

Seed an overdue loan first if you need one. Pass your own address so the seeded
listings belong to a real account; the overdue tool is then hidden from the public
board until you mark that loan returned:

```bash
npx convex run seed:populate '{"ownerEmail":"you@example.com"}'
npx convex run seed:createDemoOverdueLoan
```

## The two things that can confuse you

Whether Convex — the webhook caller — can reach `localhost:5678` depends on the
deployment mode, and both modes are supported:

- **Anonymous local deployment** (the default of `npx convex dev --once` with no
  Convex account): the backend runs on this machine, so outbound webhooks reach
  local n8n with no tunnel, and `N8N_WEBHOOK_URL` is
  `http://localhost:5678/webhook/lendloop/request-event`. The _reverse_
  direction is the one to watch: `LENDLOOP_SITE_URL` is the HTTP-actions port
  from `.env.local` (NEXT_PUBLIC_CONVEX_SITE_URL, e.g. `127.0.0.1:3211`), but
  n8n runs in a container while Convex runs on the host, so write it as
  `http://host.docker.internal:3211`.
- **Cloud-linked deployment**: Convex runs in the cloud and cannot reach
  `localhost:5678`, so the request-notification webhook only fires if n8n is
  publicly reachable:

  ```bash
  ngrok http 5678
  npx convex env set N8N_WEBHOOK_URL https://<your-id>.ngrok-free.app/webhook/lendloop/request-event
  ```

In either mode, a misconfigured outbound URL fails loudly: jobs retry five times
(six attempts in total, over about six hours) and then show as
`notification.failed` in the admin Automation tab. That is the designed failure
mode — it is how you _know_ the integration is not wired up, instead of never
finding out.

The n8n → Convex direction needs no tunnel in either mode: a local backend is
reachable at `host.docker.internal`, a cloud deployment is already public.

## Secrets

| Variable                 | Used by                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `LENDLOOP_SHARED_SECRET` | HMAC key, both directions. Must match the Convex deployment   |
| `LENDLOOP_SITE_URL`      | Convex HTTP actions base (`https://<deployment>.convex.site`) |
| `N8N_ENCRYPTION_KEY`     | n8n's own credential encryption at rest                       |

`N8N_ENCRYPTION_KEY` must be set explicitly. Without it n8n generates one and
stores it in the volume, so credentials silently become unreadable if the volume
is rebuilt.

Set the shared secret on Convex with (from the **repo root** — run from `n8n/`,
the CLI cannot find a deployment and fails with a misleading
"No CONVEX_DEPLOYMENT set"):

```bash
npx convex env set LENDLOOP_SHARED_SECRET "$(openssl rand -hex 32)"
```

then paste the same value into `n8n/.env`. Exported workflow JSON never contains
it — only `{{ $env.LENDLOOP_SHARED_SECRET }}`.

`NODE_FUNCTION_ALLOW_BUILTIN=crypto` is set in the compose file because the Code
nodes verify HMACs, and n8n blocks Node builtins by default.
