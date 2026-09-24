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

On startup, the backend uses `DATABASE_URL` to connect to PostgreSQL and creates
the `users`, `sessions`, and `messages` tables and their indexes if needed.
Passwords are hashed with Argon2id and session cookies are HttpOnly.

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
