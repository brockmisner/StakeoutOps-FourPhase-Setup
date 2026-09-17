import { describe, expect, it } from "vitest";

import {
  expandCycleRule,
  plannedCycleRunCount,
  standardPresenceRules,
} from "@/lib/scheduler/cycles";

describe("device cycle compiler preview", () => {
  it("plans 84 runs for the 15-day standard presence cycle", () => {
    expect(plannedCycleRunCount(standardPresenceRules(15), 15)).toBe(84);
  });

  it("plans 159 runs for the 30-day standard presence cycle", () => {
    expect(plannedCycleRunCount(standardPresenceRules(30), 30)).toBe(159);
  });

  it("represents day 10 or 11 as one logical occurrence", () => {
    expect(
      expandCycleRule(
        { ruleKind: "window_once", startDay: 10, endDay: 11 },
        30,
      ),
    ).toEqual([
      {
        cycleDay: 10,
        occurrenceKey: "window:10-11",
        windowStartDay: 10,
        windowEndDay: 11,
      },
    ]);
  });

  it("rejects rules that leak beyond the selected duration", () => {
    expect(() =>
      expandCycleRule(
        { ruleKind: "daily_range", startDay: 1, endDay: 30 },
        15,
      ),
    ).toThrow(/inside the cycle duration/i);
  });

  it("allows the final day of a 36-day cycle", () => {
    expect(expandCycleRule({ ruleKind: "daily_range", startDay: 36, endDay: 36 }, 36))
      .toEqual([{ cycleDay: 36, occurrenceKey: "day:36", windowStartDay: 36, windowEndDay: 36 }]);
  });

  it.each([14, 37, 30.5])("rejects unsupported cycle duration %s", (durationDays) => {
    expect(() => expandCycleRule({ ruleKind: "daily_range", startDay: 1, endDay: 1 }, durationDays))
      .toThrow(/between 15 and 36/i);
  });
});
