import type { JsonValue } from "@/lib/duoplus/types";

export type SchedulerRunStatus =
  | "pending"
  | "preparing"
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "retry_wait";

export type SchedulerRunStage =
  | "pending"
  | "prepare_phone"
  | "wait_phone"
  | "apply_settings"
  | "submit_task"
  | "resolve_task"
  | "monitor_task"
  | "fetch_logs"
  | "cancel_task"
  | "complete"
  | "error";

export type SchedulerScheduleSource = "calendar" | "device_cycle";

export type SchedulerSubmissionState =
  | "never"
  | "attempting"
  | "accepted"
  | "unknown";

export interface DuoConnectionRow {
  id: string;
  organization_id: string;
  name: string;
  base_url: string | null;
  issue_timezone: string;
  api_key_ciphertext: string;
  api_key_iv: string;
  api_key_auth_tag: string;
  credential_generation: number;
  status: string;
  min_gap_ms: number;
  last_error: string | null;
  subscription_capacity: number | null;
  subscription_in_use: number | null;
  subscription_available: number | null;
  subscription_synced_at: string | null;
  capacity_pool_id: string | null;
}

export interface DuoPhoneRow {
  id: string;
  organization_id: string;
  connection_id: string;
  client_id: string | null;
  duoplus_image_id: string;
  name: string;
  status: number;
  enabled: boolean;
  provider_present?: boolean;
  expired_at: string | null;
  busy_until: string | null;
  lease_run_id: string | null;
  /** Set only after this scheduler successfully requested a transition from off. */
  scheduler_power_requested_at?: string | null;
  /** Set only after the requested transition was subsequently observed as on. */
  scheduler_powered_on_at?: string | null;
  scheduler_powered_on_run_id?: string | null;
  scheduler_last_activity_at?: string | null;
  scheduler_poweroff_lease_owner?: string | null;
  scheduler_poweroff_lease_token?: string | null;
  scheduler_poweroff_lease_expires_at?: string | null;
  startup_slot_run_id?: string | null;
  startup_slot_reserved_until?: string | null;
  startup_power_attempted_at?: string | null;
  gps_latitude: number | null;
  gps_longitude: number | null;
  gps_mode: number | null;
  locale_timezone: string | null;
  locale_language: string | null;
}

export interface SchedulerPowerOffCandidate {
  id: string;
  organization_id: string;
  connection_id: string;
  duoplus_image_id: string;
  status: number;
  claim_token: string;
}

export interface SchedulerPowerOffSummary {
  claimed: number;
  poweredOff: number;
  released: number;
  failed: number;
}

export interface DuoTemplateRow {
  id: string;
  organization_id: string;
  connection_id: string;
  duoplus_template_id: string;
  template_type: 1 | 2;
  name: string;
  config_schema?: JsonValue;
  enabled: boolean;
}

export interface SchedulerScheduleRow {
  id: string;
  organization_id: string;
  client_id: string;
  connection_id: string;
  phone_id: string | null;
  template_id: string;
  name: string;
  keyword: string;
  config: JsonValue;
  cron_expression: string;
  timezone: string;
  next_run_at: string;
  enabled: boolean;
  gps_latitude: number | null;
  gps_longitude: number | null;
  gps_mode: number | null;
  locale_timezone: string | null;
  locale_language: string | null;
  max_attempts: number;
  expected_duration_seconds: number;
  source_kind: SchedulerScheduleSource;
  device_cycle_id: string | null;
  program_rule_id: string | null;
  active_from: string | null;
  active_through: string | null;
}

export interface SchedulerRunRow {
  id: string;
  organization_id: string;
  client_id: string;
  connection_id: string;
  schedule_id: string;
  phone_id: string | null;
  template_id: string;
  scheduled_for: string;
  issue_at: string;
  expected_duration_seconds: number;
  status: SchedulerRunStatus;
  stage: SchedulerRunStage;
  next_action_at: string;
  attempt_count: number;
  max_attempts: number;
  task_name: string | null;
  duoplus_task_id: string | null;
  duoplus_status: number | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  phone_lease_token: string | null;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  log_json: JsonValue | null;
  screenshots: JsonValue;
  cancellation_requested: boolean;
  cancellation_requested_at: string | null;
  device_cycle_id: string | null;
  program_rule_id: string | null;
  profile_id: string | null;
  app_kind: string | null;
  planned_points: number | null;
  scoring_version: number | null;
  cycle_day: number | null;
  occurrence_key: string | null;
  window_start_at: string | null;
  window_end_at: string | null;
  submission_state: SchedulerSubmissionState;
  submission_started_at: string | null;
  submission_acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SchedulerRunContext {
  run: SchedulerRunRow;
  schedule: SchedulerScheduleRow;
  phone: DuoPhoneRow | null;
  template: DuoTemplateRow;
  connection: DuoConnectionRow;
}

export interface SchedulerPhaseGate {
  allowed: boolean;
  status: "ready" | "waiting" | "recovery_required";
  blockedPhase: string | null;
  missingRequiredRuns: number;
  message?: string;
  reason?: string | null;
  requirements: Array<{
    appKind: string;
    minSuccessfulRuns: number;
    minActiveDays: number;
    successfulRuns: number;
    activeDays: number;
    met: boolean;
  }>;
}

export type RunUpdate = Partial<
  Pick<
    SchedulerRunRow,
    | "issue_at"
    | "phone_id"
    | "status"
    | "stage"
    | "next_action_at"
    | "attempt_count"
    | "task_name"
    | "duoplus_task_id"
    | "duoplus_status"
    | "started_at"
    | "finished_at"
    | "last_error"
    | "log_json"
    | "screenshots"
    | "cancellation_requested"
    | "cancellation_requested_at"
    | "submission_state"
    | "submission_started_at"
    | "submission_acknowledged_at"
  >
>;

export interface TickSummary {
  mode: "horizon" | "minute";
  workerId: string;
  startedAt: string;
  finishedAt: string;
  horizonEnd: string;
  materialized: number;
  claimed: number;
  processed: number;
  dispatched: number;
  deferred: number;
  synced: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  powerOff: SchedulerPowerOffSummary;
  errors: Array<{ runId?: string; message: string }>;
}
