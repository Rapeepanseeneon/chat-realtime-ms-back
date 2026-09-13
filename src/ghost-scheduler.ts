import { releaseDueGhosts, type PrivateMessage } from "./database";

// Durable schedules live in PostgreSQL. Poll overdue rows on startup too, so
// downtime delays delivery but does not lose the schedule. No browser timers.
export const startGhostScheduler = (
  publish: (message: PrivateMessage) => Promise<void>,
) => {
  const runtime = globalThis as typeof globalThis & {
    pbGhostTimer?: ReturnType<typeof setInterval>;
  };
  if (runtime.pbGhostTimer) clearInterval(runtime.pbGhostTimer);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const released = await releaseDueGhosts();
      for (const message of released) await publish(message);
    } catch (error) {
      console.error("Failed to release scheduled ghosts", error);
    } finally {
      running = false;
    }
  };
  runtime.pbGhostTimer = setInterval(() => void tick(), 1000);
  void tick();
  return () => {
    clearInterval(runtime.pbGhostTimer);
    runtime.pbGhostTimer = undefined;
  };
};
