import { expect, test } from "bun:test";
import {
  assertTestBackendRuntime,
  assertTestDatabaseUrl,
  getOptionalIntegrationTestEnvironment,
  requireTestAttachmentStorageDirectory,
  requireTestDatabase,
} from "../src/testing/test-environment";

const testUrl = "postgresql://tester:secret@localhost:5432/pb_messenger_test";

test("accepts a clearly named dedicated test database", () => {
  expect(assertTestDatabaseUrl(testUrl).databaseName).toBe("pb_messenger_test");
});

test("rejects development and production-like database names", () => {
  expect(() =>
    assertTestDatabaseUrl("postgresql://localhost/pb_messenger"),
  ).toThrow("must end in _test or -test");
  expect(() =>
    assertTestDatabaseUrl("postgresql://localhost/pb_production_test"),
  ).toThrow("Production-like database names are forbidden");
});

test("rejects missing and malformed TEST_DATABASE_URL", () => {
  expect(() => requireTestDatabase({})).toThrow(
    "TEST_DATABASE_URL is required",
  );
  expect(() => assertTestDatabaseUrl("not-a-database-url")).toThrow(
    "not a valid PostgreSQL URL",
  );
});

test("does not expose credentials in safety errors", () => {
  const password = "do-not-leak-this-password";
  let message = "";
  try {
    assertTestDatabaseUrl(`postgresql://tester:${password}@localhost/pb_main`);
  } catch (error) {
    message = String(error);
  }
  expect(message).not.toContain(password);
  expect(message).not.toContain("tester:");
});

test("never falls back from TEST_DATABASE_URL to DATABASE_URL", () => {
  expect(() =>
    requireTestDatabase({
      DATABASE_URL: testUrl,
      TEST_DATABASE_URL: undefined,
    }),
  ).toThrow("TEST_DATABASE_URL is required");
});

test("blocks cleanup setup before a destructive callback can execute", () => {
  let destructiveCallExecuted = false;
  const cleanup = (environment: Record<string, string | undefined>) => {
    requireTestDatabase(environment);
    destructiveCallExecuted = true;
  };
  expect(() => cleanup({ DATABASE_URL: testUrl })).toThrow();
  expect(destructiveCallExecuted).toBe(false);
});

test("integration configuration requires the dedicated database and port", () => {
  expect(() =>
    getOptionalIntegrationTestEnvironment({
      CHAT_TEST_API_URL: "http://localhost:3101",
      TEST_BACKEND_PORT: "3101",
      PORT: "3001",
    }),
  ).toThrow("TEST_DATABASE_URL is required");

  const result = getOptionalIntegrationTestEnvironment({
    CHAT_TEST_API_URL: "http://localhost:3101",
    TEST_DATABASE_URL: testUrl,
    TEST_BACKEND_PORT: "3101",
    PORT: "3001",
  });
  expect(result?.databaseUrl).toBe(testUrl);
  expect(result?.port).toBe(3101);
});

test("test backend runtime cannot use another database server", () => {
  expect(() =>
    assertTestBackendRuntime({
      TEST_DATABASE_URL: testUrl,
      DATABASE_URL: "postgresql://tester:secret@other-host/pb_messenger_test",
      TEST_BACKEND_PORT: "3101",
      PORT: "3101",
    }),
  ).toThrow("does not match TEST_DATABASE_URL");

  expect(
    assertTestBackendRuntime({
      TEST_DATABASE_URL: testUrl,
      DATABASE_URL: `${testUrl}?options=-c%20search_path%3Disolated_schema`,
      TEST_BACKEND_PORT: "3101",
      PORT: "3101",
    }).databaseName,
  ).toBe("pb_messenger_test");
});

test("test attachment storage cannot reuse development storage", () => {
  expect(() =>
    requireTestAttachmentStorageDirectory({
      ATTACHMENT_STORAGE_DIR: "storage/attachments",
      TEST_ATTACHMENT_STORAGE_DIR: "storage/attachments",
    }),
  ).toThrow("must differ from development attachment storage");
  expect(
    requireTestAttachmentStorageDirectory({
      ATTACHMENT_STORAGE_DIR: "storage/attachments",
      TEST_ATTACHMENT_STORAGE_DIR: "storage/test-attachments",
    }),
  ).toContain("test-attachments");
});
