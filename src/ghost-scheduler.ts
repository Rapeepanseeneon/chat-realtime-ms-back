import { releaseDueGhosts, publishPendingGhosts } from "./database";

// Durable schedules live in PostgreSQL. Poll overdue rows on startup too, so
// downtime delays delivery but does not lose the schedule. No browser timers.
export const startGhostScheduler = (
  publish: Parameters<typeof publishPendingGhosts>[0],
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
      try {
        await releaseDueGhosts();
      } catch (error) {
        console.error("Failed to release scheduled ghosts; will retry", error);
      }
      // Previously committed releases must retry even when a new release fails.
      await publishPendingGhosts(publish);
    } catch (error) {
      console.error("Failed to release scheduled ghosts", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  runtime.pbGhostTimer = timer;
  void tick();
  return () => {
    clearInterval(timer);
    if (runtime.pbGhostTimer === timer) runtime.pbGhostTimer = undefined;
  };
};
