import { describe, expect, it } from "vitest";

import { plannedCycleRunCount } from "@/lib/scheduler/cycles";
import {
  buildPhaseTaskSlots,
  computeAppRequirements,
  defaultPhasePlan,
  phaseForDay,
  phasePlanDuration,
  phasePlanSchema,
  phaseWindowForRule,
  phaseWindows,
} from "@/lib/scheduler/phase-plan";

describe("four-phase cycle plans", () => {
  it("places the default program in consecutive days 1–30", () => {
    expect(phaseWindows(defaultPhasePlan)).toEqual([
      { kind: "warmup", label: "Warmup", startDay: 1, endDay: 10, days: 10 },
      { kind: "money", label: "Money", startDay: 11, endDay: 13, days: 3 },
      { kind: "final_squeeze", label: "Final squeeze", startDay: 14, endDay: 16, days: 3 },
      { kind: "after_action", label: "After action", startDay: 17, endDay: 30, days: 14 },
    ]);
    expect(defaultPhasePlan.appRequirements).toEqual([]);
  });

  it("moves every later phase when warmup is extended", () => {
    const plan = { ...defaultPhasePlan, warmupDays: 14 };
    expect(phaseWindowForRule(plan, "money")).toEqual({ startDay: 15, endDay: 17 });
    expect(phaseWindowForRule(plan, "final_squeeze")).toEqual({ startDay: 18, endDay: 20 });
    expect(phaseWindowForRule(plan, "after_action")).toEqual({ startDay: 21, endDay: 34 });
  });

  it("covers every day exactly once for every allowed combination of durations", () => {
    for (let warmupDays = 10; warmupDays <= 14; warmupDays++) {
      for (let moneyDays = 2; moneyDays <= 5; moneyDays++) {
        for (let finalSqueezeDays = 1; finalSqueezeDays <= 3; finalSqueezeDays++) {
          for (let afterActionDays = 10; afterActionDays <= 14; afterActionDays++) {
            const plan = phasePlanSchema.parse({
              ...defaultPhasePlan, warmupDays, moneyDays, finalSqueezeDays, afterActionDays,
            });
            const duration = phasePlanDuration(plan);
            const days = phaseWindows(plan).flatMap((window) =>
              Array.from({ length: window.days }, (_, index) => window.startDay + index),
            );
            expect(duration).toBeGreaterThanOrEqual(23);
            expect(duration).toBeLessThanOrEqual(36);
            expect(days).toEqual(Array.from({ length: duration }, (_, index) => index + 1));
            for (const window of phaseWindows(plan)) {
              expect(phaseForDay(plan, window.startDay)).toBe(window.kind);
              expect(phaseForDay(plan, window.endDay)).toBe(window.kind);
            }
          }
        }
      }
    }
  });

  it("keeps baseline daily work through the cycle unless the operator stops it after warmup", () => {
    expect(phaseWindowForRule(defaultPhasePlan, "baseline")).toEqual({ startDay: 1, endDay: 30 });
    expect(phaseWindowForRule({ ...defaultPhasePlan, continueDailyTasks: false }, "baseline"))
      .toEqual({ startDay: 1, endDay: 10 });
    expect(phaseWindowForRule(defaultPhasePlan, "warmup")).toEqual({ startDay: 1, endDay: 10 });
  });

  it.each([0, -1, 31, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not report an active phase outside a whole cycle day: %s", (day) => {
      expect(phaseForDay(defaultPhasePlan, day)).toBeNull();
    },
  );

  it.each([
    { warmupDays: 9 }, { warmupDays: 15 }, { moneyDays: 1 }, { moneyDays: 6 },
    { finalSqueezeDays: 0 }, { finalSqueezeDays: 4 }, { afterActionDays: 9 },
    { afterActionDays: 15 }, { warmupDays: 10.5 }, { moneyDays: "3" },
    { version: 2 }, { extraProperty: true },
  ])("rejects invalid plan input %j", (input) => {
    expect(phasePlanSchema.safeParse({ ...defaultPhasePlan, ...input }).success).toBe(false);
  });

  it("requires unique app requirements with at least one positive integer target", () => {
    const requirement = { appKind: "maps", minSuccessfulRuns: 0, minActiveDays: 2 };
    expect(phasePlanSchema.parse({ ...defaultPhasePlan, appRequirements: [requirement] }).appRequirements)
      .toEqual([requirement]);
    for (const appRequirements of [
      [requirement, { ...requirement, appKind: " Maps " }],
      [{ ...requirement, minActiveDays: 0 }],
      [{ ...requirement, minSuccessfulRuns: -1 }],
      [{ ...requirement, minActiveDays: 1.5 }],
      [{ ...requirement, appKind: " " }],
      [{ ...requirement, appKind: "google app" }],
      [{ ...requirement, appKind: "a".repeat(33) }],
      [{ ...requirement, minSuccessfulRuns: 1_801 }],
      [{ ...requirement, minActiveDays: 11 }],
      [{ ...requirement, ignoredTarget: 3 }],
    ]) {
      expect(phasePlanSchema.safeParse({ ...defaultPhasePlan, appRequirements }).success).toBe(false);
    }
  });
});

describe("phase task slots", () => {
  it("compiles the agreed default daily counts to 236 runs per phone and 11,800 for 50 phones", () => {
    const slots = buildPhaseTaskSlots(defaultPhasePlan);
    expect(slots).toHaveLength(19);
    const total = plannedCycleRunCount(slots, phasePlanDuration(defaultPhasePlan));
    expect(total).toBe(236);
    expect(total * 50).toBe(11_800);
    for (const [day, count] of [[1, 5], [11, 9], [14, 11], [17, 9]]) {
      expect(slots.filter((slot) => slot.startDay <= day && slot.endDay >= day)).toHaveLength(count);
    }
    expect(slots.slice(0, 5).map((slot) => slot.appKind)).toEqual(["chrome", "maps", "google", "waze", "gmail"]);
    expect(slots.every((slot) => slot.points === 1 && slot.expectedDurationSeconds === 600)).toBe(true);
  });

  it("removes only the continuing baseline after warmup when disabled", () => {
    const plan = { ...defaultPhasePlan, continueDailyTasks: false };
    const slots = buildPhaseTaskSlots(plan);
    expect(plannedCycleRunCount(slots, phasePlanDuration(plan))).toBe(136);
    expect(slots.filter((slot) => slot.startDay <= 11 && slot.endDay >= 11)).toHaveLength(4);
  });

  it("adds explicitly warmup-only work without making it continue", () => {
    const slots = buildPhaseTaskSlots(defaultPhasePlan, { warmup: 2 });
    expect(plannedCycleRunCount(slots, 30)).toBe(256);
    expect(slots.filter((slot) => slot.phaseKind === "warmup").map((slot) => slot.endDay)).toEqual([10, 10]);
  });

  it("maintains all five default app choices even at the maximum task-rule count", () => {
    const slots = buildPhaseTaskSlots(defaultPhasePlan, { warmup: 31 });
    expect(slots).toHaveLength(50);
    const warmupApps = new Set(slots.filter((slot) => slot.startDay === 1).map((slot) => slot.appKind));
    expect(warmupApps).toEqual(new Set(["chrome", "maps", "google", "waze", "gmail"]));
    expect(slots.every((slot) => /^([01]\d|2[0-3]):[0-5]\d$/.test(slot.localTime))).toBe(true);
    expect(() => buildPhaseTaskSlots(defaultPhasePlan, { warmup: 32 })).toThrow(/at most 50/);
    expect(() => buildPhaseTaskSlots(defaultPhasePlan, { baseline: 100_000 })).toThrow();
  });

  it("preserves task identities when counts and durations change", () => {
    const initial = buildPhaseTaskSlots(defaultPhasePlan);
    const changed = buildPhaseTaskSlots({ ...defaultPhasePlan, warmupDays: 14 }, {
      baseline: 6, money: 3, final_squeeze: 7, after_action: 5,
    });
    expect(new Set(changed.map((slot) => slot.id)).size).toBe(changed.length);
    const identities = initial.filter((slot) => slot.id !== "money-4").map((slot) => slot.id);
    expect(changed.map((slot) => slot.id)).toEqual(expect.arrayContaining(identities));
    expect(changed.find((slot) => slot.id === "money-1")?.startDay).toBe(15);
    expect(changed.every((slot) => /^([01]\d|2[0-3]):[0-5]\d$/.test(slot.localTime))).toBe(true);
  });

  it("supports the 36-day maximum without truncating after action work", () => {
    const plan = { ...defaultPhasePlan, warmupDays: 14, moneyDays: 5 };
    const slots = buildPhaseTaskSlots(plan);
    expect(phasePlanDuration(plan)).toBe(36);
    expect(plannedCycleRunCount(slots, 36)).toBe(274);
    expect(slots.filter((slot) => slot.phaseKind === "after_action").every((slot) => slot.endDay === 36)).toBe(true);
  });

  it.each([
    { baseline: 4 }, { baseline: 5.5 }, { money: 2 }, { money: 5 },
    { final_squeeze: 3 }, { final_squeeze: 8 }, { after_action: 2 }, { after_action: 6 },
    { warmup: -1 },
  ])("rejects task counts outside the selected program ranges: %j", (counts) => {
    expect(() => buildPhaseTaskSlots(defaultPhasePlan, counts)).toThrow();
  });
});

describe("per-app completion requirements", () => {
  const requirements = [
    { appKind: "chrome", minSuccessfulRuns: 2, minActiveDays: 2 },
    { appKind: "maps", minSuccessfulRuns: 1, minActiveDays: 1 },
  ];

  it("keeps missing app work visible even when another app exceeds its target", () => {
    const progress = computeAppRequirements(requirements, [
      { appKind: "chrome", occurrenceKey: "rule1:day1", completedAt: "2026-09-01T10:00:00Z" },
      { appKind: "chrome", occurrenceKey: "rule1:day2", completedAt: "2026-09-02T10:00:00Z" },
      { appKind: "chrome", occurrenceKey: "rule1:day3", completedAt: "2026-09-03T10:00:00Z" },
    ]);
    expect(progress[0]).toMatchObject({ successfulRuns: 3, activeDays: 3, complete: true, reasons: [] });
    expect(progress[1]).toMatchObject({
      successfulRuns: 0, activeDays: 0, complete: false,
      reasons: ["missing_successful_runs", "missing_active_days"],
    });
  });

  it("does not turn retries or replayed completion evidence into additional runs or days", () => {
    const evidence = [
      { appKind: "chrome", occurrenceKey: "rule1:day1", completedAt: "2026-09-02T10:00:00Z" },
      { appKind: "chrome", occurrenceKey: "rule1:day1", completedAt: "2026-09-01T10:00:00Z" },
      { appKind: "chrome", occurrenceKey: "rule2:day1", completedAt: "2026-09-01T11:00:00Z" },
    ];
    const progress = computeAppRequirements(requirements, evidence);
    expect(progress[0]).toMatchObject({ successfulRuns: 2, activeDays: 1, complete: false, reasons: ["missing_active_days"] });
    expect(computeAppRequirements(requirements, [...evidence].reverse())).toEqual(progress);
  });

  it("uses actual completion dates in the client's timezone", () => {
    const evidence = [
      { appKind: "chrome", occurrenceKey: "rule1:day1", completedAt: "2026-09-01T23:30:00Z" },
      { appKind: "chrome", occurrenceKey: "rule1:day2", completedAt: "2026-09-02T00:30:00Z" },
    ];
    expect(computeAppRequirements(requirements, evidence, "UTC")[0].activeDays).toBe(2);
    expect(computeAppRequirements(requirements, evidence, "America/New_York")[0])
      .toMatchObject({ activeDays: 1, complete: false });
  });

  it("counts repeated daylight-saving hours as one active local day", () => {
    const evidence = [
      { appKind: "chrome", occurrenceKey: "rule1:day1", completedAt: "2026-11-01T05:30:00Z" },
      { appKind: "chrome", occurrenceKey: "rule2:day1", completedAt: "2026-11-01T06:30:00Z" },
    ];
    expect(computeAppRequirements(requirements, evidence, "America/New_York")[0])
      .toMatchObject({ successfulRuns: 2, activeDays: 1 });
  });

  it("merges duplicate app requirements conservatively and normalizes app names", () => {
    const progress = computeAppRequirements([
      { appKind: " Chrome ", minSuccessfulRuns: 1, minActiveDays: 0 },
      { appKind: "chrome", minSuccessfulRuns: 0, minActiveDays: 2 },
    ], [{ appKind: "CHROME", occurrenceKey: "rule1:day1", completedAt: "2026-09-01T10:00:00Z" }]);
    expect(progress).toEqual([{
      appKind: "chrome", minSuccessfulRuns: 1, minActiveDays: 2,
      successfulRuns: 1, activeDays: 1, complete: false, reasons: ["missing_active_days"],
    }]);
  });

  it("ignores unidentifiable or invalid completion evidence and never invents app targets", () => {
    expect(computeAppRequirements(requirements, [
      { appKind: "chrome", occurrenceKey: "", completedAt: "2026-09-01T10:00:00Z" },
      { appKind: "chrome", occurrenceKey: "rule1:day1", completedAt: "invalid" },
      { appKind: "unknown", occurrenceKey: "rule1:day1", completedAt: "2026-09-01T10:00:00Z" },
    ])[0].successfulRuns).toBe(0);
    expect(computeAppRequirements([], [])).toEqual([]);
    expect(() => computeAppRequirements(requirements, [], "not-a-timezone")).toThrow();
  });
});
