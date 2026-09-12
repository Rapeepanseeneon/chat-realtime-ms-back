import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import type { WSContext } from "hono/ws";

const MAX_NAME_LENGTH = 50;
const MAX_MESSAGE_LENGTH = 1_000;

type ClientMessage = {
  type: "message.send";
  data: {
    name: string;
    text: string;
  };
};

type ServerMessage =
  | {
      type: "message.new";
      data: {
        name: string;
        text: string;
        createdAt: string;
      };
    }
  | {
      type: "error";
      data: {
        message: string;
      };
    };

const app = new Hono();
const clients = new Map<unknown, WSContext>();

const getClientKey = (client: WSContext): unknown => client.raw ?? client;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseClientMessage = (rawValue: unknown): ClientMessage | null => {
  if (typeof rawValue !== "string") {
    return null;
  }

  try {
    const value: unknown = JSON.parse(rawValue);

    if (
      !isRecord(value) ||
      value.type !== "message.send" ||
      !isRecord(value.data)
    ) {
      return null;
    }

    if (
      typeof value.data.name !== "string" ||
      typeof value.data.text !== "string"
    ) {
      return null;
    }

    const name = value.data.name.trim();
    const text = value.data.text.trim();

    if (
      name.length === 0 ||
      name.length > MAX_NAME_LENGTH ||
      text.length === 0 ||
      text.length > MAX_MESSAGE_LENGTH
    ) {
      return null;
    }

    return {
      type: "message.send",
      data: { name, text },
    };
  } catch {
    return null;
  }
};

const sendJson = (client: WSContext, message: ServerMessage) => {
  try {
    client.send(JSON.stringify(message));
  } catch {
    clients.delete(getClientKey(client));
  }
};

const broadcast = (message: ServerMessage) => {
  for (const client of clients.values()) {
    sendJson(client, message);
  }
};

app.get("/", (context) =>
  context.json({
    service: "chat-realtime-ms-back",
    websocket: "/ws",
  }),
);

app.get("/health", (context) =>
  context.json({
    status: "ok",
    connectedClients: clients.size,
  }),
);

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen(_event, client) {
      clients.set(getClientKey(client), client);
      console.info(`WebSocket connected (${clients.size} total)`);
    },
    onMessage(event, client) {
      const message = parseClientMessage(event.data);

      if (!message) {
        sendJson(client, {
          type: "error",
          data: {
            message: `Invalid message. Name must be 1-${MAX_NAME_LENGTH} characters and text must be 1-${MAX_MESSAGE_LENGTH} characters.`,
          },
        });
        return;
      }

      broadcast({
        type: "message.new",
        data: {
          ...message.data,
          createdAt: new Date().toISOString(),
        },
      });
    },
    onClose(_event, client) {
      clients.delete(getClientKey(client));
      console.info(`WebSocket disconnected (${clients.size} total)`);
    },
    onError(_event, client) {
      clients.delete(getClientKey(client));
      console.error(`WebSocket error (${clients.size} total)`);
    },
  })),
);

const port = Number(Bun.env.PORT ?? 3001);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

console.info(`Realtime chat backend listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
  websocket,
};
