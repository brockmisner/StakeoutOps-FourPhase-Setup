import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const auth = vi.hoisted(() => ({
  requireOrganization: vi.fn(),
  requireSchedulerManager: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({
  requireOrganization: auth.requireOrganization,
  requireSchedulerManager: auth.requireSchedulerManager,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

import { PATCH } from "@/app/api/schedules/[id]/route";
import { scheduleUpdateSchema } from "@/app/api/schedules/_shared";

const SCHEDULE_ID = "00000000-0000-4000-8000-000000000301";
const PHONE_ID = "00000000-0000-4000-8000-000000000101";

function patchSchedule(body: unknown) {
  return PATCH(
    new Request(`https://app.test/api/schedules/${SCHEDULE_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SCHEDULE_ID }) },
  );
}

describe("required schedule phone invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.requireSchedulerManager.mockImplementation(() => undefined);
    auth.requireOrganization.mockResolvedValue({
      demo: false as const,
      user: { id: "user-a", email: "owner@example.test" },
      organizationId: "00000000-0000-4000-8000-000000000901",
      role: "owner",
      admin: {},
    });
  });

  it("allows moving a schedule to another valid phone", () => {
    expect(scheduleUpdateSchema.safeParse({ phoneId: PHONE_ID }).success).toBe(true);
  });

  it("does not allow an update to clear the required phone", () => {
    expect(scheduleUpdateSchema.safeParse({ phoneId: null }).success).toBe(false);
  });

  it("rejects a null phone through the PATCH HTTP boundary", async () => {
    const response = await patchSchedule({ phoneId: null });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "No valid schedule changes were supplied.",
      },
    });
  });
});
