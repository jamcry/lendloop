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

## Import the workflows

n8n 2.x distinguishes draft from published workflows, so importing is not enough —
you have to publish.

```bash
docker compose exec -T n8n n8n import:workflow --input=/workflows/request-notification.json
docker compose exec -T n8n n8n import:workflow --input=/workflows/overdue-reminders.json
docker compose exec -T n8n n8n import:workflow --input=/workflows/error-handler.json

# publish each (id from the listing)
docker compose exec -T n8n n8n list:workflow
docker compose exec -T n8n n8n publish:workflow --id=<id>
docker compose exec -T n8n n8n publish:workflow --id=<id>

# publishing does not take effect until the process reloads
docker compose restart
```

You should see `Processed 0 draft workflows, 2 published workflows` in the logs.
Two, not three: error workflows are referenced by ID and are not activated.

The `workflows/` directory is mounted read-only, so a running instance can never
rewrite the exported JSON in the repository.

## Try the reminder workflow by hand

The overdue workflow has both a schedule trigger and a manual trigger, so it can be
executed without waiting for 08:00:

```bash
docker compose run --rm --no-deps --entrypoint n8n -T n8n execute --id=<overdue-workflow-id>
```

Run it twice. You should get exactly one reminder row written back to Convex —
that is the idempotency key doing its job:

```bash
cd .. && npx convex data loanActivity
```

Seed an overdue loan first if you need one:

```bash
npx convex run seed:populate
npx convex run seed:createDemoOverdueLoan
```

## The one thing that will confuse you

Convex runs in the cloud and **cannot reach `localhost:5678`**. So the
`request-notification` webhook only fires if n8n is publicly reachable:

```bash
ngrok http 5678
npx convex env set N8N_WEBHOOK_URL https://<your-id>.ngrok-free.app/webhook/lendloop/request-event
```

Without a tunnel, outbound jobs retry five times and then show as
`notification.failed` in the admin Automation tab. That is the designed failure
mode — it is how you _know_ the integration is not wired up, instead of never
finding out.

The n8n → Convex direction needs no tunnel: Convex is already public.

## Secrets

| Variable                 | Used by                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `LENDLOOP_SHARED_SECRET` | HMAC key, both directions. Must match the Convex deployment   |
| `LENDLOOP_SITE_URL`      | Convex HTTP actions base (`https://<deployment>.convex.site`) |
| `N8N_ENCRYPTION_KEY`     | n8n's own credential encryption at rest                       |

`N8N_ENCRYPTION_KEY` must be set explicitly. Without it n8n generates one and
stores it in the volume, so credentials silently become unreadable if the volume
is rebuilt.

Set the shared secret on Convex with:

```bash
npx convex env set LENDLOOP_SHARED_SECRET "$(openssl rand -hex 32)"
```

then paste the same value into `n8n/.env`. Exported workflow JSON never contains
it — only `{{ $env.LENDLOOP_SHARED_SECRET }}`.

`NODE_FUNCTION_ALLOW_BUILTIN=crypto` is set in the compose file because the Code
nodes verify HMACs, and n8n blocks Node builtins by default.
