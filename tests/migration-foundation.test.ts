import { expect, test } from "bun:test";
import { loadMigrations } from "../src/migrations";

test("migration manifest has an immutable baseline and ordered C3 migration", async () => {
  const migrations = await loadMigrations();

  expect(migrations.map((migration) => migration.version)).toEqual([1, 2]);
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
  expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  expect(migrations[1]?.checksum).toMatch(/^[a-f0-9]{64}$/);
});

test("normal database startup contains no schema-changing SQL", async () => {
  const source = await Bun.file(
    new URL("../src/database.ts", import.meta.url),
  ).text();

  expect(source).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)\b/i);
  expect(source).toContain("assertDatabaseReady(database)");
});
