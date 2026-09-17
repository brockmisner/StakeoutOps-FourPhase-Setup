import { setTimeout as delay } from "node:timers/promises";

export type WorkerMode = "minute" | "horizon";
export interface WorkerState {
  startedAt: number;
  lastSuccessAt: number | null;
  lastStartedAt: number | null;
  lastHorizonWindow: string | null;
  running: WorkerMode | null;
  consecutiveFailures: number;
  completedTicks: number;
  stopping: boolean;
}

export function createWorkerState(now = Date.now()): WorkerState {
  return {
    startedAt: now, lastSuccessAt: null, lastStartedAt: null,
    lastHorizonWindow: null, running: null, consecutiveFailures: 0,
    completedTicks: 0, stopping: false,
  };
}

// The daily window changes at 05:00 UTC. A new process also fills its horizon
// immediately; database uniqueness and leases make restarts safe.
export function horizonWindow(now: number): string {
  return new Date(now - 5 * 60 * 60_000).toISOString().slice(0, 10);
}

export function workerHealth(state: WorkerState, staleAfterMs: number, now = Date.now()) {
  const stale = now - (state.lastSuccessAt ?? state.startedAt) >= staleAfterMs;
  const ready = !state.stopping && state.lastSuccessAt !== null && !stale && state.consecutiveFailures < 3;
  return {
    ready,
    stale,
    status: state.stopping ? "stopping" : ready ? "ready" : "unavailable",
    running: state.running,
    completedTicks: state.completedTicks,
    consecutiveFailures: state.consecutiveFailures,
    lastSuccessfulTickAt: state.lastSuccessAt === null ? null : new Date(state.lastSuccessAt).toISOString(),
  };
}

interface WorkerLoopOptions {
  state: WorkerState;
  signal: AbortSignal;
  intervalMs: number;
  tick: (mode: WorkerMode) => Promise<void>;
  onFailure?: (mode: WorkerMode) => void;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const { state, signal, tick, intervalMs } = options;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  try {
    while (!signal.aborted) {
      const cycleStartedAt = now();
      let mode: WorkerMode = "minute";
      try {
        for (mode of ["minute", "horizon"] as const) {
          if (signal.aborted) break;
          const window = horizonWindow(now());
          if (mode === "horizon" && state.lastHorizonWindow === window) continue;
          state.running = mode;
          state.lastStartedAt = now();
          await tick(mode);
          state.lastSuccessAt = now();
          state.completedTicks += 1;
          if (mode === "horizon") state.lastHorizonWindow = window;
        }
        state.consecutiveFailures = 0;
      } catch {
        state.consecutiveFailures += 1;
        options.onFailure?.(mode);
      } finally {
        state.running = null;
      }
      if (signal.aborted) break;
      const backoff = Math.min(120_000, intervalMs * 2 ** Math.min(state.consecutiveFailures, 4));
      const waitMs = state.consecutiveFailures ? backoff : Math.max(1_000, intervalMs - (now() - cycleStartedAt));
      try {
        await wait(waitMs, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  } finally {
    state.running = null;
    state.stopping = true;
  }
}
