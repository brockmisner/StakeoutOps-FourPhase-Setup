import { afterEach, describe, expect, it, vi } from "vitest";

import { readWorkerConfig } from "../src/worker/config";
import { createWorkerState, horizonWindow, runWorkerLoop, workerHealth } from "../src/worker/loop";

afterEach(() => vi.useRealTimers());

describe("persistent worker scheduling", () => {
  it("finishes an in-flight tick and skips the horizon when shutdown arrives", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let release!: () => void;
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const state = createWorkerState();
    const pending = runWorkerLoop({ state, signal: controller.signal, intervalMs: 5_000, tick });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(state.running).toBe("minute");
    controller.abort();
    release();
    await pending;
    expect(tick).toHaveBeenCalledTimes(1);
    expect(state.stopping).toBe(true);
  });

  it("fills one horizon per UTC window and runs minute ticks between windows", async () => {
    const controller = new AbortController();
    let time = Date.parse("2026-09-15T04:59:00Z");
    const state = createWorkerState(time);
    const modes: string[] = [];
    let cycles = 0;
    await runWorkerLoop({
      state, signal: controller.signal, intervalMs: 30_000,
      now: () => time,
      tick: async (mode) => { modes.push(mode); },
      wait: async () => {
        time += 30_000;
        if (++cycles === 3) controller.abort();
      },
    });
    expect(modes).toEqual(["minute", "horizon", "minute", "minute", "horizon"]);
    expect(horizonWindow(Date.parse("2026-09-15T05:00:00Z"))).toBe("2026-09-15");
    expect(state.completedTicks).toBe(5);
  });

  it("backs off database failures without marking them as successful", async () => {
    const controller = new AbortController();
    const state = createWorkerState(0);
    const waits: number[] = [];
    const failed = vi.fn();
    await runWorkerLoop({
      state, signal: controller.signal, intervalMs: 30_000,
      now: () => 1_000,
      onFailure: failed,
      tick: async () => { throw new Error("private upstream message"); },
      wait: async (ms) => {
        waits.push(ms);
        if (waits.length === 3) controller.abort();
      },
    });
    expect(waits).toEqual([60_000, 120_000, 120_000]);
    expect(state.lastSuccessAt).toBeNull();
    expect(state.completedTicks).toBe(0);
    expect(failed.mock.calls).toEqual([["minute"], ["minute"], ["minute"]]);
  });

  it("retries an unsuccessful horizon and clears failures after recovery", async () => {
    const controller = new AbortController();
    const state = createWorkerState();
    let horizons = 0;
    let cycles = 0;
    await runWorkerLoop({
      state, signal: controller.signal, intervalMs: 30_000,
      tick: async (mode) => {
        if (mode === "horizon" && ++horizons === 1) throw new Error("database unavailable");
      },
      wait: async () => {
        if (++cycles === 2) controller.abort();
      },
    });
    expect(horizons).toBe(2);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.completedTicks).toBe(3);
  });

  it("interrupts a long retry wait promptly on shutdown", async () => {
    const controller = new AbortController();
    const state = createWorkerState();
    const tick = vi.fn(async () => undefined);
    const pending = runWorkerLoop({ state, signal: controller.signal, intervalMs: 60_000, tick });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await pending;
    expect(tick).toHaveBeenCalledTimes(2);
    expect(state.stopping).toBe(true);
  });
});

describe("worker readiness", () => {
  it("requires database progress and fails after stale progress or repeated failures", () => {
    const state = createWorkerState(0);
    expect(workerHealth(state, 300_000, 1).ready).toBe(false);
    state.lastSuccessAt = 1_000;
    expect(workerHealth(state, 300_000, 2_000).ready).toBe(true);
    expect(workerHealth(state, 300_000, 301_000).ready).toBe(false);
    state.consecutiveFailures = 3;
    expect(workerHealth(state, 300_000, 2_000).ready).toBe(false);
    state.consecutiveFailures = 0;
    state.stopping = true;
    expect(workerHealth(state, 300_000, 2_000).ready).toBe(false);
  });
});

describe("worker configuration", () => {
  const env = {
    SUPABASE_URL: "https://scheduler.supabase.co",
    SUPABASE_SECRET_KEY: "test-secret",
    INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };
  it("accepts real-mode configuration without requiring browser keys", () => {
    expect(readWorkerConfig(env).intervalMs).toBe(30_000);
    expect(readWorkerConfig(env).batchSize).toBe(20);
  });
  it("rejects demo mode, mismatched databases, invalid encryption, and invalid timing", () => {
    expect(() => readWorkerConfig({ ...env, NEXT_PUBLIC_DEMO_MODE: "true" })).toThrow(/demo/);
    expect(() => readWorkerConfig({ ...env, NEXT_PUBLIC_SUPABASE_URL: "https://other.supabase.co" })).toThrow(/match/);
    expect(() => readWorkerConfig({ ...env, INTEGRATION_ENCRYPTION_KEY: `${env.INTEGRATION_ENCRYPTION_KEY} ` })).toThrow(/32-byte/);
    expect(() => readWorkerConfig({ ...env, WORKER_INTERVAL_MS: "0" })).toThrow(/integer/);
    expect(() => readWorkerConfig({ ...env, SUPABASE_SECRET_KEY: "" })).toThrow(/required/);
  });
  it("rejects remote plaintext credentials and credentials embedded in URLs", () => {
    expect(() => readWorkerConfig({ ...env, SUPABASE_URL: "http://remote.example" })).toThrow(/HTTPS/);
    expect(() => readWorkerConfig({ ...env, SUPABASE_URL: "https://user:private@example.com" })).toThrow(/HTTPS/);
    expect(() => readWorkerConfig({ ...env, SUPABASE_URL: "https://example.com/?token=private" })).toThrow(/HTTPS/);
    expect(readWorkerConfig({ ...env, SUPABASE_URL: "http://127.0.0.1:54321" }).supabaseUrl).toBe("http://127.0.0.1:54321");
  });
});
