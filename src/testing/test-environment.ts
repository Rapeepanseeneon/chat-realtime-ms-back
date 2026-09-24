import { basename, isAbsolute, normalize, relative, resolve } from "node:path";

const TEST_DATABASE_NAME = /(?:_test|-test)$/i;
const PRODUCTION_DATABASE_NAME =
  /(?:^|[_-])(?:prod|production|live)(?:$|[_-])/i;

type Environment = Record<string, string | undefined>;

export type TestDatabaseIdentity = {
  connectionIdentity: string;
  databaseName: string;
  url: string;
};

const safeError = (message: string) =>
  new Error(`Test database safety guard: ${message}`);

export const assertTestDatabaseUrl = (
  value: string | undefined,
): TestDatabaseIdentity => {
  if (!value?.trim()) throw safeError("TEST_DATABASE_URL is required.");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw safeError("TEST_DATABASE_URL is not a valid PostgreSQL URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw safeError("TEST_DATABASE_URL must use postgres:// or postgresql://.");
  }

  let databaseName = "";
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw safeError("TEST_DATABASE_URL has an invalid database name.");
  }
  if (!databaseName || databaseName.includes("/")) {
    throw safeError("TEST_DATABASE_URL must name one dedicated database.");
  }
  if (PRODUCTION_DATABASE_NAME.test(databaseName)) {
    throw safeError("Production-like database names are forbidden.");
  }
  if (!TEST_DATABASE_NAME.test(databaseName)) {
    throw safeError("The database name must end in _test or -test.");
  }

  return {
    connectionIdentity: `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}/${parsed.username}/${databaseName}`,
    databaseName,
    url: value.trim(),
  };
};

export const requireTestDatabase = (
  environment: Environment = Bun.env,
): TestDatabaseIdentity => assertTestDatabaseUrl(environment.TEST_DATABASE_URL);

const parsePort = (value: string | undefined, name: string) => {
  if (!value?.trim()) throw safeError(`${name} is required.`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw safeError(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
};

export const requireTestBackendPort = (environment: Environment = Bun.env) => {
  const testPort = parsePort(
    environment.TEST_BACKEND_PORT,
    "TEST_BACKEND_PORT",
  );
  const developmentPort = parsePort(
    environment.DEVELOPMENT_BACKEND_PORT ?? "3001",
    "DEVELOPMENT_BACKEND_PORT",
  );
  if (testPort === developmentPort) {
    throw safeError("TEST_BACKEND_PORT must differ from the development PORT.");
  }
  return testPort;
};

export const requireTestAttachmentStorageDirectory = (
  environment: Environment = Bun.env,
) => {
  const testDirectory =
    environment.TEST_ATTACHMENT_STORAGE_DIR?.trim() ||
    "storage/test-attachments";
  const developmentDirectory =
    environment.ATTACHMENT_STORAGE_DIR?.trim() || "storage/attachments";
  if (isAbsolute(testDirectory)) {
    throw safeError("TEST_ATTACHMENT_STORAGE_DIR must be workspace-relative.");
  }
  const resolvedTestDirectory = resolve(testDirectory);
  const relativeToWorkspace = relative(process.cwd(), resolvedTestDirectory);
  if (relativeToWorkspace.startsWith("..") || isAbsolute(relativeToWorkspace)) {
    throw safeError(
      "TEST_ATTACHMENT_STORAGE_DIR must stay inside the workspace.",
    );
  }
  if (resolvedTestDirectory === resolve(developmentDirectory)) {
    throw safeError(
      "TEST_ATTACHMENT_STORAGE_DIR must differ from development attachment storage.",
    );
  }
  if (!basename(resolvedTestDirectory).toLowerCase().includes("test")) {
    throw safeError(
      "TEST_ATTACHMENT_STORAGE_DIR must have a clearly test-specific directory name.",
    );
  }
  return normalize(testDirectory);
};

export type IntegrationTestEnvironment = {
  apiUrl: string;
  databaseName: string;
  databaseUrl: string;
  port: number;
};

export const getOptionalIntegrationTestEnvironment = (
  environment: Environment = Bun.env,
): IntegrationTestEnvironment | null => {
  const apiValue = environment.CHAT_TEST_API_URL?.trim();
  if (!apiValue) return null;

  const database = requireTestDatabase(environment);
  const port = requireTestBackendPort(environment);
  let api: URL;
  try {
    api = new URL(apiValue);
  } catch {
    throw safeError("CHAT_TEST_API_URL is not a valid URL.");
  }
  if (api.protocol !== "http:" && api.protocol !== "https:") {
    throw safeError("CHAT_TEST_API_URL must use http:// or https://.");
  }
  const apiPort = Number(api.port || (api.protocol === "https:" ? 443 : 80));
  if (apiPort !== port) {
    throw safeError("CHAT_TEST_API_URL must use TEST_BACKEND_PORT.");
  }

  return {
    apiUrl: apiValue.replace(/\/$/, ""),
    databaseName: database.databaseName,
    databaseUrl: database.url,
    port,
  };
};

export const assertTestBackendRuntime = (
  environment: Environment = Bun.env,
) => {
  const database = requireTestDatabase(environment);
  const runtimeDatabase = assertTestDatabaseUrl(environment.DATABASE_URL);
  if (runtimeDatabase.connectionIdentity !== database.connectionIdentity) {
    throw safeError(
      "The test backend DATABASE_URL does not match TEST_DATABASE_URL.",
    );
  }
  const port = requireTestBackendPort(environment);
  if (Number(environment.PORT) !== port) {
    throw safeError("The test backend PORT does not match TEST_BACKEND_PORT.");
  }
  return database;
};

export const verifyTestBackend = async (
  environment: IntegrationTestEnvironment,
) => {
  let response: Response;
  try {
    response = await fetch(`${environment.apiUrl}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    throw safeError("The dedicated test backend is not reachable.");
  }
  if (!response.ok || response.headers.get("x-pb-test-backend") !== "1") {
    throw safeError("CHAT_TEST_API_URL is not a verified Pb test backend.");
  }
};
