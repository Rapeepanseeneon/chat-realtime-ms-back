import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  getOptionalIntegrationTestEnvironment,
  verifyTestBackend,
} from "../src/testing/test-environment";

// Opt-in integration test against a running backend using its DATABASE_URL.
// Only uniquely named test accounts are deleted; FK cascades remove their data.
const integration = getOptionalIntegrationTestEnvironment();
const baseUrl = integration?.apiUrl;
const origin = (Bun.env.FRONTEND_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const integrationTest = baseUrl ? test : test.skip;

integrationTest(
  "private chat status, persistence, privacy and multiple tabs",
  async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const password = "Temporary-Status-Test-42";
    const users = ["A", "B", "C"].map((letter) => ({
      username: `Status${letter}${suffix}`,
      email: `status-${letter.toLowerCase()}-${suffix}@example.test`,
      id: "",
      cookie: "",
    }));
    if (!integration || !baseUrl)
      throw new Error("Integration environment is not configured");
    await verifyTestBackend(integration);
    const database = new SQL(integration.databaseUrl, { max: 1 });
    type Event = { type: string; [key: string]: unknown };
    type Client = { socket: WebSocket; events: Event[] };
    const clients: Client[] = [];
    const call = (path: string, cookie = "", body?: unknown, method = "GET") =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const connect = async (cookie: string): Promise<Client> => {
      const wsUrl = new URL("/ws", baseUrl);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(wsUrl.toString(), {
        headers: { Cookie: cookie, Origin: origin },
      });
      const client = { socket, events: [] as Event[] };
      clients.push(client);
      socket.addEventListener("message", (event) =>
        client.events.push(JSON.parse(String(event.data)) as Event),
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("WebSocket open timeout")),
          3_000,
        );
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error("WebSocket failed"));
          },
          { once: true },
        );
      });
      return client;
    };
    const send = (client: Client, event: unknown) =>
      client.socket.send(JSON.stringify(event));
    const waitFor = async (
      client: Client,
      predicate: (event: Event) => boolean,
      start = 0,
      timeout = 3_000,
    ) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const match = client.events.slice(start).find(predicate);
        if (match) return match;
        await Bun.sleep(20);
      }
      throw new Error(
        `Event timeout: ${JSON.stringify(client.events.slice(start))}`,
      );
    };
    const friends = async (cookie: string) => {
      const response = await call("/api/friends", cookie);
      expect(response.ok).toBe(true);
      return (
        (await response.json()) as {
          friends: { id: string; online: boolean; unreadCount: number }[];
        }
      ).friends;
    };
    const history = async (
      owner: (typeof users)[number],
      friend: (typeof users)[number],
    ) => {
      const response = await call(`/api/messages/${friend.id}`, owner.cookie);
      expect(response.ok).toBe(true);
      return (
        (await response.json()) as {
          messages: {
            id: string;
            messageText: string;
            readAt: string | null;
          }[];
        }
      ).messages;
    };
    const acceptFriendship = async (
      sender: (typeof users)[number],
      receiver: (typeof users)[number],
    ) => {
      const sent = await call(
        "/api/friend-requests",
        sender.cookie,
        { receiverId: receiver.id },
        "POST",
      );
      expect(sent.status).toBe(201);
      const { requestId } = (await sent.json()) as { requestId: string };
      const accepted = await call(
        `/api/friend-requests/${requestId}`,
        receiver.cookie,
        { action: "accept" },
        "PUT",
      );
      expect(accepted.ok).toBe(true);
    };

    try {
      expect((await call("/api/friends")).status).toBe(401);
      for (const user of users) {
        expect(
          (
            await call(
              "/api/auth/register",
              "",
              {
                username: user.username,
                email: user.email,
                password,
                confirmPassword: password,
              },
              "POST",
            )
          ).status,
        ).toBe(201);
        const response = await call(
          "/api/auth/login",
          "",
          { email: user.email, password },
          "POST",
        );
        expect(response.ok).toBe(true);
        user.cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
        user.id = ((await response.json()) as { user: { id: string } }).user.id;
      }
      const [a, b, c] = users;
      await acceptFriendship(a, b);
      await acceptFriendship(b, c);

      const socketA = await connect(a.cookie);
      const initialA = await waitFor(
        socketA,
        (event) => event.type === "chat.state",
      );
      expect(
        (initialA.friends as { id: string; online: boolean }[]).find(
          (friend) => friend.id === b.id,
        )?.online,
      ).toBe(false);
      const socketB = await connect(b.cookie);
      await waitFor(
        socketA,
        (event) =>
          event.type === "presence.update" &&
          event.userId === b.id &&
          event.online === true,
      );
      const initialB = await waitFor(
        socketB,
        (event) => event.type === "chat.state",
      );
      expect(
        (initialB.friends as { id: string; online: boolean }[]).find(
          (friend) => friend.id === a.id,
        )?.online,
      ).toBe(true);
      const socketC = await connect(c.cookie);
      const socketBTab2 = await connect(b.cookie);
      await waitFor(socketBTab2, (event) => event.type === "chat.state");
      const presenceStart = socketA.events.length;
      socketB.socket.close();
      await Bun.sleep(200);
      expect(
        (await friends(a.cookie)).find((friend) => friend.id === b.id)?.online,
      ).toBe(true);
      expect(
        socketA.events
          .slice(presenceStart)
          .some(
            (event) =>
              event.type === "presence.update" &&
              event.userId === b.id &&
              event.online === false,
          ),
      ).toBe(false);
      socketBTab2.socket.close();
      await waitFor(
        socketA,
        (event) =>
          event.type === "presence.update" &&
          event.userId === b.id &&
          event.online === false,
        presenceStart,
      );
      const reopenStart = socketA.events.length;
      const reopenedB = await connect(b.cookie);
      await waitFor(
        socketA,
        (event) =>
          event.type === "presence.update" &&
          event.userId === b.id &&
          event.online === true,
        reopenStart,
      );
      console.log(
        "PASS: online/offline initial state, final disconnect, reconnect and multiple tabs",
      );

      const privacyStart = socketC.events.length;
      const typingStart = reopenedB.events.length;
      send(socketA, { type: "typing.start", receiverId: b.id });
      await waitFor(
        reopenedB,
        (event) => event.type === "typing.start" && event.userId === a.id,
        typingStart,
      );
      send(socketA, { type: "typing.stop", receiverId: b.id });
      await waitFor(
        reopenedB,
        (event) => event.type === "typing.stop" && event.userId === a.id,
        typingStart,
      );
      const expiryStart = reopenedB.events.length;
      send(socketA, { type: "typing.start", receiverId: b.id });
      await waitFor(
        reopenedB,
        (event) => event.type === "typing.start",
        expiryStart,
      );
      await waitFor(
        reopenedB,
        (event) => event.type === "typing.stop",
        expiryStart,
        5_000,
      );
      console.log("PASS: typing start, explicit stop and server timeout");

      const messageStartA = socketA.events.length;
      const messageStartB = reopenedB.events.length;
      send(socketA, { type: "typing.start", receiverId: b.id });
      send(socketA, {
        type: "message.send",
        receiverId: b.id,
        message: "unread while another conversation is open",
      });
      const received = await waitFor(
        reopenedB,
        (event) => event.type === "message.new",
        messageStartB,
      );
      const message = received.message as { id: string; readAt: string | null };
      expect(message.readAt).toBeNull();
      await waitFor(
        socketA,
        (event) => event.type === "message.new",
        messageStartA,
      );
      await waitFor(
        reopenedB,
        (event) => event.type === "typing.stop",
        messageStartB,
      );
      await waitFor(
        reopenedB,
        (event) =>
          event.type === "unread.update" &&
          (event.counts as { friendId: string; unreadCount: number }[]).some(
            (count) => count.friendId === a.id && count.unreadCount === 1,
          ),
        messageStartB,
      );
      expect(
        (await friends(b.cookie)).find((friend) => friend.id === a.id)
          ?.unreadCount,
      ).toBe(1);
      expect(
        (await friends(a.cookie)).find((friend) => friend.id === b.id)
          ?.unreadCount,
      ).toBe(0);
      expect((await history(a, b))[0]?.readAt).toBeNull();
      expect(
        reopenedB.events
          .slice(messageStartB)
          .filter((event) => event.type === "message.new"),
      ).toHaveLength(1);
      console.log(
        "PASS: unread persists in database, own messages excluded, no duplicate delivery",
      );

      const readStartA = socketA.events.length;
      const readStartB = reopenedB.events.length;
      send(reopenedB, {
        type: "message.read",
        friendId: a.id,
        throughMessageId: message.id,
      });
      await waitFor(
        socketA,
        (event) =>
          event.type === "message.read" &&
          event.readerId === b.id &&
          event.throughMessageId === message.id,
        readStartA,
      );
      await waitFor(
        reopenedB,
        (event) =>
          event.type === "unread.update" &&
          (event.counts as unknown[]).length === 0,
        readStartB,
      );
      expect(
        (await friends(b.cookie)).find((friend) => friend.id === a.id)
          ?.unreadCount,
      ).toBe(0);
      expect((await history(a, b))[0]?.readAt).toBeString();
      console.log(
        "PASS: authorized receiver marks seen, sender receipt and unread reset",
      );

      const replyStartA = socketA.events.length;
      send(reopenedB, {
        type: "message.send",
        receiverId: a.id,
        message: "reply from B",
      });
      await waitFor(
        socketA,
        (event) => event.type === "message.new",
        replyStartA,
      );
      expect(await history(a, b)).toHaveLength(2);
      const unauthorizedStart = socketC.events.length;
      // C is a friend of B but is not the receiver of A's message.
      send(socketC, {
        type: "message.read",
        friendId: b.id,
        throughMessageId: message.id,
      });
      await waitFor(
        socketC,
        (event) => event.type === "error",
        unauthorizedStart,
      );
      const blockedTypingStart = socketC.events.length;
      send(socketC, { type: "typing.start", receiverId: a.id });
      await waitFor(
        socketC,
        (event) => event.type === "error",
        blockedTypingStart,
      );
      const blockedMessageStart = socketC.events.length;
      send(socketC, {
        type: "message.send",
        receiverId: a.id,
        message: "blocked",
      });
      await waitFor(
        socketC,
        (event) => event.type === "error",
        blockedMessageStart,
      );
      expect(
        socketC.events
          .slice(privacyStart)
          .some((event) =>
            [
              "typing.start",
              "typing.stop",
              "message.new",
              "message.read",
            ].includes(event.type),
          ),
      ).toBe(false);
      expect((await call(`/api/messages/${a.id}`, c.cookie)).status).toBe(403);
      console.log(
        "PASS: A/B message, read and typing never leak to C; friendship and receiver validation enforced",
      );

      expect((await call("/api/auth/logout", b.cookie, {}, "POST")).ok).toBe(
        true,
      );
      expect((await call("/api/friends", b.cookie)).status).toBe(401);
      const expiredStart = reopenedB.events.length;
      send(reopenedB, { type: "chat.sync" });
      await waitFor(reopenedB, (event) => event.type === "error", expiredStart);
      console.log(
        "PASS: logout/session revocation also rejects existing WebSocket events",
      );
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
