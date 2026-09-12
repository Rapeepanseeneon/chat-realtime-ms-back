# chat-realtime-ms-back

Realtime chat backend built with Bun, Hono, and Bun's native WebSocket server.

## Run locally

```bash
bun install
bun run dev
```

The HTTP server runs at `http://localhost:3001` by default. The WebSocket endpoint
is `ws://localhost:3001/ws`. Set `PORT` in a local `.env` file to use another
port.

## Checks

```bash
bun run format:check
bun run typecheck
bun run build
```
