import { expect, test } from "bun:test";
import { SQL } from "bun";

const api = Bun.env.CHAT_TEST_API_URL?.replace(/\/$/, "");
const origin = (Bun.env.FRONTEND_URL ?? "http://localhost:3000")
  .split(",")[0]!
  .trim();

type SocketClient = {
  socket: WebSocket;
  events: any[];
  state: { closed: boolean; code: number; reason: string };
};

(api ? test : test.skip)(
  "password change proactively disconnects revoked realtime sessions",
  async () => {
    if (!api || !Bun.env.DATABASE_URL)
      throw new Error("Missing integration environment");
    const database = new SQL(Bun.env.DATABASE_URL, { max: 1 });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const oldPassword = "Realtime-revocation-42";
    const newPassword = "Realtime-revocation-84";
    const users = ["Account", "Peer", "Unrelated"].map((label) => ({
      id: "",
      username: `Revoke${label}${suffix}`,
      email: `revoke-${label.toLowerCase()}-${suffix}@example.test`,
      cookie: "",
    }));
    const clients: SocketClient[] = [];
    const call = (
      path: string,
      options: {
        cookie?: string;
        method?: string;
        body?: unknown;
      } = {},
    ) =>
      fetch(`${api}${path}`, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers: {
          Origin: origin,
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
    const until = async (check: () => boolean, timeout = 5_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (check()) return;
        await Bun.sleep(20);
      }
      throw new Error("Timed out waiting for session-revocation event");
    };
    const connect = async (cookie: string) => {
      const socket = new WebSocket(api.replace(/^http/, "ws") + "/ws", {
        headers: { Origin: origin, Cookie: cookie },
      });
      const client: SocketClient = {
        socket,
        events: [],
        state: { closed: false, code: 0, reason: "" },
      };
      clients.push(client);
      socket.onmessage = (event) =>
        client.events.push(JSON.parse(String(event.data)) as unknown);
      socket.onclose = (event) => {
        client.state.closed = true;
        client.state.code = event.code;
        client.state.reason = event.reason;
      };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("WebSocket open timed out")),
          3_000,
        );
        socket.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("WebSocket connection failed"));
        };
      });
      await until(() =>
        client.events.some((event) => event.type === "chat.state"),
      );
      return client;
    };
    const send = (client: SocketClient, value: unknown) =>
      client.socket.send(JSON.stringify(value));

    try {
      for (const user of users) {
        const response = await call("/api/auth/register", {
          body: {
            username: user.username,
            email: user.email,
            password: oldPassword,
            confirmPassword: oldPassword,
          },
        });
        expect(response.status).toBe(201);
        user.cookie = (response.headers.get("set-cookie") ?? "").split(
          ";",
          1,
        )[0]!;
        user.id = ((await response.json()) as any).user.id;
      }
      const [account, peer, unrelated] = users;
      const secondLogin = await call("/api/auth/login", {
        body: { email: account.email, password: oldPassword },
      });
      expect(secondLogin.status).toBe(200);
      const secondCookie = (secondLogin.headers.get("set-cookie") ?? "").split(
        ";",
        1,
      )[0]!;

      await database`
        INSERT INTO friend_requests(sender_id, receiver_id, status)
        VALUES (${account.id}, ${peer.id}, 'accepted')
      `;
      const groupResponse = await call("/api/groups", {
        cookie: account.cookie,
        body: { name: `Revocation ${suffix}`, memberIds: [peer.id] },
      });
      expect(groupResponse.status).toBe(201);
      const groupId = ((await groupResponse.json()) as any).group.id as string;

      const [currentOldSocket, revokedSocket, peerSocket, unrelatedSocket] =
        await Promise.all([
          connect(account.cookie),
          connect(secondCookie),
          connect(peer.cookie),
          connect(unrelated.cookie),
        ]);

      const passwordResponse = await call("/api/settings/password", {
        method: "PUT",
        cookie: account.cookie,
        body: {
          currentPassword: oldPassword,
          newPassword,
          confirmPassword: newPassword,
        },
      });
      expect(passwordResponse.status).toBe(200);
      const replacementCookie = (
        passwordResponse.headers.get("set-cookie") ?? ""
      ).split(";", 1)[0]!;
      expect(replacementCookie).toContain("pb_session=");

      await until(
        () => currentOldSocket.state.closed && revokedSocket.state.closed,
      );
      expect(currentOldSocket.state.code).toBe(1008);
      expect(revokedSocket.state.code).toBe(1008);
      expect(revokedSocket.state.reason).not.toContain("token");
      expect(peerSocket.socket.readyState).toBe(WebSocket.OPEN);
      expect(unrelatedSocket.socket.readyState).toBe(WebSocket.OPEN);

      expect(
        (await call("/api/auth/me", { cookie: account.cookie })).status,
      ).toBe(401);
      expect(
        (await call("/api/auth/me", { cookie: secondCookie })).status,
      ).toBe(401);
      expect(
        (await call("/api/auth/me", { cookie: replacementCookie })).status,
      ).toBe(200);

      const replacementSocket = await connect(replacementCookie);
      const revokedEventCount = revokedSocket.events.length;
      const privateText = `private-after-revoke-${suffix}`;
      send(peerSocket, {
        type: "message.send",
        receiverId: account.id,
        message: privateText,
        replyToMessageId: null,
      });
      await until(() =>
        replacementSocket.events.some(
          (event) =>
            event.type === "message.new" &&
            event.message?.messageText === privateText,
        ),
      );

      const groupText = `group-after-revoke-${suffix}`;
      send(peerSocket, {
        type: "group.message.send",
        groupId,
        message: groupText,
        replyToMessageId: null,
      });
      await until(() =>
        replacementSocket.events.some(
          (event) =>
            event.type === "group.message.new" &&
            event.message?.messageText === groupText,
        ),
      );

      const ghostText = `ghost-after-revoke-${suffix}`;
      send(peerSocket, {
        type: "ghost.create",
        receiverId: account.id,
        message: ghostText,
        replyToMessageId: null,
      });
      await until(() =>
        peerSocket.events.some(
          (event) =>
            event.type === "ghost.updated" &&
            event.message?.messageText === ghostText,
        ),
      );
      expect(
        replacementSocket.events.some(
          (event) => event.message?.messageText === ghostText,
        ),
      ).toBe(false);
      const ghost = peerSocket.events.find(
        (event) =>
          event.type === "ghost.updated" &&
          event.message?.messageText === ghostText,
      ).message;
      send(peerSocket, { type: "ghost.release", messageId: ghost.id });
      await until(() =>
        replacementSocket.events.some(
          (event) =>
            event.type === "message.new" &&
            event.message?.messageText === ghostText,
        ),
      );

      const callId = crypto.randomUUID();
      send(peerSocket, {
        type: "call.offer",
        callId,
        calleeId: account.id,
        sdp: "revocation-test-offer",
        callType: "voice",
      });
      await until(() =>
        replacementSocket.events.some(
          (event) => event.type === "call.offer" && event.callId === callId,
        ),
      );
      send(replacementSocket, { type: "call.reject", callId });
      await until(() =>
        peerSocket.events.some(
          (event) => event.type === "call.reject" && event.callId === callId,
        ),
      );

      peerSocket.socket.close();
      await until(() => peerSocket.state.closed);
      await until(() =>
        replacementSocket.events.some(
          (event) =>
            event.type === "presence.update" &&
            event.userId === peer.id &&
            event.online === false,
        ),
      );

      const unrelatedStateCount = unrelatedSocket.events.filter(
        (event) => event.type === "chat.state",
      ).length;
      send(unrelatedSocket, { type: "chat.sync" });
      await until(
        () =>
          unrelatedSocket.events.filter((event) => event.type === "chat.state")
            .length > unrelatedStateCount,
      );
      expect(unrelatedSocket.socket.readyState).toBe(WebSocket.OPEN);

      await Bun.sleep(100);
      const revokedEvents = revokedSocket.events.slice(revokedEventCount);
      expect(
        revokedEvents.some(
          (event) =>
            event.message?.messageText === privateText ||
            event.message?.messageText === groupText ||
            event.message?.messageText === ghostText ||
            event.callId === callId ||
            (event.type === "presence.update" && event.userId === peer.id),
        ),
      ).toBe(false);
    } finally {
      for (const client of clients) client.socket.close();
      await database`
        DELETE FROM groups
        WHERE created_by IN (SELECT id FROM users WHERE email LIKE ${`%-${suffix}@example.test`})
      `;
      await database`
        DELETE FROM users WHERE email LIKE ${`%-${suffix}@example.test`}
      `;
      await database.close();
    }
  },
  60_000,
);
