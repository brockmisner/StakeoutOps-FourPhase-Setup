import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";

import { createSupabaseSchedulerRuntime, refreshStaleSubscriptionCapacities } from "@/lib/scheduler/runtime";
import { runSchedulerTick } from "@/lib/scheduler/worker";
import { readWorkerConfig } from "./config";
import { createWorkerState, runWorkerLoop, workerHealth } from "./loop";

function log(event: string, details: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`);
}

async function main() {
  const config = readWorkerConfig(process.env);
  const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      }),
    },
  });
  const workerId = `railway_${randomUUID()}`;
  const state = createWorkerState();
  const controller = new AbortController();
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (request.url !== "/health" || request.method !== "GET") {
      response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const health = workerHealth(state, config.staleAfterMs);
    response.writeHead(health.ready ? 200 : 503).end(JSON.stringify(health));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", resolve);
  });
  log("worker_started", { intervalMs: config.intervalMs, port: config.port });

  let shutdownTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    state.stopping = true;
    controller.abort();
    log("worker_stopping");
    // Finish the current tick before exit. If the platform cuts its draining
    // window short, the existing database leases and reconciliation recover it.
    shutdownTimer = setTimeout(() => process.exit(1), 240_000);
    shutdownTimer.unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const watchdog = setInterval(() => {
    if (!state.stopping && workerHealth(state, config.staleAfterMs).stale) {
      log("worker_stalled");
      process.exit(1);
    }
  }, 10_000);
  watchdog.unref();

  try {
    await runWorkerLoop({
      state,
      signal: controller.signal,
      intervalMs: config.intervalMs,
      onFailure: (mode) => log("tick_failed", { mode, consecutiveFailures: state.consecutiveFailures }),
      tick: async (mode) => {
        const capacity = await refreshStaleSubscriptionCapacities(supabase);
        const summary = await runSchedulerTick({
          ...createSupabaseSchedulerRuntime(supabase), workerId, mode,
          limit: mode === "minute" ? config.batchSize : config.horizonBatchSize,
          horizonHours: 26,
          lookaheadMinutes: config.lookaheadMinutes,
          maxRuntimeMs: config.maxRuntimeMs,
        });
        // No credential, URL, upstream error, profile, or task payload in logs.
        log("tick_completed", {
          mode, claimed: summary.claimed, processed: summary.processed,
          dispatched: summary.dispatched, succeeded: summary.succeeded,
          failed: summary.failed, deferred: summary.deferred,
          poweredOff: summary.powerOff.poweredOff,
          schedulerErrors: summary.errors.length,
          capacityRefreshFailures: capacity.failed,
        });
      },
    });
  } finally {
    clearInterval(watchdog);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log("worker_stopped");
  }
}

main().catch(() => {
  // Configuration errors can contain secrets; print their names, never values.
  log("worker_startup_failed", { check: "database credentials, encryption key, worker settings, and port" });
  process.exitCode = 1;
});
