import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  getOptionalIntegrationTestEnvironment,
  verifyTestBackend,
} from "../src/testing/test-environment";

const integration = getOptionalIntegrationTestEnvironment();
const api = integration?.apiUrl;
const origin = (Bun.env.FRONTEND_URL ?? "http://localhost:3000")
  .split(",")[0]!
  .trim();

(api ? test : test.skip)(
  "Phase B perimeter limits sessions, privacy, legacy realtime and oversized input",
  async () => {
    if (!api || !integration)
      throw new Error("Missing integration environment");
    await verifyTestBackend(integration);
    const db = new SQL(integration.databaseUrl, { max: 1 });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const password = "Security-Perimeter-42";
    const nextPassword = "Security-Perimeter-84";
    const users = ["Owner", "Private", "Viewer"].map((label) => ({
      username: `${label}${suffix}`,
      displayName: `${label} ${suffix}`,
      email: `${label.toLowerCase()}-${suffix}@example.test`,
      id: "",
      cookie: "",
    }));
    const sockets: WebSocket[] = [];
    const call = (
      path: string,
      options: {
        cookie?: string;
        method?: string;
        body?: BodyInit | null;
        contentType?: string;
      } = {},
    ) =>
      fetch(`${api}${path}`, {
        method: options.method ?? (options.body == null ? "GET" : "POST"),
        headers: {
          Origin: origin,
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...(options.contentType
            ? { "Content-Type": options.contentType }
            : {}),
        },
        body: options.body,
      });
    const json = (path: string, body: unknown, cookie = "", method = "POST") =>
      call(path, {
        cookie,
        method,
        body: JSON.stringify(body),
        contentType: "application/json",
      });
    const connect = async (cookie: string) => {
      const socket = new WebSocket(api.replace(/^http/, "ws") + "/ws", {
        headers: { Origin: origin, Cookie: cookie },
      });
      const events: any[] = [];
      socket.onmessage = (event) =>
        events.push(JSON.parse(String(event.data)) as unknown);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("WS open timeout")),
          3_000,
        );
        socket.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("WS failed"));
        };
      });
      return { socket, events };
    };
    const waitFor = async (check: () => boolean, timeout = 4_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (check()) return;
        await Bun.sleep(20);
      }
      throw new Error("Timed out waiting for security event");
    };

    try {
      for (const user of users) {
        const response = await json("/api/auth/register", {
          ...user,
          password,
          confirmPassword: password,
        });
        expect(response.status).toBe(201);
        user.cookie = (response.headers.get("set-cookie") ?? "").split(
          ";",
          1,
        )[0]!;
        user.id = ((await response.json()) as any).user.id;
      }
      const [owner, privateMember, viewer] = users;

      const secondLogin = await json("/api/auth/login", {
        email: owner.email,
        password,
      });
      expect(secondLogin.status).toBe(200);
      const secondCookie = (secondLogin.headers.get("set-cookie") ?? "").split(
        ";",
        1,
      )[0]!;

      await db`INSERT INTO friend_requests(sender_id,receiver_id,status) VALUES
        (${owner.id},${privateMember.id},'accepted'),
        (${owner.id},${viewer.id},'accepted')`;
      expect(
        (
          await json(
            "/api/profile",
            {
              username: privateMember.username,
              displayName: privateMember.displayName,
              email: privateMember.email,
              bio: "must stay private inside groups",
              links: [],
            },
            privateMember.cookie,
            "PUT",
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await json(
            "/api/profile/privacy",
            {
              profileVisibility: "private",
              friendListVisibility: "only_me",
              mutualFriendsVisibility: "only_me",
              onlineStatusVisibility: "nobody",
            },
            privateMember.cookie,
            "PUT",
          )
        ).status,
      ).toBe(200);
      const createdGroup = await json(
        "/api/groups",
        {
          name: `Security ${suffix}`,
          memberIds: [privateMember.id, viewer.id],
        },
        owner.cookie,
      );
      expect(createdGroup.status).toBe(201);
      const groupId = ((await createdGroup.json()) as any).group.id as string;
      const groupForViewer = await call(`/api/groups/${groupId}`, {
        cookie: viewer.cookie,
      });
      const groupBody = (await groupForViewer.json()) as any;
      expect(
        groupBody.group.members.find(
          (member: any) => member.id === privateMember.id,
        ).bio,
      ).toBe("");

      const exactSearch = await call(
        `/api/friends/search?q=${encodeURIComponent(privateMember.email)}`,
        { cookie: viewer.cookie },
      );
      expect(exactSearch.status).toBe(200);
      const searchText = await exactSearch.text();
      expect(searchText).not.toContain(privateMember.email);
      expect(searchText).not.toContain("password");

      const changed = await json(
        "/api/settings/password",
        {
          currentPassword: password,
          newPassword: nextPassword,
          confirmPassword: nextPassword,
        },
        owner.cookie,
        "PUT",
      );
      expect(changed.status).toBe(200);
      const replacementCookie = (changed.headers.get("set-cookie") ?? "").split(
        ";",
        1,
      )[0]!;
      expect(
        (await call("/api/auth/me", { cookie: owner.cookie })).status,
      ).toBe(401);
      expect(
        (await call("/api/auth/me", { cookie: secondCookie })).status,
      ).toBe(401);
      expect(
        (await call("/api/auth/me", { cookie: replacementCookie })).status,
      ).toBe(200);
      expect(
        (
          await json("/api/auth/login", {
            email: owner.email,
            password,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await json("/api/auth/login", {
            email: owner.email,
            password: nextPassword,
          })
        ).status,
      ).toBe(200);

      const oversizedJson = await call("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ value: "x".repeat(70 * 1024) }),
        contentType: "application/json",
      });
      expect(oversizedJson.status).toBe(413);
      expect(((await oversizedJson.json()) as any).code).toBe(
        "PAYLOAD_TOO_LARGE",
      );

      const oversizedAvatar = await call("/api/profile/avatar", {
        cookie: replacementCookie,
        method: "POST",
        body: new Uint8Array(5 * 1024 * 1024 + 512 * 1024 + 1),
        contentType: "application/octet-stream",
      });
      expect(oversizedAvatar.status).toBe(413);
      const malformedMultipart = await call("/api/attachments", {
        cookie: replacementCookie,
        method: "POST",
        body: "not multipart",
        contentType: "multipart/form-data",
      });
      expect(malformedMultipart.status).toBe(400);

      const rateIdentity = {
        username: `Rate${suffix}`,
        email: `rate-${suffix}@example.test`,
      };
      const registerStatuses: number[] = [];
      let conflictMessage = "";
      for (let index = 0; index < 4; index++) {
        const response = await json("/api/auth/register", {
          ...rateIdentity,
          password,
          confirmPassword: password,
        });
        registerStatuses.push(response.status);
        if (response.status === 409)
          conflictMessage = ((await response.json()) as any).error;
      }
      expect(registerStatuses).toEqual([201, 409, 409, 429]);
      expect(conflictMessage).toBe(
        "An account with those details already exists.",
      );

      let loginLimited = false;
      for (let index = 0; index < 10; index++) {
        const response = await json("/api/auth/login", {
          email: owner.email,
          password: "wrong-password",
        });
        if (response.status === 429) {
          loginLimited = true;
          break;
        }
      }
      expect(loginLimited).toBe(true);

      let searchLimited = false;
      for (let index = 0; index < 45; index++) {
        const response = await call(
          `/api/friends/search?q=${encodeURIComponent(`none-${index}-${suffix}`)}`,
          { cookie: viewer.cookie },
        );
        if (response.status === 429) {
          searchLimited = true;
          break;
        }
        expect(response.status).toBe(200);
      }
      expect(searchLimited).toBe(true);

      for (let index = 0; index < 12; index++)
        expect(
          (
            await json(
              "/api/friend-requests",
              { receiverId: "9223372036854775807" },
              viewer.cookie,
            )
          ).status,
        ).toBe(404);
      expect(
        (
          await json(
            "/api/friend-requests",
            { receiverId: "9223372036854775807" },
            viewer.cookie,
          )
        ).status,
      ).toBe(429);

      expect(
        (await fetch(`${api}/api/auth/logout`, { method: "POST" })).status,
      ).toBe(403);
      expect((await fetch(`${api}/ws`)).status).toBe(403);
      expect((await call("/ws")).status).toBe(401);
      expect(
        (await call("/api/messages", { cookie: replacementCookie })).status,
      ).toBe(404);
      const sender = await connect(replacementCookie);
      const receiver = await connect(privateMember.cookie);
      const forgedText = `forged-${suffix}`;
      sender.socket.send(
        JSON.stringify({
          type: "message.send",
          receiverId: privateMember.id,
          senderId: privateMember.id,
          message: forgedText,
          replyToMessageId: null,
        }),
      );
      await waitFor(() =>
        receiver.events.some(
          (event) =>
            event.type === "message.new" &&
            event.message?.messageText === forgedText &&
            event.message?.senderId === owner.id,
        ),
      );

      const legacyText = `legacy-${suffix}`;
      const receiverStart = receiver.events.length;
      sender.socket.send(
        JSON.stringify({ type: "message.send", data: { text: legacyText } }),
      );
      await waitFor(() =>
        sender.events.some(
          (event) =>
            event.type === "error" && event.data?.code === "FEATURE_DISABLED",
        ),
      );
      expect(
        receiver.events
          .slice(receiverStart)
          .some((event) => event.data?.text === legacyText),
      ).toBe(false);

      for (let index = 0; index < 24; index++)
        sender.socket.send(
          JSON.stringify({
            type: "typing.start",
            receiverId: privateMember.id,
          }),
        );
      await waitFor(() =>
        sender.events.some(
          (event) =>
            event.type === "error" && event.data?.code === "RATE_LIMITED",
        ),
      );

      const queued = await connect(viewer.cookie);
      let queueClosed = false;
      queued.socket.onclose = () => {
        queueClosed = true;
      };
      for (let index = 0; index < 40; index++)
        queued.socket.send(JSON.stringify({ type: "chat.sync" }));
      await waitFor(
        () =>
          queueClosed ||
          queued.events.some((event) => event.data?.code === "QUEUE_OVERFLOW"),
      );

      const oversizedSocket = await connect(privateMember.cookie);
      let oversizedClosed = false;
      oversizedSocket.socket.onclose = () => {
        oversizedClosed = true;
      };
      oversizedSocket.socket.send("x".repeat(96 * 1024 + 1));
      await waitFor(() => oversizedClosed);
    } finally {
      for (const socket of sockets) socket.close();
      await db`DELETE FROM groups WHERE created_by IN (SELECT id FROM users WHERE email LIKE ${`%-${suffix}@example.test`})`;
      await db`DELETE FROM users WHERE email LIKE ${`%-${suffix}@example.test`}`;
      await db.close();
    }
  },
  60_000,
);
