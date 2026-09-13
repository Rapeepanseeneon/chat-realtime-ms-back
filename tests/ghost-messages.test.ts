import { expect, test } from "bun:test";
import { SQL } from "bun";
import type { PrivateMessage } from "../src/database";

const api = Bun.env.CHAT_TEST_API_URL;
const origin = Bun.env.FRONTEND_URL ?? "http://localhost:3000";
(api ? test : test.skip)(
  "ghost privacy, ownership, release races, durable schedules and read ordering",
  async () => {
    if (!api || !Bun.env.DATABASE_URL)
      throw new Error("Integration environment missing");
    const db = new SQL(Bun.env.DATABASE_URL, { max: 1 });
    const suffix = Date.now() + "-" + Math.random().toString(16).slice(2, 7);
    const users = ["A", "B", "C"].map((letter) => ({
      username: "Ghost" + letter + suffix,
      email: "ghost-" + letter + "-" + suffix + "@example.test",
      id: "",
      cookie: "",
    }));
    type Event = {
      type: string;
      message?: PrivateMessage;
      [key: string]: unknown;
    };
    const clients: { socket: WebSocket; events: Event[] }[] = [];
    const call = (path: string, cookie = "", body?: unknown, method = "GET") =>
      fetch(api + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const wait = async (
      client: (typeof clients)[number],
      predicate: (event: Event) => boolean,
      start = 0,
      timeout = 6000,
    ) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const found = client.events.slice(start).find(predicate);
        if (found) return found;
        await Bun.sleep(20);
      }
      throw new Error(
        "Event timeout " + JSON.stringify(client.events.slice(start)),
      );
    };
    const send = async (
      client: (typeof clients)[number],
      body: unknown,
      type: string,
    ) => {
      const start = client.events.length;
      client.socket.send(JSON.stringify(body));
      return wait(client, (event) => event.type === type, start);
    };
    const connect = async (cookie: string) => {
      const socket = new WebSocket(api.replace(/^http/, "ws") + "/ws", {
        headers: { Cookie: cookie, Origin: origin },
      });
      const client = { socket, events: [] as Event[] };
      clients.push(client);
      socket.addEventListener("message", (event) =>
        client.events.push(JSON.parse(String(event.data))),
      );
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WS failed")), {
          once: true,
        });
      });
      await wait(client, (event) => event.type === "chat.state");
      return client;
    };
    const history = async (
      owner: (typeof users)[number],
      other: (typeof users)[number],
    ) => {
      const response = await call("/api/messages/" + other.id, owner.cookie);
      expect(response.ok).toBe(true);
      return ((await response.json()) as { messages: PrivateMessage[] })
        .messages;
    };
    const unread = async (
      owner: (typeof users)[number],
      other: (typeof users)[number],
    ) => {
      const response = await call("/api/friends", owner.cookie);
      return (
        (await response.json()) as {
          friends: { id: string; unreadCount: number }[];
        }
      ).friends.find((friend) => friend.id === other.id)?.unreadCount;
    };
    try {
      for (const user of users) {
        const password = "Temporary-Ghost-Test-42";
        expect(
          (
            await call(
              "/api/auth/register",
              "",
              { ...user, password, confirmPassword: password },
              "POST",
            )
          ).status,
        ).toBe(201);
        const login = await call(
          "/api/auth/login",
          "",
          { email: user.email, password },
          "POST",
        );
        expect(login.ok).toBe(true);
        user.cookie = login.headers.get("set-cookie")!.split(";")[0];
        user.id = ((await login.json()) as { user: { id: string } }).user.id;
      }
      const [a, b, c] = users;
      // Even accepted friends must not see each other's private ghost.
      for (const [from, to] of [
        [a, b],
        [a, c],
        [b, c],
      ]) {
        const request = await call(
          "/api/friend-requests",
          from.cookie,
          { receiverId: to.id },
          "POST",
        );
        const id = ((await request.json()) as { requestId: string }).requestId;
        expect(
          (
            await call(
              "/api/friend-requests/" + id,
              to.cookie,
              { action: "accept" },
              "PUT",
            )
          ).ok,
        ).toBe(true);
      }
      const sa = await connect(a.cookie),
        sb = await connect(b.cookie),
        sc = await connect(c.cookie),
        sa2 = await connect(a.cookie);
      const startB = sb.events.length,
        startC = sc.events.length;
      const ghost = (
        await send(
          sa,
          {
            type: "ghost.create",
            receiverId: b.id,
            message: "private draft",
            senderId: c.id,
            status: "sent",
          },
          "ghost.updated",
        )
      ).message!;
      expect(ghost.messageStatus).toBe("ghost");
      expect(ghost.senderId).toBe(a.id);
      expect(ghost.readAt).toBeNull();
      expect(
        (await history(a, b)).find((message) => message.id === ghost.id)
          ?.messageText,
      ).toBe("private draft");
      expect(await history(b, a)).toHaveLength(0);
      expect((await call("/api/ghosts/" + ghost.id, a.cookie)).status).toBe(
        200,
      );
      expect((await call("/api/ghosts/" + ghost.id, b.cookie)).status).toBe(
        404,
      );
      expect((await call("/api/ghosts/" + ghost.id, c.cookie)).status).toBe(
        404,
      );
      expect((await call("/api/ghosts/" + ghost.id)).status).toBe(401);
      expect(await unread(b, a)).toBe(0);
      for (const client of [sb, sc]) {
        for (const type of [
          "ghost.edit",
          "ghost.delete",
          "ghost.release",
          "ghost.schedule",
        ]) {
          await send(
            client,
            {
              type,
              messageId: ghost.id,
              message: "stolen",
              scheduledAt: new Date(Date.now() + 60_000).toISOString(),
            },
            "error",
          );
        }
      }
      await send(
        sb,
        { type: "message.read", friendId: a.id, throughMessageId: ghost.id },
        "error",
      );
      await send(
        sa,
        { type: "message.edit", messageId: ghost.id, message: "wrong path" },
        "error",
      );
      await send(sa, { type: "message.delete", messageId: ghost.id }, "error");
      await send(
        sa,
        {
          type: "message.send",
          receiverId: b.id,
          message: "leak via quote",
          replyToMessageId: ghost.id,
        },
        "error",
      );
      await send(
        sa,
        { type: "ghost.edit", messageId: ghost.id, message: "edited draft" },
        "ghost.updated",
      );
      expect((await history(a, b))[0]?.messageText).toBe("edited draft");
      expect(await unread(b, a)).toBe(0);
      expect(
        sb.events
          .slice(startB)
          .some((event) =>
            [
              "ghost.updated",
              "message.new",
              "message.edited",
              "message.deleted",
              "message.read",
            ].includes(event.type),
          ),
      ).toBe(false);
      // A later normal send is read before this older ghost is released.
      const normal = (
        await send(
          sa,
          {
            type: "message.send",
            receiverId: b.id,
            message: "normal after ghost",
          },
          "message.new",
        )
      ).message!;
      await send(
        sb,
        { type: "message.read", friendId: a.id, throughMessageId: normal.id },
        "message.read",
      );
      const raceStart = sb.events.length;
      sa.socket.send(
        JSON.stringify({ type: "ghost.release", messageId: ghost.id }),
      );
      sa2.socket.send(
        JSON.stringify({ type: "ghost.release", messageId: ghost.id }),
      );
      const released = (
        await wait(
          sb,
          (event) =>
            event.type === "message.new" && event.message?.id === ghost.id,
          raceStart,
        )
      ).message!;
      expect(released.messageStatus).toBe("sent");
      expect(released.messageText).toBe("edited draft");
      expect(released.releasedAt).toBeString();
      expect(BigInt(released.deliveryId!)).toBeGreaterThan(
        BigInt(normal.deliveryId!),
      );
      expect(released.readAt).toBeNull();
      expect(await unread(b, a)).toBe(1);
      const receipt = await send(
        sb,
        { type: "message.read", friendId: a.id, throughMessageId: ghost.id },
        "message.read",
      );
      expect(receipt.throughDeliveryId).toBe(released.deliveryId);
      expect(await unread(b, a)).toBe(0);
      await Bun.sleep(200);
      expect(
        sb.events
          .slice(raceStart)
          .filter(
            (event) =>
              event.type === "message.new" && event.message?.id === ghost.id,
          ),
      ).toHaveLength(1);
      await send(sa, { type: "ghost.release", messageId: ghost.id }, "error");
      await send(
        sa,
        {
          type: "message.edit",
          messageId: ghost.id,
          message: "normal edit after release",
        },
        "message.edited",
      );
      expect(
        (await history(b, a)).find((message) => message.id === ghost.id)
          ?.messageText,
      ).toBe("normal edit after release");
      const deleted = (
        await send(
          sa,
          {
            type: "ghost.create",
            receiverId: b.id,
            message: "never release me",
          },
          "ghost.updated",
        )
      ).message!;
      await send(
        sa,
        { type: "ghost.delete", messageId: deleted.id },
        "ghost.updated",
      );
      expect(
        (await history(a, b)).some((message) => message.id === deleted.id),
      ).toBe(false);
      expect(
        (await history(b, a)).some((message) => message.id === deleted.id),
      ).toBe(false);
      await send(sa, { type: "ghost.release", messageId: deleted.id }, "error");
      const scheduled = (
        await send(
          sa,
          {
            type: "ghost.create",
            receiverId: b.id,
            message: "browser independent",
          },
          "ghost.updated",
        )
      ).message!;
      const firstTime = new Date(Date.now() + 5000).toISOString();
      await send(
        sa,
        {
          type: "ghost.schedule",
          messageId: scheduled.id,
          scheduledAt: firstTime,
        },
        "ghost.updated",
      );
      const secondTime = new Date(Date.now() + 9000).toISOString();
      const changed = (
        await send(
          sa,
          {
            type: "ghost.schedule",
            messageId: scheduled.id,
            scheduledAt: secondTime,
          },
          "ghost.updated",
        )
      ).message!;
      expect(changed.scheduledAt).toBe(secondTime);
      await send(
        sa,
        { type: "ghost.schedule", messageId: scheduled.id, scheduledAt: null },
        "ghost.updated",
      );
      expect(
        (await history(a, b)).find((message) => message.id === scheduled.id)
          ?.messageStatus,
      ).toBe("ghost");
      await send(
        sa,
        {
          type: "ghost.schedule",
          messageId: scheduled.id,
          scheduledAt: "2030-01-01T00:00:00",
        },
        "error",
      );
      await send(
        sa,
        {
          type: "ghost.schedule",
          messageId: scheduled.id,
          scheduledAt: new Date(Date.now() - 1000).toISOString(),
        },
        "error",
      );
      const dueUtc = new Date(Date.now() + 2200).toISOString();
      const offsetTime = new Date(Date.parse(dueUtc) + 7 * 3600000)
        .toISOString()
        .replace("Z", "+07:00");
      const finalSchedule = (
        await send(
          sa,
          {
            type: "ghost.schedule",
            messageId: scheduled.id,
            scheduledAt: offsetTime,
          },
          "ghost.updated",
        )
      ).message!;
      expect(finalSchedule.scheduledAt).toBe(dueUtc);
      const scheduleStart = sb.events.length;
      sa.socket.close();
      sa2.socket.close();
      const auto = (
        await wait(
          sb,
          (event) =>
            event.type === "message.new" && event.message?.id === scheduled.id,
          scheduleStart,
        ).catch(async (error) => {
          console.log(
            "Schedule diagnostic",
            await db`SELECT id, message_status, scheduled_at, released_at, clock_timestamp() AS db_now FROM messages WHERE id = ${scheduled.id}`,
          );
          throw error;
        })
      ).message!;
      expect(auto.messageStatus).toBe("sent");
      expect(auto.messageText).toBe("browser independent");
      expect(await unread(b, a)).toBe(1);
      expect(
        (await history(b, a)).find((message) => message.id === scheduled.id)
          ?.releasedAt,
      ).toBeString();
      await Bun.sleep(1200);
      expect(
        sb.events
          .slice(scheduleStart)
          .filter(
            (event) =>
              event.type === "message.new" &&
              event.message?.id === scheduled.id,
          ),
      ).toHaveLength(1);
      expect(
        sc.events
          .slice(startC)
          .some((event) =>
            [
              "ghost.updated",
              "message.new",
              "message.edited",
              "message.deleted",
              "message.read",
            ].includes(event.type),
          ),
      ).toBe(false);
      console.log(
        "PASS: Ghost invisible before release, A-only edit/delete, single release, unread/seen ordering, schedule UTC/change/cancel and release with both sender tabs closed",
      );
    } finally {
      for (const client of clients) client.socket.close();
      await Bun.sleep(100);
      for (const user of users)
        await db`DELETE FROM users WHERE lower(email) = lower(${user.email})`;
      await db.close();
    }
  },
  30000,
);
