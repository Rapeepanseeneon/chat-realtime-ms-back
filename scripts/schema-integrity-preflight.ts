import { SQL } from "bun";
import { assertSchemaIntegrityPreflight } from "../src/schema-integrity";
import { requireTestDatabase } from "../src/testing/test-environment";

const [target] = Bun.argv.slice(2);
const testMode = target === "--test";
if (target && !testMode)
  throw new Error("Usage: schema-integrity-preflight.ts [--test]");

const databaseUrl = testMode
  ? requireTestDatabase().url
  : Bun.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

let databaseName = "";
try {
  databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\//, ""),
  );
} catch {
  throw new Error("The configured database URL is invalid.");
}

const database = new SQL(databaseUrl, { max: 1 });
try {
  const result = await assertSchemaIntegrityPreflight(database);
  console.info(
    `Database ${databaseName}: schema integrity preflight passed (${Object.keys(result).length} categories, 0 violations).`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Schema preflight failed.",
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
