import { describe, expect, it } from "vitest";

import type { DuoPlusTask } from "@/lib/duoplus/types";
import {
  makeDuoPlusTaskName,
  matchesDuoPlusTaskName,
  selectDuoPlusTaskMatch,
} from "@/lib/scheduler/task-name";
import {
  duoPlusTaskLookupWindow,
  formatDuoPlusDate,
  formatDuoPlusTaskListDate,
} from "@/lib/scheduler/time";

function task(overrides: Partial<DuoPlusTask>): DuoPlusTask {
  return { id: "task-default", status: 0, ...overrides };
}

describe("DuoPlus task correlation", () => {
  it("builds an exact, API-safe name from the durable run id", () => {
    expect(makeDuoPlusTaskName("  run:acme/42  ")).toBe("stk_run_acme_42");
    expect(() => makeDuoPlusTaskName("   ")).toThrow("runId is required");
  });

  it("matches exact names and never accepts a prefix collision", () => {
    expect(matchesDuoPlusTaskName({ name: "stk_run-42" }, "run-42")).toBe(true);
    expect(matchesDuoPlusTaskName({ name: "stk_run-420" }, "run-42")).toBe(false);
    expect(matchesDuoPlusTaskName({}, "run-42")).toBe(false);
  });

  it("returns the closest task id for the expected name and phone", () => {
    const expected = new Date("2026-09-05T14:01:00.000Z");
    const tasks = [
      task({
        id: "wrong-name",
        name: "stk_someone-else",
        image_id: "AIZ3k",
        issue_at: "2026-09-05 14:01",
      }),
      task({
        id: "wrong-phone",
        name: "stk_run-42",
        image_id: "OTHER",
        issue_at: "2026-09-05 14:01",
      }),
      task({
        id: "farther",
        name: "stk_run-42",
        image_id: "AIZ3k",
        issue_at: "2026-09-05 14:06",
      }),
      task({
        id: "the-duoplus-id",
        name: "stk_run-42",
        image_id: "AIZ3k",
        issue_at: "2026-09-05 14:02",
      }),
    ];

    expect(
      selectDuoPlusTaskMatch(tasks, {
        runId: "run-42",
        imageId: "AIZ3k",
        issueAt: expected,
      })?.id,
    ).toBe("the-duoplus-id");
  });

  it("accepts a matching legacy row with no image id and returns null otherwise", () => {
    const issueAt = new Date("2026-09-05T14:01:00.000Z");
    const legacy = task({
      id: "legacy-id",
      name: "stk_run-42",
      issue_at: "2026-09-05T14:01:00Z",
    });

    expect(
      selectDuoPlusTaskMatch([legacy], {
        runId: "run-42",
        imageId: "AIZ3k",
        issueAt,
      })?.id,
    ).toBe("legacy-id");
    expect(
      selectDuoPlusTaskMatch([], {
        runId: "run-42",
        imageId: "AIZ3k",
        issueAt,
      }),
    ).toBeNull();
  });
});

describe("DuoPlus issue-at windows", () => {
  it("keeps addTask at minute precision and gives taskList second precision", () => {
    const issueAt = new Date("2026-09-05T14:01:59.999Z");
    expect(formatDuoPlusDate(issueAt)).toBe("2026-09-05 14:01");
    expect(formatDuoPlusTaskListDate(issueAt)).toBe("2026-09-05 14:01:59");
    expect(duoPlusTaskLookupWindow(issueAt)).toEqual({
      start: "2026-09-05 13:51:59",
      end: "2026-09-05 14:11:59",
    });
  });

  it("serializes a connection-specific wall time without changing the instant", () => {
    const issueAt = new Date("2026-09-05T14:01:00.000Z");
    expect(formatDuoPlusDate(issueAt, "America/New_York")).toBe(
      "2026-09-05 10:01",
    );
    expect(duoPlusTaskLookupWindow(issueAt, "America/New_York")).toEqual({
      start: "2026-09-05 09:51:00",
      end: "2026-09-05 10:11:00",
    });
  });

  it("uses the connection zone's DST offset for each instant", () => {
    expect(
      formatDuoPlusDate(
        new Date("2026-03-08T06:59:00.000Z"),
        "America/New_York",
      ),
    ).toBe("2026-03-08 01:59");
    expect(
      formatDuoPlusDate(
        new Date("2026-03-08T07:01:00.000Z"),
        "America/New_York",
      ),
    ).toBe("2026-03-08 03:01");
  });

  it("rejects invalid dates before making an API request", () => {
    expect(() => formatDuoPlusDate(new Date("invalid"))).toThrow(
      "Cannot format an invalid date",
    );
  });
});
