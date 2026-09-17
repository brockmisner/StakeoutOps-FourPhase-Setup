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

import { PATCH } from "@/app/api/device-cycles/[id]/route";

const CYCLE_ID = "00000000-0000-4000-8000-000000000301";

function request(status: string) {
  return new Request(`https://app.test/api/device-cycles/${CYCLE_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

function call(status: string) {
  return PATCH(request(status), { params: Promise.resolve({ id: CYCLE_ID }) });
}

describe("device cycle controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.requireSchedulerManager.mockImplementation(() => undefined);
  });

  it.each(["active", "paused", "cancelled"] as const)(
    "tenant-scopes the %s transition through the atomic database function",
    async (status) => {
      const rpc = vi.fn().mockResolvedValue({
        data: { cycleId: CYCLE_ID, status, cancellationRequested: 0 },
        error: null,
      });
      auth.requireOrganization.mockResolvedValue({
        demo: false,
        user: { id: "user-a" },
        organizationId: "org-a",
        role: "owner",
        admin: { rpc },
      });

      const response = await call(status);

      expect(response.status).toBe(200);
      expect(rpc).toHaveBeenCalledWith("set_device_cycle_operating_status", {
        p_organization_id: "org-a",
        p_cycle_id: CYCLE_ID,
        p_status: status,
      });
      await expect(response.json()).resolves.toMatchObject({
        data: { cycleId: CYCLE_ID, status },
      });
      expect(nextServer.after).toHaveBeenCalledTimes(status === "cancelled" ? 1 : 0);
    },
  );

  it("rejects unsupported transitions before touching the database", async () => {
    const rpc = vi.fn();
    auth.requireOrganization.mockResolvedValue({
      demo: false,
      user: { id: "user-a" },
      organizationId: "org-a",
      role: "owner",
      admin: { rpc },
    });

    const response = await call("completed");

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps cycle, schedules, and cancellation requests in one transaction", () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/20260905220000_device_cycle_controls.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("for update");
    expect(migration).toContain("set enabled = false");
    expect(migration).toContain("device_cycle_id = p_cycle_id");
    expect(migration).toContain("cancellation_requested = true");
    expect(migration).toContain("organization_id = p_organization_id");
  });
});
