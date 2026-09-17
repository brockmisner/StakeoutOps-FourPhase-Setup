import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const auth = vi.hoisted(() => ({
  requireOrganization: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({
  requireOrganization: auth.requireOrganization,
}));

import { GET } from "@/app/api/device-profiles/route";
import { ApiError } from "@/lib/auth/errors";

type FixtureRow = Record<string, unknown>;
type QueryResult = { data: FixtureRow[]; error: null };

type QueryTrace = {
  table: string;
  eq: ReturnType<typeof vi.fn>;
};

function serviceRoleAdmin(
  fixtures: Record<string, FixtureRow[]>,
  appScores: FixtureRow[] = [],
  phaseGates: FixtureRow[] = [],
) {
  const traces: QueryTrace[] = [];
  const from = vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    let limit: number | null = null;

    const materialize = (): QueryResult => {
      let rows = [...(fixtures[table] ?? [])].filter((row) =>
        filters.every(([column, value]) => row[column] === value),
      );
      if (limit !== null) rows = rows.slice(0, limit);
      return { data: rows, error: null };
    };

    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn((value: number) => {
        limit = value;
        return query;
      }),
      then: <TResult1 = QueryResult, TResult2 = never>(
        onfulfilled?:
          | ((value: QueryResult) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null,
      ): Promise<TResult1 | TResult2> =>
        Promise.resolve(materialize()).then(onfulfilled, onrejected),
    };

    traces.push({ table, eq: query.eq });
    return query;
  });
  const rpc = vi.fn(async (name: string) => ({ data: name === "get_device_cycle_phase_gates" ? phaseGates : appScores, error: null }));
  return { from, rpc, traces };
}

function liveContext(admin: ReturnType<typeof serviceRoleAdmin>) {
  return {
    demo: false as const,
    user: { id: "user-1", email: "owner@example.test" },
    organizationId: "org-a",
    role: "owner",
    admin,
  };
}

describe("profile readiness API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T16:00:00.000Z"));
  });

  it("requires an authenticated organization", async () => {
    auth.requireOrganization.mockRejectedValueOnce(
      new ApiError(401, "UNAUTHORIZED", "Sign in to continue."),
    );

    const response = await GET(
      new Request("https://app.test/api/device-profiles"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED", message: "Sign in to continue." },
    });
  });

  it("returns a complete demo readiness contract", async () => {
    auth.requireOrganization.mockResolvedValue({
      demo: true,
      user: { id: "demo-user", email: "preview@stakeout.local" },
      organizationId: "demo-workspace",
      role: "owner",
      admin: null,
    });

    const response = await GET(
      new Request("https://app.test/api/device-profiles"),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.data.summary).toEqual({
      total: 2,
      new: 0,
      warming: 1,
      ready: 1,
      completed: 0,
      needsAttention: 0,
    });
    expect(payload.data.profiles[0]).toMatchObject({
      id: "demo-profile-1",
      state: "ready",
      score: 402,
      readyScore: 360,
      completionScore: 927,
      currentDay: 12,
      appScores: expect.arrayContaining([
        { app: "chrome", score: 160, possible: 420 },
      ]),
    });
  });

  it("scopes every service-role lookup and the score aggregate to the tenant", async () => {
    const profileBase = {
      phone_id: "phone-a",
      device_cycle_id: "cycle-a",
      label: "Lakeland profile A",
      state: "warming",
      started_on: "2026-09-01",
      duration_days: 30,
      timezone: "America/New_York",
      earned_points: "338",
      possible_points: "1030",
      ready_day: 10,
      ready_score_threshold: "360",
      completion_score_threshold: "927",
      successful_days: "10",
      last_success_at: "2026-09-12T15:30:00.000Z",
      ready_at: null,
      completed_at: null,
      retired_at: null,
      status_reason: null,
      created_at: "2026-09-01T00:00:00.000Z",
    };
    const admin = serviceRoleAdmin(
      {
        device_profiles: [
          {
            ...profileBase,
            id: "profile-a",
            organization_id: "org-a",
            client_id: "client-a",
          },
          {
            ...profileBase,
            id: "profile-stale",
            organization_id: "org-a",
            client_id: "client-a",
            phone_id: "phone-stale",
            device_cycle_id: "cycle-stale",
            label: "Lakeland stale profile",
            state: "ready",
            last_success_at: "2026-09-09T12:00:00.000Z",
            ready_at: "2026-09-09T12:00:00.000Z",
            status_reason: "Ready threshold and activity gates reached.",
          },
          {
            ...profileBase,
            id: "profile-b",
            organization_id: "org-b",
            client_id: "client-b",
          },
        ],
        clients: [
          { id: "client-a", organization_id: "org-a", name: "Client A" },
          { id: "client-b", organization_id: "org-b", name: "Client B" },
        ],
        duo_phones: [
          { id: "phone-a", organization_id: "org-a", name: "Phone A" },
          {
            id: "phone-stale",
            organization_id: "org-a",
            name: "Phone Stale",
          },
        ],
        device_cycles: [
          {
            id: "cycle-a",
            organization_id: "org-a",
            name: "Cycle A",
            program_id: "program-a",
            status: "blocked",
            last_error: "Two required runs failed.",
          },
          {
            id: "cycle-stale",
            organization_id: "org-a",
            name: "Cycle Stale",
            program_id: "program-a",
            status: "active",
            last_error: null,
          },
        ],
        cycle_programs: [
          { id: "program-a", organization_id: "org-a", name: "Program A" },
        ],
      },
      [
        {
          profile_id: "profile-a",
          app_kind: "maps",
          earned_points: "93",
          possible_points: "295",
        },
        {
          profile_id: "profile-a",
          app_kind: "chrome",
          earned_points: "140",
          possible_points: "420",
        },
      ],
    );
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await GET(
      new Request("https://app.test/api/device-profiles"),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.data.profiles).toHaveLength(2);
    expect(payload.data.profiles[0]).toMatchObject({
      id: "profile-a",
      clientName: "Client A",
      phoneName: "Phone A",
      cycleName: "Cycle A",
      programId: "program-a",
      programName: "Program A",
      state: "needs_attention",
      currentDay: 12,
      score: 338,
      possibleScore: 1030,
      readyScore: 360,
      completionScore: 927,
      successfulDays: 10,
      statusReason: "Two required runs failed.",
      appScores: [
        { app: "chrome", score: 140, possible: 420 },
        { app: "maps", score: 93, possible: 295 },
      ],
    });
    expect(payload.data.profiles[1]).toMatchObject({
      id: "profile-stale",
      state: "needs_attention",
      statusReason:
        "No successful scored activity was recorded in the last 48 hours.",
    });
    expect(payload.data.summary).toEqual({
      total: 2,
      new: 0,
      warming: 0,
      ready: 0,
      completed: 0,
      needsAttention: 2,
    });

    expect(admin.traces.map((trace) => trace.table)).toEqual([
      "device_profiles",
      "clients",
      "duo_phones",
      "device_cycles",
      "cycle_programs",
    ]);
    for (const trace of admin.traces) {
      expect(trace.eq).toHaveBeenCalledWith("organization_id", "org-a");
    }
    expect(admin.rpc).toHaveBeenCalledWith("get_profile_app_scores", {
      p_organization_id: "org-a",
    });
  });

  it("shows phase recovery instead of a stale Ready badge from aggregate points", async () => {
    const phaseGate = {
      allowed: false, status: "recovery_required", blockedPhase: "money",
      missingRequiredRuns: 1, requirements: [], reason: "A required Maps task missed its window.",
    };
    const admin = serviceRoleAdmin({
      device_profiles: [{
        id: "profile-a", organization_id: "org-a", client_id: "client-a", phone_id: "phone-a",
        device_cycle_id: "cycle-a", label: "City profile", state: "ready",
        started_on: "2026-09-01", duration_days: 30, timezone: "America/New_York",
        ready_day: 10, earned_points: 1000, last_success_at: "2026-09-12T15:30:00Z",
      }],
      device_cycles: [{ id: "cycle-a", organization_id: "org-a", program_id: "program-a", status: "active" }],
      cycle_programs: [{ id: "program-a", organization_id: "org-a", name: "Phased", phase_plan: { version: 1 } }],
    }, [], [{ device_cycle_id: "cycle-a", current_phase: "warmup", phase_gate: phaseGate }]);
    auth.requireOrganization.mockResolvedValue(liveContext(admin));
    const response = await GET(new Request("https://app.test/api/device-profiles"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.profiles[0]).toMatchObject({
      state: "needs_attention", currentPhase: "warmup", phaseGate, statusReason: phaseGate.reason,
    });
    expect(payload.data.summary).toMatchObject({ ready: 0, needsAttention: 1 });
    expect(admin.rpc).toHaveBeenCalledWith("get_device_cycle_phase_gates", { p_organization_id: "org-a" });
  });
});
