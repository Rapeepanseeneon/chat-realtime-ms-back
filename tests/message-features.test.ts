import { expect, test } from "bun:test";
import { SQL } from "bun";
import type { PrivateMessage } from "../src/database";

const api = Bun.env.CHAT_TEST_API_URL;
const origin = Bun.env.FRONTEND_URL ?? "http://localhost:3000";

(api ? test : test.skip)(
  "reply, edit, soft delete, ownership, privacy and status regression",
  async () => {
    if (!api || !Bun.env.DATABASE_URL)
      throw new Error("Test environment missing");
    const database = new SQL(Bun.env.DATABASE_URL, { max: 1 });
    const suffix = Date.now() + "-" + Math.random().toString(16).slice(2, 7);
    const users = ["A", "B", "C"].map((letter) => ({
      username: "Features" + letter + suffix,
      email: "features-" + letter + "-" + suffix + "@example.test",
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
      type: string,
      start: number,
    ) => {
      for (let n = 0; n < 150; n++) {
        const match = client.events
          .slice(start)
          .find((event) => event.type === type);
        if (match) return match;
        await Bun.sleep(20);
      }
      throw new Error(
        "Event timeout " +
          type +
          ": " +
          JSON.stringify(client.events.slice(start)),
      );
    };
    const send = async (
      client: (typeof clients)[number],
      body: unknown,
      expected: string,
    ) => {
      const start = client.events.length;
      client.socket.send(JSON.stringify(body));
      return wait(client, expected, start);
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
    const count = async (
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
        const password = "Temporary-Features-Test-42";
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
        const logged = await call(
          "/api/auth/login",
          "",
          { email: user.email, password },
          "POST",
        );
        expect(logged.ok).toBe(true);
        user.cookie = logged.headers.get("set-cookie")!.split(";")[0];
        user.id = ((await logged.json()) as { user: { id: string } }).user.id;
      }
      const [a, b, c] = users;
      // All three are friends: C must still not access an A/B message.
      for (const [sender, receiver] of [
        [a, b],
        [a, c],
        [b, c],
      ]) {
        const requested = await call(
          "/api/friend-requests",
          sender.cookie,
          { receiverId: receiver.id },
          "POST",
        );
        const requestId = ((await requested.json()) as { requestId: string })
          .requestId;
        expect(
          (
            await call(
              "/api/friend-requests/" + requestId,
              receiver.cookie,
              { action: "accept" },
              "PUT",
            )
          ).ok,
        ).toBe(true);
      }
      for (const user of users) {
        const ws = new WebSocket(api.replace(/^http/, "ws") + "/ws", {
          headers: { Cookie: user.cookie, Origin: origin },
        });
        const client = { socket: ws, events: [] as Event[] };
        clients.push(client);
        ws.addEventListener("message", (event) =>
          client.events.push(JSON.parse(String(event.data))),
        );
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener(
            "error",
            () => reject(new Error("WebSocket failed")),
            { once: true },
          );
        });
        await wait(client, "chat.state", 0);
      }
      const [sa, sb, sc] = clients;
      const original = (
        await send(
          sa,
          {
            type: "message.send",
            receiverId: b.id,
            message: "original secret",
          },
          "message.new",
        )
      ).message!;
      await wait(sb, "message.new", 0);
      expect(await count(b, a)).toBe(1);
      const replyB = (
        await send(
          sb,
          {
            type: "message.send",
            receiverId: a.id,
            message: "B reply",
            replyToMessageId: original.id,
          },
          "message.new",
        )
      ).message!;
      expect(replyB.replyToMessageId).toBe(original.id);
      expect(replyB.reply?.messageText).toBe("original secret");
      const ownReply = (
        await send(
          sa,
          {
            type: "message.send",
            receiverId: b.id,
            message: "self reply",
            replyToMessageId: original.id,
          },
          "message.new",
        )
      ).message!;
      expect(ownReply.reply?.senderId).toBe(a.id);
      const replyA = (
        await send(
          sa,
          {
            type: "message.send",
            receiverId: b.id,
            message: "A reply",
            replyToMessageId: replyB.id,
          },
          "message.new",
        )
      ).message!;
      expect(replyA.reply?.senderId).toBe(b.id);
      const beforeEdit = await count(b, a);
      const editStartB = sb.events.length;
      const edited = (
        await send(
          sa,
          {
            type: "message.edit",
            messageId: original.id,
            message: "edited secret",
            senderId: c.id,
          },
          "message.edited",
        )
      ).message!;
      expect(edited.senderId).toBe(a.id);
      expect(edited.receiverId).toBe(b.id);
      expect(edited.editedAt).toBeString();
      expect(
        (await wait(sb, "message.edited", editStartB)).message?.messageText,
      ).toBe("edited secret");
      expect(await count(b, a)).toBe(beforeEdit);
      expect(
        (await history(b, a)).find((message) => message.id === replyB.id)?.reply
          ?.messageText,
      ).toBe("edited secret");
      await send(
        sa,
        { type: "message.edit", messageId: replyB.id, message: "stolen" },
        "error",
      );
      await send(sa, { type: "message.delete", messageId: replyB.id }, "error");
      await send(
        sa,
        { type: "message.edit", messageId: original.id, message: "   " },
        "error",
      );
      for (const event of [
        { type: "message.edit", messageId: original.id, message: "C edit" },
        { type: "message.delete", messageId: original.id },
        {
          type: "message.send",
          receiverId: b.id,
          message: "C quote",
          replyToMessageId: original.id,
        },
        {
          type: "message.send",
          receiverId: c.id,
          message: "cross room",
          replyToMessageId: original.id,
        },
      ])
        await send(sc, event, "error");
      expect(await history(c, a)).toHaveLength(0);
      expect(await history(c, b)).toHaveLength(0);
      const deleteStartB = sb.events.length;
      const deleted = (
        await send(
          sa,
          { type: "message.delete", messageId: original.id },
          "message.deleted",
        )
      ).message!;
      expect(deleted.deletedAt).toBeString();
      expect(deleted.messageText).toBe("");
      expect(
        (await wait(sb, "message.deleted", deleteStartB)).message?.messageText,
      ).toBe("");
      await send(
        sa,
        { type: "message.edit", messageId: original.id, message: "resurrect" },
        "error",
      );
      await send(
        sa,
        { type: "message.delete", messageId: original.id },
        "error",
      );
      expect(await count(b, a)).toBe(beforeEdit! - 1);
      const refreshed = await history(b, a);
      expect(refreshed).toHaveLength(4);
      expect(
        refreshed.find((message) => message.id === original.id)?.messageText,
      ).toBe("");
      expect(
        refreshed.find((message) => message.id === replyB.id)?.reply?.deletedAt,
      ).toBeString();
      expect(
        refreshed.find((message) => message.id === replyB.id)?.reply
          ?.messageText,
      ).toBe("");
      const [row] = await database<
        { message_text: string; deleted_at: Date }[]
      >`SELECT message_text, deleted_at FROM messages WHERE id = ${original.id}`;
      expect(row.message_text).toBe("");
      expect(row.deleted_at).toBeTruthy();
      await send(
        sb,
        { type: "message.read", friendId: a.id, throughMessageId: replyA.id },
        "message.read",
      );
      expect(await count(b, a)).toBe(0);
      expect(
        (await history(a, b)).find((message) => message.id === replyA.id)
          ?.readAt,
      ).toBeString();
      expect(
        sc.events.some((event) =>
          [
            "message.new",
            "message.edited",
            "message.deleted",
            "message.read",
            "typing.start",
            "typing.stop",
          ].includes(event.type),
        ),
      ).toBe(false);
      expect(
        sb.events.filter((event) => event.type === "message.new"),
      ).toHaveLength(4);
      console.log(
        "PASS: A/B reply edit delete, persistence, no content leaks, C blocked, unread and seen preserved",
      );
    } finally {
      for (const client of clients) client.socket.close();
      await Bun.sleep(100);
      for (const user of users)
        await database`DELETE FROM users WHERE lower(email) = lower(${user.email})`;
      await database.close();
    }
  },
  30000,
);
