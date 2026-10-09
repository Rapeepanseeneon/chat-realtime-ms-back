import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  getDatabaseTimeoutKind,
  readRuntimeDatabaseSettings,
  runtimeDatabaseOptions,
} from "../src/database-runtime";
import {
  deleteExpiredSessionsBatch,
  readSessionCleanupSettings,
} from "../src/session-cleanup";
import {
  getOptionalIntegrationTestEnvironment,
  requireTestDatabase,
  verifyTestBackend,
} from "../src/testing/test-environment";

test("C5 runtime timeout and cleanup settings are bounded", () => {
  expect(readRuntimeDatabaseSettings({})).toEqual({
    statementTimeoutMs: 15_000,
    lockTimeoutMs: 3_000,
    idleInTransactionTimeoutMs: 10_000,
    connectionTimeoutSeconds: 10,
    idleTimeoutSeconds: 30,
    maxLifetimeSeconds: 3_600,
  });
  expect(readSessionCleanupSettings({})).toEqual({
    batchSize: 200,
    intervalMs: 300_000,
  });
  expect(() =>
    readRuntimeDatabaseSettings({
      DATABASE_STATEMENT_TIMEOUT_MS: "100",
      DATABASE_LOCK_TIMEOUT_MS: "100",
    }),
  ).toThrow("must be less");
});

const testDatabase = Bun.env.TEST_DATABASE_URL ? requireTestDatabase() : null;

(testDatabase ? test : test.skip)(
  "C5 PostgreSQL timeouts are enforced and timed-out transactions roll back",
  async () => {
    if (!testDatabase) throw new Error("Missing TEST_DATABASE_URL");
    const prefix = `c5_timeout_${crypto.randomUUID().replaceAll("-", "")}`;
    const quickEnvironment = {
      DATABASE_STATEMENT_TIMEOUT_MS: "150",
      DATABASE_LOCK_TIMEOUT_MS: "75",
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "100",
      DATABASE_CONNECTION_TIMEOUT_SECONDS: "5",
      DATABASE_IDLE_CONNECTION_TIMEOUT_SECONDS: "5",
      DATABASE_CONNECTION_MAX_LIFETIME_SECONDS: "60",
    };
    const database = new SQL(testDatabase.url, {
      max: 4,
      ...runtimeDatabaseOptions(quickEnvironment),
    });
    const control = new SQL(testDatabase.url, { max: 2 });
    try {
      const [settings] = await database<
        {
          statementTimeout: string;
          lockTimeout: string;
          idleTimeout: string;
        }[]
      >`SELECT current_setting('statement_timeout') AS "statementTimeout",
        current_setting('lock_timeout') AS "lockTimeout",
        current_setting('idle_in_transaction_session_timeout') AS "idleTimeout"`;
      expect(settings).toEqual({
        statementTimeout: "150ms",
        lockTimeout: "75ms",
        idleTimeout: "100ms",
      });

      let statementError: unknown;
      try {
        await database`SELECT pg_sleep(0.3)`;
      } catch (error) {
        statementError = error;
      }
      expect(getDatabaseTimeoutKind(statementError)).toBe("statement_timeout");

      let rollbackError: unknown;
      try {
        await database.begin(async (transaction) => {
          await transaction`
            INSERT INTO users(username,display_name,email,password_hash)
            VALUES(${prefix},${prefix},${`${prefix}@example.test`},'c5-test-only')
          `;
          await transaction`SELECT pg_sleep(0.3)`;
        });
      } catch (error) {
        rollbackError = error;
      }
      expect(getDatabaseTimeoutKind(rollbackError)).toBe("statement_timeout");
      const [rolledBack] = await control<{ count: number }[]>`
        SELECT count(*)::integer count FROM users WHERE username=${prefix}
      `;
      expect(rolledBack?.count).toBe(0);

      const [lockedUser] = await control<{ id: string }[]>`
        INSERT INTO users(username,display_name,email,password_hash)
        VALUES(${`${prefix}_lock`},${prefix},${`${prefix}_lock@example.test`},'c5-test-only')
        RETURNING id::text id
      `;
      if (!lockedUser) throw new Error("Lock test user was not created");
      let releaseLock!: () => void;
      const hold = new Promise<void>((resolve) => (releaseLock = resolve));
      let lockReady!: () => void;
      const ready = new Promise<void>((resolve) => (lockReady = resolve));
      const locker = control.begin(async (transaction) => {
        await transaction`SELECT id FROM users WHERE id=${lockedUser.id} FOR UPDATE`;
        lockReady();
        await hold;
      });
      await ready;
      let lockError: unknown;
      try {
        await database`UPDATE users SET updated_at=clock_timestamp() WHERE id=${lockedUser.id}`;
      } catch (error) {
        lockError = error;
      } finally {
        releaseLock();
        await locker;
      }
      expect(getDatabaseTimeoutKind(lockError)).toBe("lock_timeout");

      const idleName = `${prefix}_idle`;
      let idleError: unknown;
      try {
        await database.begin(async (transaction) => {
          await transaction`
            INSERT INTO users(username,display_name,email,password_hash)
            VALUES(${idleName},${idleName},${`${idleName}@example.test`},'c5-test-only')
          `;
          await Bun.sleep(250);
          await transaction`SELECT 1`;
        });
      } catch (error) {
        idleError = error;
      }
      // Bun can surface a server-terminated idle transaction as a generic
      // connection read error, so effectiveness is proven by termination and
      // rollback rather than depending on a driver-specific error code.
      expect(idleError).toBeDefined();
      const [idleRolledBack] = await control<{ count: number }[]>`
        SELECT count(*)::integer count FROM users WHERE username=${idleName}
      `;
      expect(idleRolledBack?.count).toBe(0);
      expect((await database`SELECT 1 AS ok`)[0]?.ok).toBe(1);
    } finally {
      await control`DELETE FROM users WHERE username LIKE ${`${prefix}%`}`;
      await database.close();
      await control.close();
    }
  },
  15_000,
);

(testDatabase ? test : test.skip)(
  "C5 expired-session cleanup is indexed, bounded, concurrent-safe and idempotent",
  async () => {
    if (!testDatabase) throw new Error("Missing TEST_DATABASE_URL");
    const database = new SQL(testDatabase.url, { max: 5 });
    const prefix = `c5_sessions_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      const [user] = await database<{ id: string }[]>`
        INSERT INTO users(username,display_name,email,password_hash)
        VALUES(${prefix},${prefix},${`${prefix}@example.test`},'c5-test-only')
        RETURNING id::text id
      `;
      if (!user) throw new Error("Session growth user was not created");
      await database`
        INSERT INTO sessions(user_id,token_hash,expires_at,created_at)
        SELECT ${user.id}, md5(${prefix} || ':expired:' || value::text) || md5('x' || value::text),
          clock_timestamp() - interval '1 hour', clock_timestamp() - interval '8 days'
        FROM generate_series(1,450) value
      `;
      const expiredHash = `${Bun.MD5.hash(`${prefix}:expired:1`, "hex")}${Bun.MD5.hash("x1", "hex")}`;
      const [expiredAuthentication] = await database<{ count: number }[]>`
        SELECT count(*)::integer count FROM sessions
        WHERE token_hash=${expiredHash} AND expires_at > clock_timestamp()
      `;
      expect(expiredAuthentication?.count).toBe(0);
      await database`
        INSERT INTO sessions(user_id,token_hash,expires_at)
        SELECT ${user.id}, md5(${prefix} || ':active:' || value::text) || md5('a' || value::text),
          clock_timestamp() + interval '7 days'
        FROM generate_series(1,10) value
      `;
      const replacementHash = new Bun.CryptoHasher("sha256")
        .update(`${prefix}:replacement`)
        .digest("hex");
      await database`
        INSERT INTO sessions(user_id,token_hash,expires_at)
        VALUES(${user.id},${replacementHash},clock_timestamp() + interval '7 days')
      `;
      const revokedHash = new Bun.CryptoHasher("sha256")
        .update(`${prefix}:revoked`)
        .digest("hex");
      await database`
        INSERT INTO sessions(user_id,token_hash,expires_at)
        VALUES(${user.id},${revokedHash},clock_timestamp() + interval '7 days')
      `;
      await database`DELETE FROM sessions WHERE token_hash=${revokedHash}`;
      expect(
        Number(
          (
            await database`SELECT count(*) count FROM sessions WHERE token_hash=${revokedHash}`
          )[0]?.count,
        ),
      ).toBe(0);

      const plan = await database`
        EXPLAIN (FORMAT JSON)
        WITH expired AS (
          SELECT id FROM sessions WHERE expires_at <= clock_timestamp()
          ORDER BY expires_at,id LIMIT 200 FOR UPDATE SKIP LOCKED
        )
        DELETE FROM sessions session USING expired WHERE session.id=expired.id
      `;
      const [index] = await database<{ name: string | null }[]>`
        SELECT to_regclass('sessions_expires_at_idx')::text AS name
      `;
      expect(index?.name).toBe("sessions_expires_at_idx");
      // PostgreSQL may still prefer a sequential scan for this deliberately
      // small fixture. The plan must stay bounded by the cleanup LIMIT.
      expect(JSON.stringify(plan)).toContain('"Node Type":"Limit"');

      const first = await Promise.all([
        deleteExpiredSessionsBatch(database, 200),
        deleteExpiredSessionsBatch(database, 200),
      ]);
      expect(first.every((deleted) => deleted <= 200)).toBe(true);
      expect(
        first.reduce((sum, deleted) => sum + deleted, 0),
      ).toBeLessThanOrEqual(400);
      const batches = [...first];
      while (true) {
        const deleted = await deleteExpiredSessionsBatch(database, 200);
        batches.push(deleted);
        if (deleted === 0) break;
      }
      expect(batches.every((deleted) => deleted <= 200)).toBe(true);
      expect(batches.reduce((sum, deleted) => sum + deleted, 0)).toBe(450);
      expect(await deleteExpiredSessionsBatch(database, 200)).toBe(0);

      const [remaining] = await database<
        { active: number; expired: number; replacement: number }[]
      >`
        SELECT count(*) FILTER (WHERE expires_at > clock_timestamp())::integer active,
          count(*) FILTER (WHERE expires_at <= clock_timestamp())::integer expired,
          count(*) FILTER (WHERE token_hash=${replacementHash})::integer replacement
        FROM sessions WHERE user_id=${user.id}
      `;
      expect(remaining).toEqual({ active: 11, expired: 0, replacement: 1 });
    } finally {
      await database`DELETE FROM users WHERE username=${prefix}`;
      await database.close();
    }
  },
  15_000,
);

const integration = getOptionalIntegrationTestEnvironment();
const api = integration?.apiUrl;
const origin = (Bun.env.FRONTEND_URL ?? "http://localhost:3000")
  .split(",")[0]!
  .trim();

(api ? test : test.skip)(
  "C5 lock timeout returns a sanitized response and the backend stays healthy",
  async () => {
    if (!api || !integration)
      throw new Error("Missing integration test environment");
    await verifyTestBackend(integration);
    const database = new SQL(integration.databaseUrl, { max: 2 });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const account = {
      username: `C5Api${suffix}`,
      email: `c5-api-${suffix}@example.test`,
      password: "C5-timeout-test-42",
    };
    let releaseLock!: () => void;
    const hold = new Promise<void>((resolve) => (releaseLock = resolve));
    let lockTask: Promise<unknown> | null = null;
    try {
      const registration = await fetch(`${api}/api/auth/register`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ...account, confirmPassword: account.password }),
      });
      expect(registration.status).toBe(201);
      const cookie = (registration.headers.get("set-cookie") ?? "").split(
        ";",
      )[0]!;
      const token = cookie.slice(cookie.indexOf("=") + 1);
      const tokenHash = new Bun.CryptoHasher("sha256")
        .update(token)
        .digest("hex");
      let lockReady!: () => void;
      const ready = new Promise<void>((resolve) => (lockReady = resolve));
      lockTask = database.begin(async (transaction) => {
        await transaction`SELECT id FROM sessions WHERE token_hash=${tokenHash} FOR UPDATE`;
        lockReady();
        await hold;
      });
      await ready;
      const logout = await fetch(`${api}/api/auth/logout`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      });
      expect(logout.status).toBe(503);
      const body = await logout.text();
      expect(body).toContain("DATABASE_TIMEOUT");
      expect(body).not.toContain(token);
      expect(body).not.toContain(tokenHash);
      expect(body).not.toContain("DELETE FROM");
      releaseLock();
      await lockTask;
      lockTask = null;
      expect((await fetch(`${api}/health`)).status).toBe(200);
      expect(
        (
          await fetch(`${api}/api/auth/me`, {
            headers: { Origin: origin, Cookie: cookie },
          })
        ).status,
      ).toBe(200);
    } finally {
      releaseLock();
      if (lockTask) await lockTask.catch(() => undefined);
      await database`DELETE FROM users WHERE email=${account.email}`;
      await database.close();
    }
  },
  15_000,
);
