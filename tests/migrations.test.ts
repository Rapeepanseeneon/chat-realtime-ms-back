import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  assertDatabaseReady,
  checksumMigrationSql,
  getMigrationStatus,
  loadMigrations,
  migrateDatabase,
  type Migration,
} from "../src/migrations";
import { requireTestDatabase } from "../src/testing/test-environment";

const testDatabase = Bun.env.TEST_DATABASE_URL ? requireTestDatabase() : null;

const migration = (
  version: number,
  name: string,
  sql: string,
  transactional = true,
): Migration => ({
  version,
  name,
  sql,
  transactional,
  checksum: checksumMigrationSql(sql),
});

(testDatabase ? test : test.skip)(
  "migration baseline, adoption, drift, rollback and locking are safe",
  async () => {
    if (!testDatabase) throw new Error("Missing TEST_DATABASE_URL");
    const admin = new SQL(testDatabase.url, { max: 2 });
    const schemas: string[] = [];
    const isolatedDatabases = new Set<SQL>();
    const isolatedUrls = new WeakMap<SQL, string>();
    const isolated = async (label: string) => {
      const schema = `migration_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
      schemas.push(schema);
      await admin.unsafe(`CREATE SCHEMA "${schema}"`);
      const url = new URL(testDatabase.url);
      url.searchParams.set("options", `-c search_path=${schema}`);
      const database = new SQL(url.toString(), { max: 3 });
      isolatedDatabases.add(database);
      isolatedUrls.set(database, url.toString());
      return database;
    };
    const closeIsolated = async (database: SQL) => {
      isolatedDatabases.delete(database);
      await database.close();
    };

    try {
      const migrations = await loadMigrations();
      expect(migrations.map((item) => item.version)).toEqual([1, 2]);

      // Empty schema: build the complete baseline and record it once.
      const empty = await isolated("empty");
      const first = await migrateDatabase(empty, migrations);
      expect(first.ready).toBe(true);
      expect(first.applied).toEqual([1, 2]);
      const history = await empty`
        SELECT version::integer AS version, name, checksum
        FROM schema_migrations
      `;
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        version: 1,
        name: "baseline",
        checksum: migrations[0]!.checksum,
      });
      expect(history[1]).toMatchObject({
        version: 2,
        name: "schema_integrity",
        checksum: migrations[1]!.checksum,
      });
      const second = await migrateDatabase(empty, migrations);
      expect(second).toEqual(first);
      await assertDatabaseReady(empty);
      await closeIsolated(empty);

      // Existing schema: verify before adoption and preserve application data.
      const adopted = await isolated("adopt");
      await adopted.begin((transaction) =>
        transaction.unsafe(migrations[0]!.sql),
      );
      await adopted`
        INSERT INTO users(username, email, password_hash)
        VALUES('Migration Survivor', 'migration-survivor@example.test', 'hash')
      `;
      expect((await migrateDatabase(adopted, migrations)).ready).toBe(true);
      const [survivor] = await adopted<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM users
        WHERE email = 'migration-survivor@example.test'
      `;
      expect(survivor?.count).toBe(1);

      // History/checksum drift fails closed.
      await adopted`UPDATE schema_migrations SET checksum = ${"0".repeat(64)} WHERE version = 1`;
      await expect(getMigrationStatus(adopted, migrations)).rejects.toThrow(
        "history/checksum drift",
      );
      await closeIsolated(adopted);

      // Partial/mismatched legacy schema is never adopted or repaired.
      const drifted = await isolated("drift");
      await drifted`CREATE TABLE users(id BIGINT PRIMARY KEY)`;
      await expect(migrateDatabase(drifted, migrations)).rejects.toThrow(
        "schema drift detected",
      );
      const [driftHistory] = await drifted<{ exists: boolean }[]>`
        SELECT to_regclass(current_schema() || '.schema_migrations') IS NOT NULL AS exists
      `;
      expect(driftHistory?.exists).toBe(false);
      await closeIsolated(drifted);

      // A failed transactional migration leaves neither its table nor history.
      const rollback = await isolated("rollback");
      await migrateDatabase(rollback, migrations);
      const failedSql =
        "CREATE TABLE rollback_probe(id INTEGER); SELECT 1 / 0;";
      const failed = migration(3, "forced_failure", failedSql);
      await expect(
        migrateDatabase(rollback, [...migrations, failed]),
      ).rejects.toThrow("migration execution failed");
      const [rolledBack] = await rollback<
        { tableExists: boolean; historyCount: number }[]
      >`
        SELECT to_regclass(current_schema() || '.rollback_probe') IS NOT NULL AS "tableExists",
          (SELECT count(*)::integer FROM schema_migrations WHERE version = 3) AS "historyCount"
      `;
      expect(rolledBack).toEqual({ tableExists: false, historyCount: 0 });
      await closeIsolated(rollback);

      // Competing runners serialize on the advisory lock and record once.
      const concurrentA = await isolated("concurrent");
      const concurrentUrl = isolatedUrls.get(concurrentA);
      if (!concurrentUrl) throw new Error("Missing isolated database URL");
      const concurrentB = new SQL(concurrentUrl, { max: 2 });
      const results = await Promise.all([
        migrateDatabase(concurrentA, migrations),
        migrateDatabase(concurrentB, migrations),
      ]);
      expect(results.every((status) => status.ready)).toBe(true);
      const [concurrentHistory] = await concurrentA<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM schema_migrations
      `;
      expect(concurrentHistory?.count).toBe(2);
      await closeIsolated(concurrentA);
      await concurrentB.close();

      // Startup verification is read-only and refuses missing migrations.
      const missing = await isolated("missing");
      await expect(assertDatabaseReady(missing)).rejects.toThrow(
        "pending migrations",
      );
      const [missingHistory] = await missing<{ exists: boolean }[]>`
        SELECT to_regclass(current_schema() || '.schema_migrations') IS NOT NULL AS exists
      `;
      expect(missingHistory?.exists).toBe(false);
      const missingUrl = isolatedUrls.get(missing);
      if (!missingUrl) throw new Error("Missing isolated database URL");
      const startup = Bun.spawn([process.execPath, "run", "src/index.ts"], {
        cwd: process.cwd(),
        env: {
          ...Bun.env,
          DATABASE_URL: missingUrl,
          TEST_DATABASE_URL: testDatabase.url,
          PORT: "31999",
          TEST_BACKEND_PORT: "31999",
          DEVELOPMENT_BACKEND_PORT: "3001",
          PB_TEST_BACKEND: "1",
          DEV_HTTPS: "false",
          COOKIE_SECURE: "false",
          TEST_ATTACHMENT_STORAGE_DIR: "storage/test-migration-attachments",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const startupError = new Response(startup.stderr).text();
      expect(await startup.exited).not.toBe(0);
      expect(await startupError).toContain("pending migrations: 1, 2");
      await closeIsolated(missing);
    } finally {
      await Promise.allSettled(
        [...isolatedDatabases].map((database) => database.close()),
      );
      for (const schema of schemas.reverse()) {
        await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      await admin.close();
    }
  },
  60_000,
);
