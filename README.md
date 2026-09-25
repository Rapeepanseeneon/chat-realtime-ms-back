# chat-realtime-ms-back

Realtime chat backend built with Bun, Hono, PostgreSQL, and Bun's native
WebSocket server.

## Run locally

```powershell
Copy-Item .env.example .env
# Replace DATABASE_URL in .env with your PostgreSQL connection string.
bun install
bun run dev
```

The HTTP server runs at `http://localhost:3001` by default. The authenticated
WebSocket endpoint is `ws://localhost:3001/ws`. Set `FRONTEND_URL` to the exact
frontend origin. In production, use HTTPS and set `COOKIE_SECURE=true`. Set
`TRUST_PROXY=true` only behind a trusted reverse proxy that overwrites
`X-Forwarded-For`.

Legacy global chat is disabled by default. `GET /api/messages` and the legacy
global broadcast payload are available only when
`ENABLE_LEGACY_GLOBAL_CHAT=true`; private and group chat do not depend on it.

## Discovery and account privacy

Friend search is authenticated and rate-limited. Username search is partial;
email search requires an exact email address. Search results intentionally omit
the email address and other private account fields. Exact email remains a
discoverability key for signed-in users, while registration uses one generic
conflict response for username/email collisions.

On startup, the backend uses `DATABASE_URL` and verifies that every committed
database migration is already applied. Startup is read-only and fails closed
when migrations are pending or the recorded checksum/schema has drifted.
Passwords are hashed with Argon2id and session cookies are HttpOnly.

## Database migrations

Schema changes are explicit and serialized with a PostgreSQL advisory lock.
Check status and apply pending migrations before starting application traffic:

```powershell
bun run db:status
bun run db:migrate
bun run db:status
```

Before applying schema-integrity migrations to an existing database, run the
read-only preflight. It reports violation counts without changing schema or
application data:

```powershell
bun run db:preflight
# Dedicated test database:
bun run db:preflight:test
```

If any category is nonzero, stop and investigate the existing rows. Do not
delete or silently repair user data merely to make a constraint pass.

The first migration is a baseline of the current Pb schema. For an existing
database, `db:migrate` first verifies every expected table, column, constraint,
and index. Only an exact match is adopted into `schema_migrations`; application
tables and data are not recreated. A partial or mismatched schema, an unknown
history row, or a changed checksum stops the command without automatic repair.

For a new empty database, the baseline and its history row are created in one
transaction. Transactional migrations roll back on error, and repeated runs are
idempotent. Migration files are immutable after they have been applied; add a
new numbered file for later changes.

## Isolated integration tests

Integration tests never fall back to `DATABASE_URL`. Create a dedicated test
database whose name ends in `_test` or `-test` (for example,
`pb_messenger_test`) and set `TEST_DATABASE_URL`. Production-like names are
rejected even when they have a test suffix.

Create the database manually with an authorized PostgreSQL account:

```sql
CREATE DATABASE pb_messenger_test OWNER your_pb_database_user;
```

Configure a separate backend port, then start the guarded test backend:

```powershell
$env:TEST_DATABASE_URL = "postgresql://username:password@localhost:5432/pb_messenger_test"
$env:TEST_BACKEND_PORT = "3101"
$env:CHAT_TEST_API_URL = "http://localhost:3101"
bun run test:integration:backend
```

Apply and verify the same migrations against the dedicated test database before
starting that backend:

```powershell
bun run db:status:test
bun run db:migrate:test
bun run db:status:test
```

In a second terminal with the same three variables, run `bun run
test:integration`. The test backend exposes an identity marker on `/health`;
integration suites refuse to mutate data unless both the database guard and
that marker pass. The normal development backend continues to use
`DATABASE_URL` and port 3001.

## Checks

```bash
bun run format:check
bun run typecheck
bun run build
```
