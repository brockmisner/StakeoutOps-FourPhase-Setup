import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DUOPLUS_PHONE_STATUS,
  DUOPLUS_UI_HIERARCHY_DUMP_COMMAND,
  DuoPlusApiError,
  type DuoPlusClient,
  type DuoPlusPhone,
  type DuoPlusSetTaskStatusData,
  type DuoPlusTask,
  type DuoPlusTaskConfigEntry,
  type DuoPlusUpdatePhonesData,
  isDuoPlusApiError,
  mapDuoPlusTaskStatus,
} from "@/lib/duoplus";
import { sanitizeDuoPlusTaskConfig } from "@/lib/duoplus/task-config";
import {
  defaultTaskConfigForSchema,
  resolvedTemplateConfigSchema,
} from "@/lib/duoplus/template-schema";
import type { Clock, Sleeper } from "@/lib/duoplus/rate-limit";
import { systemClock, systemSleeper } from "@/lib/duoplus/rate-limit";

import { runSchedulerPowerOffSweep } from "./device-power";
import { isPhoneEligibleForNewWork } from "./phone-safety";
import { computeScheduleOccurrences, nextScheduleOccurrence } from "./recurrence";
import type { SchedulerRepository } from "./repository";
import { makeDuoPlusTaskName, selectDuoPlusTaskMatch } from "./task-name";
import { summarizeTaskLogs, taskLogEvidenceAsJson } from "./task-logs";
import { summarizeUiDumpEvidence } from "./ui-dump";
import { addMilliseconds, duoPlusTaskLookupWindow, formatDuoPlusDate } from "./time";
import type {
  DuoConnectionRow,
  RunUpdate,
  SchedulerRunContext,
  SchedulerRunRow,
  SchedulerRunStage,
  SchedulerRunStatus,
  TickSummary,
} from "./types";

export type SchedulerTickMode = "horizon" | "minute";

export type DuoPlusClientFactory = (
  connection: DuoConnectionRow,
) => DuoPlusClient;

export interface SchedulerTickOptions {
  repository?: SchedulerRepository;
  clientFactory?: DuoPlusClientFactory;
  /** Convenience injection used by authenticated API routes. */
  supabase?: SupabaseClient;
  mode?: SchedulerTickMode;
  workerId?: string;
  now?: Date;
  horizonHours?: number;
  lookaheadMinutes?: number;
  limit?: number;
  leaseSeconds?: number;
  phoneLeaseSeconds?: number;
  maxRuntimeMs?: number;
  powerPollIntervalMs?: number;
  powerPollTimeoutMs?: number;
  phoneIdleSeconds?: number;
  powerOffLimit?: number;
  clock?: Clock;
  sleeper?: Sleeper;
}

type RunOutcome =
  | "dispatched"
  | "deferred"
  | "synced"
  | "succeeded"
  | "failed"
  | "cancelled";

class PermanentRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentRunError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown scheduler error";
}

export function retryDelayMs(attemptNumber: number): number {
  return Math.min(15 * 60_000, 15_000 * 2 ** Math.max(0, attemptNumber - 1));
}

export function effectiveDuoPlusIssueAt(scheduledFor: Date, now: Date): Date {
  const minimum = addMilliseconds(now, 2 * 60_000);
  return scheduledFor < minimum ? minimum : scheduledFor;
}

export function hasScheduleDeviceMutation(
  schedule: Pick<
    SchedulerRunContext["schedule"],
    | "gps_mode"
    | "gps_latitude"
    | "gps_longitude"
    | "locale_timezone"
    | "locale_language"
  >,
): boolean {
  return Boolean(
    schedule.gps_mode === 1 ||
      schedule.gps_mode === 2 ||
      schedule.gps_latitude !== null ||
      schedule.gps_longitude !== null ||
      schedule.locale_timezone ||
      schedule.locale_language,
  );
}

export const DEVICE_MUTATION_LEAD_MS = 3 * 60_000;

export function shouldDeferDeviceMutation(options: {
  schedule: Parameters<typeof hasScheduleDeviceMutation>[0];
  issueAt: Date;
  now: Date;
  isExistingTask: boolean;
  leadMs?: number;
}): boolean {
  return (
    !options.isExistingTask &&
    hasScheduleDeviceMutation(options.schedule) &&
    options.issueAt.getTime() >
      options.now.getTime() + (options.leadMs ?? DEVICE_MUTATION_LEAD_MS)
  );
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildDuoPlusTaskConfig(
  keyword: string,
  rawConfig: unknown,
  template?: { name: string; config_schema?: unknown },
): Record<string, DuoPlusTaskConfigEntry> {
  const schema = template
    ? resolvedTemplateConfigSchema(template.name, template.config_schema)
    : null;
  const defaults = schema ? defaultTaskConfigForSchema(schema) : {};
  const result = {
    ...defaults,
    ...sanitizeDuoPlusTaskConfig(jsonRecord(rawConfig)),
  };
  if (schema) {
    const missing = schema.inputs.filter((input) => {
      if (!input.required) return false;
      const entry = result[input.key];
      if (!entry) return true;
      if (Array.isArray(entry.value)) return entry.value.length === 0;
      return String(entry.value).trim() === "";
    });
    if (missing.length) {
      throw new Error(
        `Missing required template inputs: ${missing
          .map((input) => input.key)
          .join(", ")}`,
      );
    }
    return result;
  }
  result.keyword = {
    key: "keyword",
    value: keyword,
    type: "string",
    required: true,
  };
  return result;
}

function extractCreatedTaskId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["task_id", "id"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return null;
}

/**
 * Once a submission has started, a worker crash or network failure can leave
 * us unable to prove whether DuoPlus accepted the request. Treat that state as
 * submitted and reconcile by deterministic name instead of risking a second
 * addTask side effect.
 */
export function submissionMayHaveReachedDuoPlus(
  run: Pick<
    SchedulerRunRow,
    "submission_state" | "duoplus_task_id" | "stage"
  >,
): boolean {
  return Boolean(
    run.duoplus_task_id ||
      (run.submission_state ?? "never") !== "never" ||
      run.stage === "resolve_task" ||
      run.stage === "monitor_task",
  );
}

function submissionVisibilityDeadline(run: SchedulerRunRow): number {
  const issueAt = new Date(run.issue_at).getTime();
  const windowEnd = run.window_end_at
    ? new Date(run.window_end_at).getTime()
    : Number.NaN;
  const reference = Math.max(
    Number.isFinite(issueAt) ? issueAt : 0,
    Number.isFinite(windowEnd) ? windowEnd : 0,
  );
  return reference + run.expected_duration_seconds * 1_000 + 6 * 60 * 60_000;
}

async function safeEvent(
  repository: SchedulerRepository,
  runId: string,
  eventType: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await repository.recordEvent(runId, eventType, message, metadata);
  } catch {
    // Events are useful diagnostics but never gate task dispatch.
  }
}

async function materializeHorizon(
  repository: SchedulerRepository,
  horizonEnd: Date,
  limit: number,
  summary: TickSummary,
): Promise<void> {
  const schedules = await repository.listSchedulesToMaterialize(horizonEnd, limit);
  for (const schedule of schedules) {
    try {
      const occurrences = computeScheduleOccurrences({
        cronExpression: schedule.cron_expression,
        timeZone: schedule.timezone,
        nextRunAt: new Date(schedule.next_run_at),
        horizonEnd,
        maxOccurrences: 500,
      });
      if (occurrences.length === 0) continue;
      const nextRunAt = nextScheduleOccurrence({
        cronExpression: schedule.cron_expression,
        timeZone: schedule.timezone,
        after: occurrences.at(-1)!,
      });
      summary.materialized += await repository.materializeScheduleRuns(
        schedule.id,
        occurrences,
        nextRunAt,
      );
    } catch (error) {
      summary.errors.push({
        message: `Schedule ${schedule.id}: ${errorMessage(error)}`,
      });
    }
  }
}

function validateContext(
  context: SchedulerRunContext,
  isExistingTask: boolean,
): void {
  if (!context.schedule.enabled) return;
  if (!isExistingTask) {
    if (!context.schedule.phone_id || !context.run.phone_id || !context.phone) {
      throw new PermanentRunError(
        "A required phone must be assigned before this schedule can run",
      );
    }
    if (context.phone && !context.phone.enabled) {
      throw new PermanentRunError("Assigned phone is disabled");
    }
    if (!context.template.enabled) {
      throw new PermanentRunError("Assigned RPA template is disabled");
    }
  }
  if (context.connection.status === "invalid") {
    throw new PermanentRunError("DuoPlus connection needs a new API key");
  }
  try {
    formatDuoPlusDate(new Date(0), context.connection.issue_timezone ?? "UTC");
  } catch {
    throw new PermanentRunError("DuoPlus issue timezone is not a valid IANA timezone");
  }
}

function phoneFailure(phone: DuoPlusPhone): PermanentRunError | null {
  switch (phone.status) {
    case DUOPLUS_PHONE_STATUS.EXPIRED:
      return new PermanentRunError("DuoPlus phone is expired");
    case DUOPLUS_PHONE_STATUS.RENEWAL_OVERDUE:
      return new PermanentRunError("DuoPlus phone renewal is overdue");
    case DUOPLUS_PHONE_STATUS.NOT_CONFIGURED:
      return new PermanentRunError("DuoPlus phone is not configured");
    case DUOPLUS_PHONE_STATUS.CONFIG_FAILED:
      return new PermanentRunError("DuoPlus phone configuration failed");
    default:
      return null;
  }
}

async function setDeferred(
  repository: SchedulerRepository,
  run: SchedulerRunRow,
  workerId: string,
  clock: Clock,
  options: {
    message: string;
    stage: SchedulerRunStage;
    delayMs: number;
    incrementAttempt?: boolean;
    finishAttempt?: boolean;
    preservePreparation?: boolean;
    status?: SchedulerRunStatus;
  },
): Promise<RunOutcome> {
  const attemptCount =
    run.attempt_count + (options.incrementAttempt === false ? 0 : 1);
  const update: RunUpdate = {
    status:
      options.status ??
      (options.preservePreparation ? "preparing" : "retry_wait"),
    stage: options.stage,
    next_action_at: addMilliseconds(clock.now(), options.delayMs).toISOString(),
    last_error: options.message,
  };
  if (options.incrementAttempt !== false) update.attempt_count = attemptCount;
  await repository.updateRun(run, workerId, update);
  if (
    (options.incrementAttempt !== false || options.finishAttempt) &&
    repository.finishOpenAttempt
  ) {
    await repository.finishOpenAttempt(
      run.id,
      "failed",
      options.stage,
      options.message,
      run.duoplus_task_id,
    );
  }
  await safeEvent(repository, run.id, "deferred", options.message, {
    stage: options.stage,
    attemptCount,
  });
  return "deferred";
}

async function markTerminal(
  repository: SchedulerRepository,
  run: SchedulerRunRow,
  workerId: string,
  clock: Clock,
  outcome: "succeeded" | "failed" | "cancelled",
  extra: RunUpdate = {},
): Promise<RunOutcome> {
  await repository.updateRun(run, workerId, {
    ...extra,
    status: outcome,
    stage: outcome === "failed" ? "error" : "complete",
    finished_at: clock.now().toISOString(),
    next_action_at: clock.now().toISOString(),
  });
  if (repository.finishOpenAttempt) {
    try {
      await repository.finishOpenAttempt(
        run.id,
        outcome === "cancelled" ? "cancelled" : outcome,
        outcome === "failed" ? "error" : "complete",
        extra.last_error ?? null,
        extra.duoplus_task_id ?? run.duoplus_task_id,
      );
    } catch (error) {
      // Once the terminal run row is committed, secondary bookkeeping must not
      // bubble into processClaimedRun and overwrite that proven terminal state.
      await safeEvent(
        repository,
        run.id,
        "attempt_finalize_failed",
        errorMessage(error),
      );
    }
  }
  if (outcome === "succeeded") {
    try {
      const credited = await repository.creditProfileRun(run.id, workerId);
      if (credited) {
        await safeEvent(
          repository,
          run.id,
          "profile_score_credited",
          "Successful run credited to profile readiness",
        );
      }
    } catch (error) {
      // The database's succeeded-run trigger is the authoritative credit path.
      // This explicit idempotent call also self-heals rows created before that
      // trigger existed, but its failure must never rewrite a proven DuoPlus
      // success as a failed automation run.
      await safeEvent(
        repository,
        run.id,
        "profile_score_credit_failed",
        errorMessage(error),
      );
    }
  }
  await safeEvent(repository, run.id, outcome, extra.last_error ?? outcome);
  return outcome;
}

export async function waitForPhoneOn(options: {
  client: DuoPlusClient;
  imageId: string;
  initialPhone: DuoPlusPhone;
  mode: SchedulerTickMode;
  clock: Clock;
  sleeper: Sleeper;
  pollIntervalMs: number;
  timeoutMs: number;
  deadline: number;
  beforePowerOn?: () => Promise<boolean>;
  onPowerOnAccepted?: () => Promise<void>;
}): Promise<DuoPlusPhone | null> {
  let phone = options.initialPhone;
  if (phone.status === DUOPLUS_PHONE_STATUS.OFF) {
    const shouldRequest = await options.beforePowerOn?.() ?? true;
    if (shouldRequest) {
      await options.client.powerOn([options.imageId]);
      await options.onPowerOnAccepted?.();
    }
  }
  if (phone.status === DUOPLUS_PHONE_STATUS.ON) return phone;
  if (options.mode === "minute") return null;

  const expiresAt = Math.min(
    options.clock.now().getTime() + options.timeoutMs,
    options.deadline,
  );
  while (options.clock.now().getTime() + options.pollIntervalMs < expiresAt) {
    await options.sleeper.sleep(options.pollIntervalMs);
    const refreshed = await options.client.getPhone(options.imageId);
    if (!refreshed) continue;
    phone = refreshed;
    const failure = phoneFailure(phone);
    if (failure) throw failure;
    if (phone.status === DUOPLUS_PHONE_STATUS.ON) return phone;
  }
  return null;
}

async function resolveTask(options: {
  client: DuoPlusClient;
  run: SchedulerRunRow;
  imageId?: string;
  issueAt: Date;
  issueTimeZone?: string;
  mode: SchedulerTickMode;
  sleeper: Sleeper;
  attempts?: number;
}): Promise<DuoPlusTask | null> {
  const lookupWindow = duoPlusTaskLookupWindow(
    options.issueAt,
    options.issueTimeZone ?? "UTC",
  );
  const attempts = options.attempts ?? (options.mode === "horizon" ? 3 : 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await options.sleeper.sleep(2_000);
    const tasks = await options.client.listTasks({
      name: makeDuoPlusTaskName(options.run.id),
      issue_at_start: lookupWindow.start,
      issue_at_end: lookupWindow.end,
      pagesize: 50,
    });
    const byId = options.run.duoplus_task_id
      ? tasks.find((task) => task.id === options.run.duoplus_task_id)
      : null;
    const match =
      byId ??
      selectDuoPlusTaskMatch(tasks, {
        runId: options.run.id,
        imageId: options.imageId,
        issueAt: options.issueAt,
        issueTimeZone: options.issueTimeZone,
      });
    if (match) return match;
  }
  return null;
}

function mutationAccepted(
  result: { success?: string[]; fail?: string[] },
  taskId: string,
): boolean {
  if (result.fail?.includes(taskId)) return false;
  return result.success?.includes(taskId) === true;
}

function mutationFailureReason(
  result: {
    fail_reason?: Record<string, string> | string;
  },
  id: string,
  fallback: string,
): string {
  const reason =
    typeof result.fail_reason === "string"
      ? result.fail_reason
      : result.fail_reason?.[id];
  return typeof reason === "string" && reason.trim() ? reason.trim() : fallback;
}

async function cancelForDisabledSchedule(options: {
  repository: SchedulerRepository;
  client: DuoPlusClient;
  context: SchedulerRunContext;
  workerId: string;
  mode: SchedulerTickMode;
  clock: Clock;
  sleeper: Sleeper;
}): Promise<RunOutcome> {
  const { repository, client, context, workerId, mode, clock, sleeper } = options;
  const { run } = context;
  let task: DuoPlusTask | null = null;
  if (run.duoplus_task_id) {
    task = await resolveTask({
      client,
      run,
      imageId: context.phone?.duoplus_image_id,
      issueAt: new Date(run.issue_at),
      issueTimeZone: context.connection.issue_timezone,
      mode,
      sleeper,
    });
    task ??= {
      id: run.duoplus_task_id,
      name: run.task_name ?? makeDuoPlusTaskName(run.id),
      status: run.duoplus_status ?? 0,
    };
  } else if (
    run.stage === "prepare_phone" ||
    run.stage === "wait_phone" ||
    run.stage === "apply_settings" ||
    run.stage === "submit_task" ||
    run.stage === "resolve_task" ||
    run.stage === "cancel_task"
  ) {
    task = await resolveTask({
      client,
      run,
      imageId: context.phone?.duoplus_image_id,
      issueAt: new Date(run.issue_at),
      issueTimeZone: context.connection.issue_timezone,
      mode,
      sleeper,
    });
  }

  if (!task) {
    return markTerminal(repository, run, workerId, clock, "cancelled", {
      last_error: "Schedule was disabled before DuoPlus accepted a task",
    });
  }
  if (task.status === 3) {
    return markTerminal(repository, run, workerId, clock, "succeeded", {
      duoplus_task_id: task.id,
      duoplus_status: task.status,
      last_error: null,
    });
  }
  if (task.status === 4) {
    return markTerminal(repository, run, workerId, clock, "failed", {
      duoplus_task_id: task.id,
      duoplus_status: task.status,
      last_error: "DuoPlus task failed before cancellation",
    });
  }
  if (task.status === 5) {
    return markTerminal(repository, run, workerId, clock, "cancelled", {
      duoplus_task_id: task.id,
      duoplus_status: 5,
      last_error: null,
    });
  }

  try {
    const result = await client.cancelTasks([task.id]);
    if (!mutationAccepted(result, task.id)) {
      if (run.attempt_count >= run.max_attempts) {
        return markTerminal(repository, run, workerId, clock, "failed", {
          duoplus_task_id: task.id,
          last_error:
            "DuoPlus rejected the final cancellation attempt; manual cancellation is required",
        });
      }
      return setDeferred(repository, run, workerId, clock, {
        message: "DuoPlus did not accept the cancellation request",
        stage: "cancel_task",
        delayMs: retryDelayMs(run.attempt_count + 1),
      });
    }
  } catch (error) {
    if (run.attempt_count >= run.max_attempts) {
      return markTerminal(repository, run, workerId, clock, "failed", {
        duoplus_task_id: task.id,
        last_error: `Final cancellation attempt failed; manual cancellation is required: ${errorMessage(error)}`,
      });
    }
    return setDeferred(repository, run, workerId, clock, {
      message: `Cancellation will retry: ${errorMessage(error)}`,
      stage: "cancel_task",
      delayMs: retryDelayMs(run.attempt_count + 1),
    });
  }
  return markTerminal(repository, run, workerId, clock, "cancelled", {
    duoplus_task_id: task.id,
    duoplus_status: 5,
    last_error: null,
  });
}

async function storeLogs(
  repository: SchedulerRepository,
  client: DuoPlusClient,
  run: SchedulerRunRow,
  workerId: string,
): Promise<{ errorMessage: string | null }> {
  if (!run.duoplus_task_id) return { errorMessage: null };
  const logs = await client.listTaskLogs({
    task_id: run.duoplus_task_id,
    pagesize: 250,
  });
  const { summaries, screenshots, evidence } = summarizeTaskLogs(logs);
  const latestError = [...summaries]
    .reverse()
    .find((entry) => entry.errorMessage)?.errorMessage ?? null;
  await repository.updateRun(run, workerId, {
    log_json: taskLogEvidenceAsJson(evidence),
    screenshots,
  });
  return { errorMessage: latestError };
}

/**
 * Best-effort selector evidence for a final remote RPA failure. The command is
 * fixed, bounded by the DuoPlus client, and its result is recorded only as an
 * event. A diagnostic outage must not replace or retry the original outcome.
 */
export async function captureFailedRpaUiDump(options: {
  repository: SchedulerRepository;
  client: DuoPlusClient;
  run: SchedulerRunRow;
  imageId: string | null | undefined;
}): Promise<void> {
  const { repository, client, run, imageId } = options;
  if (!imageId) return;
  try {
    const evidence = await client.dumpUiHierarchy(imageId);
    await safeEvent(
      repository,
      run.id,
      "ui_dump_captured",
      "Captured Android UI hierarchy after the final RPA failure",
      {
        diagnosticType: "android_ui_hierarchy",
        source: "duoplus_cloud_phone_command",
        command: DUOPLUS_UI_HIERARCHY_DUMP_COMMAND,
        scorePoints: 0,
        evidence: summarizeUiDumpEvidence(evidence),
      },
    );
  } catch (error) {
    await safeEvent(
      repository,
      run.id,
      "ui_dump_unavailable",
      "Android UI hierarchy could not be captured after the final RPA failure",
      {
        diagnosticType: "android_ui_hierarchy",
        source: "duoplus_cloud_phone_command",
        scorePoints: 0,
        error: errorMessage(error),
      },
    );
  }
}

async function syncTask(options: {
  repository: SchedulerRepository;
  client: DuoPlusClient;
  context: SchedulerRunContext;
  task: DuoPlusTask;
  workerId: string;
  clock: Clock;
}): Promise<RunOutcome> {
  const { repository, client, context, task, workerId, clock } = options;
  const { run } = context;
  const status = mapDuoPlusTaskStatus(task.status);
  const taskFields: RunUpdate = {
    duoplus_task_id: task.id,
    duoplus_status: task.status,
    task_name: makeDuoPlusTaskName(run.id),
    submission_state: "accepted",
    submission_started_at:
      run.submission_started_at ?? clock.now().toISOString(),
    submission_acknowledged_at:
      run.submission_acknowledged_at ?? clock.now().toISOString(),
    last_error: null,
  };

  if (status === "queued" || status === "paused") {
    const issueAt = new Date(run.issue_at);
    const nextCheck =
      issueAt > clock.now()
        ? addMilliseconds(issueAt, 60_000)
        : addMilliseconds(clock.now(), status === "paused" ? 5 * 60_000 : 60_000);
    await repository.updateRun(run, workerId, {
      ...taskFields,
      status,
      stage: "monitor_task",
      next_action_at: nextCheck.toISOString(),
    });
    return run.duoplus_task_id ? "synced" : "dispatched";
  }

  if (status === "running") {
    await repository.updateRun(run, workerId, {
      ...taskFields,
      status: "running",
      stage: "monitor_task",
      started_at: run.started_at ?? task.start_at ?? clock.now().toISOString(),
      next_action_at: addMilliseconds(clock.now(), 60_000).toISOString(),
    });
    return "synced";
  }

  if (status === "cancelled") {
    return markTerminal(repository, run, workerId, clock, "cancelled", taskFields);
  }

  if (status === "succeeded" || status === "failed") {
    const runWithTask = { ...run, duoplus_task_id: task.id };
    let storedError: string | null = null;
    try {
      storedError = (await storeLogs(repository, client, runWithTask, workerId)).errorMessage;
    } catch (error) {
      await safeEvent(repository, run.id, "log_sync_failed", errorMessage(error));
    }

    if (status === "failed") {
      const currentAttempt = Math.max(1, run.attempt_count);
      if (currentAttempt < run.max_attempts) {
        if (repository.finishOpenAttempt) {
          await repository.finishOpenAttempt(
            run.id,
            "failed",
            "fetch_logs",
            storedError ?? "DuoPlus task failed",
            task.id,
          );
        }
        const replay = (await client.rerunTasks([
          task.id,
        ])) as DuoPlusSetTaskStatusData;
        if (!mutationAccepted(replay, task.id)) {
          return markTerminal(repository, run, workerId, clock, "failed", {
            ...taskFields,
            last_error: mutationFailureReason(
              replay,
              task.id,
              "DuoPlus did not confirm the task replay request",
            ),
          });
        }
        if (repository.startAttempt) {
          await repository.startAttempt(
            run.id,
            context.phone?.id ?? run.phone_id,
            currentAttempt + 1,
            workerId,
            "monitor_task",
            task.id,
          );
        }
        await repository.updateRun(run, workerId, {
          ...taskFields,
          status: "queued",
          stage: "monitor_task",
          attempt_count: currentAttempt + 1,
          last_error: storedError ?? "DuoPlus task failed; retry queued",
          next_action_at: addMilliseconds(
            clock.now(),
            retryDelayMs(currentAttempt + 1),
          ).toISOString(),
        });
        await safeEvent(repository, run.id, "retry_queued", "DuoPlus task replay requested", {
          attempt: currentAttempt + 1,
        });
        return "deferred";
      }
      const terminalOutcome = await markTerminal(
        repository,
        run,
        workerId,
        clock,
        "failed",
        {
          ...taskFields,
          last_error: storedError ?? "DuoPlus task failed",
        },
      );
      // Commit the canonical remote failure before spending up to ten seconds
      // on optional selector evidence. A function timeout can now lose only
      // the diagnostic, never the proven DuoPlus outcome.
      await captureFailedRpaUiDump({
        repository,
        client,
        run,
        imageId: context.phone?.duoplus_image_id,
      });
      return terminalOutcome;
    }

    return markTerminal(repository, run, workerId, clock, "succeeded", taskFields);
  }

  return setDeferred(repository, run, workerId, clock, {
    message: `Unknown DuoPlus task status ${task.status}`,
    stage: "monitor_task",
    delayMs: 5 * 60_000,
  });
}

async function processRun(options: {
  repository: SchedulerRepository;
  client: DuoPlusClient;
  context: SchedulerRunContext;
  workerId: string;
  mode: SchedulerTickMode;
  clock: Clock;
  sleeper: Sleeper;
  phoneLeaseSeconds: number;
  powerPollIntervalMs: number;
  powerPollTimeoutMs: number;
  deadline: number;
  phoneSnapshotCache: Map<string, DuoPlusPhone>;
}): Promise<RunOutcome> {
  const {
    repository,
    client,
    context,
    workerId,
    mode,
    clock,
    sleeper,
  } = options;
  const { run, schedule, template } = context;
  let phone = context.phone;
  let phoneLeaseAcquired = false;

  try {
    if (!schedule.enabled || run.cancellation_requested) {
      return cancelForDisabledSchedule({
        repository,
        client,
        context,
        workerId,
        mode,
        clock,
        sleeper,
      });
    }
    let submissionState = run.submission_state ?? "never";
    if (
      submissionState !== "never" &&
      !run.duoplus_task_id &&
      run.stage !== "resolve_task" &&
      run.stage !== "monitor_task" &&
      run.stage !== "cancel_task"
    ) {
      // `attempting` may mean a process died immediately before or after the
      // network write. Promote it to `unknown` and move directly to the
      // reconciliation path. This also lets the database phone lease regard
      // the run as an existing external-task concern rather than a new start.
      submissionState = submissionState === "attempting" ? "unknown" : submissionState;
      await repository.updateRun(run, workerId, {
        submission_state: submissionState,
        stage: "resolve_task",
        last_error:
          submissionState === "unknown"
            ? "DuoPlus submission outcome is unknown; automatic resubmission is blocked"
            : run.last_error,
      });
      run.submission_state = submissionState;
      run.stage = "resolve_task";
    }
    const isExistingTask = submissionMayHaveReachedDuoPlus(run);
    // A task that may already exist remotely must remain reconcilable even if
    // its phone or template was disabled later. New addTask work still fails
    // closed on those eligibility gates.
    validateContext(context, isExistingTask);
    let taskConfig: Record<string, DuoPlusTaskConfigEntry> | undefined;
    if (!isExistingTask) {
      try {
        taskConfig = buildDuoPlusTaskConfig(
          schedule.keyword,
          schedule.config,
          template,
        );
      } catch (error) {
        throw new PermanentRunError(`Invalid task config: ${errorMessage(error)}`);
      }
    }
    const taskIssueAt = isExistingTask
      ? new Date(run.issue_at)
      : effectiveDuoPlusIssueAt(new Date(run.issue_at), clock.now());
    const eligibilityEndsAt = run.window_end_at
      ? new Date(run.window_end_at)
      : null;
    if (
      !isExistingTask &&
      eligibilityEndsAt &&
      taskIssueAt.getTime() >= eligibilityEndsAt.getTime()
    ) {
      return markTerminal(repository, run, workerId, clock, "failed", {
        last_error:
          "The cycle task missed its allowed execution window and was not submitted",
      });
    }
    if (!isExistingTask && run.device_cycle_id) {
      const phaseGate = await repository.getRunPhaseGate(run);
      if (phaseGate && !phaseGate.allowed) {
        const missing = phaseGate.missingRequiredRuns || 0;
        const phaseName = (phaseGate.blockedPhase ?? "next phase").replaceAll("_", " ");
        return setDeferred(repository, run, workerId, clock, {
          message: phaseGate.reason || phaseGate.message || (
            phaseGate.status === "recovery_required"
              ? `Profile recovery required before ${phaseName}; ${missing} required runs remain incomplete`
              : `Waiting for ${phaseName} prerequisites, including required app completions and active days`
          ),
          stage: run.stage,
          delayMs: 60_000,
          incrementAttempt: false,
        });
      }
    }
    if (
      shouldDeferDeviceMutation({
        schedule,
        issueAt: taskIssueAt,
        now: clock.now(),
        isExistingTask,
      })
    ) {
      const resumeAt = new Date(
        Math.max(clock.now().getTime() + 15_000, taskIssueAt.getTime() - 2 * 60_000),
      );
      await repository.updateRun(run, workerId, {
        status: "retry_wait",
        stage: "apply_settings",
        next_action_at: resumeAt.toISOString(),
        last_error:
          "Waiting until the safe execution window to apply GPS/locale",
      });
      await safeEvent(
        repository,
        run.id,
        "device_mutation_deferred",
        "Future phone settings were not mutated before the safe execution window",
        { resumeAt: resumeAt.toISOString() },
      );
      return "deferred";
    }

    const candidates = await repository.listCandidatePhones(context);
    for (const candidate of candidates) {
      if (
        !isExistingTask &&
        !isPhoneEligibleForNewWork(candidate, clock.now())
      ) {
        continue;
      }
      const acquired = await repository.acquirePhoneLease(
        candidate.id,
        run,
        workerId,
        options.phoneLeaseSeconds,
      );
      if (acquired) {
        phone = candidate;
        phoneLeaseAcquired = true;
        break;
      }
    }
    if (!phoneLeaseAcquired) {
      return setDeferred(repository, run, workerId, clock, {
        message:
          candidates.length === 0
            ? "No eligible phone is available for this client and connection"
            : context.connection.subscription_capacity == null
              ? "DuoPlus Subscription Startup capacity has not been synced"
              : "All eligible phones are busy, overlap another run, or Subscription Startup capacity is full",
        stage: run.stage,
        delayMs: 30_000,
        incrementAttempt: false,
      });
    }
    if (!phone) throw new PermanentRunError("Phone lease succeeded without a phone");
    context.phone = phone;

    if (isExistingTask) {
      const task = await resolveTask({
        client,
        run,
        imageId: phone.duoplus_image_id,
        issueAt: taskIssueAt,
        issueTimeZone: context.connection.issue_timezone,
        mode,
        sleeper,
      });
      if (task) {
        return syncTask({ repository, client, context, task, workerId, clock });
      }
      if (run.duoplus_task_id) {
        const visibilityDeadline = submissionVisibilityDeadline(run);
        if (clock.now().getTime() > visibilityDeadline) {
          return markTerminal(repository, run, workerId, clock, "failed", {
            last_error:
              "Known DuoPlus task disappeared from taskList beyond the reconciliation window",
          });
        }
        return setDeferred(repository, run, workerId, clock, {
          message: "DuoPlus task is temporarily absent from taskList",
          stage: "monitor_task",
          delayMs: retryDelayMs(run.attempt_count + 1),
          incrementAttempt: false,
          status: ["queued", "running", "paused"].includes(run.status)
            ? run.status
            : "queued",
        });
      }
      if (clock.now().getTime() > submissionVisibilityDeadline(run)) {
        return markTerminal(repository, run, workerId, clock, "failed", {
          submission_state:
            submissionState === "never" ? "unknown" : submissionState,
          submission_started_at:
            run.submission_started_at ?? run.started_at ?? clock.now().toISOString(),
          last_error:
            "No DuoPlus task became visible before the reconciliation deadline; automatic resubmission was blocked",
        });
      }
      return setDeferred(repository, run, workerId, clock, {
        message:
          submissionState === "accepted"
            ? "Task was accepted; waiting for taskList without resubmitting"
            : "Submission may have reached DuoPlus; reconciling without resubmitting",
        stage: "resolve_task",
        delayMs: retryDelayMs(run.attempt_count + 1),
        incrementAttempt: false,
      });
    }

    // Reconcile by the durable task name before the only addTask side effect.
    // This protects runs created by older workers (or recovered after a partial
    // outage) where DuoPlus accepted the task but the local submission fields
    // were never advanced. One snapshot is enough here; post-submit visibility
    // polling still uses the bounded multi-attempt path above.
    const preexistingTask = await resolveTask({
      client,
      run,
      imageId: phone.duoplus_image_id,
      issueAt: taskIssueAt,
      issueTimeZone: context.connection.issue_timezone,
      mode,
      sleeper,
      attempts: 1,
    });
    if (preexistingTask) {
      await safeEvent(
        repository,
        run.id,
        "submission_reconciled_before_create",
        "Existing DuoPlus task was reconciled before addTask; duplicate submission skipped",
        { remoteTaskFound: true },
      );
      return syncTask({
        repository,
        client,
        context,
        task: preexistingTask,
        workerId,
        clock,
      });
    }

    await repository.updateRun(run, workerId, {
      status: "preparing",
      stage: "prepare_phone",
      task_name: makeDuoPlusTaskName(run.id),
      issue_at: taskIssueAt.toISOString(),
      last_error: null,
    });

    const phoneCacheKey = `${context.connection.id}:${phone.duoplus_image_id}`;
    const currentPhone =
      options.phoneSnapshotCache.get(phoneCacheKey) ??
      (await client.getPhone(phone.duoplus_image_id));
    if (!currentPhone) {
      throw new DuoPlusApiError({
        endpoint: "/api/v1/cloudPhone/list",
        message: `DuoPlus phone ${phone.duoplus_image_id} was not found`,
        retryable: true,
      });
    }
    try {
      await repository.updatePhoneSnapshot(phone.id, currentPhone);
    } catch {
      // Inventory freshness must not block a task that can safely run.
    }
    const failure = phoneFailure(currentPhone);
    if (failure) throw failure;

    if (currentPhone.status !== DUOPLUS_PHONE_STATUS.ON) {
      await repository.updateRun(run, workerId, {
        status: "preparing",
        stage: "wait_phone",
      });
      const readyPhone = await waitForPhoneOn({
        client,
        imageId: phone.duoplus_image_id,
        initialPhone: currentPhone,
        mode,
        clock,
        sleeper,
        pollIntervalMs: options.powerPollIntervalMs,
        timeoutMs: options.powerPollTimeoutMs,
        deadline: options.deadline,
        beforePowerOn: async () => {
          if (!repository.claimPhonePowerOnAttempt) return true;
          return repository.claimPhonePowerOnAttempt(
            phone!.id,
            run.id,
            clock.now(),
          );
        },
        onPowerOnAccepted: async () => {
          if (!repository.markPhonePowerRequested) return;
          try {
            const recorded = await repository.markPhonePowerRequested(
              phone!.id,
              run.id,
              clock.now(),
            );
            if (!recorded) {
              await safeEvent(
                repository,
                run.id,
                "phone_power_ownership_unrecorded",
                "Phone power-on was requested, but automatic shutdown ownership was not recorded",
              );
            }
          } catch (error) {
            // Running the requested task is still safe. Fail open for task
            // dispatch but fail closed for later automatic power-off.
            await safeEvent(
              repository,
              run.id,
              "phone_power_ownership_unrecorded",
              errorMessage(error),
            );
          }
        },
      });
      if (!readyPhone) {
        const preparationAge = run.started_at
          ? clock.now().getTime() - new Date(run.started_at).getTime()
          : 0;
        const timedOut =
          mode === "horizon" || preparationAge >= options.powerPollTimeoutMs;
        if (timedOut && run.attempt_count + 1 >= run.max_attempts) {
          return markTerminal(repository, run, workerId, clock, "failed", {
            attempt_count: run.attempt_count + 1,
            last_error: "Phone did not reach the on state after bounded power-on retries",
          });
        }
        return setDeferred(repository, run, workerId, clock, {
          message: "Phone power-on is still in progress",
          stage: "wait_phone",
          delayMs: 15_000,
          incrementAttempt: timedOut,
          preservePreparation: !timedOut,
        });
      }
      try {
        await repository.updatePhoneSnapshot(phone.id, readyPhone);
      } catch {
        // The confirmed scheduler ownership record below is the shutdown
        // boundary. A later inventory sync can repair this cached status.
      }
      options.phoneSnapshotCache.set(phoneCacheKey, readyPhone);
    } else {
      options.phoneSnapshotCache.set(phoneCacheKey, currentPhone);
    }

    if (repository.confirmPhoneSchedulerPoweredOn) {
      try {
        await repository.confirmPhoneSchedulerPoweredOn(
          phone.id,
          run.id,
          clock.now(),
        );
      } catch (error) {
        // Without durable confirmation this phone is intentionally never an
        // automatic power-off candidate.
        await safeEvent(
          repository,
          run.id,
          "phone_power_confirmation_failed",
          errorMessage(error),
        );
      }
    }

    const gpsMode = schedule.gps_mode;
    const latitude = schedule.gps_latitude;
    const longitude = schedule.gps_longitude;
    const localeTimezone = schedule.locale_timezone;
    const localeLanguage = schedule.locale_language;
    if (gpsMode === 2 && (latitude === null || longitude === null)) {
      throw new PermanentRunError("Explicit GPS mode requires latitude and longitude");
    }
    if (gpsMode === 1 || gpsMode === 2 || localeTimezone || localeLanguage) {
      await repository.updateRun(run, workerId, { stage: "apply_settings" });
      const phoneUpdate = (await client.updatePhones({
        images: [
          {
            image_id: phone.duoplus_image_id,
            gps:
              gpsMode === 1
                ? { type: 1 }
                : gpsMode === 2 && latitude !== null && longitude !== null
                  ? { type: 2, latitude, longitude }
                  : undefined,
            locale:
              localeTimezone || localeLanguage
                ? {
                    type: 2,
                    timezone: localeTimezone ?? undefined,
                    language: localeLanguage ?? undefined,
                  }
                : undefined,
          },
        ],
      })) as DuoPlusUpdatePhonesData;
      if (!mutationAccepted(phoneUpdate, phone.duoplus_image_id)) {
        const reason = mutationFailureReason(
          phoneUpdate,
          phone.duoplus_image_id,
          "DuoPlus did not confirm the phone settings update",
        );
        if (phoneUpdate.fail?.includes(phone.duoplus_image_id)) {
          throw new PermanentRunError(`DuoPlus rejected phone settings: ${reason}`);
        }
        throw new DuoPlusApiError({
          endpoint: "/api/v1/cloudPhone/update",
          message: reason,
          retryable: true,
        });
      }
      await repository.updatePhoneLocation(phone.id, {
        gpsMode,
        latitude: gpsMode === 2 ? latitude : null,
        longitude: gpsMode === 2 ? longitude : null,
        timezone: localeTimezone,
        language: localeLanguage,
      });
    }

    await repository.updateRun(run, workerId, {
      status: "preparing",
      stage: "submit_task",
    });
    const submissionStartedAt = clock.now();
    const submissionBegan = await repository.beginRunSubmission(
      run,
      workerId,
      submissionStartedAt,
    );
    if (!submissionBegan) {
      await safeEvent(
        repository,
        run.id,
        "submission_fence_closed",
        "The atomic lease, schedule, template, connection, phone, cycle, or prior-submission fence blocked addTask",
      );
      return setDeferred(repository, run, workerId, clock, {
        message: "A prior submission may have reached DuoPlus; reconciling without resubmitting",
        stage: "resolve_task",
        delayMs: 15_000,
        incrementAttempt: false,
      });
    }
    const taskName = makeDuoPlusTaskName(run.id);
    let created: unknown;
    try {
      created = await client.addTask({
        template_id: template.duoplus_template_id,
        template_type: template.template_type,
        name: taskName,
        remark: `client=${run.client_id} schedule=${run.schedule_id} run=${run.id}`,
        images: [
          {
            image_id: phone.duoplus_image_id,
            issue_at: formatDuoPlusDate(
              taskIssueAt,
              context.connection.issue_timezone ?? "UTC",
            ),
            config: taskConfig,
          },
        ],
      });
    } catch (error) {
      await repository.updateRun(run, workerId, {
        submission_state: "unknown",
        submission_started_at: submissionStartedAt.toISOString(),
        submission_acknowledged_at: null,
        stage: "resolve_task",
        last_error: `${errorMessage(error)}; checking taskList without resubmitting`,
      });
      await safeEvent(
        repository,
        run.id,
        "submission_outcome_unknown",
        "addTask did not produce a definitive acceptance response; automatic resubmission is blocked",
      );
      run.submission_state = "unknown";
      run.submission_started_at = submissionStartedAt.toISOString();
      run.submission_acknowledged_at = null;
      run.stage = "resolve_task";
      if (!isDuoPlusApiError(error) || !error.retryable) throw error;
      await repository.updateRun(run, workerId, {
        stage: "resolve_task",
        status: "retry_wait",
        attempt_count: run.attempt_count + 1,
        next_action_at: addMilliseconds(clock.now(), 10_000).toISOString(),
        last_error: `${error.message}; checking taskList without resubmitting`,
      });
      const ambiguousTask = await resolveTask({
        client,
        run: {
          ...run,
          stage: "resolve_task",
          task_name: taskName,
          submission_state: "unknown",
          submission_started_at: submissionStartedAt.toISOString(),
        },
        imageId: phone.duoplus_image_id,
        issueAt: taskIssueAt,
        issueTimeZone: context.connection.issue_timezone,
        mode,
        sleeper,
      });
      if (!ambiguousTask) {
        if (repository.finishOpenAttempt) {
          await repository.finishOpenAttempt(
            run.id,
            "failed",
            "resolve_task",
            error.message,
            null,
          );
        }
        return "deferred";
      }
      return syncTask({ repository, client, context, task: ambiguousTask, workerId, clock });
    }

    const submissionAcknowledgedAt = clock.now().toISOString();
    await repository.updateRun(run, workerId, {
      submission_state: "accepted",
      submission_started_at: submissionStartedAt.toISOString(),
      submission_acknowledged_at: submissionAcknowledgedAt,
      stage: "resolve_task",
      last_error: null,
    });
    run.submission_state = "accepted";
    run.submission_started_at = submissionStartedAt.toISOString();
    run.submission_acknowledged_at = submissionAcknowledgedAt;
    run.stage = "resolve_task";

    const returnedTaskId = extractCreatedTaskId(created);
    if (!(await repository.isRunSubmissionValid(run, workerId))) {
      const orphanCandidate = await resolveTask({
        client,
        run: { ...run, duoplus_task_id: returnedTaskId, task_name: taskName },
        imageId: phone.duoplus_image_id,
        issueAt: taskIssueAt,
        issueTimeZone: context.connection.issue_timezone,
        mode,
        sleeper,
      });
      if (orphanCandidate && orphanCandidate.status < 3) {
        await client.cancelTasks([orphanCandidate.id]);
      }
      await safeEvent(
        repository,
        run.id,
        "submission_cancelled_after_race",
        "Task was reconciled after a concurrent schedule change",
        { remoteTaskFound: Boolean(orphanCandidate) },
      );
      return "deferred";
    }
    await repository.updateRun(run, workerId, {
      status: "preparing",
      stage: "resolve_task",
      task_name: taskName,
      duoplus_task_id: returnedTaskId,
      submission_state: "accepted",
      submission_started_at: submissionStartedAt.toISOString(),
      submission_acknowledged_at: submissionAcknowledgedAt,
      next_action_at: clock.now().toISOString(),
    });
    const task = await resolveTask({
      client,
      run: { ...run, duoplus_task_id: returnedTaskId, task_name: taskName },
      imageId: phone.duoplus_image_id,
      issueAt: taskIssueAt,
      issueTimeZone: context.connection.issue_timezone,
      mode,
      sleeper,
    });
    if (!task) {
      return setDeferred(repository, run, workerId, clock, {
        message: "Task accepted; waiting for taskList without resubmitting",
        stage: "resolve_task",
        delayMs: 15_000,
        incrementAttempt: false,
        preservePreparation: true,
      });
    }
    return syncTask({ repository, client, context, task, workerId, clock });
  } finally {
    if (phoneLeaseAcquired) {
      try {
        if (phone) await repository.releasePhoneLease(phone.id, run, workerId);
      } catch {
        // The lease has its own TTL, so cleanup remains safe after an outage.
      }
    }
  }
}

async function processClaimedRun(options: {
  repository: SchedulerRepository;
  client: DuoPlusClient;
  run: SchedulerRunRow;
  workerId: string;
  mode: SchedulerTickMode;
  clock: Clock;
  sleeper: Sleeper;
  phoneLeaseSeconds: number;
  powerPollIntervalMs: number;
  powerPollTimeoutMs: number;
  deadline: number;
  phoneSnapshotCache: Map<string, DuoPlusPhone>;
}): Promise<RunOutcome> {
  const { repository, run, workerId, clock } = options;
  let credentialGeneration: number | null = null;
  try {
    const context = await repository.loadRunContext(run);
    credentialGeneration = context.connection.credential_generation;
    return await processRun({ ...options, context });
  } catch (error) {
    const message = errorMessage(error);
    if (isDuoPlusApiError(error) && error.unauthorized) {
      try {
        if (credentialGeneration !== null) {
          await repository.markConnectionInvalid(
            run.connection_id,
            credentialGeneration,
            message,
          );
        }
      } catch {
        // The run failure still communicates the credential problem.
      }
      return markTerminal(repository, run, workerId, clock, "failed", {
        last_error: "DuoPlus API key is invalid or expired",
      });
    }
    if (error instanceof PermanentRunError || (isDuoPlusApiError(error) && !error.retryable)) {
      return markTerminal(repository, run, workerId, clock, "failed", {
        last_error: message,
      });
    }
    const nextAttempt = run.attempt_count + 1;
    if (nextAttempt >= run.max_attempts) {
      return markTerminal(repository, run, workerId, clock, "failed", {
        attempt_count: nextAttempt,
        last_error: message,
      });
    }
    return setDeferred(repository, run, workerId, clock, {
      message,
      stage: run.stage,
      delayMs: retryDelayMs(nextAttempt),
    });
  } finally {
    try {
      await repository.releaseRunLease(run, workerId);
    } catch {
      // Run leases expire automatically and can be reclaimed safely.
    }
  }
}

export async function runSchedulerTick(
  options: SchedulerTickOptions,
): Promise<TickSummary> {
  let repository = options.repository;
  let clientFactory = options.clientFactory;
  if (!repository || !clientFactory) {
    if (!options.supabase) {
      throw new Error("runSchedulerTick requires repository/clientFactory or supabase");
    }
    const { createSupabaseSchedulerRuntime } = await import("./runtime");
    const runtime = createSupabaseSchedulerRuntime(options.supabase);
    repository = runtime.repository;
    clientFactory = runtime.clientFactory;
  }
  const mode = options.mode ?? "horizon";
  const clock = options.clock ?? systemClock;
  const sleeper = options.sleeper ?? systemSleeper;
  const startedAt = options.now ?? clock.now();
  const workerId = options.workerId ?? `tick_${randomUUID()}`;
  const horizonEnd = addMilliseconds(
    startedAt,
    mode === "horizon"
      ? (options.horizonHours ?? 26) * 60 * 60_000
      : (options.lookaheadMinutes ?? 15) * 60_000,
  );
  const limit = options.limit ?? 100;
  const summary: TickSummary = {
    mode,
    workerId,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    horizonEnd: horizonEnd.toISOString(),
    materialized: 0,
    claimed: 0,
    processed: 0,
    dispatched: 0,
    deferred: 0,
    synced: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    powerOff: { claimed: 0, poweredOff: 0, released: 0, failed: 0 },
    errors: [],
  };

  if (mode === "horizon" && repository.pruneHistory) {
    try {
      await repository.pruneHistory();
    } catch (error) {
      summary.errors.push({ message: `History pruning: ${errorMessage(error)}` });
    }
  }

  if (repository.reconcileProfileScoreCredits) {
    try {
      await repository.reconcileProfileScoreCredits(
        Math.max(1, Math.min(limit, 100)),
      );
    } catch {
      // This is intentionally silent for zero-downtime deploys where code can
      // briefly run before the reconciliation RPC exists. The per-run trigger
      // and success hook remain the primary credit paths.
    }
  }

  // Materialize first so the power-off claim can see and protect near-term
  // work. The sweep still runs before dispatch, allowing a slot released from
  // a truly idle phone to rotate to the next due phone in this same tick.
  await materializeHorizon(repository, horizonEnd, limit, summary);

  // Reclaim safely-idle scheduler-started phones before admitting new work so
  // a freed Startup slot can rotate to the next phone in this same tick.
  const deadline = startedAt.getTime() + (options.maxRuntimeMs ?? 270_000);
  try {
    summary.powerOff = await runSchedulerPowerOffSweep({
      repository,
      clientFactory,
      workerId,
      idleSeconds: options.phoneIdleSeconds,
      limit: options.powerOffLimit,
      deadline,
      clock,
    });
  } catch (error) {
    summary.errors.push({
      message: `Phone power-off sweep: ${errorMessage(error)}`,
    });
  }

  const runs = await repository.claimDueRuns({
    workerId,
    limit,
    leaseSeconds: options.leaseSeconds ?? 180,
    horizonEnd,
  });
  const runLeaseSeconds = options.leaseSeconds ?? 180;
  summary.claimed = runs.length;
  const groups = new Map<string, SchedulerRunRow[]>();
  const phoneSnapshotCache = new Map<string, DuoPlusPhone>();
  for (const run of runs) {
    const group = groups.get(run.connection_id) ?? [];
    group.push(run);
    groups.set(run.connection_id, group);
  }

  await Promise.all(
    [...groups.values()].map(async (connectionRuns) => {
      let client: DuoPlusClient | null = null;
      for (const run of connectionRuns) {
        if (clock.now().getTime() >= deadline) {
          try {
            await repository.releaseRunLease(run, workerId);
          } catch {
            // TTL recovery handles this case.
          }
          summary.deferred += 1;
          continue;
        }
        if (repository.renewRunLease) {
          try {
            // A claimed run can spend most of the invocation polling DuoPlus.
            // Renew through the scheduler deadline (plus a small handoff
            // cushion), not merely for the original 180-second claim. Losing
            // the lease between addTask and the acknowledgement write would
            // leave an avoidable ambiguous remote side effect.
            const leaseSecondsThroughDeadline = Math.min(
              3_600,
              Math.max(
                runLeaseSeconds,
                Math.ceil((deadline - clock.now().getTime()) / 1_000) + 30,
              ),
            );
            const renewed = await repository.renewRunLease(
              run,
              workerId,
              leaseSecondsThroughDeadline,
            );
            if (!renewed) {
              summary.deferred += 1;
              continue;
            }
          } catch (error) {
            summary.deferred += 1;
            summary.errors.push({ runId: run.id, message: errorMessage(error) });
            continue;
          }
        }
        try {
          if (!client) {
            try {
              const context = await repository.loadRunContext(run);
              client = clientFactory(context.connection);
            } catch (error) {
              const message = errorMessage(error);
              try {
                await markTerminal(repository, run, workerId, clock, "failed", {
                  last_error: `Unable to initialize DuoPlus connection: ${message}`,
                });
              } finally {
                try {
                  await repository.releaseRunLease(run, workerId);
                } catch {
                  // Lease TTL provides recovery.
                }
              }
              summary.processed += 1;
              summary.failed += 1;
              summary.errors.push({ runId: run.id, message });
              continue;
            }
          }
          const outcome = await processClaimedRun({
            repository,
            client,
            run,
            workerId,
            mode,
            clock,
            sleeper,
            phoneLeaseSeconds: options.phoneLeaseSeconds ?? 15 * 60,
            powerPollIntervalMs: options.powerPollIntervalMs ?? 5_000,
            powerPollTimeoutMs: options.powerPollTimeoutMs ?? 60_000,
            deadline,
            phoneSnapshotCache,
          });
          summary.processed += 1;
          summary[outcome] += 1;
        } catch (error) {
          summary.errors.push({ runId: run.id, message: errorMessage(error) });
        }
      }
    }),
  );

  summary.finishedAt = clock.now().toISOString();
  return summary;
}
