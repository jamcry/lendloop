# n8n — local instance

Not required to run LendLoop. The app works without an automation layer; this
compose file exists so the integration described in `docs/n8n-design.md` has a
place to run when it is built.

## Run it

```bash
cd n8n
cp .env.example .env        # then set the two secrets
docker compose up -d
open http://localhost:5678
```

Data persists in the `n8n_data` volume. To reset, `docker compose down -v`.

## Secrets

Two independent secrets, because the two directions fail separately:

| Variable                 | Used by                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `LENDLOOP_SHARED_SECRET` | HMAC key for app → n8n payloads **and** n8n → app write-backs |
| `N8N_ENCRYPTION_KEY`     | n8n's own credential encryption at rest                       |

Neither belongs in a workflow JSON. When a workflow needs the shared secret, it
reads `{{ $env.LENDLOOP_SHARED_SECRET }}` or a credential — exported JSON should
contain only the reference.

`N8N_ENCRYPTION_KEY` in particular must be set explicitly: without it n8n
generates one and stores it in the volume, so credentials silently become
unreadable if the volume is rebuilt.

## Why not n8n Cloud

Local Docker keeps the shared secret on the same machine as Convex's dev
deployment and makes the "no secrets in exported JSON" claim easy to verify. The
workflows are identical either way.
