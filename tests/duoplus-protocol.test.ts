import { describe, expect, it } from "vitest";

import { DuoPlusApiError } from "@/lib/duoplus/errors";
import {
  extractDuoPlusList,
  parseDuoPlusEnvelope,
} from "@/lib/duoplus/protocol";
import {
  isDuoPlusTerminalStatus,
  mapDuoPlusTaskStatus,
} from "@/lib/duoplus/task-status";

describe("parseDuoPlusEnvelope", () => {
  it("returns data only when DuoPlus code is 200", () => {
    expect(
      parseDuoPlusEnvelope<{ message: string }>(
        { code: 200, data: { message: "success" } },
        "/api/v1/automation/addTask",
      ),
    ).toEqual({ message: "success" });
  });

  it("turns code 401 into a non-retryable authorization error", () => {
    let error: unknown;
    try {
      parseDuoPlusEnvelope(
        { code: 401, message: "API key invalid" },
        "/api/v1/cloudPhone/list",
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DuoPlusApiError);
    expect(error).toMatchObject({
      endpoint: "/api/v1/cloudPhone/list",
      duoCode: 401,
      retryable: false,
      unauthorized: true,
    });
  });

  it("marks throttling and server failures as retryable", () => {
    for (const code of [429, 500, 503]) {
      expect(() =>
        parseDuoPlusEnvelope(
          { code, message: "try later" },
          "/api/v1/automation/taskList",
        ),
      ).toThrowError(
        expect.objectContaining({
          duoCode: code,
          retryable: true,
        }),
      );
    }
  });

  it("rejects malformed JSON envelopes", () => {
    expect(() =>
      parseDuoPlusEnvelope({ data: [] }, "/api/v1/cloudPhone/list"),
    ).toThrow("invalid DuoPlus envelope");
    expect(() =>
      parseDuoPlusEnvelope("not-json", "/api/v1/cloudPhone/list", 502),
    ).toThrow("non-JSON response");
  });
});

describe("extractDuoPlusList", () => {
  it.each([
    [[{ id: "A" }]],
    [{ list: [{ id: "A" }] }],
    [{ rows: [{ id: "A" }] }],
    [{ items: [{ id: "A" }] }],
    [{ data: [{ id: "A" }] }],
  ])("normalizes known list response shapes", (value) => {
    expect(extractDuoPlusList<{ id: string }>(value)).toEqual([{ id: "A" }]);
  });

  it("rejects an unknown response shape instead of treating it as empty inventory", () => {
    expect(() =>
      extractDuoPlusList({ message: "success" }, "/api/v1/cloudPhone/list"),
    ).toThrow("invalid list payload");
  });
});

describe("DuoPlus task status mapping", () => {
  it.each([
    [0, "queued", false],
    [1, "running", false],
    [2, "paused", false],
    [3, "succeeded", true],
    [4, "failed", true],
    [5, "cancelled", true],
    [999, "unknown", false],
  ] as const)("maps status %s", (raw, expected, terminal) => {
    expect(mapDuoPlusTaskStatus(raw)).toBe(expected);
    expect(isDuoPlusTerminalStatus(raw)).toBe(terminal);
  });
});
