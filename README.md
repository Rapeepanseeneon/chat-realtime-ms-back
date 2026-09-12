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
WebSocket endpoint is `ws://localhost:3001/ws`, and message history is available
from `GET http://localhost:3001/api/messages`. Set `FRONTEND_URL` to the exact
frontend origin. In production, use HTTPS and set `COOKIE_SECURE=true`.

On startup, the backend uses `DATABASE_URL` to connect to PostgreSQL and creates
the `users`, `sessions`, and `messages` tables and their indexes if needed.
Passwords are hashed with Argon2id and session cookies are HttpOnly.

## Checks

```bash
bun run format:check
bun run typecheck
bun run build
```
