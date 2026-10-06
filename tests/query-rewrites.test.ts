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
  "C4.2 set-based friends/groups/suggestions and bigint lookups preserve behavior",
  async () => {
    if (!api || !integration)
      throw new Error("Missing integration environment");
    await verifyTestBackend(integration);
    const database = new SQL(integration.databaseUrl, { max: 1 });
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const users = ["A", "B", "C", "D", "E", "F"].map((letter) => ({
      username: `C42${letter}${suffix}`,
      email: `c42-${letter.toLowerCase()}-${suffix}@example.test`,
      id: "",
      cookie: "",
    }));
    const sockets: WebSocket[] = [];
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
    const connect = async (cookie: string) => {
      const socket = new WebSocket(`${api.replace(/^http/, "ws")}/ws`, {
        headers: { Cookie: cookie, Origin: origin },
      });
      const events: any[] = [];
      sockets.push(socket);
      socket.onmessage = (event) => events.push(JSON.parse(String(event.data)));
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("WebSocket failed"));
      });
      return { socket, events };
    };
    const until = async (
      check: () => boolean | Promise<boolean>,
      timeout = 5_000,
    ) => {
      const expires = Date.now() + timeout;
      while (Date.now() < expires) {
        if (await check()) return;
        await Bun.sleep(20);
      }
      throw new Error("Timed out waiting for C4.2 state");
    };
    const createRequest = async (
      sender: (typeof users)[number],
      receiverId: string,
    ) => {
      const response = await request("/api/friend-requests", sender.cookie, {
        receiverId,
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { requestId: string }).requestId;
    };

    try {
      for (const user of users) {
        const password = "C4.2-Query-Test-42";
        const response = await request("/api/auth/register", "", {
          username: user.username,
          email: user.email,
          password,
          confirmPassword: password,
        });
        expect(response.status).toBe(201);
        user.cookie = (response.headers.get("set-cookie") ?? "").split(
          ";",
          1,
        )[0]!;
        user.id = ((await response.json()) as { user: { id: string } }).user.id;
      }
      const [a, b, c, d, e, f] = users;
      await database`
        INSERT INTO friend_requests(sender_id, receiver_id, status)
        VALUES (${a.id}, ${b.id}, 'accepted'), (${a.id}, ${c.id}, 'accepted'),
          (${b.id}, ${d.id}, 'accepted'), (${c.id}, ${d.id}, 'accepted'),
          (${b.id}, ${e.id}, 'accepted'), (${a.id}, ${e.id}, 'pending')
      `;
      await database`
        INSERT INTO messages(sender_name, sender_id, receiver_id, message_text, message_status, created_at)
        VALUES (${a.username}, ${a.id}, ${b.id}, 'private recent', 'sent', NOW() - INTERVAL '2 minutes'),
          (${a.username}, ${a.id}, ${c.id}, 'hidden ghost', 'ghost', NOW())
      `;
      const [zeroGroup] = await database<{ id: string }[]>`
        INSERT INTO groups(name, created_by) VALUES ('C4.2 zero messages', ${a.id}) RETURNING id::text AS id
      `;
      const [activeGroup] = await database<{ id: string }[]>`
        INSERT INTO groups(name, created_by) VALUES ('C4.2 active group', ${a.id}) RETURNING id::text AS id
      `;
      await database`
        INSERT INTO group_members(group_id, user_id, role)
        VALUES (${zeroGroup!.id}, ${a.id}, 'owner'), (${zeroGroup!.id}, ${b.id}, 'member'),
          (${activeGroup!.id}, ${a.id}, 'owner'), (${activeGroup!.id}, ${c.id}, 'member'),
          (${activeGroup!.id}, ${d.id}, 'member')
      `;
      await database`
        INSERT INTO group_messages(group_id, sender_id, message_text, created_at)
        VALUES (${activeGroup!.id}, ${a.id}, 'own message', NOW() - INTERVAL '90 seconds'),
          (${activeGroup!.id}, ${c.id}, 'friend group recent', NOW() - INTERVAL '1 minute'),
          (${activeGroup!.id}, ${d.id}, 'other member unread', NOW() - INTERVAL '30 seconds')
      `;

      const realtime = await connect(a.cookie);
      await until(() =>
        realtime.events.some((event) => event.type === "chat.state"),
      );
      const state = realtime.events.find(
        (event) => event.type === "chat.state",
      );
      expect(state.friends.map((friend: any) => friend.id).sort()).toEqual(
        [b.id, c.id].sort(),
      );

      expect(
        (
          await request(
            `/api/friends/${c.id}/favorite`,
            a.cookie,
            { favorite: true },
            "PUT",
          )
        ).status,
      ).toBe(200);
      const friends = (
        (await (await request("/api/friends", a.cookie)).json()) as any
      ).friends;
      expect(friends.map((friend: any) => friend.id)).toEqual([c.id, b.id]);
      expect(friends[0].favorite).toBe(true);
      expect(new Date(friends[0].recentAt).getTime()).toBeGreaterThan(
        new Date(friends[1].recentAt).getTime(),
      );

      const groups = (
        (await (await request("/api/groups", a.cookie)).json()) as any
      ).groups;
      const emptySummary = groups.find(
        (group: any) => group.id === zeroGroup!.id,
      );
      const activeSummary = groups.find(
        (group: any) => group.id === activeGroup!.id,
      );
      expect(emptySummary.memberCount).toBe(2);
      expect(emptySummary.unreadCount).toBe(0);
      expect(activeSummary.memberCount).toBe(3);
      expect(activeSummary.unreadCount).toBe(2);

      expect(
        (
          await request(
            "/api/profile",
            d.cookie,
            {
              username: d.username,
              displayName: d.username,
              email: d.email,
              bio: "group-private-bio",
              links: [],
            },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await request(
            "/api/profile/privacy",
            d.cookie,
            {
              profileVisibility: "friends",
              friendListVisibility: "only_me",
              mutualFriendsVisibility: "everyone",
              onlineStatusVisibility: "friends",
            },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      const groupInfo = (
        (await (
          await request(`/api/groups/${activeGroup!.id}`, a.cookie)
        ).json()) as any
      ).group;
      expect(groupInfo.id).toBe(activeGroup!.id);
      expect(
        groupInfo.members.find((member: any) => member.id === d.id).bio,
      ).toBe("");
      expect(
        (await request(`/api/groups/${activeGroup!.id}`, f.cookie)).status,
      ).toBe(404);

      const suggestions = (
        (await (
          await request("/api/friends/suggestions", a.cookie)
        ).json()) as any
      ).users;
      expect(
        suggestions.find((user: any) => user.id === d.id).mutualFriendCount,
      ).toBe(2);
      expect(
        suggestions.find((user: any) => user.id === e.id).relationship,
      ).toBe("outgoing_pending");
      expect(
        suggestions.some((user: any) => user.id === b.id || user.id === c.id),
      ).toBe(false);

      const acceptId = await createRequest(a, f.id);
      expect(
        (
          await request(
            `/api/friend-requests/${acceptId}`,
            f.cookie,
            { action: "accept" },
            "PUT",
          )
        ).status,
      ).toBe(200);
      const rejectId = await createRequest(c, f.id);
      expect(
        (
          await request(
            `/api/friend-requests/${rejectId}`,
            f.cookie,
            { action: "reject" },
            "PUT",
          )
        ).status,
      ).toBe(200);
      const cancelId = await createRequest(c, e.id);
      expect(
        (
          await request(
            `/api/friend-requests/${cancelId}`,
            c.cookie,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(200);
      const tooLargeId = "9223372036854775808";
      expect(
        (
          await request(
            `/api/friend-requests/${tooLargeId}`,
            f.cookie,
            { action: "accept" },
            "PUT",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await request(
            `/api/friend-requests/${tooLargeId}`,
            a.cookie,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(400);
      expect(
        (await request(`/api/messages/${tooLargeId}`, a.cookie)).status,
      ).toBe(400);
      expect((await request(`/api/messages/${b.id}`, a.cookie)).status).toBe(
        200,
      );

      const [incoming] = await database<{ id: string }[]>`
        INSERT INTO messages(sender_name, sender_id, receiver_id, message_text, message_status)
        VALUES (${b.username}, ${b.id}, ${a.id}, 'read boundary', 'sent') RETURNING id::text AS id
      `;
      realtime.socket.send(
        JSON.stringify({
          type: "message.read",
          friendId: b.id,
          throughMessageId: incoming!.id,
        }),
      );
      await until(async () => {
        const [row] = await database<{ read: boolean }[]>`
          SELECT read_at IS NOT NULL AS read FROM messages WHERE id = ${incoming!.id}
        `;
        return row?.read === true;
      });
    } finally {
      for (const socket of sockets) socket.close();
      await database`
        DELETE FROM groups
        WHERE created_by IN (
          SELECT id FROM users WHERE email IN ${database(users.map((user) => user.email))}
        )
      `;
      await database`DELETE FROM users WHERE email IN ${database(users.map((user) => user.email))}`;
      await database.close();
    }
  },
  30_000,
);
