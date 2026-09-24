import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  getOptionalIntegrationTestEnvironment,
  verifyTestBackend,
} from "../src/testing/test-environment";

const integration = getOptionalIntegrationTestEnvironment();
const api = integration?.apiUrl;
const origin = (Bun.env.FRONTEND_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);

(api ? test : test.skip)(
  "settings enforce presence, typing, read receipt and password privacy",
  async () => {
    if (!api || !integration)
      throw new Error("Missing integration environment");
    await verifyTestBackend(integration);
    const database = new SQL(integration.databaseUrl, { max: 1 });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const oldPassword = "Settings-Test-42";
    const newPassword = "Settings-Test-84";
    const users = ["A", "B"].map((letter) => ({
      username: `Settings${letter}${suffix}`,
      email: `settings-${letter.toLowerCase()}-${suffix}@example.test`,
      id: "",
      cookie: "",
    }));
    type Event = { type: string; [key: string]: unknown };
    const clients: { socket: WebSocket; events: Event[] }[] = [];
    const request = (
      path: string,
      cookie = "",
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
    ) =>
      fetch(`${api}${path}`, {
        method,
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const connect = async (cookie: string) => {
      const url = new URL("/ws", api);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url, {
        headers: { Cookie: cookie, Origin: origin },
      });
      const client = { socket, events: [] as Event[] };
      clients.push(client);
      socket.addEventListener("message", (event) =>
        client.events.push(JSON.parse(String(event.data)) as Event),
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WS timeout")), 3_000);
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener("error", reject, { once: true });
      });
      return client;
    };
    const waitFor = async (
      client: (typeof clients)[number],
      predicate: (event: Event) => boolean,
      start = 0,
    ) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const event = client.events.slice(start).find(predicate);
        if (event) return event;
        await Bun.sleep(20);
      }
      throw new Error(
        `Event timeout: ${JSON.stringify(client.events.slice(start))}`,
      );
    };

    try {
      expect((await request("/api/settings")).status).toBe(401);
      for (const user of users) {
        expect(
          (
            await request("/api/auth/register", "", {
              username: user.username,
              email: user.email,
              password: oldPassword,
              confirmPassword: oldPassword,
            })
          ).status,
        ).toBe(201);
        const login = await request("/api/auth/login", "", {
          email: user.email,
          password: oldPassword,
        });
        user.cookie = login.headers.get("set-cookie")!.split(";")[0];
        user.id = ((await login.json()) as { user: { id: string } }).user.id;
      }
      const [a, b] = users;
      await database`
        INSERT INTO friend_requests(sender_id, receiver_id, status)
        VALUES(${a.id}, ${b.id}, 'accepted')
      `;
      const socketA = await connect(a.cookie);
      const socketB = await connect(b.cookie);
      await waitFor(socketA, (event) => event.type === "chat.state");
      await waitFor(socketB, (event) => event.type === "chat.state");

      const defaults = (await (
        await request("/api/settings", a.cookie)
      ).json()) as {
        settings: { presenceStatus: string; enterToSend: boolean };
      };
      expect(defaults.settings.presenceStatus).toBe("online");
      expect(defaults.settings.enterToSend).toBe(true);
      expect(
        (await request("/api/settings", a.cookie, { unsupported: true }, "PUT"))
          .status,
      ).toBe(400);

      const awayStart = socketB.events.length;
      expect(
        (
          await request(
            "/api/settings",
            a.cookie,
            { presenceStatus: "away", customStatus: "💻 Coding" },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      const away = await waitFor(
        socketB,
        (event) => event.type === "presence.update" && event.userId === a.id,
        awayStart,
      );
      expect(away.status).toBe("away");
      expect(away.customStatus).toBe("💻 Coding");

      const invisibleStart = socketB.events.length;
      await request(
        "/api/settings",
        a.cookie,
        { presenceStatus: "invisible" },
        "PUT",
      );
      const invisible = await waitFor(
        socketB,
        (event) => event.type === "presence.update" && event.userId === a.id,
        invisibleStart,
      );
      expect(invisible.online).toBe(false);
      expect(invisible.status).toBe("offline");
      expect(invisible.customStatus).toBe("");

      await request(
        "/api/settings",
        a.cookie,
        {
          presenceStatus: "online",
          showOnlineStatus: true,
          showTypingIndicator: false,
          sendReadReceipts: false,
        },
        "PUT",
      );
      const typingStart = socketB.events.length;
      socketA.socket.send(
        JSON.stringify({ type: "typing.start", receiverId: b.id }),
      );
      await Bun.sleep(250);
      expect(
        socketB.events
          .slice(typingStart)
          .some((event) => event.type === "typing.start"),
      ).toBe(false);

      const sentStart = socketA.events.length;
      socketB.socket.send(
        JSON.stringify({
          type: "message.send",
          receiverId: a.id,
          message: "private settings receipt test",
        }),
      );
      const delivered = await waitFor(
        socketA,
        (event) => event.type === "message.new",
        sentStart,
      );
      const messageId = (delivered.message as { id: string }).id;
      const receiptStart = socketB.events.length;
      socketA.socket.send(
        JSON.stringify({
          type: "message.read",
          friendId: b.id,
          throughMessageId: messageId,
        }),
      );
      await Bun.sleep(250);
      expect(
        socketB.events
          .slice(receiptStart)
          .some((event) => event.type === "message.read"),
      ).toBe(false);
      const history = (await (
        await request(`/api/messages/${b.id}`, a.cookie)
      ).json()) as { messages: { id: string; readAt: string | null }[] };
      expect(
        history.messages.find((message) => message.id === messageId)?.readAt,
      ).toBeString();

      expect(
        (
          await request(
            "/api/settings/password",
            a.cookie,
            {
              currentPassword: "wrong-password",
              newPassword,
              confirmPassword: newPassword,
            },
            "PUT",
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await request(
            "/api/settings/password",
            a.cookie,
            {
              currentPassword: oldPassword,
              newPassword,
              confirmPassword: newPassword,
            },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await request("/api/auth/login", "", {
            email: a.email,
            password: oldPassword,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request("/api/auth/login", "", {
            email: a.email,
            password: newPassword,
          })
        ).ok,
      ).toBe(true);
    } finally {
      for (const client of clients) client.socket.close();
      await Bun.sleep(100);
      for (const user of users)
        await database`DELETE FROM users WHERE email = ${user.email}`;
      await database.close();
    }
  },
  30_000,
);
