import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CommandCenter,
  type CommandRun,
} from "@/components/command-center";

function cycleRun(id: string, status: CommandRun["status"], issueAt: string): CommandRun {
  return {
    id,
    clientId: "client-1",
    clientName: "Example Client",
    scheduleId: `schedule-${id}`,
    scheduleName: `Cycle ${id}`,
    keyword: `${id} keyword`,
    sourceKind: "device_cycle",
    phoneId: "phone-1",
    phoneName: "Pilot Phone",
    templateId: "template-1",
    templateName: "Maps Daily Actions",
    deviceCycleId: "cycle-1",
    cycleDay: 11,
    expectedDurationSeconds: 600,
    status,
    stage: status === "failed" ? "monitor_task" : status === "succeeded" ? "complete" : "pending",
    issueAt,
    finishedAt: ["failed", "succeeded"].includes(status) ? issueAt : null,
    lastError: status === "failed" ? "Provider task timed out" : null,
    screenshots: [],
    createdAt: issueAt,
  };
}

describe("cycle-generated run visibility", () => {
  it("shows cycle work without exposing cycle schedules through the editable schedule list", () => {
    const runs = [
      cycleRun("failed", "failed", "2026-09-06T12:02:00.000Z"),
      cycleRun("pending", "pending", "2026-09-06T12:10:00.000Z"),
      cycleRun("completed", "succeeded", "2026-09-06T11:30:00.000Z"),
    ];
    const markup = renderToStaticMarkup(createElement(CommandCenter, {
      schedules: [],
      runs,
      phones: [],
      devices: [],
      clients: ["Example Client"],
      clientOptions: [{ id: "client-1", name: "Example Client" }],
      cycles: [],
      profiles: [],
      profileSummary: { total: 0, new: 0, warming: 0, ready: 0, completed: 0, needsAttention: 0 },
      cyclePrograms: [],
      templateOptions: [],
      proxySummary: null,
      demo: false,
      loading: false,
      integrationConnected: true,
      subscriptionCapacity: 1,
      successRate: "0%",
      initialNow: "2026-09-06T12:00:00.000Z",
      onRefresh: () => undefined,
      onRun: () => undefined,
      onViewSchedule: () => undefined,
      onViewRun: () => undefined,
      onOpenIntegration: () => undefined,
      onLaunchCycle: () => undefined,
      onCreateCycleProgram: async () => { throw new Error("not called"); },
      onNotify: () => undefined,
    }));

    expect(markup).toContain("pending keyword");
    expect(markup).toContain("Pilot Phone");
    expect(markup).toContain("Failed cycle run");
    expect(markup).toContain("Provider task timed out");
    expect(markup).toContain("completed keyword");
    expect(markup).toContain("View proof");
  });
});
