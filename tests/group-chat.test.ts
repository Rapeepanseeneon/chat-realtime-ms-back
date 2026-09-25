import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  getOptionalIntegrationTestEnvironment,
  verifyTestBackend,
} from "../src/testing/test-environment";
const integration = getOptionalIntegrationTestEnvironment();
const api = integration?.apiUrl,
  origin = Bun.env.FRONTEND_URL ?? "http://localhost:3000";
(api ? test : test.skip)(
  "group create, permissions, realtime, reply/edit/delete, unread, typing and membership",
  async () => {
    if (!api || !integration) throw Error("Missing integration environment");
    await verifyTestBackend(integration);
    const db = new SQL(integration.databaseUrl, { max: 1 });
    const suffix = Date.now() + Math.random().toString(16).slice(2);
    const users = ["A", "B", "C", "D", "E"].map((x) => ({
      username: "Group" + x + suffix,
      email: `group-${x}-${suffix}@example.test`.toLowerCase(),
      id: "",
      cookie: "",
    }));
    const sockets: { socket: WebSocket; events: any[] }[] = [];
    const call = (
      path: string,
      cookie = "",
      body?: unknown,
      method = body ? "POST" : "GET",
    ) =>
      fetch(api + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const until = async (check: () => boolean, timeout = 5000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (check()) return;
        await Bun.sleep(20);
      }
      throw Error("Event timeout");
    };
    const connect = async (cookie: string) => {
      const socket = new WebSocket(api.replace(/^http/, "ws") + "/ws", {
          headers: { Cookie: cookie, Origin: origin },
        }),
        client = { socket, events: [] as any[] };
      sockets.push(client);
      socket.onmessage = (e) => client.events.push(JSON.parse(String(e.data)));
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(Error("WS failed"));
      });
      return client;
    };
    try {
      for (const user of users) {
        const password = "Group-test-42";
        expect(
          (
            await call("/api/auth/register", "", {
              ...user,
              password,
              confirmPassword: password,
            })
          ).status,
        ).toBe(201);
        const login = await call("/api/auth/login", "", {
          email: user.email,
          password,
        });
        user.cookie = login.headers.get("set-cookie")!.split(";")[0];
        user.id = ((await login.json()) as any).user.id;
      }
      const [a, b, c, d, e] = users;
      for (const friend of [b, c, e])
        await db`INSERT INTO friend_requests(sender_id,receiver_id,status) VALUES(${a.id},${friend.id},'accepted')`;
      const clients = await Promise.all(
        users.map((user) => connect(user.cookie)),
      );
      const [sa, sb, sc, sd, se] = clients;
      expect(
        (
          await call("/api/groups", a.cookie, {
            name: "Invalid Team",
            memberIds: [d.id],
          })
        ).status,
      ).toBe(403);
      const create = await call("/api/groups", a.cookie, {
        name: "Developer Team",
        memberIds: [b.id, c.id],
      });
      expect(create.status).toBe(201);
      const group = ((await create.json()) as any).group;
      const createdGroupUpdatedAt = new Date(group.updatedAt).getTime();
      expect(group.members).toHaveLength(3);
      expect(group.members.find((m: any) => m.id === a.id).role).toBe("owner");
      await until(() => sb.events.some((x) => x.type === "group.updated"));
      await until(() => sc.events.some((x) => x.type === "group.updated"));
      expect((await call(`/api/groups/${group.id}`, d.cookie)).status).toBe(
        404,
      );
      expect(
        (await call(`/api/groups/${group.id}/messages`, d.cookie)).status,
      ).toBe(403);
      const send = (client: typeof sa, value: unknown) =>
        client.socket.send(JSON.stringify(value));
      const startD = sd.events.length;
      send(sa, {
        type: "group.message.send",
        groupId: group.id,
        message: "Hello team",
        replyToMessageId: null,
        senderId: d.id,
      });
      await until(() =>
        [sa, sb, sc].every((client) =>
          client.events.some(
            (x) =>
              x.type === "group.message.new" &&
              x.message.messageText === "Hello team",
          ),
        ),
      );
      expect(
        sd.events.slice(startD).some((x) => x.type === "group.message.new"),
      ).toBe(false);
      const first = sa.events.find(
        (x) =>
          x.type === "group.message.new" &&
          x.message.messageText === "Hello team",
      ).message;
      const [activity] = await db<{ updatedAt: Date | string }[]>`
        SELECT updated_at AS "updatedAt" FROM groups WHERE id=${group.id}
      `;
      expect(new Date(activity!.updatedAt).getTime()).toBeGreaterThan(
        createdGroupUpdatedAt,
      );
      const listB = await call("/api/groups", b.cookie);
      expect(
        ((await listB.json()) as any).groups.find((g: any) => g.id === group.id)
          .unreadCount,
      ).toBe(1);
      send(sb, { type: "group.read", groupId: group.id });
      await until(() => sb.events.some((x) => x.type === "group.updated"));
      await Bun.sleep(50);
      expect(
        (
          (await (await call("/api/groups", b.cookie)).json()) as any
        ).groups.find((g: any) => g.id === group.id).unreadCount,
      ).toBe(0);
      send(sb, {
        type: "group.message.send",
        groupId: group.id,
        message: "Reply",
        replyToMessageId: first.id,
      });
      await until(() =>
        sa.events.some(
          (x) =>
            x.type === "group.message.new" && x.message.messageText === "Reply",
        ),
      );
      const reply = sa.events.findLast(
        (x: any) =>
          x.type === "group.message.new" && x.message.messageText === "Reply",
      ).message;
      expect(reply.reply.id).toBe(first.id);
      send(sb, {
        type: "group.message.edit",
        messageId: reply.id,
        message: "Edited reply",
      });
      await until(() =>
        sc.events.some(
          (x) => x.type === "group.message.edited" && x.message.id === reply.id,
        ),
      );
      send(sb, { type: "group.message.delete", messageId: reply.id });
      await until(() =>
        sa.events.some(
          (x) =>
            x.type === "group.message.deleted" && x.message.id === reply.id,
        ),
      );
      const deleted = sa.events.findLast(
        (x: any) =>
          x.type === "group.message.deleted" && x.message.id === reply.id,
      ).message;
      expect(deleted.messageText).toBe("");
      send(sb, { type: "group.typing.start", groupId: group.id });
      await until(() =>
        sc.events.some(
          (x) => x.type === "group.typing.start" && x.userId === b.id,
        ),
      );
      expect(
        sd.events.some(
          (x) => x.type === "group.typing.start" && x.userId === b.id,
        ),
      ).toBe(false);
      send(sb, { type: "group.typing.stop", groupId: group.id });
      send(sd, {
        type: "group.message.send",
        groupId: group.id,
        message: "intrusion",
        replyToMessageId: null,
      });
      await until(() => sd.events.some((x) => x.type === "error"));
      expect(
        [sa, sb, sc].some((client) =>
          client.events.some((x) => x.message?.messageText === "intrusion"),
        ),
      ).toBe(false);
      send(sa, {
        type: "ghost.create",
        groupId: group.id,
        message: "no group ghost",
      });
      await until(() => sa.events.some((x) => x.type === "error"));
      expect(
        (
          await call(
            `/api/groups/${group.id}`,
            b.cookie,
            { action: "remove", userId: c.id },
            "PUT",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            `/api/groups/${group.id}`,
            a.cookie,
            { action: "add", userId: e.id },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await call(
            `/api/groups/${group.id}`,
            a.cookie,
            { action: "remove", userId: e.id },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await call(
            `/api/groups/${group.id}`,
            c.cookie,
            { action: "leave" },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      const history = await call(`/api/groups/${group.id}/messages`, b.cookie);
      const messages = ((await history.json()) as any).messages;
      expect(messages.filter((m: any) => m.id === first.id)).toHaveLength(1);
      expect(
        messages.find((m: any) => m.id === reply.id).deletedAt,
      ).not.toBeNull();
      expect(
        (
          await call(
            `/api/groups/${group.id}`,
            a.cookie,
            { action: "rename", name: "Renamed Team" },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          (await (
            await call(`/api/groups/${group.id}`, b.cookie)
          ).json()) as any
        ).group.name,
      ).toBe("Renamed Team");
      expect(
        (
          await call(
            `/api/groups/${group.id}`,
            a.cookie,
            { action: "leave" },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      expect((await call(`/api/groups/${group.id}`, a.cookie)).status).toBe(
        404,
      );
      expect(
        (
          (await (
            await call(`/api/groups/${group.id}`, b.cookie)
          ).json()) as any
        ).group.role,
      ).toBe("owner");
    } finally {
      for (const client of sockets) client.socket.close();
      await db`DELETE FROM groups WHERE created_by IN (SELECT id FROM users WHERE email IN ${db(users.map((user) => user.email))})`;
      await db`DELETE FROM users WHERE email IN ${db(users.map((user) => user.email))}`;
      await db.close();
    }
  },
  25000,
);
