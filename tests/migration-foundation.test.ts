import { expect, test } from "bun:test";
import { loadMigrations } from "../src/migrations";

test("migration manifest has immutable foundations and ordered C4 indexes", async () => {
  const migrations = await loadMigrations();

  expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3]);
  expect(migrations[0]).toMatchObject({
    version: 1,
    name: "baseline",
    transactional: true,
  });
  expect(migrations[1]).toMatchObject({
    version: 2,
    name: "schema_integrity",
    transactional: true,
  });
  expect(migrations[2]).toMatchObject({
    version: 3,
    name: "chat_query_indexes",
    transactional: true,
  });
  expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  expect(migrations[1]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  expect(migrations[2]?.checksum).toMatch(/^[a-f0-9]{64}$/);
});

test("normal database startup contains no schema-changing SQL", async () => {
  const source = await Bun.file(
    new URL("../src/database.ts", import.meta.url),
  ).text();

  expect(source).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)\b/i);
  expect(source).toContain("assertDatabaseReady(database)");
});
