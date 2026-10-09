import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  getOptionalIntegrationTestEnvironment,
  verifyTestBackend,
} from "../src/testing/test-environment";

const integration = getOptionalIntegrationTestEnvironment();
const api = integration?.apiUrl;
const origin = (Bun.env.FRONTEND_URL ?? "http://localhost:3000").split(",")[0]!;

(api ? test : test.skip)(
  "C4.4 list cursors traverse requests, friends, groups, and members safely",
  async () => {
    if (!api || !integration)
      throw new Error("Missing integration environment");
    await verifyTestBackend(integration);
    const database = new SQL(integration.databaseUrl, { max: 1 });
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const users = "ABCDEFGH".split("").map((letter) => ({
      username: `C44${letter}${suffix}`,
      email: `c44-${letter.toLowerCase()}-${suffix}@example.test`,
      id: "",
      cookie: "",
    }));
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
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const traverse = async (path: string, cookie: string, key: string) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "1" });
        if (cursor) query.set("cursor", cursor);
        const response = await request(`${path}?${query}`, cookie);
        expect(response.status).toBe(200);
        const value = (await response.json()) as Record<string, any>;
        const items = value[key] as { id: string }[];
        expect(items.length).toBeLessThanOrEqual(1);
        ids.push(...items.map((item) => item.id));
        cursor = value.hasMore ? value.nextCursor : null;
        if (value.hasMore) expect(typeof cursor).toBe("string");
      } while (cursor);
      expect(new Set(ids).size).toBe(ids.length);
      return ids;
    };

    try {
      for (const user of users) {
        const [created] = await database<{ id: string }[]>`
          INSERT INTO users(username,display_name,email,password_hash)
          VALUES(${user.username},${user.username},${user.email},'c44-test-only')
          RETURNING id::text id
        `;
        user.id = created!.id;
        const token = `c44-${crypto.randomUUID()}`;
        const tokenHash = new Bun.CryptoHasher("sha256")
          .update(token)
          .digest("hex");
        await database`
          INSERT INTO sessions(user_id,token_hash,expires_at)
          VALUES(${user.id},${tokenHash},NOW()+INTERVAL '1 hour')
        `;
        user.cookie = `pb_session=${token}`;
      }
      const [a, b, c, d, e, f, g, h] = users;
      await database`
        INSERT INTO friend_requests(sender_id,receiver_id,status,created_at)
        VALUES (${a.id},${b.id},'accepted',NOW()-INTERVAL '3 days'),
          (${a.id},${c.id},'accepted',NOW()-INTERVAL '2 days'),
          (${d.id},${a.id},'pending','2026-01-01T00:00:00.000Z'),
          (${e.id},${a.id},'pending','2026-01-01T00:00:00.000Z'),
          (${a.id},${f.id},'pending','2026-01-02T00:00:00.000Z'),
          (${a.id},${g.id},'pending','2026-01-02T00:00:00.000Z')
      `;
      await database`
        INSERT INTO favorite_friends(user_id,friend_id) VALUES(${a.id},${c.id})
      `;
      const received = await traverse(
        "/api/friend-requests",
        a.cookie,
        "requests",
      );
      const sent = await traverse(
        "/api/friend-requests/sent",
        a.cookie,
        "requests",
      );
      const friends = await traverse("/api/friends", a.cookie, "friends");
      expect(received.sort()).toEqual(
        (
          await database<{ id: string }[]>`
            SELECT id::text id FROM friend_requests WHERE receiver_id=${a.id} AND status='pending'
          `
        )
          .map((row) => row.id)
          .sort(),
      );
      expect(sent.length).toBe(2);
      expect(friends.sort()).toEqual([b.id, c.id].sort());
      const firstFriendsPage = (await (
        await request("/api/friends?limit=2", a.cookie)
      ).json()) as any;
      expect(firstFriendsPage.friends[0].id).toBe(c.id);
      expect(firstFriendsPage.friends[0].favorite).toBe(true);

      for (const path of [
        "/api/friend-requests?limit=0",
        "/api/friend-requests?limit=101",
        "/api/friend-requests?cursor=not-a-cursor",
        "/api/groups?limit=1.5",
      ])
        expect((await request(path, a.cookie)).status).toBe(400);

      const [firstGroup] = await database<{ id: string }[]>`
        INSERT INTO groups(name,created_by,updated_at)
        VALUES (${`C44 first ${suffix}`},${a.id},'2026-02-01T00:00:00.000Z') RETURNING id::text id
      `;
      const [secondGroup] = await database<{ id: string }[]>`
        INSERT INTO groups(name,created_by,updated_at)
        VALUES (${`C44 second ${suffix}`},${a.id},'2026-02-01T00:00:00.000Z') RETURNING id::text id
      `;
      await database`
        INSERT INTO group_members(group_id,user_id,role,joined_at)
        VALUES (${firstGroup!.id},${a.id},'owner','2026-01-01T00:00:00.000Z'),
          (${firstGroup!.id},${b.id},'member','2026-01-02T00:00:00.000Z'),
          (${firstGroup!.id},${c.id},'member','2026-01-02T00:00:00.000Z'),
          (${secondGroup!.id},${a.id},'owner','2026-01-01T00:00:00.000Z')
      `;
      await database`
        INSERT INTO group_messages(group_id,sender_id,message_text)
        VALUES (${firstGroup!.id},${b.id},'unread one'),(${firstGroup!.id},${c.id},'unread two')
      `;
      await database`
        INSERT INTO profile_privacy(user_id,profile_visibility)
        VALUES(${c.id},'private')
        ON CONFLICT(user_id) DO UPDATE SET profile_visibility='private'
      `;
      const groups = await traverse("/api/groups", a.cookie, "groups");
      expect(groups.sort()).toEqual([firstGroup!.id, secondGroup!.id].sort());
      const groupSummary = (await (
        await request("/api/groups?limit=2", a.cookie)
      ).json()) as any;
      const firstSummary = groupSummary.groups.find(
        (group: any) => group.id === firstGroup!.id,
      );
      expect(firstSummary.memberCount).toBe(3);
      expect(firstSummary.unreadCount).toBe(2);

      const memberIds: string[] = [];
      let memberCursor: string | null = null;
      do {
        const query = new URLSearchParams({ memberLimit: "1" });
        if (memberCursor) query.set("memberCursor", memberCursor);
        const response = await request(
          `/api/groups/${firstGroup!.id}?${query}`,
          a.cookie,
        );
        expect(response.status).toBe(200);
        const info = ((await response.json()) as any).group;
        memberIds.push(...info.members.map((member: any) => member.id));
        if (info.members[0]?.id === c.id) expect(info.members[0].bio).toBe("");
        memberCursor = info.memberPage.hasMore
          ? info.memberPage.nextCursor
          : null;
      } while (memberCursor);
      expect(memberIds).toEqual([a.id, b.id, c.id]);
      expect(new Set(memberIds).size).toBe(3);
      expect(
        (await request(`/api/groups/${firstGroup!.id}`, h.cookie)).status,
      ).toBe(404);
      const empty = (await (
        await request("/api/friend-requests", h.cookie)
      ).json()) as any;
      expect(empty.requests).toEqual([]);
      expect(empty.hasMore).toBe(false);
      expect(empty.nextCursor).toBeNull();
    } finally {
      await database`
        DELETE FROM groups WHERE created_by IN (
          SELECT id FROM users WHERE email IN ${database(users.map((user) => user.email))}
        )
      `;
      await database`DELETE FROM users WHERE email IN ${database(users.map((user) => user.email))}`;
      await database.close();
    }
  },
  30_000,
);
