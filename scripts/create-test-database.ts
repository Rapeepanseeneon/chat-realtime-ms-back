import { SQL } from "bun";

const TEST_DATABASE_NAME = "pb_messenger_test";
const ADMIN_DATABASE_NAME = "postgres";

const developmentUrlValue = Bun.env.DATABASE_URL?.trim();
if (!developmentUrlValue) {
  throw new Error("DATABASE_URL is required in the backend environment.");
}

let developmentUrl: URL;
try {
  developmentUrl = new URL(developmentUrlValue);
} catch {
  throw new Error("DATABASE_URL is not a valid PostgreSQL URL.");
}

if (
  developmentUrl.protocol !== "postgres:" &&
  developmentUrl.protocol !== "postgresql:"
) {
  throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
}

const developmentDatabase = decodeURIComponent(
  developmentUrl.pathname.replace(/^\//, ""),
);
if (developmentDatabase !== "pp_realtimechat") {
  throw new Error(
    "Safety check failed: DATABASE_URL does not identify pp_realtimechat.",
  );
}

const adminUrl = new URL(developmentUrl.toString());
adminUrl.pathname = `/${ADMIN_DATABASE_NAME}`;
const admin = new SQL(adminUrl.toString(), { max: 1 });

try {
  const existing = await admin<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM pg_database WHERE datname = ${TEST_DATABASE_NAME}
    ) AS exists
  `;

  if (existing[0]?.exists) {
    console.info(
      `Test database ${TEST_DATABASE_NAME} already exists; no changes made.`,
    );
  } else {
    // PostgreSQL does not allow CREATE DATABASE inside a transaction or accept
    // a parameter for its identifier. The identifier is a fixed source-code
    // constant above and never comes from user input or the environment.
    await admin.unsafe('CREATE DATABASE "pb_messenger_test"');
    console.info(`Test database ${TEST_DATABASE_NAME} created successfully.`);
  }
} catch (error) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "42P04"
  ) {
    console.info(
      `Test database ${TEST_DATABASE_NAME} already exists; no changes made.`,
    );
  } else {
    // Do not print the driver error: connection errors may contain sensitive
    // connection details. Exit with a generic message instead.
    console.error(
      `Could not create ${TEST_DATABASE_NAME}. No development database changes were attempted.`,
    );
    process.exitCode = 1;
  }
} finally {
  try {
    await admin.close();
  } catch {
    console.error(
      "Could not close the one-time PostgreSQL setup connection cleanly.",
    );
    process.exitCode = 1;
  }
}
