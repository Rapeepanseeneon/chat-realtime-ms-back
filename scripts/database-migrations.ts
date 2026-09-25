import { SQL } from "bun";
import { getMigrationStatus, migrateDatabase } from "../src/migrations";
import { requireTestDatabase } from "../src/testing/test-environment";

const [action, target] = Bun.argv.slice(2);
if (
  !(["migrate", "status"] as const).includes(action as "migrate" | "status")
) {
  throw new Error("Usage: database-migrations.ts <migrate|status> [--test]");
}

const testMode = target === "--test";
if (target && !testMode) throw new Error("Unknown migration target.");

const databaseUrl = testMode
  ? requireTestDatabase().url
  : Bun.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

let databaseName = "";
try {
  const parsed = new URL(databaseUrl);
  databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
} catch {
  throw new Error("The configured database URL is invalid.");
}

const database = new SQL(databaseUrl, { max: 2 });
try {
  if (action === "migrate") {
    const status = await migrateDatabase(database);
    console.info(
      `Database ${databaseName}: migrations ready; applied versions: ${status.applied.join(", ")}.`,
    );
  } else {
    const status = await getMigrationStatus(database);
    console.info(
      `Database ${databaseName}: ${status.ready ? "ready" : "not ready"}; applied: ${status.applied.join(", ") || "none"}; pending: ${status.pending.join(", ") || "none"}.`,
    );
    if (!status.ready) process.exitCode = 1;
  }
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Migration command failed.";
  console.error(message);
  process.exitCode = 1;
} finally {
  await database.close();
}
