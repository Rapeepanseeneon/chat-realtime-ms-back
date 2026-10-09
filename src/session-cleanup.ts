import type { SQL } from "bun";
import { logOperationalError } from "./database-runtime";

type Environment = Record<string, string | undefined>;

export type SessionCleanupSettings = {
  batchSize: number;
  intervalMs: number;
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

export const readSessionCleanupSettings = (
  environment: Environment = Bun.env,
): SessionCleanupSettings => ({
  batchSize: positiveInteger(environment, "SESSION_CLEANUP_BATCH_SIZE", 200),
  intervalMs: positiveInteger(
    environment,
    "SESSION_CLEANUP_INTERVAL_MS",
    5 * 60 * 1_000,
  ),
});

export const deleteExpiredSessionsBatch = async (
  database: SQL,
  batchSize: number,
) => {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000)
    throw new Error("Session cleanup batch size must be between 1 and 5000");
  const deleted = await database<{ id: string }[]>`
    WITH expired AS (
      SELECT id FROM sessions
      WHERE expires_at <= clock_timestamp()
      ORDER BY expires_at, id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM sessions session
    USING expired
    WHERE session.id = expired.id
    RETURNING session.id::text AS id
  `;
  return deleted.length;
};

export const startSessionCleanup = (
  cleanup: () => Promise<number>,
  settings: SessionCleanupSettings,
) => {
  const runtime = globalThis as typeof globalThis & {
    pbSessionCleanupTimer?: ReturnType<typeof setInterval>;
  };
  if (runtime.pbSessionCleanupTimer)
    clearInterval(runtime.pbSessionCleanupTimer);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const deleted = await cleanup();
      if (deleted > 0)
        console.info(`Expired session cleanup removed ${deleted} row(s).`);
    } catch (error) {
      logOperationalError("Expired session cleanup failed; will retry", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), settings.intervalMs);
  timer.unref();
  runtime.pbSessionCleanupTimer = timer;
  // Exactly one bounded startup batch; later work is paced by the interval.
  void tick();
  return () => {
    clearInterval(timer);
    if (runtime.pbSessionCleanupTimer === timer)
      runtime.pbSessionCleanupTimer = undefined;
  };
};
