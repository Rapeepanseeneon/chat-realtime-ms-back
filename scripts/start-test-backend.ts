import {
  requireTestAttachmentStorageDirectory,
  requireTestBackendPort,
  requireTestDatabase,
} from "../src/testing/test-environment";

const database = requireTestDatabase();
const port = requireTestBackendPort();
const attachmentStorageDirectory = requireTestAttachmentStorageDirectory();

Bun.env.DATABASE_URL = database.url;
Bun.env.PORT = String(port);
Bun.env.PB_TEST_BACKEND = "1";
Bun.env.DEV_HTTPS = Bun.env.TEST_BACKEND_HTTPS ?? "false";
Bun.env.COOKIE_SECURE =
  Bun.env.TEST_BACKEND_HTTPS === "true" ? "true" : "false";
Bun.env.ATTACHMENT_STORAGE_DIR = attachmentStorageDirectory;

await import("../src/index");
