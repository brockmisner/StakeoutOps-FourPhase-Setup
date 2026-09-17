import { describe, expect, it } from "vitest";

import {
  computeScheduleOccurrences,
  nextScheduleOccurrence,
} from "@/lib/scheduler/recurrence";

describe("schedule recurrence expansion", () => {
  it("keeps a 9 AM New York schedule at local wall time across spring DST", () => {
    const occurrences = computeScheduleOccurrences({
      cronExpression: "0 9 * * *",
      timeZone: "America/New_York",
      nextRunAt: new Date("2026-03-07T14:00:00.000Z"),
      horizonEnd: new Date("2026-03-10T14:00:00.000Z"),
    });

    expect(occurrences.map((date) => date.toISOString())).toEqual([
      "2026-03-07T14:00:00.000Z", // 09:00 EST
      "2026-03-08T13:00:00.000Z", // 09:00 EDT
      "2026-03-09T13:00:00.000Z",
      "2026-03-10T13:00:00.000Z",
    ]);
  });

  it("keeps local wall time across fall DST", () => {
    const occurrences = computeScheduleOccurrences({
      cronExpression: "0 9 * * *",
      timeZone: "America/New_York",
      nextRunAt: new Date("2026-10-31T13:00:00.000Z"),
      horizonEnd: new Date("2026-11-03T15:00:00.000Z"),
    });

    expect(occurrences.map((date) => date.toISOString())).toEqual([
      "2026-10-31T13:00:00.000Z", // 09:00 EDT
      "2026-11-01T14:00:00.000Z", // 09:00 EST
      "2026-11-02T14:00:00.000Z",
      "2026-11-03T14:00:00.000Z",
    ]);
  });

  it("includes the canonical next run at an inclusive horizon boundary", () => {
    const boundary = new Date("2026-09-06T13:00:00.000Z");
    expect(
      computeScheduleOccurrences({
        cronExpression: "0 9 * * *",
        timeZone: "America/New_York",
        nextRunAt: boundary,
        horizonEnd: boundary,
      }),
    ).toEqual([boundary]);
  });

  it("returns no occurrences when the next run is beyond the horizon", () => {
    expect(
      computeScheduleOccurrences({
        cronExpression: "0 9 * * *",
        timeZone: "UTC",
        nextRunAt: new Date("2026-09-07T09:00:00.000Z"),
        horizonEnd: new Date("2026-09-06T09:00:00.000Z"),
      }),
    ).toEqual([]);
  });

  it("caps high-frequency schedules to protect one materialization tick", () => {
    const occurrences = computeScheduleOccurrences({
      cronExpression: "* * * * *",
      timeZone: "UTC",
      nextRunAt: new Date("2026-09-05T12:00:00.000Z"),
      horizonEnd: new Date("2026-09-06T12:00:00.000Z"),
      maxOccurrences: 3,
    });

    expect(occurrences.map((date) => date.toISOString())).toEqual([
      "2026-09-05T12:00:00.000Z",
      "2026-09-05T12:01:00.000Z",
      "2026-09-05T12:02:00.000Z",
    ]);
  });

  it("rejects malformed recurrence inputs", () => {
    const validDates = {
      nextRunAt: new Date("2026-09-05T12:00:00.000Z"),
      horizonEnd: new Date("2026-09-06T12:00:00.000Z"),
    };

    expect(() =>
      computeScheduleOccurrences({
        ...validDates,
        cronExpression: "",
        timeZone: "UTC",
      }),
    ).toThrow("cronExpression is required");
    expect(() =>
      computeScheduleOccurrences({
        ...validDates,
        cronExpression: "0 9 * * *",
        timeZone: "Not/A_Timezone",
      }),
    ).toThrow();
    expect(() =>
      computeScheduleOccurrences({
        ...validDates,
        cronExpression: "0 9 * * *",
        timeZone: "UTC",
        maxOccurrences: 0,
      }),
    ).toThrow("maxOccurrences must be a positive integer");
  });

  it("computes a strictly later next occurrence", () => {
    expect(
      nextScheduleOccurrence({
        cronExpression: "0 9 * * 1",
        timeZone: "America/New_York",
        after: new Date("2026-09-07T13:00:00.000Z"),
      }).toISOString(),
    ).toBe("2026-09-14T13:00:00.000Z");
  });
});
