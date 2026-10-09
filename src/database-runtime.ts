type Environment = Record<string, string | undefined>;

export type DatabaseTimeoutKind =
  "statement_timeout" | "lock_timeout" | "idle_in_transaction_timeout";

export type RuntimeDatabaseSettings = {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
  connectionTimeoutSeconds: number;
  idleTimeoutSeconds: number;
  maxLifetimeSeconds: number;
};

const positiveInteger = (
  environment: Environment,
  name: string,
  fallback: number,
) => {
  const raw = environment[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
};

export const readRuntimeDatabaseSettings = (
  environment: Environment = Bun.env,
): RuntimeDatabaseSettings => {
  const settings = {
    statementTimeoutMs: positiveInteger(
      environment,
      "DATABASE_STATEMENT_TIMEOUT_MS",
      15_000,
    ),
    lockTimeoutMs: positiveInteger(
      environment,
      "DATABASE_LOCK_TIMEOUT_MS",
      3_000,
    ),
    idleInTransactionTimeoutMs: positiveInteger(
      environment,
      "DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS",
      10_000,
    ),
    connectionTimeoutSeconds: positiveInteger(
      environment,
      "DATABASE_CONNECTION_TIMEOUT_SECONDS",
      10,
    ),
    idleTimeoutSeconds: positiveInteger(
      environment,
      "DATABASE_IDLE_CONNECTION_TIMEOUT_SECONDS",
      30,
    ),
    maxLifetimeSeconds: positiveInteger(
      environment,
      "DATABASE_CONNECTION_MAX_LIFETIME_SECONDS",
      3_600,
    ),
  };
  if (settings.lockTimeoutMs >= settings.statementTimeoutMs) {
    throw new Error(
      "DATABASE_LOCK_TIMEOUT_MS must be less than DATABASE_STATEMENT_TIMEOUT_MS",
    );
  }
  return settings;
};

export const runtimeDatabaseOptions = (environment: Environment = Bun.env) => {
  const settings = readRuntimeDatabaseSettings(environment);
  return {
    connection: {
      application_name: "pb-messenger-runtime",
      statement_timeout: `${settings.statementTimeoutMs}ms`,
      lock_timeout: `${settings.lockTimeoutMs}ms`,
      idle_in_transaction_session_timeout: `${settings.idleInTransactionTimeoutMs}ms`,
    },
    connectionTimeout: settings.connectionTimeoutSeconds,
    idleTimeout: settings.idleTimeoutSeconds,
    maxLifetime: settings.maxLifetimeSeconds,
  };
};

const databaseError = (error: unknown) =>
  error && typeof error === "object"
    ? (error as { code?: unknown; message?: unknown })
    : null;

export const getDatabaseTimeoutKind = (
  error: unknown,
): DatabaseTimeoutKind | null => {
  const candidate = databaseError(error);
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const message =
    typeof candidate?.message === "string"
      ? candidate.message.toLowerCase()
      : "";
  if (code === "55P03" || message.includes("lock timeout"))
    return "lock_timeout";
  if (
    code === "25P03" ||
    message.includes("idle-in-transaction") ||
    message.includes("idle in transaction")
  )
    return "idle_in_transaction_timeout";
  if (code === "57014" || message.includes("statement timeout"))
    return "statement_timeout";
  return null;
};

export const databaseErrorCode = (error: unknown) => {
  const code = databaseError(error)?.code;
  return typeof code === "string" &&
    (/^[A-Z0-9]{5}$/.test(code) || /^ERR_POSTGRES_[A-Z0-9_]+$/.test(code))
    ? code
    : "UNKNOWN";
};

export const logOperationalError = (label: string, error: unknown) => {
  const timeout = getDatabaseTimeoutKind(error);
  if (timeout) {
    // Keep timeout diagnostics useful without printing SQL, credentials,
    // session tokens, filesystem paths, or stack traces.
    console.error(label, { kind: timeout, code: databaseErrorCode(error) });
    return;
  }
  const candidate = databaseError(error);
  if (
    candidate &&
    (databaseErrorCode(error) !== "UNKNOWN" ||
      (error as { name?: unknown }).name === "PostgresError")
  ) {
    console.error(label, {
      kind: "database_error",
      code: databaseErrorCode(error),
    });
    return;
  }
  console.error(label, error);
};
