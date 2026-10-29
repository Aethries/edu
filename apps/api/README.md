# API

Hono + Cloudflare Workers. Infrastructure only; no teacher/student/accounting samples.

## Local setup

1. Copy `.dev.vars.example` to `.dev.vars` in this directory.
2. From the root, run `npm install`, then `npm run db:migrate:local --workspace @edu/api`.
3. Run `npm run dev:api` (port 8787), `npm run dev:admin` (port 3000), or `npm run dev:all`.

`AUTH_ENABLED=false` makes protected routes return 503; it never bypasses auth. Configure a trusted OIDC issuer, API audience, and JWKS endpoint to enable authentication. Only RS256/ES256 access JWTs with `sub`, `exp`, `iat` are accepted; issuer/audience/signature/expiry are verified. Login, signup, password reset, MFA, and refresh belong to your identity provider, not this Worker. Cloudflare Access can protect internal staff access; it is not an end-user identity system for student/parent mobile apps.

Apply migrations before requests or scheduled maintenance. Membership provisioning is intentionally not public: insert verified issuer subject IDs and organization UUIDs through a reviewed administrative migration/tool. Roles: owner/admin have files read/write + realtime access; member has files read + realtime access. No client-supplied roles. Organization ownership lifecycle and finer business permissions must be defined with actual features.

## Structure

- `src/modules`: all feature/infrastructure implementations; routes and runtime handlers stay together.
- `src/modules/middleware`: request context, logging, rate limiting, JWT/permissions, public caching.
- `src/db`: Drizzle schema/client; SQL migrations in `drizzle/`.
- `src/db/schema`: existing IAM/infrastructure domain files, re-exported by `index.ts`; add domains when implemented, not beforehand.
- `src/lib/router.ts`: shared OpenAPI router factory and validation error format.
- `src/modules/queue`: validated job envelope, consumer registry, transactional outbox/idempotency helpers.
- `src/modules/cron`: minutely outbox delivery and expired-ticket cleanup.
- `src/modules/realtime`: routes, Durable Object, namespace lookup, one-use ticket hashing.
- `src/modules/storage`: private R2 routes and upload validation.
- `src/configs`, `src/db`, `src/lib`, `src/types.ts`: shared configuration, database, helpers, types. `app.ts`/`index.ts` compose module entrypoints.
- `packages/common`: platform-neutral public contracts and shared schemas; never credentials/DB entities.

## HTTP and security

Request IDs, safe structured timing/error logs, security headers, exact-origin CORS, body limits, no-store default, validated configuration. No tokens, bodies, query strings, WebSocket ticket headers, or URL identifiers in custom logs. Review platform logging settings separately. CORS is not authorization. No cookies are accepted for identity; adding cookie auth requires CSRF protection.

`API_RATE_LIMITER` limits `/v1/*` to 120 requests/minute per Cloudflare-provided IP. Native rate limits are per location/approximate, not billing quotas or global correctness guarantees. Add WAF/identity-specific abuse controls before production. Health is liveness only; no internal resource details. `/openapi.json` requires a valid bearer token and describes REST routes; the WebSocket handshake is documented below. Feature request schemas use `@hono/zod-openapi`.

## Storage

`PUT/GET/DELETE /v1/orgs/:organizationId/files/:fileId` require UUIDs, JWT and DB membership permissions. R2 is private; keys are server-derived, organization-scoped. Uploads are bounded (default 5 MiB, maximum configured 10 MiB), allow PNG/JPEG/PDF with magic-byte checks, and cannot overwrite an existing file ID. Downloads are attachments with `nosniff`; delete is idempotent.

Uploads require a valid `Content-Length` (411 if missing). Browsers set this automatically for Blob/File bodies; native clients must send the known size. Only the first eight bytes are retained for signature validation; a counted stream and `FixedLengthStream` feed R2 without whole-file buffering. Length mismatches/signature failures abort the put; R2 does not commit partial objects. Unknown-length/chunked uploads are intentionally unsupported. Use direct multipart transfers when that requirement exists.

Magic bytes are **not malware scanning or full file parsing**. Treat uploaded files as untrusted. Add quarantine/scanning before exposing user uploads to others. There are no public buckets or presigned URLs: authenticated API transfers avoid an unnecessary S3 credential dependency. Add signed direct transfers only when larger files justify them.

## Caching

Private downloads use ETag + `If-None-Match`, returning 304 only after authorization. `Cache-Control: private, no-cache` permits private storage but requires revalidation; no CDN cache. This is not suitable for a policy that forbids any client-side file retention.

`publicCache(seconds)` is opt-in for genuinely public GET routes only. It bypasses requests with Authorization/Cookie, excludes errors/private responses/Set-Cookie and Vary fields other than Origin, and uses the per-data-center Cache API. Allowlisted Origins have distinct cache keys, including a separate no-Origin variant; untrusted Origins bypass caching. Global CORS and request logging remain enabled; request IDs are regenerated on hits. No existing private route enables it. Version public URLs for invalidation; local `cache.delete()` is not global purge. Never cache permissions, financial truth, tokens, or tenant-private API responses publicly. TanStack Query owns admin client state; clear it on logout/account changes. JWKS caching is handled by jose with key rotation support.

## Realtime

1. Authenticated clients POST `/v1/orgs/:organizationId/realtime/tickets`. If present, `Origin` must be allowlisted; native clients may omit it.
2. Connect to `/v1/orgs/:organizationId/realtime` using protocols `edu.v1` and `edu-ticket.<ticket>`; do not put bearer tokens/tickets in URLs.
3. Tickets are hashed, organization/origin-bound, expire after 30 seconds by default, and are atomically consumed once. Membership is rechecked on connection.

Each `(organizationId, subject)` tuple has its own Durable Object, capped at five sockets; no shared 100-socket organization ceiling. Backend publishers use `getUserRoom()` to target a subject. Organization/branch broadcasts need explicit recipient fan-out; there is no implicit broadcast to every room. Sockets use hibernation and live until verified access-token expiry, without a five-minute cap (30-second alarm granularity). Membership checks are cached in memory for at most 30 seconds; alarms invalidate this cache. Revocations can therefore take up to 30 seconds under normal scheduling. Publication still checks session expiry and refreshes stale membership; it does not rely solely on timely alarms. Reconnect with a fresh token/ticket after expiry. Native clients may omit Origin; tickets issued without Origin cannot be redeemed with an Origin, or vice versa. Origin is additional protection, not identity.

Only backend binding RPC `publish()` sends validated events, limited to 16 KiB. Clients cannot publish. No business broadcasts exist yet. Delivery is ephemeral; reconnecting clients must refetch authoritative state. A token revoked at the identity provider remains valid until expiry unless provider-specific revocation is added. Identity endpoints and DO bindings are server-controlled trust boundaries.

## D1, queues, cron

Drizzle Kit generates SQL; Wrangler applies it. Use `db:generate`, review SQL, then `db:migrate:local`. Production migrations run once in a controlled release, never at Worker startup. D1 atomic `batch()` is not a general interactive PostgreSQL transaction; plan around the 10 GB paid per-database limit. Financial features need safe integer minor units/explicit decimals, immutable balanced postings, audits, constraints, and a reviewed domain model—not this infrastructure alone.

Migration generation has one owner at integration time after rebasing. Review journal/snapshot changes and generated table rebuild/copy SQL; do not independently generate competing sequence numbers or rewrite applied migrations. Moving schema files alone must leave SQL unchanged. Repository architecture/stack rules live in root `AGENTS.md`; configuration parity runs in `tests/env.test.ts`.

Use request-context `c.get("db")` or `createDatabase(env.DB)` for typed domain queries. Clients/config are weakly cached per binding object; bindings are treated as immutable. `outboxStatement(db, job)` returns a Drizzle insert for the **same `db.batch([...])`** as the business write. `commitJobOnce(db, id, queries)` also accepts Drizzle queries. Raw parameterized SQL remains limited to infrastructure lease/dispatch/cleanup/archive operations; ORM use does not replace tenant predicates or constraints.

Cron dispatches up to 100 eligible pending jobs per minute using `sendBatch()` and D1 batch updates. Payloads are limited to 127000 bytes, with batches split at 240000 bytes to leave Queue metadata headroom. Invalid/old-schema/oversized rows are atomically archived in `failed_jobs` and quarantined, never blocking later rows. Each attempt records attempts/last_error; failed batches back off 60 seconds while later batches continue. Quarantined jobs remain until reviewed, not automatically purged. A D1 lease atomically acquires dispatch ownership, renews before each send, expires after five minutes, and releases only for the owning invocation. This suppresses ordinary cron overlap, not all duplicates: a stalled sender can outlive its lease; a crash between Queue acceptance and D1 marking can resend. Consumers must stay idempotent. Direct `enqueueJob()` is nontransactional.

Register real handlers in `queue/consumer.ts`; validate feature payloads. Successful handling acknowledges. Unknown/malformed jobs archive directly to D1; handler failures retry, then reach the configured DLQ after five retries. Each environment has a DLQ consumer archiving messages to `failed_jobs`; acknowledgement happens only after successful storage, duplicate archival is idempotent. Archive failures retry; Queue retention/retries are still finite, so prolonged D1 outages require alerts/recovery/export. `failed_jobs` retains original body, source/message ID, reason, attempts, timestamp without automatic deletion. It is the storage foundation for a later authorized admin review/replay UI, not a public replay endpoint. Replays must preserve job IDs for deduplication; fix invalid payloads explicitly before replay. `commitJobOnce()` atomically records a job ID with its **Drizzle queries**, rolling back together. It does not provide exactly-once external effects. External services need provider idempotency keys. No arbitrary HTTP mutation idempotency guarantee is claimed.

Cron `* * * * *` uses UTC. Maintenance deletes expired tickets, dispatches the outbox, and deletes up to 1000 old records per table per invocation. `OUTBOX_RETENTION_DAYS=30` deletes only sent rows; pending jobs are never purged. `PROCESSED_JOBS_RETENTION_DAYS=0` preserves deduplication records by default. Set it to at least 30 days only after defining/enforcing a replay cutoff that exceeds Queue + DLQ + manual replay windows; deleting the record allows old jobs to execute again. A 30-day minimum alone does not guarantee safety. These are operational records, not financial audit retention. No fake business schedules. Workflows/KV/email remain absent until a feature needs them.

## Checks

```sh
npm run lint
npm run typecheck
npm run test --workspace @edu/api
npm run build
```

Tests build a dry-run bundle, then run unit checks and a local workerd/Miniflare integration with signed JWTs, D1 migrations, tenant checks, private R2 transfers/ETags, one-use WebSocket tickets, outbox, rollback, duplicate-job prevention. No cloud resources are contacted; the test issuer is local. Queue sending is stubbed in the outbox test; actual cloud retry/DLQ behavior needs staging validation.

## Staging / production

`wrangler.staging.jsonc` and `wrangler.production.jsonc` explicitly isolate resource names/settings. They contain **placeholder** D1 IDs/domains/identity endpoints. Replace them, configure custom API routes, provision resources after budget review, and verify account selection. Public workers.dev/preview URLs remain disabled. Deployed configuration requires enabled auth + HTTPS origins/identity URLs.

Use explicit `--config wrangler.staging.jsonc` or `--config wrangler.production.jsonc` with Wrangler commands. Never apply remote migrations without selecting/reviewing the target. `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` belong in shell/CI; required runtime secrets, if added, belong in Wrangler secrets. Bindings do not require copying R2/D1 credentials into env files. `.dev.vars.example` lists all current runtime variables; there are no required runtime secrets yet.

No resources provisioned, deployments performed, identity account configured, or production-readiness claim. Before launch: test recovery, DLQ replay/alerts, resource budgets, log retention, malware handling, user provisioning, permission revocation, identity-provider compatibility, and financial requirements.
