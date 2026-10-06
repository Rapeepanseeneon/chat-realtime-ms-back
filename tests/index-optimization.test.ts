import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  getOptionalIntegrationTestEnvironment,
  verifyTestBackend,
} from "../src/testing/test-environment";

test("C4.3 migration and private history query stay aligned", async () => {
  const migration = await Bun.file(
    new URL(
      "../database/migrations/003_chat_query_indexes.sql",
      import.meta.url,
    ),
  ).text();
  const databaseSource = await Bun.file(
    new URL("../src/database.ts", import.meta.url),
  ).text();

  expect(migration).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  expect(migration).toContain("messages_private_effective_history_idx");
  expect(migration).toContain("COALESCE(released_at, created_at)");
  expect(migration).toContain("created_at DESC, id DESC");
  expect(migration).toContain("lower(username) public.gin_trgm_ops");
  expect(migration).toContain("DROP INDEX group_messages_history_idx");
  expect(databaseSource).toContain(
    "LEAST(sender_id, receiver_id) = LEAST(${currentUserId}::bigint, ${otherUserId}::bigint)",
  );
  expect(databaseSource).toContain(
    "ORDER BY COALESCE(messages.released_at, messages.created_at) DESC",
  );
});

const integration = getOptionalIntegrationTestEnvironment();
const api = integration?.apiUrl;
const origin = (Bun.env.FRONTEND_URL ?? "http://localhost:3000").split(",")[0]!;

(api ? test : test.skip)(
  "C4.3 request ordering and username/email search remain compatible",
  async () => {
    if (!api || !integration)
      throw new Error("Missing integration environment");
    await verifyTestBackend(integration);
    const database = new SQL(integration.databaseUrl, { max: 1 });
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const users = ["A", "B", "C", "D", "E"].map((letter) => ({
      username:
        letter === "E" ? `MixedNeedle${suffix}` : `C43${letter}${suffix}`,
      email: `c43-${letter.toLowerCase()}-${suffix}@example.test`,
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
        const password = "C4.3-Index-Test-42";
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
      const [a, b, c, d, e] = users;
      const createdAt = new Date(Date.now() - 60_000).toISOString();
      const incoming = await database<{ id: string }[]>`
        INSERT INTO friend_requests(sender_id,receiver_id,status,created_at,updated_at)
        VALUES (${b.id},${a.id},'pending',${createdAt},${createdAt}),
          (${c.id},${a.id},'pending',${createdAt},${createdAt})
        RETURNING id::text AS id
      `;
      const outgoing = await database<{ id: string }[]>`
        INSERT INTO friend_requests(sender_id,receiver_id,status,created_at,updated_at)
        VALUES (${a.id},${d.id},'pending',${createdAt},${createdAt}),
          (${a.id},${e.id},'pending',${createdAt},${createdAt})
        RETURNING id::text AS id
      `;
      const received = (
        (await (await request("/api/friend-requests", a.cookie)).json()) as any
      ).requests;
      const sent = (
        (await (
          await request("/api/friend-requests/sent", a.cookie)
        ).json()) as any
      ).requests;
      expect(received.map((item: any) => item.id)).toEqual(
        incoming.map((item) => item.id).reverse(),
      );
      expect(sent.map((item: any) => item.id)).toEqual(
        outgoing.map((item) => item.id).reverse(),
      );

      const substring = (await (
        await request("/api/friends/search?q=mIxEdNeEdLe", a.cookie)
      ).json()) as any;
      expect(substring.users.map((user: any) => user.id)).toContain(e.id);
      const exactEmail = (await (
        await request(
          `/api/friends/search?q=${encodeURIComponent(e.email.toUpperCase())}`,
          a.cookie,
        )
      ).json()) as any;
      expect(exactEmail.users[0].id).toBe(e.id);
      expect(JSON.stringify(exactEmail)).not.toContain(e.email);
      expect(JSON.stringify(exactEmail)).not.toContain("password");
      const none = (await (
        await request(`/api/friends/search?q=no-result-${suffix}`, a.cookie)
      ).json()) as any;
      expect(none.users).toEqual([]);
    } finally {
      await database`DELETE FROM users WHERE email IN ${database(users.map((user) => user.email))}`;
      await database.close();
    }
  },
  20_000,
);
