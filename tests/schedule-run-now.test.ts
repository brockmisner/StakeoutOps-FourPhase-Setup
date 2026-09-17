import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const auth = vi.hoisted(() => ({
  requireOrganization: vi.fn(),
  requireSchedulerManager: vi.fn(),
}));
const nextServer = vi.hoisted(() => ({ after: vi.fn() }));

vi.mock("@/lib/auth/context", () => ({
  requireOrganization: auth.requireOrganization,
  requireSchedulerManager: auth.requireSchedulerManager,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: nextServer.after,
}));

import { POST } from "@/app/api/schedules/[id]/run-now/route";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000901";
const SCHEDULE_ID = "00000000-0000-4000-8000-000000000301";
const RUN_ID = "00000000-0000-4000-8000-000000000401";

function runNowRequest() {
  return new Request(`https://app.test/api/schedules/${SCHEDULE_ID}/run-now`, {
    method: "POST",
  });
}

function callRunNow() {
  return POST(runNowRequest(), {
    params: Promise.resolve({ id: SCHEDULE_ID }),
  });
}

function liveContext(rpc: ReturnType<typeof vi.fn>) {
  return {
    demo: false as const,
    user: { id: "user-a", email: "owner@example.test" },
    organizationId: ORGANIZATION_ID,
    role: "owner",
    admin: { rpc },
  };
}

function queuedRun() {
  return {
    id: RUN_ID,
    schedule_id: SCHEDULE_ID,
    status: "pending",
    stage: "pending",
    issue_at: "2026-09-06T12:02:00.000Z",
    created_at: "2026-09-06T12:00:00.000Z",
  };
}

describe("schedule Run Now API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.requireSchedulerManager.mockImplementation(() => undefined);
  });

  it("queues through the tenant-scoped atomic database function", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [queuedRun()], error: null });
    auth.requireOrganization.mockResolvedValue(liveContext(rpc));

    const response = await callRunNow();

    expect(response.status).toBe(202);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("enqueue_schedule_run_now", {
      p_organization_id: ORGANIZATION_ID,
      p_schedule_id: SCHEDULE_ID,
      p_run_id: expect.any(String),
      p_scheduled_for: expect.any(String),
      p_issue_at: expect.any(String),
    });
    await expect(response.json()).resolves.toMatchObject({
      data: {
        run: {
          id: RUN_ID,
          scheduleId: SCHEDULE_ID,
          status: "pending",
        },
      },
    });
    expect(nextServer.after).toHaveBeenCalledOnce();
  });

  it("rejects a repeated click even after the first request was accepted", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: [queuedRun()], error: null })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "P4201",
          message: "Schedule already has an unfinished run",
        },
      });
    auth.requireOrganization.mockResolvedValue(liveContext(rpc));

    expect((await callRunNow()).status).toBe(202);
    const duplicateResponse = await callRunNow();

    expect(duplicateResponse.status).toBe(409);
    await expect(duplicateResponse.json()).resolves.toEqual({
      error: {
        code: "SCHEDULE_RUN_IN_PROGRESS",
        message:
          "This schedule already has an unfinished run. Wait for it to finish or cancel it before running again.",
      },
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(nextServer.after).toHaveBeenCalledOnce();
  });

  it("uses one schedule lock and blocks exactly the non-terminal run states", () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/20260906011554_guard_duplicate_schedule_run_now.sql",
      ),
      "utf8",
    );
    const guard = migration.match(/if exists \(([\s\S]*?)\) then/)?.[1] ?? "";

    expect(migration).toContain("for update");
    expect(migration).toContain("errcode = 'P4201'");
    for (const status of [
      "pending",
      "preparing",
      "queued",
      "running",
      "paused",
      "retry_wait",
    ]) {
      expect(guard).toContain(`'${status}'`);
    }
    for (const status of ["succeeded", "failed", "cancelled"]) {
      expect(guard).not.toContain(`'${status}'`);
    }
  });
});
