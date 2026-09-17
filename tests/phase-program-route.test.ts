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
vi.mock("@/lib/auth/duoplus", () => ({ getDefaultDuoConnection: vi.fn() }));

import { POST } from "@/app/api/cycle-programs/route";
import { buildPhaseTaskSlots, defaultPhasePlan } from "@/lib/scheduler/phase-plan";
import { getDefaultDuoConnection } from "@/lib/auth/duoplus";

function programDatabase() {
  let saved: Record<string, unknown> | null = null;
  const rows = (table: string) => {
    if (table === "duo_templates") return [{
      id: "00000000-0000-4000-8000-000000000301", name: "Generic app task",
      duoplus_template_id: "generic", template_type: 1, enabled: true,
    }];
    if (table === "cycle_programs" && saved) return [{
      id: "program-a", connection_id: "connection-a", name: saved.p_name,
      duration_days: saved.p_duration_days, phase_plan: saved.p_phase_plan,
      ready_day: saved.p_ready_day, timezone: saved.p_timezone,
    }];
    if (table === "cycle_program_rules" && saved) return (saved.p_rules as Array<Record<string, unknown>>).map((rule) => ({
      program_id: "program-a", template_id: rule.templateId, phase_kind: rule.phaseKind,
      rule_kind: rule.ruleKind, start_day: rule.startDay, end_day: rule.endDay,
      app_kind: rule.appKind, local_time: rule.localTime, sequence: rule.sequence,
    }));
    return [];
  };
  return {
    from: (table: string) => {
      const query = {
        select: () => query, eq: () => query, order: () => query, range: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: rows(table), error: null })),
      };
      return query;
    },
    rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => {
      saved = args;
      return { data: "program-a", error: null };
    }),
  };
}

function programInput() {
  return {
    name: "Four-phase city program",
    durationDays: 30,
    timezone: "America/New_York",
    readyDay: 10,
    phasePlan: structuredClone(defaultPhasePlan),
    rules: buildPhaseTaskSlots(defaultPhasePlan).map((slot, index) => ({
      name: `Task ${index + 1}`,
      templateId: "00000000-0000-4000-8000-000000000301",
      ruleKind: slot.ruleKind,
      phaseKind: slot.phaseKind,
      startDay: slot.startDay,
      endDay: slot.endDay,
      localTime: "08:00",
      sequence: index + 1,
      required: true,
      appKind: index === 0 ? "maps" : "chrome",
    })),
  };
}

async function submit(value: unknown) {
  const response = await POST(new Request("https://app.test/api/cycle-programs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  }));
  return { status: response.status, body: await response.json() };
}

describe("four-phase program publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.requireOrganization.mockResolvedValue({
      demo: false, organizationId: "org-a", user: { id: "user-a" }, admin: programDatabase(),
    });
    vi.mocked(getDefaultDuoConnection).mockResolvedValue({ id: "connection-a", status: "active" } as never);
  });

  it("derives all dates from the phase lengths even when client day ranges disagree", async () => {
    const input = programInput();
    input.phasePlan.warmupDays = 14;
    input.phasePlan.moneyDays = 5;
    input.phasePlan.finalSqueezeDays = 3;
    input.phasePlan.afterActionDays = 14;
    input.rules = input.rules.map((rule) => ({ ...rule, startDay: 1, endDay: 1 }));
    const response = await submit(input);
    expect(response.status).toBe(201);
    const result = response.body.data.program;
    expect(result.durationDays).toBe(36);
    expect(result.readyDay).toBe(14);
    expect(result.rules.filter((rule: { phaseKind: string }) => rule.phaseKind === "money"))
      .toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ startDay: 15, endDay: 19, ruleKind: "daily_range" })));
    expect(result.rules.find((rule: { phaseKind: string }) => rule.phaseKind === "after_action"))
      .toMatchObject({ startDay: 23, endDay: 36 });
  });

  it("ends baseline at warmup when continuing daily tasks is disabled", async () => {
    const input = programInput();
    input.phasePlan.continueDailyTasks = false;
    const response = await submit(input);
    expect(response.status).toBe(201);
    expect(response.body.data.program.rules[0]).toMatchObject({ phaseKind: "baseline", startDay: 1, endDay: 10 });
  });

  it("rejects a program that cannot fulfill the required task counts", async () => {
    const input = programInput();
    input.rules = input.rules.filter((rule) => rule.phaseKind !== "money");
    const response = await submit(input);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_PHASE_TASK_COUNTS");
  });

  it("rejects an app target that cannot be reached during warmup", async () => {
    const input = programInput();
    input.phasePlan.appRequirements = [{ appKind: "maps", minSuccessfulRuns: 11, minActiveDays: 10 }];
    const response = await submit(input);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("UNREACHABLE_APP_REQUIREMENT");
  });

  it("prevents required phase completion from being bypassed by making every task optional", async () => {
    const input = programInput();
    input.rules = input.rules.map((rule) => ({ ...rule, required: false }));
    const response = await submit(input);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_PHASE_TASK_COUNTS");
  });

  it("accepts an achievable app target without treating other apps as substitutes", async () => {
    const input = programInput();
    input.phasePlan.appRequirements = [{ appKind: "maps", minSuccessfulRuns: 10, minActiveDays: 10 }];
    const response = await submit(input);
    expect(response.status).toBe(201);
    expect(response.body.data.program.phasePlan.appRequirements).toEqual(input.phasePlan.appRequirements);
  });

  it("rejects phase-tagged tasks without a phase plan", async () => {
    const input = programInput();
    const response = await submit({ ...input, phasePlan: null });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("PHASE_PLAN_REQUIRED");
  });
});
