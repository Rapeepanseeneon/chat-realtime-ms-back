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

The HTTP server runs at `http://localhost:3001` by default. The WebSocket endpoint
is `ws://localhost:3001/ws`, and message history is available from
`GET http://localhost:3001/api/messages`. Set `PORT` in the uncommitted `.env`
file to use another port.

On startup, the backend uses `DATABASE_URL` to connect to PostgreSQL and creates
the `messages` table and its history index if they do not already exist.

## Checks

```bash
bun run format:check
bun run typecheck
bun run build
```
