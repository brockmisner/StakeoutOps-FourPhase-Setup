import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  effectiveDuoPlusIssueAt,
  hasScheduleDeviceMutation,
  retryDelayMs,
  runSchedulerTick,
  shouldDeferDeviceMutation,
  submissionMayHaveReachedDuoPlus,
} from "@/lib/scheduler/worker";
import { DuoPlusApiError, type DuoPlusClient } from "@/lib/duoplus";
import type { SchedulerRepository } from "@/lib/scheduler/repository";
import type {
  DuoConnectionRow,
  DuoPhoneRow,
  RunUpdate,
  SchedulerRunContext,
  SchedulerRunRow,
  SchedulerScheduleRow,
  SchedulerSubmissionState,
} from "@/lib/scheduler/types";

const unchangedDeviceSettings = {
  gps_mode: 0,
  gps_latitude: null,
  gps_longitude: null,
  locale_timezone: null,
  locale_language: null,
};

describe("horizon dispatch safety", () => {
  it("allows schedules that leave phone-level settings unchanged", () => {
    expect(hasScheduleDeviceMutation(unchangedDeviceSettings)).toBe(false);
  });

  it.each([
    ["proxy-derived GPS", { ...unchangedDeviceSettings, gps_mode: 1 }],
    [
      "explicit GPS",
      {
        ...unchangedDeviceSettings,
        gps_mode: 2,
        gps_latitude: 25.7907,
        gps_longitude: -80.13,
      },
    ],
    [
      "timezone override",
      { ...unchangedDeviceSettings, locale_timezone: "America/New_York" },
    ],
    ["language override", { ...unchangedDeviceSettings, locale_language: "en-US" }],
  ])("detects a schedule-level device mutation: %s", (_label, settings) => {
    expect(hasScheduleDeviceMutation(settings)).toBe(true);
  });

  it("moves a late task at least two minutes into the future", () => {
    const now = new Date("2026-09-05T14:00:00.000Z");

    expect(
      effectiveDuoPlusIssueAt(
        new Date("2026-09-05T13:30:00.000Z"),
        now,
      ).toISOString(),
    ).toBe("2026-09-05T14:02:00.000Z");
    expect(
      effectiveDuoPlusIssueAt(
        new Date("2026-09-05T15:00:00.000Z"),
        now,
      ).toISOString(),
    ).toBe("2026-09-05T15:00:00.000Z");
  });

  it("defers mutable phone settings until the near-execution window in every tick mode", () => {
    const now = new Date("2026-09-05T14:00:00.000Z");
    const mutable = {
      ...unchangedDeviceSettings,
      gps_mode: 2,
      gps_latitude: 25.7907,
      gps_longitude: -80.13,
    };

    expect(
      shouldDeferDeviceMutation({
        schedule: mutable,
        issueAt: new Date("2026-09-05T14:15:00.000Z"),
        now,
        isExistingTask: false,
      }),
    ).toBe(true);
    expect(
      shouldDeferDeviceMutation({
        schedule: mutable,
        issueAt: new Date("2026-09-05T14:02:00.000Z"),
        now,
        isExistingTask: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferDeviceMutation({
        schedule: mutable,
        issueAt: new Date("2026-09-05T14:15:00.000Z"),
        now,
        isExistingTask: true,
      }),
    ).toBe(false);
  });
});

describe("bounded retry backoff", () => {
  it.each([
    [1, 15_000],
    [2, 30_000],
    [3, 60_000],
    [7, 900_000],
    [50, 900_000],
  ])("maps attempt %s to %sms", (attempt, expected) => {
    expect(retryDelayMs(attempt)).toBe(expected);
  });
});

function schedulerHarness(options: {
  submissionState: SchedulerSubmissionState;
  stage?: SchedulerRunRow["stage"];
  scheduleConfig?: SchedulerScheduleRow["config"];
  scheduleSettings?: Partial<SchedulerScheduleRow>;
  phoneSettings?: Partial<DuoPhoneRow>;
  templateEnabled?: boolean;
  issueAt?: string;
  addTask?: ReturnType<typeof vi.fn>;
  listTasks?: ReturnType<typeof vi.fn>;
  listTaskLogs?: ReturnType<typeof vi.fn>;
  rerunTasks?: ReturnType<typeof vi.fn>;
  updatePhones?: ReturnType<typeof vi.fn>;
  dumpUiHierarchy?: ReturnType<typeof vi.fn>;
  creditProfileRun?: SchedulerRepository["creditProfileRun"];
  finishOpenAttempt?: NonNullable<SchedulerRepository["finishOpenAttempt"]>;
  reconcileProfileScoreCredits?: NonNullable<
    SchedulerRepository["reconcileProfileScoreCredits"]
  >;
  renewRunLease?: NonNullable<SchedulerRepository["renewRunLease"]>;
  isRunSubmissionValid?: SchedulerRepository["isRunSubmissionValid"];
  phoneAssigned?: boolean;
}) {
  const now = new Date("2026-09-05T14:00:00.000Z");
  const phoneAssigned = options.phoneAssigned ?? true;
  const run: SchedulerRunRow = {
    id: "run-1",
    organization_id: "organization-1",
    client_id: "client-1",
    connection_id: "connection-1",
    schedule_id: "schedule-1",
    phone_id: phoneAssigned ? "phone-1" : null,
    template_id: "template-1",
    scheduled_for: options.issueAt ?? "2026-09-05T14:10:00.000Z",
    issue_at: options.issueAt ?? "2026-09-05T14:10:00.000Z",
    expected_duration_seconds: 600,
    status: options.submissionState === "never" ? "pending" : "retry_wait",
    stage:
      options.stage ??
      (options.submissionState === "never" ? "pending" : "resolve_task"),
    next_action_at: now.toISOString(),
    attempt_count: options.submissionState === "never" ? 0 : 1,
    max_attempts: 3,
    task_name: "stk_run-1",
    duoplus_task_id: null,
    duoplus_status: null,
    lease_owner: "worker-1",
    lease_token: "lease-1",
    lease_expires_at: "2026-09-05T14:03:00.000Z",
    phone_lease_token: null,
    claimed_at: now.toISOString(),
    started_at: now.toISOString(),
    finished_at: null,
    last_error: null,
    log_json: null,
    screenshots: [],
    cancellation_requested: false,
    cancellation_requested_at: null,
    device_cycle_id: null,
    program_rule_id: null,
    profile_id: null,
    app_kind: null,
    planned_points: null,
    scoring_version: null,
    cycle_day: null,
    occurrence_key: null,
    window_start_at: null,
    window_end_at: null,
    submission_state: options.submissionState,
    submission_started_at:
      options.submissionState === "never" ? null : now.toISOString(),
    submission_acknowledged_at:
      options.submissionState === "accepted" ? now.toISOString() : null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const schedule: SchedulerScheduleRow = {
    id: "schedule-1",
    organization_id: "organization-1",
    client_id: "client-1",
    connection_id: "connection-1",
    phone_id: phoneAssigned ? "phone-1" : null,
    template_id: "template-1",
    name: "Ordinary schedule",
    keyword: "test keyword",
    config: options.scheduleConfig ?? {},
    cron_expression: "10 14 * * *",
    timezone: "UTC",
    next_run_at: run.issue_at,
    enabled: true,
    ...unchangedDeviceSettings,
    ...options.scheduleSettings,
    max_attempts: 3,
    expected_duration_seconds: 600,
    source_kind: "calendar",
    device_cycle_id: null,
    program_rule_id: null,
    active_from: null,
    active_through: null,
  };
  const phone: DuoPhoneRow = {
    id: "phone-1",
    organization_id: "organization-1",
    connection_id: "connection-1",
    client_id: "client-1",
    duoplus_image_id: "image-1",
    name: "Phone 1",
    status: 1,
    enabled: true,
    expired_at: null,
    busy_until: null,
    lease_run_id: null,
    ...unchangedDeviceSettings,
    ...options.phoneSettings,
  };
  const connection: DuoConnectionRow = {
    id: "connection-1",
    organization_id: "organization-1",
    name: "DuoPlus",
    base_url: "https://openapi.duoplus.net",
    issue_timezone: "UTC",
    api_key_ciphertext: "ciphertext",
    api_key_iv: "iv",
    api_key_auth_tag: "tag",
    credential_generation: 4,
    status: "active",
    min_gap_ms: 1200,
    last_error: null,
    subscription_capacity: 1,
    subscription_in_use: 1,
    subscription_available: 0,
    subscription_synced_at: now.toISOString(),
    capacity_pool_id: null,
  };
  const context: SchedulerRunContext = {
    run,
    schedule,
    phone: phoneAssigned ? phone : null,
    template: {
      id: "template-1",
      organization_id: "organization-1",
      connection_id: "connection-1",
      duoplus_template_id: "remote-template-1",
      template_type: 2,
      name: "Template 1",
      enabled: options.templateEnabled ?? true,
    },
    connection,
  };

  const updateRun = vi.fn(
    async (
      _run: Pick<SchedulerRunRow, "id" | "lease_token">,
      _workerId: string,
      update: RunUpdate,
    ) => {
      Object.assign(run, update);
    },
  );
  const beginRunSubmission = vi.fn(
    async (
      _run: Pick<SchedulerRunRow, "id" | "lease_token">,
      _workerId: string,
      startedAt: Date,
    ) => {
      if (run.submission_state !== "never") return false;
      Object.assign(run, {
        submission_state: "attempting" as const,
        submission_started_at: startedAt.toISOString(),
        submission_acknowledged_at: null,
      });
      return true;
    },
  );
  const creditProfileRun =
    options.creditProfileRun ?? vi.fn(async () => true);
  const markConnectionInvalid = vi.fn(async () => undefined);
  const repository: SchedulerRepository = {
    listSchedulesToMaterialize: vi.fn(async () => []),
    materializeScheduleRuns: vi.fn(async () => 0),
    claimDueRuns: vi.fn(async () => [run]),
    loadRunContext: vi.fn(async () => context),
    getRunPhaseGate: vi.fn(async () => null),
    listCandidatePhones: vi.fn(async () => phoneAssigned ? [phone] : []),
    acquirePhoneLease: vi.fn(async () => true),
    releasePhoneLease: vi.fn(async () => undefined),
    releaseRunLease: vi.fn(async () => undefined),
    renewRunLease: options.renewRunLease,
    updateRun,
    creditProfileRun,
    beginRunSubmission,
    isRunSubmissionValid:
      options.isRunSubmissionValid ?? vi.fn(async () => true),
    updatePhoneSnapshot: vi.fn(async () => undefined),
    updatePhoneLocation: vi.fn(async () => undefined),
    markConnectionInvalid,
    recordEvent: vi.fn(async () => undefined),
    finishOpenAttempt: options.finishOpenAttempt,
  };
  if (options.reconcileProfileScoreCredits) {
    repository.reconcileProfileScoreCredits =
      options.reconcileProfileScoreCredits;
  }
  const addTask = options.addTask ?? vi.fn(async () => ({ task_id: "remote-1" }));
  const listTasks = options.listTasks ?? vi.fn(async () => []);
  const listTaskLogs = options.listTaskLogs ?? vi.fn(async () => []);
  const rerunTasks = options.rerunTasks ?? vi.fn(async () => ({ success: ["remote-1"] }));
  const updatePhones =
    options.updatePhones ?? vi.fn(async () => ({ success: ["image-1"] }));
  const client = {
    getPhone: vi.fn(async () => ({ id: "image-1", status: 1 })),
    addTask,
    listTasks,
    listTaskLogs,
    isRunSubmissionValid: repository.isRunSubmissionValid,
    rerunTasks,
    updatePhones,
    dumpUiHierarchy:
      options.dumpUiHierarchy ?? vi.fn(async () => ({ output: "<hierarchy />" })),
  } as unknown as DuoPlusClient;
  const tick = () =>
    runSchedulerTick({
      repository,
      clientFactory: () => client,
      mode: "minute",
      workerId: "worker-1",
      now,
      clock: { now: () => now },
      sleeper: { sleep: vi.fn(async () => undefined) },
      limit: 1,
    });

  return {
    repository,
    addTask,
    beginRunSubmission,
    creditProfileRun,
    listTasks,
    listTaskLogs,
    markConnectionInvalid,
    recordEvent: repository.recordEvent,
    reconcileProfileScoreCredits: repository.reconcileProfileScoreCredits,
    rerunTasks,
    updatePhoneLocation: repository.updatePhoneLocation,
    updatePhones,
    run,
    tick,
  };
}

describe("run lease lifetime", () => {
  it("renews a claimed run beyond the invocation deadline before provider work", async () => {
    const renewRunLease = vi.fn(async () => true);
    const harness = schedulerHarness({
      submissionState: "never",
      renewRunLease,
    });

    await harness.tick();

    expect(renewRunLease).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", lease_token: "lease-1" }),
      "worker-1",
      300,
    );
  });
});

describe("credential-generation invalidation fence", () => {
  it("invalidates only the credential generation used by the failed run", async () => {
    const harness = schedulerHarness({
      submissionState: "never",
      addTask: vi.fn(async () => {
        throw new DuoPlusApiError({
          endpoint: "/api/v1/automation/addTask",
          httpStatus: 401,
          duoCode: 401,
          message: "invalid key",
        });
      }),
    });

    await harness.tick();

    expect(harness.markConnectionInvalid).toHaveBeenCalledWith(
      "connection-1",
      4,
      expect.any(String),
    );
  });
});

describe("profile phase prerequisites", () => {
  it("waits without leasing a phone or consuming attempts when required app work is missing", async () => {
    const harness = schedulerHarness({ submissionState: "never" });
    harness.run.device_cycle_id = "cycle-1";
    vi.mocked(harness.repository.getRunPhaseGate).mockResolvedValue({
      allowed: false, status: "waiting", blockedPhase: "money",
      missingRequiredRuns: 2, requirements: [],
    });
    await harness.tick();
    expect(harness.repository.acquirePhoneLease).not.toHaveBeenCalled();
    expect(harness.addTask).not.toHaveBeenCalled();
    expect(harness.updatePhones).not.toHaveBeenCalled();
    expect(harness.run.attempt_count).toBe(0);
    expect(harness.run.status).toBe("retry_wait");
    expect(harness.run.last_error).toContain("prerequisites");
  });

  it("ends expired blocked work while preserving the original due window", async () => {
    const harness = schedulerHarness({ submissionState: "never" });
    harness.run.device_cycle_id = "cycle-1";
    harness.run.window_end_at = "2026-09-04T23:59:00.000Z";
    vi.mocked(harness.repository.getRunPhaseGate).mockResolvedValue({
      allowed: false, status: "recovery_required", blockedPhase: "final_squeeze",
      missingRequiredRuns: 3, requirements: [],
    });
    await harness.tick();
    expect(harness.run.last_error).toContain("missed its allowed execution window");
    expect(harness.run.status).toBe("failed");
    expect(harness.repository.getRunPhaseGate).not.toHaveBeenCalled();
    expect(harness.run.window_end_at).toBe("2026-09-04T23:59:00.000Z");
    expect(harness.repository.acquirePhoneLease).not.toHaveBeenCalled();
    expect(harness.run.attempt_count).toBe(0);
  });

  it("keeps an already submitted task reconcilable when its phase is blocked", async () => {
    const harness = schedulerHarness({ submissionState: "unknown", stage: "resolve_task" });
    harness.run.device_cycle_id = "cycle-1";
    await harness.tick();
    expect(harness.repository.getRunPhaseGate).not.toHaveBeenCalled();
    expect(harness.listTasks).toHaveBeenCalled();
    expect(harness.addTask).not.toHaveBeenCalled();
  });

  it("does not power or submit when the phase check cannot be loaded", async () => {
    const harness = schedulerHarness({ submissionState: "never" });
    harness.run.device_cycle_id = "cycle-1";
    vi.mocked(harness.repository.getRunPhaseGate).mockRejectedValue(new Error("Phase check unavailable"));
    await harness.tick();
    expect(harness.repository.acquirePhoneLease).not.toHaveBeenCalled();
    expect(harness.addTask).not.toHaveBeenCalled();
    expect(harness.updatePhones).not.toHaveBeenCalled();
  });
});

describe("duplicate-proof DuoPlus submission", () => {
  it.each([
    ["attempting", "submit_task"],
    ["accepted", "resolve_task"],
    ["unknown", "resolve_task"],
  ] as const)(
    "reconciles submission_state=%s without another addTask call",
    async (submissionState, stage) => {
      const harness = schedulerHarness({ submissionState, stage });

      await harness.tick();

      expect(harness.listTasks).toHaveBeenCalledTimes(1);
      expect(harness.addTask).not.toHaveBeenCalled();
      expect(harness.beginRunSubmission).not.toHaveBeenCalled();
      expect(harness.run.stage).toBe("resolve_task");
      expect(harness.run.submission_state).not.toBe("never");
    },
  );

  it("reconciles a recovered accepted run after its attempt budget is exhausted", async () => {
    const listTasks = vi.fn(async () => [
      {
        id: "recovered-remote-task",
        name: "stk_run-1",
        image_id: "image-1",
        issue_at: "2026-09-05 14:10:00",
        status: 0,
      },
    ]);
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "resolve_task",
      listTasks,
    });
    harness.run.status = "retry_wait";
    harness.run.attempt_count = 3;
    harness.run.max_attempts = 3;
    harness.run.finished_at = null;

    await harness.tick();

    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(harness.beginRunSubmission).not.toHaveBeenCalled();
    expect(harness.addTask).not.toHaveBeenCalled();
    expect(harness.run.duoplus_task_id).toBe("recovered-remote-task");
    expect(harness.run.submission_state).toBe("accepted");
  });

  it("reconciles a persisted task after its phone and template become ineligible", async () => {
    const listTasks = vi.fn(async () => [
      {
        id: "existing-remote-task",
        name: "stk_run-1",
        image_id: "image-1",
        issue_at: "2026-09-05 14:10:00",
        status: 0,
      },
    ]);
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "resolve_task",
      listTasks,
      phoneSettings: {
        enabled: false,
        provider_present: false,
        status: 3,
        expired_at: "2026-09-01T00:00:00.000Z",
      },
      templateEnabled: false,
    });

    await harness.tick();

    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(harness.beginRunSubmission).not.toHaveBeenCalled();
    expect(harness.addTask).not.toHaveBeenCalled();
    expect(harness.run.duoplus_task_id).toBe("existing-remote-task");
    expect(harness.run.submission_state).toBe("accepted");
  });

  it("allows an ordinary never-submitted schedule to call addTask once", async () => {
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "remote-1",
          name: "stk_run-1",
          image_id: "image-1",
          issue_at: "2026-09-05 14:10",
          status: 0,
        },
      ]);
    const harness = schedulerHarness({ submissionState: "never", listTasks });

    await harness.tick();

    expect(listTasks).toHaveBeenNthCalledWith(1, {
      name: "stk_run-1",
      issue_at_start: "2026-09-05 14:00:00",
      issue_at_end: "2026-09-05 14:20:00",
      pagesize: 50,
    });
    expect(harness.beginRunSubmission).toHaveBeenCalledTimes(1);
    expect(harness.addTask).toHaveBeenCalledTimes(1);
    expect(harness.run.submission_state).toBe("accepted");
    expect(harness.run.duoplus_task_id).toBe("remote-1");
  });

  it("uses the post-submit validity guard after acceptance", async () => {
    const isRunSubmissionValid = vi.fn(async () => false);
    const harness = schedulerHarness({
      submissionState: "never",
      isRunSubmissionValid,
    });

    await harness.tick();

    expect(harness.addTask).toHaveBeenCalledTimes(1);
    expect(isRunSubmissionValid).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", lease_token: "lease-1" }),
      "worker-1",
    );
    expect(harness.run.submission_state).toBe("accepted");
    expect(harness.run.duoplus_task_id).toBeNull();
    expect(harness.recordEvent).toHaveBeenCalledWith(
      "run-1",
      "submission_cancelled_after_race",
      "Task was reconciled after a concurrent schedule change",
      { remoteTaskFound: false },
    );
  });

  it("reconciles a previously accepted task before addTask can replay it", async () => {
    const listTasks = vi.fn(async () => [
      {
        id: "already-accepted",
        name: "stk_run-1",
        image_id: "image-1",
        issue_at: "2026-09-05 14:10:00",
        status: 0,
      },
    ]);
    const harness = schedulerHarness({ submissionState: "never", listTasks });

    await harness.tick();

    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(harness.beginRunSubmission).not.toHaveBeenCalled();
    expect(harness.addTask).not.toHaveBeenCalled();
    expect(harness.run.submission_state).toBe("accepted");
    expect(harness.run.duoplus_task_id).toBe("already-accepted");
    expect(harness.recordEvent).toHaveBeenCalledWith(
      "run-1",
      "submission_reconciled_before_create",
      "Existing DuoPlus task was reconciled before addTask; duplicate submission skipped",
      { remoteTaskFound: true },
    );
  });

  it("fails permanently before addTask when stored task config is malformed", async () => {
    const harness = schedulerHarness({
      submissionState: "never",
      scheduleConfig: {
        upload: {
          type: "file",
          value: ["valid-file-id", 42],
          required: true,
        },
      },
    });

    await harness.tick();

    expect(harness.addTask).not.toHaveBeenCalled();
    expect(harness.beginRunSubmission).not.toHaveBeenCalled();
    expect(harness.run.status).toBe("failed");
    expect(harness.run.last_error).toMatch(/invalid task config/i);
  });

  it("fails a legacy unassigned run before phone selection or addTask", async () => {
    const harness = schedulerHarness({
      submissionState: "never",
      phoneAssigned: false,
    });

    await harness.tick();

    expect(harness.addTask).not.toHaveBeenCalled();
    expect(harness.beginRunSubmission).not.toHaveBeenCalled();
    expect(harness.run.status).toBe("failed");
    expect(harness.run.last_error).toMatch(/required phone/i);
  });

  it("does not resubmit after an ambiguous addTask failure", async () => {
    const addTask = vi.fn(async () => {
      throw new DuoPlusApiError({
        endpoint: "/api/v1/automation/addTask",
        message: "Connection closed after request write",
        retryable: true,
      });
    });
    const harness = schedulerHarness({ submissionState: "never", addTask });

    await harness.tick();
    await harness.tick();

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(harness.listTasks).toHaveBeenCalledTimes(3);
    expect(harness.run.submission_state).toBe("unknown");
    expect(harness.run.stage).toBe("resolve_task");
  });

  it("does not submit a cycle task after its eligibility window", async () => {
    const harness = schedulerHarness({ submissionState: "never" });
    harness.run.device_cycle_id = "cycle-1";
    harness.run.program_rule_id = "rule-1";
    harness.run.cycle_day = 10;
    harness.run.occurrence_key = "window:10-11";
    harness.run.window_start_at = "2026-09-04T14:00:00.000Z";
    harness.run.window_end_at = "2026-09-05T14:01:00.000Z";

    await harness.tick();

    expect(harness.addTask).not.toHaveBeenCalled();
    expect(harness.beginRunSubmission).not.toHaveBeenCalled();
    expect(harness.run.status).toBe("failed");
    expect(harness.run.last_error).toMatch(/missed its allowed execution window/i);
  });

  it("classifies every non-never submission state as reconciliation-only", () => {
    for (const submissionState of ["attempting", "accepted", "unknown"] as const) {
      expect(
        submissionMayHaveReachedDuoPlus({
          submission_state: submissionState,
          duoplus_task_id: null,
          stage: "submit_task",
        }),
      ).toBe(true);
    }
  });
});

describe("DuoPlus action evidence", () => {
  it("stores sanitized action totals without using actions as readiness points", async () => {
    const listTasks = vi.fn(async () => [
      {
        id: "remote-1",
        name: "stk_run-1",
        image_id: "image-1",
        issue_at: "2026-09-05 14:10",
        status: 3,
        start_at: "2026-09-05 14:10:01",
        finish_at: "2026-09-05 14:12:03",
        cost_time: 122,
      },
    ]);
    const listTaskLogs = vi.fn(async () => [
      {
        id: "node-1",
        result_info: {
          action: "OPEN_APP",
          result: true,
          extra_data: {
            data: {
              email: "profile@example.com",
              request_body: "do-not-store",
            },
          },
        },
      },
      {
        id: "node-2",
        result_info: {
          action: "CLICK_ELEMENT",
          result: false,
          error_message: "Selector text='private label' failed",
          extra_data: {
            data: { selector_bean_list: [{ text: "private label" }] },
          },
        },
      },
    ]);
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "monitor_task",
      listTasks,
      listTaskLogs,
    });

    await harness.tick();

    expect(harness.run.status).toBe("succeeded");
    expect(harness.run.finished_at).toBe("2026-09-05T14:00:00.000Z");
    expect(harness.run.log_json).toMatchObject({
      schemaVersion: 2,
      actionTelemetryPoints: 0,
      actions: {
        total: 2,
        successful: 1,
        failed: 1,
        byAction: [
          { action: "CLICK_ELEMENT", total: 1, failed: 1 },
          { action: "OPEN_APP", total: 1, successful: 1 },
        ],
      },
    });
    expect(JSON.stringify(harness.run.log_json)).not.toContain("profile@example.com");
    expect(JSON.stringify(harness.run.log_json)).not.toContain("do-not-store");
    expect(JSON.stringify(harness.run.log_json)).not.toContain("private label");
    expect(harness.creditProfileRun).toHaveBeenCalledTimes(1);
  });
});

describe("terminal diagnostic ordering", () => {
  it("commits a final remote failure before attempting the optional UI dump", async () => {
    let observedStatus: SchedulerRunRow["status"] | null = null;
    const dumpUiHierarchy = vi.fn(async () => {
      observedStatus = harness.run.status;
      return { output: "<hierarchy />" };
    });
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "monitor_task",
      dumpUiHierarchy,
      listTasks: vi.fn(async () => [
        {
          id: "remote-1",
          name: "stk_run-1",
          image_id: "image-1",
          issue_at: "2026-09-05 14:10",
          status: 4,
        },
      ]),
    });
    harness.run.max_attempts = 1;

    await harness.tick();

    expect(observedStatus).toBe("failed");
    expect(harness.run.status).toBe("failed");
    expect(dumpUiHierarchy).toHaveBeenCalledTimes(1);
  });
});

describe("profile-readiness score credit", () => {
  it("credits a remotely successful run exactly once", async () => {
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "monitor_task",
      listTasks: vi.fn(async () => [
        {
          id: "remote-1",
          name: "stk_run-1",
          image_id: "image-1",
          issue_at: "2026-09-05 14:10",
          status: 3,
        },
      ]),
    });

    await harness.tick();

    expect(harness.run.status).toBe("succeeded");
    expect(harness.creditProfileRun).toHaveBeenCalledTimes(1);
    expect(harness.creditProfileRun).toHaveBeenCalledWith("run-1", "worker-1");
  });

  it.each([
    ["failed", 4],
    ["cancelled", 5],
  ] as const)("awards zero points when the run is %s", async (status, duoStatus) => {
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "monitor_task",
      listTasks: vi.fn(async () => [
        {
          id: "remote-1",
          name: "stk_run-1",
          image_id: "image-1",
          issue_at: "2026-09-05 14:10",
          status: duoStatus,
        },
      ]),
    });
    harness.run.max_attempts = 1;

    await harness.tick();

    expect(harness.run.status).toBe(status);
    expect(harness.creditProfileRun).not.toHaveBeenCalled();
  });

  it("keeps a proven task successful when readiness credit is temporarily unavailable", async () => {
    const creditProfileRun = vi.fn(async () => {
      throw new Error("readiness ledger unavailable");
    });
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "monitor_task",
      creditProfileRun,
      listTasks: vi.fn(async () => [
        {
          id: "remote-1",
          name: "stk_run-1",
          image_id: "image-1",
          issue_at: "2026-09-05 14:10",
          status: 3,
        },
      ]),
    });

    await harness.tick();

    expect(harness.run.status).toBe("succeeded");
    expect(harness.recordEvent).toHaveBeenCalledWith(
      "run-1",
      "profile_score_credit_failed",
      "readiness ledger unavailable",
      undefined,
    );
  });

  it("credits once after a failed attempt is replayed and eventually succeeds", async () => {
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "remote-1",
          name: "stk_run-1",
          image_id: "image-1",
          issue_at: "2026-09-05 14:10",
          status: 4,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "remote-1",
          name: "stk_run-1",
          image_id: "image-1",
          issue_at: "2026-09-05 14:10",
          status: 3,
        },
      ]);
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "monitor_task",
      listTasks,
    });

    await harness.tick();
    expect(harness.run.status).toBe("queued");
    expect(harness.rerunTasks).toHaveBeenCalledTimes(1);
    expect(harness.creditProfileRun).not.toHaveBeenCalled();

    await harness.tick();
    expect(harness.run.status).toBe("succeeded");
    expect(harness.creditProfileRun).toHaveBeenCalledTimes(1);
  });

  it("does not mark a failed task queued when DuoPlus rejects its replay", async () => {
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "monitor_task",
      listTasks: vi.fn(async () => [
        {
          id: "remote-1",
          name: "stk_run-1",
          image_id: "image-1",
          issue_at: "2026-09-05 14:10",
          status: 4,
        },
      ]),
      rerunTasks: vi.fn(async () => ({
        success: [],
        fail: ["remote-1"],
        fail_reason: { "remote-1": "Completed tasks cannot be replayed" },
      })),
    });

    await harness.tick();

    expect(harness.run.status).toBe("failed");
    expect(harness.run.last_error).toBe("Completed tasks cannot be replayed");
  });

  it("does not persist or submit after DuoPlus rejects phone settings", async () => {
    const harness = schedulerHarness({
      submissionState: "never",
      issueAt: "2026-09-05T14:02:00.000Z",
      scheduleSettings: {
        gps_mode: 2,
        gps_latitude: 25.7907,
        gps_longitude: -80.13,
      },
      updatePhones: vi.fn(async () => ({
        success: [],
        fail: ["image-1"],
        fail_reason: { "image-1": "Location update rejected" },
      })),
    });

    await harness.tick();

    expect(harness.run.status).toBe("failed");
    expect(harness.run.last_error).toContain("Location update rejected");
    expect(harness.updatePhoneLocation).not.toHaveBeenCalled();
    expect(harness.addTask).not.toHaveBeenCalled();
  });

  it("does not overwrite success when attempt bookkeeping fails after terminal commit", async () => {
    const finishOpenAttempt = vi.fn(async () => {
      throw new Error("attempt table unavailable");
    });
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "monitor_task",
      finishOpenAttempt,
      listTasks: vi.fn(async () => [
        {
          id: "remote-1",
          name: "stk_run-1",
          image_id: "image-1",
          issue_at: "2026-09-05 14:10",
          status: 3,
        },
      ]),
    });

    await harness.tick();

    expect(harness.run.status).toBe("succeeded");
    expect(harness.creditProfileRun).toHaveBeenCalledTimes(1);
    expect(harness.recordEvent).toHaveBeenCalledWith(
      "run-1",
      "attempt_finalize_failed",
      "attempt table unavailable",
      undefined,
    );
  });

  it("keeps the tick healthy when bounded score reconciliation is unavailable", async () => {
    const reconcileProfileScoreCredits = vi.fn(async () => {
      throw new Error("RPC is not in the schema cache yet");
    });
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "monitor_task",
      reconcileProfileScoreCredits,
      listTasks: vi.fn(async () => [
        {
          id: "remote-1",
          name: "stk_run-1",
          image_id: "image-1",
          issue_at: "2026-09-05 14:10",
          status: 3,
        },
      ]),
    });

    const summary = await harness.tick();

    expect(reconcileProfileScoreCredits).toHaveBeenCalledWith(1);
    expect(summary.errors).toEqual([]);
    expect(harness.run.status).toBe("succeeded");
  });

  it("replays the bounded missing-credit scan on the next scheduler tick", async () => {
    const reconcileProfileScoreCredits = vi
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    const harness = schedulerHarness({
      submissionState: "accepted",
      stage: "monitor_task",
      reconcileProfileScoreCredits,
      listTasks: vi.fn(async () => [
        {
          id: "remote-1",
          name: "stk_run-1",
          image_id: "image-1",
          issue_at: "2026-09-05 14:10",
          status: 0,
        },
      ]),
    });

    await harness.tick();
    await harness.tick();

    expect(reconcileProfileScoreCredits).toHaveBeenCalledTimes(2);
    expect(reconcileProfileScoreCredits).toHaveBeenNthCalledWith(1, 1);
    expect(reconcileProfileScoreCredits).toHaveBeenNthCalledWith(2, 1);
  });
});
