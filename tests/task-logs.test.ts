import { describe, expect, it } from "vitest";

import { summarizeTaskLogs } from "../src/lib/scheduler/task-logs";

describe("task log persistence", () => {
  it("drops node/result content and replaces raw errors with a generic marker", () => {
    const { summaries } = summarizeTaskLogs([
      {
        id: "log-1",
        node_name: "proxy password=super-secret",
        error_message:
          "Authorization: Bearer token-value https://user:pass@example.com and api_key=live-key",
        result: "https://proxy-seller.com/personal/api/v1/provider-key/resident/package",
      },
    ]);

    expect(summaries).toEqual([
      {
        id: "log-1",
        action: null,
        successful: null,
        errorMessage: "DuoPlus action error (details withheld)",
        startedAt: null,
        finishedAt: null,
        createdAt: null,
        screenshots: [],
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("super-secret");
    expect(JSON.stringify(summaries)).not.toContain("token-value");
    expect(JSON.stringify(summaries)).not.toContain("provider-key");
    expect(JSON.stringify(summaries)).not.toContain(":pass@");
    expect(JSON.stringify(summaries)).not.toContain("live-key");
  });

  it("preserves non-secret proof fields and safe screenshots", () => {
    const { summaries, screenshots } = summarizeTaskLogs([
      {
        id: "log-2",
        node_name: "Search complete",
        start_at: "2026-01-15 05:43:16 912",
        finish_at: "2026-01-15 05:43:20 832",
        result_info: {
          action: "PAGE_SCREENSHOT",
          result: true,
          extra_data: { screenshot: "https://cdn.example.com/proof.png" },
        },
      },
    ]);

    expect(summaries[0]).toMatchObject({
      id: "log-2",
      action: "PAGE_SCREENSHOT",
      successful: true,
      startedAt: "2026-01-15 05:43:16 912",
      finishedAt: "2026-01-15 05:43:20 832",
    });
    expect(screenshots).toEqual(["https://cdn.example.com/proof.png"]);
  });

  it("stores only allowlisted action evidence and aggregate outcomes", () => {
    const { evidence } = summarizeTaskLogs([
      {
        id: "start",
        result_info: { action: "START", result: true },
      },
      {
        id: "open",
        result_info: {
          action: "OPEN_APP",
          result: true,
          extra_data: {
            data: {
              package_name: "com.example.private",
              email: "profile@example.com",
            },
          },
        },
      },
      {
        id: "click-ok",
        result_info: {
          action: "CLICK_ELEMENT",
          result: true,
          extra_data: {
            data: {
              selector_bean_list: [{ text: "Private profile label" }],
              password: "never-store-me",
            },
          },
        },
      },
      {
        id: "click-fail",
        result_info: {
          action: "CLICK_ELEMENT",
          result: false,
          error_message:
            "Could not find text='profile@example.com'; api_key=secret-key",
          extra_data: {
            data: {
              request_url: "https://private.example.test/account",
              request_body: "private-body",
              request_headers: { authorization: "Bearer secret-token" },
            },
          },
        },
      },
      {
        id: "unknown",
        result_info: {
          action: "SECRET profile@example.com",
          result: true,
        },
      },
    ]);

    expect(evidence).toMatchObject({
      schemaVersion: 2,
      actionTelemetryPoints: 0,
      totalLogEntries: 5,
      storedLogEntries: 5,
      truncated: false,
      actions: {
        total: 4,
        successful: 3,
        failed: 1,
        unknown: 0,
        byAction: [
          { action: "CLICK_ELEMENT", total: 2, successful: 1, failed: 1 },
          { action: "OPEN_APP", total: 1, successful: 1, failed: 0 },
          { action: "START", total: 1, successful: 1, failed: 0 },
        ],
      },
    });
    expect(evidence.entries.at(-1)?.action).toBeNull();

    const stored = JSON.stringify(evidence);
    expect(stored).not.toContain("com.example.private");
    expect(stored).not.toContain("profile@example.com");
    expect(stored).not.toContain("Private profile label");
    expect(stored).not.toContain("never-store-me");
    expect(stored).not.toContain("secret-key");
    expect(stored).not.toContain("private.example.test");
    expect(stored).not.toContain("private-body");
    expect(stored).not.toContain("secret-token");
    expect(stored).not.toContain("SECRET profile");
    expect(stored).toContain("DuoPlus action error (details withheld)");
  });

  it("counts all fetched actions while bounding stored per-node evidence", () => {
    const logs = Array.from({ length: 300 }, (_, index) => ({
      id: `log-${index}`,
      result_info: { action: "WAIT_TIME", result: index % 2 === 0 },
    }));

    const { evidence } = summarizeTaskLogs(logs);

    expect(evidence.totalLogEntries).toBe(300);
    expect(evidence.storedLogEntries).toBe(250);
    expect(evidence.truncated).toBe(true);
    expect(evidence.actions).toMatchObject({
      total: 300,
      successful: 150,
      failed: 150,
    });
  });

  it("recognizes the documented selector-wait and email action names", () => {
    const { evidence } = summarizeTaskLogs([
      { result_info: { action: "WAIT_FOR_SELECTOR", result: true } },
      { result_info: { action: "GET_EMAIL", result: false } },
    ]);

    expect(evidence.actions.byAction).toEqual([
      {
        action: "GET_EMAIL",
        total: 1,
        successful: 0,
        failed: 1,
        unknown: 0,
      },
      {
        action: "WAIT_FOR_SELECTOR",
        total: 1,
        successful: 1,
        failed: 0,
        unknown: 0,
      },
    ]);
  });

  it("rejects screenshots with embedded URL credentials", () => {
    const { screenshots } = summarizeTaskLogs([
      {
        result_info: {
          action: "PAGE_SCREENSHOT",
          result: true,
          extra_data: {
            screenshot: [
              "https://cdn.example.com/safe.png",
              "https://private-user:private-pass@cdn.example.com/unsafe.png",
            ],
          },
        },
      },
    ]);

    expect(screenshots).toEqual(["https://cdn.example.com/safe.png"]);
  });

  it("does not retain phone-like values even when supplied as a log id", () => {
    const { evidence } = summarizeTaskLogs([
      {
        id: "15551234567",
        node_name: "+1 (555) 123-4567",
        error_message: "Call +1 (555) 123-4567 for profile@example.com",
        result_info: { action: "OUTPUT_LOG", result: false },
      },
    ]);

    expect(evidence.entries[0]?.id).toBeNull();
    expect(JSON.stringify(evidence)).not.toContain("15551234567");
    expect(JSON.stringify(evidence)).not.toContain("555) 123");
    expect(JSON.stringify(evidence)).not.toContain("profile@example.com");
  });
});
