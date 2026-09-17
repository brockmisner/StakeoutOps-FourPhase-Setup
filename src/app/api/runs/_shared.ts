import type { AuthContext } from "@/lib/auth/context";
import { ApiError } from "@/lib/auth/errors";

export type CancellableRun = {
  id: string;
  duoplus_task_id: string | null;
  status: string;
  attempt_count?: number;
  lease_owner?: string | null;
};

export type RunRow = {
  id: string;
  client_id: string;
  connection_id: string;
  schedule_id: string;
  phone_id: string | null;
  template_id: string;
  scheduled_for: string;
  issue_at: string;
  expected_duration_seconds: number;
  status: string;
  stage: string;
  next_action_at: string;
  attempt_count: number;
  max_attempts: number;
  task_name: string;
  duoplus_task_id: string | null;
  duoplus_status: number | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  cancellation_requested: boolean;
  cancellation_requested_at: string | null;
  log_json: unknown;
  screenshots: unknown;
  device_cycle_id: string | null;
  program_rule_id: string | null;
  cycle_day: number | null;
  occurrence_key: string | null;
  window_start_at: string | null;
  window_end_at: string | null;
  submission_state: string;
  created_at: string;
  updated_at: string;
};

export function presentRun(
  row: RunRow,
  names: {
    client?: string;
    schedule?: string;
    keyword?: string;
    sourceKind?: "calendar" | "device_cycle";
    phone?: string;
    template?: string;
  } = {},
) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: names.client ?? null,
    connectionId: row.connection_id,
    scheduleId: row.schedule_id,
    scheduleName: names.schedule ?? null,
    keyword: names.keyword ?? null,
    sourceKind:
      names.sourceKind ?? (row.device_cycle_id ? "device_cycle" : "calendar"),
    phoneId: row.phone_id,
    phoneName: names.phone ?? null,
    templateId: row.template_id,
    templateName: names.template ?? null,
    scheduledFor: row.scheduled_for,
    issueAt: row.issue_at,
    expectedDurationSeconds: row.expected_duration_seconds,
    status: row.status,
    stage: row.stage,
    nextActionAt: row.next_action_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    hasDuoPlusTask: Boolean(row.duoplus_task_id),
    duoPlusStatus: row.duoplus_status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
    cancellationRequested: row.cancellation_requested,
    cancellationRequestedAt: row.cancellation_requested_at,
    log: row.log_json,
    screenshots: row.screenshots,
    deviceCycleId: row.device_cycle_id,
    programRuleId: row.program_rule_id,
    cycleDay: row.cycle_day,
    occurrenceKey: row.occurrence_key,
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    submissionState: row.submission_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function cancelRuns(
  context: Exclude<AuthContext, { demo: true }>,
  runs: CancellableRun[],
) {
  const runIds = [...new Set(runs.map((run) => run.id))];
  if (runIds.length === 0) {
    return { requested: 0, cancellationRequested: 0 };
  }
  const now = new Date().toISOString();
  const { data, error } = await context.admin
    .from("scheduler_runs")
    .update({
      cancellation_requested: true,
      cancellation_requested_at: now,
      next_action_at: now,
      updated_at: now,
    })
    .eq("organization_id", context.organizationId)
    .in("id", runIds)
    .in("status", [
      "pending",
      "preparing",
      "queued",
      "running",
      "paused",
      "retry_wait",
    ])
    .select("id");

  if (error) {
    throw new ApiError(
      503,
      "CANCELLATION_SAVE_FAILED",
      "The cancellation request could not be saved.",
    );
  }

  const requestedIds = (data ?? []).map((row) => row.id);
  if (requestedIds.length > 0) {
    // Audit events are best effort; the durable flag above is authoritative.
    try {
      await context.admin.from("scheduler_run_events").insert(
        requestedIds.map((runId) => ({
          organization_id: context.organizationId,
          run_id: runId,
          event_type: "cancellation_requested",
          stage: "cancel_task",
          message: "Cancellation requested from the workspace UI.",
          metadata: {},
        })),
      );
    } catch {
      // The worker also records the resulting cancellation outcome.
    }
  }

  return {
    requested: runs.length,
    cancellationRequested: requestedIds.length,
  };
}
