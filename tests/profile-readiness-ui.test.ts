import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CommandCenter,
  type CommandProfileReadiness,
} from "@/components/command-center";

describe("profile readiness command center", () => {
  it("renders profile score gates, app coverage, and diagnostic scoring policy", () => {
    const profile: CommandProfileReadiness = {
      id: "profile-1",
      label: "profile.alias.01",
      clientId: "client-1",
      clientName: "Example Client",
      phoneId: "phone-1",
      phoneName: "Phone 01",
      cycleId: "cycle-1",
      cycleName: "September cycle",
      programId: "program-1",
      programName: "30-day program",
      state: "ready",
      currentDay: 11,
      durationDays: 30,
      score: 42,
      readyScore: 40,
      completionScore: 90,
      possibleScore: 100,
      successfulDays: 10,
      appScores: [
        { app: "chrome", score: 20, possible: 40 },
        { app: "discover", score: 14, possible: 30 },
        { app: "maps", score: 8, possible: 30 },
        { app: "gmail", score: 1, possible: 5 },
        { app: "waze", score: 2, possible: 5 },
      ],
      currentPhase: "warmup",
      phaseGate: {
        allowed: false,
        status: "recovery_required",
        blockedPhase: "money",
        missingRequiredRuns: 2,
        requirements: [{ appKind: "waze", minSuccessfulRuns: 5, minActiveDays: 3, successfulRuns: 2, activeDays: 1, met: false }],
        earliestStartAt: null,
        reason: "Waze still needs successful work before Money can start.",
      },
      lastSuccessAt: "2026-09-05T12:00:00.000Z",
      statusReason: "Ready threshold and activity gates reached.",
    };

    const markup = renderToStaticMarkup(createElement(CommandCenter, {
      schedules: [],
      runs: [],
      phones: [],
      devices: [],
      clients: ["Example Client"],
      clientOptions: [{ id: "client-1", name: "Example Client" }],
      cycles: [],
      profiles: [profile],
      profileSummary: { total: 1, new: 0, warming: 0, ready: 1, completed: 0, needsAttention: 0 },
      cyclePrograms: [],
      templateOptions: [],
      proxySummary: null,
      demo: false,
      loading: false,
      integrationConnected: true,
      successRate: "100%",
      initialNow: "2026-09-05T13:00:00.000Z",
      onRefresh: () => undefined,
      onRun: () => undefined,
      onViewSchedule: () => undefined,
      onViewRun: () => undefined,
      onOpenIntegration: () => undefined,
      onLaunchCycle: () => undefined,
      onCreateCycleProgram: async (input) => ({
        id: "program-1",
        name: input.name,
        durationDays: input.durationDays,
        timezone: input.timezone,
        readyDay: input.readyDay,
        readyThresholdPercent: input.readyThresholdPercent,
        completionThresholdPercent: input.completionThresholdPercent,
        status: "published" as const,
        rules: input.rules.map((rule, index) => ({
          id: `rule-${index}`,
          name: rule.name,
          appKind: rule.appKind,
          points: rule.points,
        })),
      }),
      onNotify: () => undefined,
    }));

    expect(markup).toContain("Profile readiness");
    expect(markup).toContain("profile.alias.01");
    expect(markup).toContain("Ready 40 · Complete 90");
    expect(markup).toContain("chrome");
    expect(markup).toContain("gmail");
    expect(markup).toContain("waze");
    expect(markup).toContain("2 / 5 runs");
    expect(markup).toContain("1 / 3 days");
    expect(markup).toContain("Waze still needs successful work before Money can start.");
    expect(markup).toContain("ADB diagnostic activity earns zero points");
  });
});
