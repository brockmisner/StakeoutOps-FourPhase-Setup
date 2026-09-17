// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandCenter } from "@/components/command-center";

afterEach(cleanup);

const baseProps = {
  schedules: [],
  runs: [],
  phones: [],
  devices: [],
  clients: ["Example Client"],
  clientOptions: [{ id: "client-1", name: "Example Client" }],
  cycles: [],
  profiles: [],
  profileSummary: {
    total: 0,
    new: 0,
    warming: 0,
    ready: 0,
    completed: 0,
    needsAttention: 0,
  },
  cyclePrograms: [],
  templateOptions: [],
  proxySummary: null,
  demo: true,
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
  onCreateCycleProgram: async () => {
    throw new Error("not called");
  },
  onNotify: () => undefined,
};

describe("DuoPlus template selection", () => {
  it("uses local template UUIDs and distinguishes duplicate official/custom names", () => {
    render(createElement(CommandCenter, {
      ...baseProps,
      templateOptions: [
        {
          id: "00000000-0000-4000-8000-000000000201",
          duoplusTemplateId: "shared-remote-name",
          templateType: 1 as const,
          templateSource: "official" as const,
          name: "Account warming",
        },
        {
          id: "00000000-0000-4000-8000-000000000202",
          duoplusTemplateId: "shared-remote-name",
          templateType: 2 as const,
          templateSource: "custom" as const,
          name: "Account warming",
        },
      ],
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "Launch cycle" })[0]);

    const selector = screen.getByLabelText("Daily routine task 1 RPA template") as HTMLSelectElement;
    expect(selector.value).toBe("");
    const options = Array.from(selector.options).slice(1);
    expect(options.map((option) => option.value)).toEqual([
      "00000000-0000-4000-8000-000000000201",
      "00000000-0000-4000-8000-000000000202",
    ]);
    expect(options.map((option) => option.textContent)).toEqual([
      "Account warming",
      "Account warming",
    ]);
    expect(options.map((option) => option.parentElement?.getAttribute("label"))).toEqual([
      "Official (1)",
      "Custom (1)",
    ]);
  });

  it("never assigns unrelated official TikTok or Reddit templates to readiness apps", () => {
    const createProgram = vi.fn();
    render(createElement(CommandCenter, {
      ...baseProps,
      onCreateCycleProgram: createProgram,
      templateOptions: [
        {
          id: "00000000-0000-4000-8000-000000000211",
          duoplusTemplateId: "Olm2q",
          templateType: 1 as const,
          templateSource: "official" as const,
          name: "TikTok Auto Comment - Version 42.4.3",
        },
        {
          id: "00000000-0000-4000-8000-000000000212",
          duoplusTemplateId: "HFVsc",
          templateType: 1 as const,
          templateSource: "official" as const,
          name: "Reddit Account Warming",
        },
      ],
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "Launch cycle" })[0]);

    const selectors = screen.getAllByLabelText(/RPA template$/) as HTMLSelectElement[];
    expect(selectors).toHaveLength(19);
    expect(selectors.every((selector) => selector.value === "")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Create four-phase program" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Choose a currently synced RPA template for all 19 program tasks.",
    );
    expect(createProgram).not.toHaveBeenCalled();
  });

  it("keeps schedule drafts on the internal id field", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/operations-dashboard.tsx"),
      "utf8",
    );

    expect(source).toContain("templateId: string;");
    expect(source).toContain("item.id === draft.templateId");
    expect(source).toContain('value={draft.templateId}');
    expect(source).not.toMatch(/draft\.template(?!Id)/);
  });

  it("shows client-neutral bindings once per selected program template", () => {
    render(createElement(CommandCenter, {
      ...baseProps,
      templateOptions: [{
        id: "00000000-0000-4000-8000-000000000221",
        duoplusTemplateId: "chrome-aio",
        templateType: 2 as const,
        templateSource: "custom" as const,
        name: "$ Chrome AIO + Local Pack GBP Click",
      }],
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "Launch cycle" })[0]);
    const firstTemplate = screen.getByLabelText("Daily routine task 1 RPA template");
    fireEvent.change(firstTemplate, {
      target: { value: "00000000-0000-4000-8000-000000000221" },
    });

    const inputs = screen.getByRole("region", { name: "Program template inputs" });
    expect(within(inputs).getByText("$ Chrome AIO + Local Pack GBP Click")).toBeTruthy();
    expect(within(inputs).getByText("Search Term *")).toBeTruthy();
    expect(within(inputs).getByText("Business Name *")).toBeTruthy();
    expect(within(inputs).getByText("{{search_term}}")).toBeTruthy();
    expect(within(inputs).getAllByText(/collected at cycle launch/i)).toHaveLength(2);
    expect(within(inputs).queryByRole("textbox", { name: /search term/i })).toBeNull();
    expect(within(inputs).getByText("4 selector defaults")).toBeTruthy();
  });

  it("stores schema placeholders in a new program instead of client values", async () => {
    const createProgram = vi.fn().mockResolvedValue({
      id: "program-new",
      name: "30-day local presence",
      durationDays: 30,
      timezone: "America/New_York",
      status: "published" as const,
      rules: [],
    });
    render(createElement(CommandCenter, {
      ...baseProps,
      onCreateCycleProgram: createProgram,
      templateOptions: [{
        id: "00000000-0000-4000-8000-000000000221",
        duoplusTemplateId: "chrome-aio",
        templateType: 2 as const,
        templateSource: "custom" as const,
        name: "$ Chrome AIO + Local Pack GBP Click",
      }],
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "Launch cycle" })[0]);
    for (const selector of screen.getAllByLabelText(/RPA template$/)) {
      fireEvent.change(selector, {
        target: { value: "00000000-0000-4000-8000-000000000221" },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Create four-phase program" }));

    await waitFor(() => expect(createProgram).toHaveBeenCalledTimes(1));
    const input = createProgram.mock.calls[0][0];
    for (const rule of input.rules) {
      expect(rule.config.search_term.value).toBe("{{search_term}}");
      expect(rule.config.business_name.value).toBe("{{business_name}}");
      expect(rule.config.ai_overview_text.value).toBe("AI Overview");
      expect(rule.config.ai_show_more_text.value).toBe("Show more AI Overview");
    }
  });

  it("collects reusable program variables only when a cycle launches", () => {
    render(createElement(CommandCenter, {
      ...baseProps,
      cyclePrograms: [{
        id: "program-1",
        name: "Reusable readiness",
        durationDays: 30,
        timezone: "America/New_York",
        status: "published" as const,
        rules: [{
          id: "rule-1",
          name: "Daily search",
          config: {
            search_term: { key: "search_term", type: "string", value: "{{search_term}}", required: true },
            visit_count: { key: "visit_count", type: "number", value: "{{visit_count}}", required: false },
          },
        }],
      }],
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "Launch cycle" })[0]);

    expect(screen.getByLabelText(/Search Term required · client value/i)).toBeTruthy();
    expect((screen.getByLabelText(/Visit Count optional · client value/i) as HTMLInputElement).type).toBe("number");
  });

  it("shifts every phase after warmup and preserves task mappings when counts change", () => {
    render(createElement(CommandCenter, {
      ...baseProps,
      templateOptions: [{ id: "template-1", templateType: 2 as const, name: "Selected template" }],
    }));
    fireEvent.click(screen.getAllByRole("button", { name: "Launch cycle" })[0]);
    const preview = screen.getByRole("region", { name: "Program phase preview" });
    expect(within(preview).getByText("30-day program · 236 runs per phone")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Money task 4 RPA template"), { target: { value: "template-1" } });
    fireEvent.change(screen.getByLabelText("Money task 4 estimated minutes"), { target: { value: "7.5" } });
    fireEvent.change(screen.getByLabelText("Warmup days"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("Money days"), { target: { value: "5" } });
    expect(within(preview).getByText("36-day program · 274 runs per phone")).toBeTruthy();
    expect(within(preview).getByRole("row", { name: "Money Days 15–19 9 45" })).toBeTruthy();
    expect(within(preview).getByRole("row", { name: "Final squeeze Days 20–22 11 33" })).toBeTruthy();
    expect(within(preview).getByRole("row", { name: "After action Days 23–36 9 126" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Money tasks"), { target: { value: "3" } });
    expect(screen.queryByLabelText("Money task 4 RPA template")).toBeNull();
    fireEvent.change(screen.getByLabelText("Money tasks"), { target: { value: "4" } });
    expect((screen.getByLabelText("Money task 4 RPA template") as HTMLSelectElement).value).toBe("template-1");
    expect((screen.getByLabelText("Money task 4 estimated minutes") as HTMLInputElement).value).toBe("7.5");
    fireEvent.click(screen.getByRole("checkbox", { name: /Continue daily routine through every phase/ }));
    expect(within(preview).getByText("36-day program · 164 runs per phone")).toBeTruthy();
    expect(within(preview).getByRole("row", { name: "Money Days 15–19 4 20" })).toBeTruthy();
  });

  it("publishes the chosen phase windows, per-app requirements, and real task estimates", async () => {
    const createProgram = vi.fn().mockImplementation(async (input) => ({ id: "new-phase-program", ...input, status: "published" }));
    render(createElement(CommandCenter, {
      ...baseProps,
      onCreateCycleProgram: createProgram,
      templateOptions: [{ id: "template-1", templateType: 2 as const, name: "Selected template" }],
    }));
    fireEvent.click(screen.getAllByRole("button", { name: "Launch cycle" })[0]);
    for (const selector of screen.getAllByLabelText(/RPA template$/)) {
      fireEvent.change(selector, { target: { value: "template-1" } });
    }
    fireEvent.change(screen.getByLabelText("Warmup days"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("Daily routine task 1 estimated minutes"), { target: { value: "7.5" } });
    fireEvent.change(screen.getByLabelText("Daily routine task 1 local time"), { target: { value: "09:25" } });
    fireEvent.change(screen.getByLabelText("Waze minimum successful runs"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Waze minimum active days"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Create four-phase program" }));
    await waitFor(() => expect(createProgram).toHaveBeenCalledTimes(1));
    const input = createProgram.mock.calls[0][0];
    expect(input.durationDays).toBe(34);
    expect(input.readyDay).toBe(14);
    expect(input.phasePlan).toEqual({ version: 1, warmupDays: 14, moneyDays: 3, finalSqueezeDays: 3, afterActionDays: 14, continueDailyTasks: true, appRequirements: [{ appKind: "waze", minSuccessfulRuns: 10, minActiveDays: 8 }] });
    expect(input.rules).toHaveLength(19);
    expect(input.rules[0]).toMatchObject({ phaseKind: "baseline", startDay: 1, endDay: 34, expectedDurationSeconds: 450, localTime: "09:25", appKind: "chrome", templateId: "template-1" });
    expect(input.rules.find((rule: { phaseKind: string }) => rule.phaseKind === "money")).toMatchObject({ startDay: 15, endDay: 17 });
    expect(input.rules.map((rule: { appKind: string }) => rule.appKind)).toContain("gmail");
    expect(screen.getByRole("region", { name: "Selected program phases" })).toBeTruthy();
    expect(screen.getByText(/Program volume: 256 runs on this phone/)).toBeTruthy();
    expect((screen.getByLabelText(/Latitude required/) as HTMLInputElement).required).toBe(true);
  });

  it("counts mixed recurring and once-only rules when estimating an existing program", () => {
    render(createElement(CommandCenter, {
      ...baseProps,
      cyclePrograms: [{
        id: "legacy-program", name: "Custom legacy program", durationDays: 15,
        timezone: "America/New_York", status: "published" as const,
        rules: [
          { id: "daily-rule", name: "Daily", ruleKind: "daily_range" as const, startDay: 1, endDay: 15 },
          { id: "once-rule", name: "Once", ruleKind: "window_once" as const, startDay: 10, endDay: 11 },
          { id: "range-rule", name: "Range", ruleKind: "day_range" as const, startDay: 11, endDay: 13 },
        ],
      }],
    }));
    fireEvent.click(screen.getAllByRole("button", { name: "Launch cycle" })[0]);
    expect(screen.getByText(/Program volume: 19 runs on this phone/)).toBeTruthy();
  });

});
