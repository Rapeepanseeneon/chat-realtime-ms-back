import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createServer } from "node:net";
import { migrateDatabase } from "../src/migrations";
import { requireTestDatabase } from "../src/testing/test-environment";

// Opt-in integration test. A disposable PostgreSQL schema and real backend
// process keep crash/restart tests away from existing users and the dev worker.
const testDatabase = Bun.env.TEST_DATABASE_URL ? requireTestDatabase() : null;
(testDatabase ? test : test.skip)(
  "scheduled ghost recovery, concurrent release, offline history and error retry",
  async () => {
    if (!testDatabase) throw new Error("Missing TEST_DATABASE_URL");
    Bun.env.DATABASE_URL = testDatabase.url;
    const { publishPendingGhosts, releaseDueGhosts } =
      await import("../src/database");
    const admin = new SQL(testDatabase.url, { max: 1 });
    const schema =
      "ghost_reliability_" + crypto.randomUUID().replaceAll("-", "");
    const url = new URL(testDatabase.url);
    url.searchParams.set("options", "-c search_path=" + schema);
    const db = new SQL(url.toString(), { max: 5 });
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const api = `http://localhost:${port}`;
    const origin = Bun.env.FRONTEND_URL ?? "http://localhost:3000";
    let backend: ReturnType<typeof Bun.spawn> | undefined;
    const logs: Promise<string>[] = [];
    const sockets: WebSocket[] = [];
    const until = async (
      check: () => Promise<boolean> | boolean,
      timeout = 6000,
    ) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(20);
      }
      throw new Error("Reliability test timed out");
    };
    const stop = async () => {
      if (!backend) return;
      backend.kill();
      await backend.exited;
      backend = undefined;
    };
    const start = async () => {
      backend = Bun.spawn([process.execPath, "run", "src/index.ts"], {
        cwd: process.cwd(),
        env: {
          ...Bun.env,
          DATABASE_URL: url.toString(),
          TEST_DATABASE_URL: testDatabase.url,
          DATABASE_POOL_SIZE: "1",
          PORT: String(port),
          TEST_BACKEND_PORT: String(port),
          PB_TEST_BACKEND: "1",
          DEV_HTTPS: "false",
          COOKIE_SECURE: "false",
          FRONTEND_URL: origin,
          FRONTEND_URLS: origin,
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      logs.push(new Response(backend.stderr).text());
      await until(async () => {
        try {
          return (
            (
              await fetch(api + "/health", {
                signal: AbortSignal.timeout(250),
                headers: { Connection: "close" },
              })
            ).headers.get("x-pb-test-backend") === "1"
          );
        } catch {
          return false;
        }
      }, 12000);
    };
    const call = (path: string, cookie = "", body?: unknown) =>
      fetch(api + path, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const connect = async (cookie: string) => {
      const events: { type: string; message?: { id: string } }[] = [];
      const socket = new WebSocket(api.replace("http", "ws") + "/ws", {
        headers: { Cookie: cookie, Origin: origin },
      });
      sockets.push(socket);
      socket.addEventListener("message", (event) =>
        events.push(JSON.parse(String(event.data))),
      );
      await until(() => events.some((event) => event.type === "chat.state"));
      return { socket, events };
    };
    try {
      // schema is generated exclusively from a UUID; never a user-supplied identifier.
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      await migrateDatabase(db);
      await start();
      const users = [] as { id: string; username: string; cookie: string }[];
      for (const letter of ["A", "B", "C"]) {
        const username = "Reliable" + letter;
        const email = letter + "@example.test",
          password = "Reliability-test-42";
        expect(
          (
            await call("/api/auth/register", "", {
              username,
              email,
              password,
              confirmPassword: password,
            })
          ).status,
        ).toBe(201);
        const response = await call("/api/auth/login", "", { email, password });
        expect(response.ok).toBe(true);
        const { user } = (await response.json()) as { user: { id: string } };
        users.push({
          ...user,
          username,
          cookie: response.headers.get("set-cookie")!.split(";")[0],
        });
      }
      const [a, b, c] = users;
      await db`INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES (${a.id}, ${b.id}, 'accepted')`;
      const schedule = async (text: string, delay = 200) => {
        const [row] = await db<{ id: string }[]>`
          INSERT INTO messages (sender_name, sender_id, receiver_id, message_text, message_status, scheduled_at)
          VALUES (${a.username}, ${a.id}, ${b.id}, ${text}, 'scheduled', clock_timestamp() + ${delay} * interval '1 millisecond')
          RETURNING id::text AS id
        `;
        return row.id;
      };
      const state = async (id: string) =>
        (
          await db`
        SELECT message_status, released_at, delivery_id::text, ghost_publish_pending FROM messages WHERE id = ${id}
      `
        )[0];
      const history = async () => {
        const response = await call("/api/messages/" + a.id, b.cookie);
        expect(response.ok).toBe(true);
        return ((await response.json()) as { messages: { id: string }[] })
          .messages;
      };

      // A: normal release uses the existing authenticated sockets, only A/B.
      const receiver = await connect(b.cookie),
        outsider = await connect(c.cookie);
      const normal = await schedule("normal schedule");
      expect((await history()).some((message) => message.id === normal)).toBe(
        false,
      );
      await until(() =>
        receiver.events.some(
          (event) =>
            event.type === "message.new" && event.message?.id === normal,
        ),
      );
      expect((await state(normal)).message_status).toBe("sent");
      expect(
        outsider.events.some((event) => event.message?.id === normal),
      ).toBe(false);

      // B/D: no backend/browser at the due time. Startup catches up, offline
      // receiver retrieves the same persisted row, without any socket required.
      await stop();
      const overdue = await schedule("recover while offline");
      await Bun.sleep(350);
      expect((await state(overdue)).message_status).toBe("scheduled");
      await start();
      await until(async () => (await state(overdue)).message_status === "sent");
      expect(
        (await history()).filter((message) => message.id === overdue),
      ).toHaveLength(1);
      const delivery = (await state(overdue)).delivery_id;
      // C: repeated real process restarts never re-release or reinsert.
      for (let i = 0; i < 3; i++) {
        await stop();
        await start();
      }
      expect((await state(overdue)).delivery_id).toBe(delivery);
      expect(
        (await history()).filter((message) => message.id === overdue),
      ).toHaveLength(1);
      await stop();

      // E: PostgreSQL rejects the transition. The transaction must roll back;
      // removing the temporary fault allows the next attempt to recover it.
      const retry = await schedule("release retry", -1);
      await db.unsafe(
        `CREATE FUNCTION reject_ghost_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_status = 'sent' AND OLD.message_status = 'scheduled' THEN RAISE EXCEPTION 'simulated release failure'; END IF; RETURN NEW; END $$`,
      );
      await db.unsafe(
        `CREATE TRIGGER reject_ghost_release BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION reject_ghost_release()`,
      );
      await expect(releaseDueGhosts(db)).rejects.toThrow(
        "simulated release failure",
      );
      await start();
      await Bun.sleep(1200); // the real worker retries while the DB fault persists
      expect((await state(retry)).message_status).toBe("scheduled");
      expect((await state(retry)).released_at).toBeNull();
      expect((await state(retry)).ghost_publish_pending).toBe(false);
      await db.unsafe("DROP TRIGGER reject_ghost_release ON messages");
      await until(async () => (await state(retry)).message_status === "sent");
      await until(
        async () => (await state(retry)).ghost_publish_pending === false,
      );
      await stop();
      expect((await Promise.all(logs)).join("\n")).toContain(
        "Failed to release scheduled ghosts; will retry",
      );
      const concurrent = await schedule("concurrent workers", -1);
      const batches = await Promise.all(
        Array.from({ length: 4 }, () => releaseDueGhosts(db)),
      );
      expect(
        batches.flat().filter((message) => message.id === concurrent),
      ).toHaveLength(1);
      expect((await state(concurrent)).ghost_publish_pending).toBe(true);

      // Realtime failure is independent of DB delivery: retain the durable
      // outbox flag, retry it, then acknowledge once even with competing workers.
      await publishPendingGhosts(async () => {
        throw new Error("simulated publish failure");
      }, db);
      expect((await state(concurrent)).ghost_publish_pending).toBe(true);
      const published: string[] = [];
      await Promise.all(
        Array.from({ length: 4 }, () =>
          publishPendingGhosts(async (message) => {
            published.push(message.id);
            await Bun.sleep(25);
          }, db),
        ),
      );
      expect(published.filter((id) => id === concurrent)).toHaveLength(1);
      expect((await state(concurrent)).ghost_publish_pending).toBe(false);
      await releaseDueGhosts(db);
      expect((await state(concurrent)).delivery_id).toBe(
        batches.flat().find((message) => message.id === concurrent)!.deliveryId,
      );
    } catch (error) {
      await stop();
      console.error(
        "Isolated backend logs:",
        (await Promise.all(logs)).join("\n"),
      );
      throw error;
    } finally {
      for (const socket of sockets) socket.close();
      await stop();
      await Promise.all(logs);
      await db.close();
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.close();
    }
  },
  40000,
);
