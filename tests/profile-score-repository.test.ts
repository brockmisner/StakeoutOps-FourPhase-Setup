import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SupabaseSchedulerRepository } from "@/lib/scheduler/repository";

describe("profile score repository contract", () => {
  it.each([
    [true, true],
    [false, false],
  ])(
    "delegates successful-run idempotency to credit_profile_run (%s)",
    async (databaseResult, expected) => {
      const rpc = vi.fn(async () => ({ data: databaseResult, error: null }));
      const repository = new SupabaseSchedulerRepository({ rpc } as never);

      await expect(
        repository.creditProfileRun("run-1", "worker-1"),
      ).resolves.toBe(expected);
      expect(rpc).toHaveBeenCalledWith("credit_profile_run", {
        p_run_id: "run-1",
        p_worker_id: "worker-1",
      });
    },
  );

  it("runs bounded missing-credit reconciliation through the service RPC", async () => {
    const rpc = vi.fn(async () => ({ data: 7, error: null }));
    const repository = new SupabaseSchedulerRepository({ rpc } as never);

    await expect(repository.reconcileProfileScoreCredits(100)).resolves.toBe(7);
    expect(rpc).toHaveBeenCalledWith("reconcile_profile_score_credits", {
      p_limit: 100,
    });
  });
});
