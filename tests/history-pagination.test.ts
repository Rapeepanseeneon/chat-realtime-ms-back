import { expect, test } from "bun:test";
import { SQL } from "bun";
import type { GroupMessage, PrivateMessage } from "../src/database";
import {
  getOptionalIntegrationTestEnvironment,
  verifyTestBackend,
} from "../src/testing/test-environment";

const integration = getOptionalIntegrationTestEnvironment();
const api = integration?.apiUrl;
const origin = Bun.env.FRONTEND_URL ?? "http://localhost:3000";

type TestUser = {
  username: string;
  email: string;
  id: string;
  cookie: string;
};

type PrivatePage = {
  messages: PrivateMessage[];
  hasMore: boolean;
  nextCursor: string | null;
};

type GroupPage = {
  messages: GroupMessage[];
  hasMore: boolean;
  nextBeforeId: string | null;
};

(api ? test : test.skip)(
  "private and group history use safe keyset pagination",
  async () => {
    if (!api || !integration)
      throw new Error("Integration environment missing");
    await verifyTestBackend(integration);
    const db = new SQL(integration.databaseUrl, { max: 1 });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const users: TestUser[] = ["A", "B", "C"].map((letter) => ({
      username: `Page${letter}${suffix}`.slice(0, 49),
      email: `page-${letter.toLowerCase()}-${suffix}@example.test`,
      id: "",
      cookie: "",
    }));
    const call = (path: string, cookie = "", body?: unknown, method = "GET") =>
      fetch(api + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    let groupId: string | null = null;

    try {
      for (const user of users) {
        const password = "Temporary-Pagination-Test-42";
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
      const request = await call(
        "/api/friend-requests",
        a.cookie,
        { receiverId: b.id },
        "POST",
      );
      const requestId = ((await request.json()) as { requestId: string })
        .requestId;
      expect(
        (
          await call(
            `/api/friend-requests/${requestId}`,
            b.cookie,
            { action: "accept" },
            "PUT",
          )
        ).ok,
      ).toBe(true);

      const baseTime = Date.now() - 500_000;
      const privateIds: string[] = [];
      let replyId = "";
      let attachmentMessageId = "";
      for (let index = 0; index < 105; index += 1) {
        const sender = index % 2 === 0 ? a : b;
        const receiver = index % 2 === 0 ? b : a;
        let attachmentId: string | null = null;
        if (index === 20) {
          const [attachment] = await db<{ id: string }[]>`
            INSERT INTO chat_attachments(owner_id,kind,latitude,longitude)
            VALUES(${sender.id},'location',13.7563,100.5018)
            RETURNING id::text AS id`;
          attachmentId = attachment.id;
        }
        const [message] = await db<{ id: string }[]>`
          INSERT INTO messages(
            sender_name,sender_id,receiver_id,message_text,created_at,
            reply_to_message_id,attachment_id
          ) VALUES(
            ${sender.username},${sender.id},${receiver.id},
            ${attachmentId ? "" : `private-${index}`},
            ${new Date(baseTime + index * 1000)},
            ${index === 21 ? privateIds[20] : null}::bigint,
            ${attachmentId}::bigint
          ) RETURNING id::text AS id`;
        privateIds.push(message.id);
        if (index === 21) replyId = message.id;
        if (attachmentId) attachmentMessageId = message.id;
      }

      const releaseOrder = BigInt(Date.now()) * 1000n + 777n;
      const [released] = await db<{ id: string }[]>`
        INSERT INTO messages(
          sender_name,sender_id,receiver_id,message_text,created_at,
          message_status,released_at,state_updated_at,delivery_id
        ) VALUES(
          ${a.username},${a.id},${b.id},'released-ghost',
          ${new Date(baseTime - 1000)},'sent',
          ${new Date(baseTime + 106 * 1000)},${new Date(baseTime + 106 * 1000)},
          ${releaseOrder.toString()}
        ) RETURNING id::text AS id`;
      privateIds.push(released.id);

      await db`
        INSERT INTO messages(sender_name,sender_id,receiver_id,message_text,message_status,created_at,state_updated_at)
        VALUES(${a.username},${a.id},${b.id},'owner-only-hold','ghost',${new Date(baseTime + 107 * 1000)},NOW())`;
      await db`
        INSERT INTO messages(sender_name,sender_id,receiver_id,message_text,message_status,created_at,scheduled_at,state_updated_at)
        VALUES(${a.username},${a.id},${b.id},'owner-only-scheduled','scheduled',${new Date(baseTime + 108 * 1000)},'2100-01-01T00:00:00.000Z',NOW())`;
      await db`
        INSERT INTO messages(sender_name,sender_id,receiver_id,message_text,message_status,created_at,deleted_at,state_updated_at)
        VALUES(${a.username},${a.id},${b.id},'','cancelled',${new Date(baseTime + 109 * 1000)},NOW(),NOW())`;

      const newestResponse = await call(`/api/messages/${a.id}`, b.cookie);
      expect(newestResponse.ok).toBe(true);
      const newest = (await newestResponse.json()) as PrivatePage;
      expect(newest.messages).toHaveLength(50);
      expect(newest.hasMore).toBe(true);
      expect(newest.nextCursor).toBeString();
      expect(newest.messages.at(-1)?.id).toBe(released.id);
      expect(
        newest.messages.some((message) =>
          ["owner-only-hold", "owner-only-scheduled"].includes(
            message.messageText,
          ),
        ),
      ).toBe(false);

      const traversed: PrivateMessage[] = [];
      let cursor: string | null = null;
      let pageCount = 0;
      do {
        const path = `/api/messages/${a.id}?limit=17${
          cursor ? `&before=${encodeURIComponent(cursor)}` : ""
        }`;
        const response = await call(path, b.cookie);
        expect(response.ok).toBe(true);
        const page = (await response.json()) as PrivatePage;
        traversed.push(...page.messages);
        pageCount += 1;
        cursor = page.nextCursor;
        expect(page.hasMore).toBe(cursor !== null);
      } while (cursor && pageCount < 20);
      expect(cursor).toBeNull();
      expect(new Set(traversed.map((message) => message.id)).size).toBe(
        traversed.length,
      );
      expect(traversed).toHaveLength(privateIds.length);
      expect(new Set(traversed.map((message) => message.id))).toEqual(
        new Set(privateIds),
      );
      expect(
        traversed.find((message) => message.id === released.id)?.messageText,
      ).toBe("released-ghost");
      expect(
        traversed.find((message) => message.id === replyId)?.reply?.id,
      ).toBe(attachmentMessageId);
      expect(
        traversed.find((message) => message.id === attachmentMessageId)
          ?.attachment?.kind,
      ).toBe("location");

      const ownerHistory = (await (
        await call(`/api/messages/${b.id}?limit=100`, a.cookie)
      ).json()) as PrivatePage;
      expect(
        ownerHistory.messages.some(
          (message) => message.messageText === "owner-only-hold",
        ),
      ).toBe(true);
      expect(
        ownerHistory.messages.some(
          (message) => message.messageText === "owner-only-scheduled",
        ),
      ).toBe(true);
      expect(
        ownerHistory.messages.some(
          (message) => message.messageStatus === "cancelled",
        ),
      ).toBe(false);
      expect(
        (await call(`/api/messages/${a.id}?before=%25%25%25`, b.cookie)).status,
      ).toBe(400);
      expect(
        (await call(`/api/messages/${a.id}?limit=101`, b.cookie)).status,
      ).toBe(400);
      expect((await call(`/api/messages/${a.id}`, c.cookie)).status).toBe(403);

      const created = await call(
        "/api/groups",
        a.cookie,
        { name: `Page Group ${suffix}`, memberIds: [b.id] },
        "POST",
      );
      expect(created.status).toBe(201);
      groupId = ((await created.json()) as { group: { id: string } }).group.id;
      const groupBase = BigInt(Date.now()) * 1000n;
      const groupIds = [8n, 9n, 10n, 11n].map((offset) =>
        (groupBase + offset).toString(),
      );
      const [groupAttachment] = await db<{ id: string }[]>`
        INSERT INTO chat_attachments(owner_id,kind,latitude,longitude)
        VALUES(${b.id},'location',13.7563,100.5018)
        RETURNING id::text AS id`;
      for (let index = 0; index < groupIds.length; index += 1) {
        await db`
          INSERT INTO group_messages(
            id,group_id,sender_id,message_text,created_at,
            reply_to_message_id,attachment_id
          ) VALUES(
            ${groupIds[index]},${groupId},${index === 2 ? b.id : a.id},
            ${index === 2 ? "" : `group-${index}`},
            ${new Date(baseTime + index * 1000)},
            ${index === 1 ? groupIds[0] : null}::bigint,
            ${index === 2 ? groupAttachment.id : null}::bigint
          )`;
      }

      const groupNewestResponse = await call(
        `/api/groups/${groupId}/messages?limit=2`,
        b.cookie,
      );
      expect(groupNewestResponse.ok).toBe(true);
      const groupNewest = (await groupNewestResponse.json()) as GroupPage;
      expect(groupNewest.messages.map((message) => message.id)).toEqual([
        groupIds[2],
        groupIds[3],
      ]);
      expect(groupNewest.hasMore).toBe(true);
      expect(groupNewest.nextBeforeId).toBe(groupIds[2]);
      expect(groupNewest.messages[0].attachment?.kind).toBe("location");

      const groupOlder = (await (
        await call(
          `/api/groups/${groupId}/messages?limit=2&beforeId=${groupNewest.nextBeforeId}`,
          b.cookie,
        )
      ).json()) as GroupPage;
      expect(groupOlder.messages.map((message) => message.id)).toEqual([
        groupIds[0],
        groupIds[1],
      ]);
      expect(groupOlder.messages[1].reply?.id).toBe(groupIds[0]);
      expect(groupOlder.hasMore).toBe(false);
      expect(groupOlder.nextBeforeId).toBeNull();
      expect(
        new Set(
          [...groupOlder.messages, ...groupNewest.messages].map(
            (message) => message.id,
          ),
        ).size,
      ).toBe(4);
      expect(
        (
          await call(
            `/api/groups/${groupId}/messages?beforeId=invalid`,
            b.cookie,
          )
        ).status,
      ).toBe(400);
      expect(
        (await call(`/api/groups/${groupId}/messages?limit=101`, b.cookie))
          .status,
      ).toBe(400);
      expect(
        (await call(`/api/groups/${groupId}/messages`, c.cookie)).status,
      ).toBe(403);
    } finally {
      if (groupId) await db`DELETE FROM groups WHERE id=${groupId}`;
      await db`DELETE FROM users WHERE lower(email) IN ${db(
        users.map((user) => user.email.toLowerCase()),
      )}`;
      await db.close();
    }
  },
  30_000,
);
