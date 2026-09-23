import { expect, test } from "bun:test";
import { SQL } from "bun";

const api = Bun.env.CHAT_TEST_API_URL?.replace(/\/$/, "");
const origin = (Bun.env.FRONTEND_URL ?? "http://localhost:3000").split(",")[0]!;

(api ? test : test.skip)(
  "friends page APIs enforce request ownership, profile privacy and real mutual suggestions",
  async () => {
    if (!api || !Bun.env.DATABASE_URL)
      throw new Error("Missing integration environment");
    const database = new SQL(Bun.env.DATABASE_URL, { max: 1 });
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const users = ["A", "B", "C", "D"].map((letter) => ({
      username:
        letter === "D"
          ? `Step 143 👌<PB>${suffix}`
          : `Step143${letter}${suffix}`,
      email: `step143-${letter.toLowerCase()}-${suffix}@example.test`,
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
    try {
      for (const user of users) {
        const password = "Step-14.3-Test-42";
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
      const [a, b, c, d] = users;
      await database`
        INSERT INTO friend_requests(sender_id, receiver_id, status)
        VALUES (${a.id}, ${b.id}, 'accepted'), (${b.id}, ${c.id}, 'accepted')
      `;

      const ownProfile = await request(
        `/api/profiles/by-username/${a.username}`,
        a.cookie,
      );
      expect(ownProfile.status).toBe(200);
      expect(((await ownProfile.json()) as any).profile.isOwner).toBe(true);

      const encodedUsernameProfile = await request(
        `/api/profiles/by-username/${encodeURIComponent(d.username)}`,
        a.cookie,
      );
      expect(encodedUsernameProfile.status).toBe(200);
      expect(
        ((await encodedUsernameProfile.json()) as any).profile.username,
      ).toBe(d.username);

      const updateA = await request(
        "/api/profile",
        a.cookie,
        {
          username: a.username,
          displayName: "Visible A",
          email: a.email,
          bio: "Private profile detail",
          links: [],
        },
        "PUT",
      );
      expect(updateA.ok).toBe(true);
      expect(
        (
          await request(
            "/api/profile/privacy",
            a.cookie,
            {
              profileVisibility: "friends",
              friendListVisibility: "only_me",
              mutualFriendsVisibility: "friends",
              onlineStatusVisibility: "friends",
            },
            "PUT",
          )
        ).ok,
      ).toBe(true);

      const friendView = (await (
        await request(`/api/profiles/by-username/${a.username}`, b.cookie)
      ).json()) as any;
      expect(friendView.profile.bio).toBe("Private profile detail");
      const strangerView = (await (
        await request(`/api/profiles/by-username/${a.username}`, c.cookie)
      ).json()) as any;
      expect(strangerView.profile.isPrivate).toBe(true);
      expect(strangerView.profile.bio).toBeNull();
      expect(strangerView.profile.links).toEqual([]);
      expect(strangerView.profile.friendCount).toBeNull();
      expect(JSON.stringify(strangerView)).not.toContain(a.email);

      expect(
        (
          await request(
            "/api/profile/privacy",
            a.cookie,
            {
              profileVisibility: "private",
              friendListVisibility: "only_me",
              mutualFriendsVisibility: "only_me",
              onlineStatusVisibility: "nobody",
            },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      const privateFriendView = (await (
        await request(`/api/profiles/by-username/${a.username}`, b.cookie)
      ).json()) as any;
      expect(privateFriendView.profile.bio).toBeNull();

      const suggestions = (await (
        await request("/api/friends/suggestions", a.cookie)
      ).json()) as any;
      expect(suggestions.users.some((user: any) => user.id === c.id)).toBe(
        true,
      );
      expect(suggestions.users.some((user: any) => user.id === b.id)).toBe(
        false,
      );

      const created = await request("/api/friend-requests", a.cookie, {
        receiverId: d.id,
      });
      expect(created.status).toBe(201);
      const requestId = ((await created.json()) as { requestId: string })
        .requestId;
      const sent = (await (
        await request("/api/friend-requests/sent", a.cookie)
      ).json()) as any;
      expect(sent.requests.some((item: any) => item.id === requestId)).toBe(
        true,
      );
      expect(
        (
          await request(
            `/api/friend-requests/${requestId}`,
            b.cookie,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await request(
            `/api/friend-requests/${requestId}`,
            b.cookie,
            { action: "accept" },
            "PUT",
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await request(
            `/api/friend-requests/${requestId}`,
            a.cookie,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(200);

      const search = (await (
        await request(
          `/api/friends/search?q=${encodeURIComponent(d.email)}`,
          a.cookie,
        )
      ).json()) as any;
      expect(search.users[0].id).toBe(d.id);
      expect(JSON.stringify(search)).not.toContain(d.email);
      expect(JSON.stringify(search)).not.toContain("password");
    } finally {
      await database`DELETE FROM users WHERE email IN ${database(users.map((user) => user.email))}`;
      await database.close();
    }
  },
  20_000,
);
