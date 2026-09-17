// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const testRuntime = vi.hoisted(() => {
  const previousDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE;
  process.env.NEXT_PUBLIC_DEMO_MODE = "true";
  return {
    previousDemoMode,
    router: { replace: vi.fn(), refresh: vi.fn() },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => testRuntime.router,
}));

vi.mock("@/lib/supabase/config", () => ({
  hasSupabaseBrowserConfig: () => false,
}));

import {
  IntegrationDialog,
  OperationsDashboard,
} from "@/components/operations-dashboard";
import {
  CommandCenter,
  type CommandDeviceCycle,
  type CommandRun,
  type CommandSchedule,
} from "@/components/command-center";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeAll(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (testRuntime.previousDemoMode === undefined) {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  } else {
    process.env.NEXT_PUBLIC_DEMO_MODE = testRuntime.previousDemoMode;
  }
});

function schedules(count = 15): CommandSchedule[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      id: `schedule-${number}`,
      phoneId: `phone-${number}`,
      title: `Schedule ${number}`,
      keyword: `Keyword ${number}`,
      client: number % 2 ? "Acme" : "Beacon",
      device: `Phone ${number}`,
      status: "Scheduled" as const,
      nextRun: "in 10 minutes",
      lastRun: "yesterday",
      duration: "10 minutes",
    };
  });
}

function runs(count = 15): CommandRun[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      id: `run-${number}`,
      scheduleId: `schedule-${number}`,
      phoneName: `Phone ${number}`,
      status: "queued" as const,
      stage: "submit_task",
      issueAt: "2026-09-06T12:10:00.000Z",
      createdAt: "2026-09-06T12:00:00.000Z",
    };
  });
}

function deviceCycle(overrides: Partial<CommandDeviceCycle> = {}): CommandDeviceCycle {
  return {
    id: "cycle-1",
    name: "Pilot cycle",
    clientId: "client-acme",
    clientName: "Acme",
    phoneId: "phone-1",
    phoneName: "Phone 1",
    programId: "program-1",
    programName: "Warmup",
    status: "active",
    startsOn: "2026-09-01",
    endsOn: "2026-09-30",
    durationDays: 30,
    currentDay: 6,
    keyword: "safe test",
    target: {
      country: "US",
      region: "New York",
      city: "Albany",
      latitude: 42.6526,
      longitude: -73.7562,
    },
    runCounts: { total: 6, done: 5, running: 1, failed: 0, pending: 0 },
    proxy: null,
    ...overrides,
  };
}

function commandCenterProps(overrides: Record<string, unknown> = {}) {
  return {
    schedules: schedules(),
    runs: runs(),
    phones: [],
    devices: [],
    clients: ["Acme", "Beacon"],
    clientOptions: [
      { id: "client-acme", name: "Acme" },
      { id: "client-beacon", name: "Beacon" },
    ],
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
    demo: false,
    loading: false,
    integrationConnected: true,
    systemReady: true,
    subscriptionCapacity: 24,
    subscriptionInUse: 18,
    subscriptionAvailable: 6,
    subscriptionSyncedAt: "2026-09-06T12:00:00.000Z",
    successRate: "100%",
    initialNow: "2026-09-06T12:00:00.000Z",
    pendingRunIds: new Set<string>(),
    onRefresh: vi.fn(),
    onRun: vi.fn(),
    onViewSchedule: vi.fn(),
    onViewRun: vi.fn(),
    onOpenIntegration: vi.fn(),
    onLaunchCycle: vi.fn(),
    onCreateCycleProgram: vi.fn(),
    onNotify: vi.fn(),
    ...overrides,
  };
}

describe("command center quick improvements", () => {
  it("opens on Command Center with the schedule drawer closed", () => {
    render(createElement(OperationsDashboard, {
      initialNow: "2026-09-06T12:00:00.000Z",
      systemReady: false,
    }));

    expect(screen.getByRole("heading", { level: 1, name: /command center/i })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: /add schedule|edit schedule/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Command center" })).toHaveProperty("disabled", false);
  });

  it("does not render unfinished navigation as working destinations or show a fake run badge", () => {
    render(createElement(OperationsDashboard, {
      initialNow: "2026-09-06T12:00:00.000Z",
      systemReady: false,
    }));

    const navigation = screen.getByRole("complementary", { name: "Primary navigation" });
    for (const label of ["Runs", "Devices", "Clients", "Templates", "Settings"]) {
      expect(within(navigation).queryByText(label)).toBeNull();
    }
    expect(document.querySelector(".nav-badge")).toBeNull();

    const schedulesButton = screen.getByRole("button", { name: "Schedules" });
    expect(schedulesButton).toHaveProperty("disabled", false);
    fireEvent.click(schedulesButton);
    expect(screen.getByRole("heading", { level: 1, name: "Schedules" })).toBeTruthy();
  });

  it("renders live operations beyond the former twelve-schedule cutoff", () => {
    render(createElement(CommandCenter, commandCenterProps()));

    expect(screen.getByRole("cell", { name: "Keyword 13" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Keyword 14" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Keyword 15" })).toBeTruthy();
  });

  it("keeps every fetched occurrence visible and opens the selected run detail", () => {
    const onViewRun = vi.fn();
    const repeatedRuns: CommandRun[] = [
      {
        ...runs(1)[0],
        id: "run-current",
        status: "running",
        stage: "monitor_task",
        issueAt: "2026-09-06T11:58:00.000Z",
      },
      {
        ...runs(1)[0],
        id: "run-previous",
        status: "succeeded",
        stage: "complete",
        issueAt: "2026-09-06T10:00:00.000Z",
        finishedAt: "2026-09-06T10:10:00.000Z",
      },
    ];
    render(createElement(CommandCenter, commandCenterProps({
      schedules: schedules(1),
      runs: repeatedRuns,
      subscriptionCapacity: 3,
      subscriptionInUse: 1,
      onViewRun,
    })));

    const liveOperations = screen.getByRole("region", { name: "Live operations" });
    expect(within(liveOperations).getAllByRole("row")).toHaveLength(3);
    const viewButtons = within(liveOperations).getAllByRole("button", { name: "View run" });
    expect(viewButtons).toHaveLength(2);
    fireEvent.click(viewButtons[1]);
    expect(onViewRun).toHaveBeenCalledWith(repeatedRuns[1]);
    expect(screen.getAllByRole("button", { name: /View proof/i })).toHaveLength(1);
  });

  it("offers every runnable schedule in Quick Run and filters the full list", () => {
    render(createElement(CommandCenter, commandCenterProps({ runs: [] })));

    fireEvent.click(screen.getByRole("button", { name: /^Run now$/i }));
    const menu = screen.getByRole("dialog", { name: /choose a schedule/i });
    expect(within(menu).getAllByRole("button")).toHaveLength(15);
    expect(within(menu).getByRole("button", { name: /keyword 15/i })).toBeTruthy();

    fireEvent.change(within(menu).getByLabelText("Search quick-run schedules"), {
      target: { value: "Keyword 15" },
    });

    expect(within(menu).getAllByRole("button")).toHaveLength(1);
    expect(within(menu).getByRole("button", { name: /keyword 15/i })).toBeTruthy();
  });

  it("disables a pending schedule everywhere Run Now can be repeated", () => {
    const onRun = vi.fn();
    render(createElement(CommandCenter, commandCenterProps({
      onRun,
      runs: [{ ...runs()[14], status: "failed" as const }],
      pendingRunIds: new Set(["schedule-15"]),
    })));

    const rowAction = screen.getByRole("button", { name: /queueing keyword 15/i });
    expect(rowAction).toHaveProperty("disabled", true);
    fireEvent.click(rowAction);

    fireEvent.click(screen.getByRole("button", { name: /^Run now$/i }));
    const quickAction = within(screen.getByRole("dialog", { name: /choose a schedule/i }))
      .getByRole("button", { name: /keyword 15/i });
    expect(quickAction).toHaveProperty("disabled", true);
    fireEvent.click(quickAction);

    expect(onRun).not.toHaveBeenCalled();
  });

  it.each([
    "pending",
    "preparing",
    "queued",
    "running",
    "paused",
    "retry_wait",
  ] as const)("does not offer another Run Now while the latest run is %s", (status) => {
    const onRun = vi.fn();
    const openRun: CommandRun = {
      ...runs()[14],
      status,
    };
    render(createElement(CommandCenter, commandCenterProps({
      onRun,
      runs: [openRun],
    })));

    const operationRow = screen.getByRole("cell", { name: "Keyword 15" }).closest("tr");
    expect(operationRow).not.toBeNull();
    const operationActions = within(operationRow as HTMLTableRowElement).getAllByRole("button");
    const runAction = operationActions.at(-1) as HTMLButtonElement;
    expect(runAction).toHaveProperty("disabled", true);
    fireEvent.click(runAction);

    fireEvent.click(screen.getByRole("button", { name: /^Run now$/i }));
    const menu = screen.getByRole("dialog", { name: /choose a schedule/i });
    const quickAction = within(menu).queryByRole("button", { name: /keyword 15/i });
    if (quickAction) {
      expect(quickAction).toHaveProperty("disabled", true);
      fireEvent.click(quickAction);
    }

    expect(onRun).not.toHaveBeenCalled();
  });

  it("returns keyboard focus to the Run now trigger after choosing a schedule", () => {
    render(createElement(CommandCenter, commandCenterProps({ runs: [] })));

    const trigger = screen.getByRole("button", { name: /^Run now$/i });
    fireEvent.click(trigger);
    const menu = screen.getByRole("dialog", { name: /choose a schedule/i });
    fireEvent.click(within(menu).getByRole("button", { name: "Keyword 1Acme · Phone 1" }));

    expect(screen.queryByRole("dialog", { name: /choose a schedule/i })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not map blank provider coordinates to Null Island", () => {
    const onOpenIntegration = vi.fn();
    render(createElement(CommandCenter, commandCenterProps({
      onOpenIntegration,
      phones: [{
        id: "phone-1",
        clientId: "client-acme",
        name: "Phone 1",
        status: 1,
        enabled: true,
        gpsLatitude: "" as unknown as number,
        gpsLongitude: "" as unknown as number,
      }],
    })));

    expect(screen.getByText("0 devices · 0 targets · All clients")).toBeTruthy();
    expect(screen.queryByRole("region", {
      name: /Map showing [1-9]\d* DuoPlus device locations/,
    })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set device locations" }));
    expect(onOpenIntegration).toHaveBeenCalledTimes(1);
  });

  it("renders exactly three worker lanes and places the next job after the first lane frees", () => {
    const activeRuns: CommandRun[] = [
      {
        ...runs()[0],
        status: "running",
        issueAt: "2026-09-06T11:50:00.000Z",
        startedAt: "2026-09-06T11:50:00.000Z",
        expectedDurationSeconds: 1_200,
      },
      {
        ...runs()[1],
        status: "running",
        issueAt: "2026-09-06T11:55:00.000Z",
        startedAt: "2026-09-06T11:55:00.000Z",
        expectedDurationSeconds: 1_800,
      },
      {
        ...runs()[2],
        status: "running",
        issueAt: "2026-09-06T11:45:00.000Z",
        startedAt: "2026-09-06T11:45:00.000Z",
        expectedDurationSeconds: 3_600,
      },
      {
        ...runs()[3],
        status: "pending",
        issueAt: "2026-09-06T12:01:00.000Z",
        expectedDurationSeconds: 600,
      },
    ];

    render(createElement(CommandCenter, commandCenterProps({
      runs: activeRuns,
      subscriptionCapacity: 3,
      subscriptionInUse: 3,
      subscriptionAvailable: 0,
    })));

    const slots = screen.getAllByLabelText(/Worker slot \d/);
    expect(slots).toHaveLength(3);
    expect(screen.getByText("3 worker slots · 4 planned jobs · America/New_York")).toBeTruthy();
    expect(document.querySelectorAll(".workload-block.is-current")).toHaveLength(3);
    const fourthJob = screen.getByRole("button", { name: /Phone 4, Beacon, starts/i });
    // Current RPA duration starts after phone preparation, so the lane keeps
    // the full estimate instead of advertising a slot ten minutes too early.
    expect(fourthJob.title).toMatch(/Planner recommends .+ \(34 min later\)$/);
    const fourthStart = fourthJob.getAttribute("aria-label")?.match(/starts (.+)$/)?.[1];
    expect(fourthJob.closest(".workload-row")?.textContent).toContain(`Free ~ ${fourthStart}`);
    expect(document.querySelectorAll(".workload-block")).toHaveLength(4);
  });

  it("defaults the live workload pool to three slots until capacity is synced", () => {
    render(createElement(CommandCenter, commandCenterProps({
      runs: [],
      subscriptionCapacity: null,
      subscriptionInUse: null,
      subscriptionAvailable: null,
    })));

    expect(screen.getAllByLabelText(/Worker slot \d/)).toHaveLength(3);
    expect(screen.getByText("All 3 slots are free. Due work will be placed here automatically.")).toBeTruthy();
  });

  it("shows an on phone as occupied even when it has no active run", () => {
    const onNotify = vi.fn();
    render(createElement(CommandCenter, commandCenterProps({
      schedules: schedules(1),
      runs: [],
      phones: [{
        id: "phone-1",
        clientId: "client-acme",
        imageId: "IMAGE-1",
        name: "Phone 1",
        status: 1,
        enabled: true,
      }],
      subscriptionCapacity: 3,
      subscriptionInUse: 1,
      subscriptionAvailable: 2,
      onNotify,
    })));

    expect(screen.getByText("3 worker slots · 0 planned jobs · 1 occupied · America/New_York")).toBeTruthy();
    const occupied = screen.getByRole("button", {
      name: "Phone 1, Startup slot occupied without an active run",
    });
    expect(occupied.closest(".workload-row")?.textContent).toContain("Occupied · no active run");
    fireEvent.click(occupied);
    expect(onNotify).toHaveBeenCalledWith(
      "Phone 1 is consuming a Startup slot without an active scheduler run",
    );
  });

  it("renders a target-only map and keeps pins visible if every map tile fails", () => {
    const targetSchedule = {
      ...schedules(1)[0],
      gpsLatitude: "40.7128",
      gpsLongitude: "-74.0060",
    };
    const { container } = render(createElement(CommandCenter, commandCenterProps({
      schedules: [targetSchedule],
      runs: [],
      phones: [],
    })));

    expect(screen.getByRole("region", {
      name: "Map showing 0 DuoPlus device locations and 1 targets",
    })).toBeTruthy();
    expect(screen.getByLabelText("Acme target location")).toBeTruthy();

    const tiles = Array.from(container.querySelectorAll("img.map-tile"));
    expect(tiles).toHaveLength(15);
    tiles.forEach((tile) => fireEvent.error(tile));
    expect(screen.getByText("Map tiles unavailable — location pins are still accurate").getAttribute("role")).toBe("status");
  });

  it("uses one valid coordinate pair in phone, schedule, cycle order", () => {
    const assignedSchedule = {
      ...schedules(1)[0],
      gpsLatitude: "41",
      gpsLongitude: "-72",
    };
    const basePhone = {
      id: "phone-1",
      clientId: "client-acme",
      name: "Phone 1",
      status: 1,
      enabled: true,
      gpsLatitude: 40,
      gpsLongitude: null,
    };
    const props = commandCenterProps({
      schedules: [assignedSchedule],
      runs: [],
      phones: [basePhone],
      cycles: [deviceCycle()],
    });
    const { rerender } = render(createElement(CommandCenter, props));

    expect(screen.getByText("Planned schedule GPS · 41.0000, -72.0000")).toBeTruthy();

    rerender(createElement(CommandCenter, {
      ...props,
      phones: [{ ...basePhone, gpsLongitude: -71 }],
    }));
    expect(screen.getByText("Saved phone GPS · 40.0000, -71.0000")).toBeTruthy();
  });

  it("rejects out-of-range coordinate pairs", () => {
    render(createElement(CommandCenter, commandCenterProps({
      schedules: schedules(1),
      runs: [],
      phones: [{
        id: "phone-1",
        clientId: "client-acme",
        name: "Phone 1",
        status: 1,
        enabled: true,
        gpsLatitude: 91,
        gpsLongitude: -71,
      }],
    })));

    expect(screen.getByText("No device coordinates yet")).toBeTruthy();
  });

  it("selects the first device after async data arrives and offsets it from an exact target overlap", () => {
    const assignedSchedule = {
      ...schedules(1)[0],
      gpsLatitude: "40",
      gpsLongitude: "-71",
    };
    const props = commandCenterProps({ schedules: [assignedSchedule], runs: [], phones: [] });
    const { rerender } = render(createElement(CommandCenter, props));
    const phone = {
      id: "phone-1",
      clientId: "client-acme",
      name: "Phone 1",
      status: 1,
      enabled: true,
      gpsLatitude: 40,
      gpsLongitude: -71,
    };

    rerender(createElement(CommandCenter, { ...props, phones: [phone] }));

    expect(screen.getByText("Saved phone GPS · 40.0000, -71.0000")).toBeTruthy();
    const devicePin = screen.getByRole("button", { name: /Phone 1, Acme, online/i });
    expect(devicePin.style.getPropertyValue("--map-pin-offset-x")).not.toBe("0px");
    expect(devicePin.style.getPropertyValue("--map-pin-offset-y")).not.toBe("0px");
  });

  it("keeps live operation elapsed time moving after the dashboard loads", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    try {
      render(createElement(CommandCenter, commandCenterProps({
        runs: [{
          ...runs()[0],
          status: "running" as const,
          startedAt: "2026-09-06T11:58:00.000Z",
        }],
      })));

      expect(screen.getByRole("cell", { name: "2 min" })).toBeTruthy();
      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByRole("cell", { name: "3 min" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("searches the schedule template catalog while preserving Official and Custom groups", () => {
    render(createElement(OperationsDashboard, {
      initialNow: "2026-09-06T12:00:00.000Z",
      systemReady: false,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Schedules" }));
    fireEvent.click(screen.getByRole("button", { name: /add schedule/i }));

    const templateSearch = screen.getByLabelText("Search templates");
    const templateSelect = screen.getByRole("combobox", { name: "Template" });
    const groupLabels = Array.from(templateSelect.querySelectorAll("optgroup"))
      .map((group) => group.label);
    expect(groupLabels.some((label) => /^Official(?:\s|\(|$)/.test(label))).toBe(true);
    expect(groupLabels.some((label) => /^Custom(?:\s|\(|$)/.test(label))).toBe(true);

    fireEvent.change(templateSearch, { target: { value: "Finder" } });
    expect(screen.getByRole("option", { name: /maps.*finder scan/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /local search/i })).toBeNull();
  });
});

describe("DuoPlus connect and inventory presentation", () => {
  const dialogProps = {
    demoMode: false,
    loading: false,
    error: "",
    apiKey: "",
    showKey: false,
    phones: [],
    clients: [],
    phoneAssignmentSavingIds: new Set<string>(),
    onApiKeyChange: vi.fn(),
    onToggleKey: vi.fn(),
    onConnect: vi.fn(),
    onSync: vi.fn(),
    onAssignPhone: vi.fn(),
    onDisconnect: vi.fn(),
    onClose: vi.fn(),
  };

  it("presents connection and inventory sync as one action", () => {
    render(createElement(IntegrationDialog, {
      ...dialogProps,
      integration: { connected: false },
      syncSummary: null,
    }));

    fireEvent.submit(screen.getByRole("button", { name: "Connect & sync" }).closest("form") as HTMLFormElement);
    expect(dialogProps.onConnect).toHaveBeenCalledTimes(1);

    const source = readFileSync(
      resolve(process.cwd(), "src/components/operations-dashboard.tsx"),
      "utf8",
    );
    const connectStart = source.indexOf("async function connectDuoPlus");
    const connectEnd = source.indexOf("async function assignPhoneClient", connectStart);
    const connectFlow = source.slice(connectStart, connectEnd);
    expect(connectStart).toBeGreaterThan(-1);
    expect(connectFlow).toMatch(/await\s+syncDuoPlusInventory\s*\(\s*\)/);
  });

  it("renders the total and Official/Custom template split after sync", () => {
    const { container } = render(createElement(IntegrationDialog, {
      ...dialogProps,
      integration: {
        connected: true,
        keyHint: "•••• 2b4f",
        verifiedAt: "2026-09-06T12:00:00.000Z",
      },
      syncSummary: {
        phoneCount: 37,
        templateCount: 88,
        officialTemplateCount: 55,
        customTemplateCount: 33,
        subscriptionCapacity: 1,
        subscriptionInUse: 1,
        subscriptionAvailable: 0,
      },
    }));

    expect(container.textContent).toMatch(/88\s*templates/i);
    expect(container.textContent).toMatch(/55\s*official/i);
    expect(container.textContent).toMatch(/33\s*custom/i);
  });

  it("keeps disabled historical phones out of presented inventory counts", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/operations-dashboard.tsx"),
      "utf8",
    );

    expect(source).toMatch(/const activePhones = useMemo\([\s\S]*?phones\.filter\(\(phone\) => phone\.enabled\)/);
    expect(source).toMatch(/phoneCount:\s*activePhones\.length/);
    expect(source).toMatch(/<CommandCenter[\s\S]*?phones=\{activePhones\}/);
    expect(source).toMatch(/<IntegrationDialog[\s\S]*?phones=\{activePhones\}/);
  });

  it("wires command-center run actions to the task-log dialog", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/operations-dashboard.tsx"),
      "utf8",
    );

    expect(source).toContain("onViewRun={setSelectedRunDetail}");
    expect(source).toMatch(/\{selectedRunDetail \? \([\s\S]*?<RunLogDialog[\s\S]*?run=\{selectedRunDetail\}/);
  });
});
