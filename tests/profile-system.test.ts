import { expect, test } from "bun:test";
import { SQL } from "bun";

const api = Bun.env.CHAT_TEST_API_URL;
const origin = Bun.env.FRONTEND_URL ?? "http://localhost:3000";

(api ? test : test.skip)(
  "profile privacy, links, avatar lifecycle and per-user favorites",
  async () => {
    if (!api || !Bun.env.DATABASE_URL)
      throw new Error("Missing integration environment");
    const db = new SQL(Bun.env.DATABASE_URL, { max: 1 });
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const users = ["A", "B", "C"].map((letter) => ({
      username: `Profile${letter}${suffix}`,
      email: `profile-${letter}-${suffix}@example.test`.toLowerCase(),
      id: "",
      cookie: "",
    }));
    const json = (
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
    try {
      for (const user of users) {
        const password = "Profile-test-42";
        expect(
          (
            await json("/api/auth/register", "", {
              ...user,
              password,
              confirmPassword: password,
            })
          ).status,
        ).toBe(201);
        const login = await json("/api/auth/login", "", {
          email: user.email,
          password,
        });
        user.cookie = login.headers.get("set-cookie")!.split(";")[0];
        user.id = ((await login.json()) as any).user.id;
      }
      const [a, b, c] = users;
      await db`INSERT INTO friend_requests(sender_id,receiver_id,status) VALUES(${a.id},${b.id},'accepted')`;

      const update = await json(
        "/api/profile",
        a.cookie,
        {
          username: a.username,
          email: a.email,
          bio: "Building Pb Messenger 👻",
          links: [
            {
              platform: "GitHub",
              label: "Code",
              url: "https://github.com/example",
            },
          ],
        },
        "PUT",
      );
      expect(update.ok).toBe(true);
      expect((await json("/api/profile", a.cookie)).status).toBe(200);
      expect(
        (
          await json(
            "/api/profile",
            a.cookie,
            {
              username: a.username,
              email: a.email,
              bio: "x",
              links: [
                { platform: "Other", label: "Bad", url: "javascript:alert(1)" },
              ],
            },
            "PUT",
          )
        ).status,
      ).toBe(400);

      const visible = await json(`/api/profiles/${a.id}`, b.cookie);
      const visibleBody = (await visible.json()) as any;
      expect(visible.ok).toBe(true);
      expect(visibleBody.profile.bio).toContain("Messenger");
      expect(visibleBody.profile.links[0].url).toStartWith("https://");
      expect(JSON.stringify(visibleBody)).not.toContain(a.email);
      expect(JSON.stringify(visibleBody)).not.toContain("password");
      expect((await json(`/api/profiles/${a.id}`, c.cookie)).status).toBe(404);
      expect(
        (
          await json(
            `/api/profiles/${a.id}`,
            b.cookie,
            { username: "Hacked" },
            "PUT",
          )
        ).status,
      ).toBe(404);

      expect(
        (
          await json(
            `/api/friends/${b.id}/favorite`,
            a.cookie,
            { favorite: true },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      let friends = (
        (await (await json("/api/friends", a.cookie)).json()) as any
      ).friends;
      expect(friends.find((friend: any) => friend.id === b.id).favorite).toBe(
        true,
      );
      expect(
        (
          await json(
            `/api/friends/${c.id}/favorite`,
            a.cookie,
            { favorite: true },
            "PUT",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await json(
            `/api/friends/${b.id}/favorite`,
            a.cookie,
            { favorite: false },
            "PUT",
          )
        ).ok,
      ).toBe(true);
      friends = ((await (await json("/api/friends", a.cookie)).json()) as any)
        .friends;
      expect(friends.find((friend: any) => friend.id === b.id).favorite).toBe(
        false,
      );

      const upload = async (bytes: number[], type: string, name: string) => {
        const form = new FormData();
        form.set("avatar", new File([new Uint8Array(bytes)], name, { type }));
        return fetch(`${api}/api/profile/avatar`, {
          method: "POST",
          headers: { Origin: origin, Cookie: a.cookie },
          body: form,
        });
      };
      const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0];
      const firstUpload = await upload(png, "image/png", "ignored-name.png");
      const firstUrl = ((await firstUpload.json()) as any).user.avatarUrl;
      expect(firstUpload.ok).toBe(true);
      expect(firstUrl).toMatch(/^\/uploads\/avatars\/[a-zA-Z0-9-]+\.png$/);
      const secondUpload = await upload(
        [0xff, 0xd8, 0xff, 0xd9],
        "image/jpeg",
        "another.jpg",
      );
      const secondUrl = ((await secondUpload.json()) as any).user.avatarUrl;
      expect(secondUpload.ok).toBe(true);
      expect(secondUrl).not.toBe(firstUrl);
      expect((await fetch(api + firstUrl)).status).toBe(404);
      expect(
        (
          await upload(
            [60, 115, 99, 114, 105, 112, 116],
            "image/png",
            "attack.png",
          )
        ).status,
      ).toBe(400);
      expect(
        (await json("/api/profile/avatar", a.cookie, undefined, "DELETE")).ok,
      ).toBe(true);
      expect((await fetch(api + secondUrl)).status).toBe(404);
    } finally {
      await db`DELETE FROM users WHERE email IN ${db(users.map((user) => user.email))}`;
      await db.close();
    }
  },
  20_000,
);
