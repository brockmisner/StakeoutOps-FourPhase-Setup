import { describe, expect, it } from "vitest";

import { planWorkload, type WorkloadTask } from "@/lib/scheduler/workload-planner";

const start = "2026-09-06T12:00:00.000Z";

function task(id: string, clientId: string, phoneId: string, overrides: Partial<WorkloadTask> = {}): WorkloadTask {
  return {
    id,
    clientId,
    phoneId,
    preferredStart: start,
    durationSeconds: 10 * 60,
    ...overrides,
  };
}

describe("capacity-aware workload planner", () => {
  it("round-robins equal-time work across clients and enforces spacing", () => {
    const plan = planWorkload([
      task("a-1", "a", "phone-a"),
      task("a-2", "a", "phone-a"),
      task("b-1", "b", "phone-b"),
      task("b-2", "b", "phone-b"),
    ], { capacity: 1, minimumSpacingMinutes: 15 });

    expect(plan.planned.map((item) => item.id)).toEqual(["a-1", "b-1", "a-2", "b-2"]);
    expect(plan.planned.map((item) => item.shiftedByMinutes)).toEqual([0, 25, 50, 75]);
  });

  it("uses parallel capacity lanes while never overlapping one phone", () => {
    const plan = planWorkload([
      task("a", "a", "phone-1"),
      task("b", "b", "phone-2"),
      task("c", "c", "phone-1"),
    ], { capacity: 2, minimumSpacingMinutes: 15 });

    expect(plan.planned.find((item) => item.id === "a")?.lane).toBe(0);
    expect(plan.planned.find((item) => item.id === "b")?.startAt).toBe(start);
    expect(plan.planned.find((item) => item.id === "c")?.shiftedByMinutes).toBe(25);
  });

  it("reports work that cannot fit before its deadline", () => {
    const plan = planWorkload([
      task("first", "a", "phone-a"),
      task("blocked", "b", "phone-b", { deadline: "2026-09-06T12:05:00.000Z" }),
    ], { capacity: 1, minimumSpacingMinutes: 15 });

    expect(plan.planned.map((item) => item.id)).toEqual(["first"]);
    expect(plan.unplanned).toEqual([{ task: expect.objectContaining({ id: "blocked" }), reason: "deadline_exceeded" }]);
  });

  it("rejects a zero or unknown capacity instead of assuming it is safe", () => {
    expect(() => planWorkload([], { capacity: 0 })).toThrow("positive integer");
  });
});
