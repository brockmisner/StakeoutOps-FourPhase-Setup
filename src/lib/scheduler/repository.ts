import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  DuoPlusOutboundLogger,
  DuoPlusPhone,
  DuoPlusRequestMeta,
  JsonValue,
} from "@/lib/duoplus/types";
import {
  normalizeDuoPlusIpAddress,
  normalizeDuoPlusProviderTimestamp,
} from "@/lib/duoplus/normalization";
import { compactDuoPlusAuditValue } from "@/lib/duoplus/protocol";

import type {
  DuoConnectionRow,
  DuoPhoneRow,
  DuoTemplateRow,
  RunUpdate,
  SchedulerRunContext,
  SchedulerRunRow,
  SchedulerScheduleRow,
  SchedulerPowerOffCandidate,
  SchedulerPhaseGate,
} from "./types";
import { isPhoneEligibleForNewWork } from "./phone-safety";

type DbError = { message: string } | null;
export type RunLeaseIdentity = Pick<SchedulerRunRow, "id" | "lease_token">;

function assertNoError(error: DbError, operation: string): void {
  if (error) throw new Error(`${operation}: ${error.message}`);
}

function requireRunLeaseToken(run: RunLeaseIdentity): string {
  if (!run.lease_token) throw new Error(`Run ${run.id} has no claim lease token`);
  return run.lease_token;
}

function firstBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return firstBoolean(value[0]);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "acquired",
      "success",
      "result",
      "acquire_phone_lease",
      "complete_scheduler_phone_power_off",
      "is_run_submission_valid",
    ]) {
      if (typeof record[key] === "boolean") return record[key] as boolean;
    }
  }
  return false;
}

export interface SchedulerRepository {
  listSchedulesToMaterialize(
    horizonEnd: Date,
    limit: number,
  ): Promise<SchedulerScheduleRow[]>;
  materializeScheduleRuns(
    scheduleId: string,
    occurrences: Date[],
    nextRunAt: Date,
  ): Promise<number>;
  claimDueRuns(options: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
    horizonEnd: Date;
  }): Promise<SchedulerRunRow[]>;
  loadRunContext(run: SchedulerRunRow): Promise<SchedulerRunContext>;
  getRunPhaseGate(run: SchedulerRunRow): Promise<SchedulerPhaseGate | null>;
  listCandidatePhones(context: SchedulerRunContext): Promise<DuoPhoneRow[]>;
  acquirePhoneLease(
    phoneId: string,
    run: RunLeaseIdentity,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  releasePhoneLease(
    phoneId: string,
    run: RunLeaseIdentity,
    workerId: string,
  ): Promise<void>;
  releaseRunLease(
    run: RunLeaseIdentity,
    workerId: string,
  ): Promise<void>;
  renewRunLease?(
    run: RunLeaseIdentity,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  updateRun(
    run: RunLeaseIdentity,
    workerId: string,
    update: RunUpdate,
  ): Promise<void>;
  /**
   * Awards the immutable readiness-score event for a successful run.
   *
   * The database function owns eligibility and idempotency: schedules without
   * a scored profile are a no-op, and a run can be credited at most once.
   */
  creditProfileRun(runId: string, workerId: string): Promise<boolean>;
  /** Repairs successful profile runs that are missing their immutable credit. */
  reconcileProfileScoreCredits?(limit: number): Promise<number>;
  beginRunSubmission(
    run: RunLeaseIdentity,
    workerId: string,
    startedAt: Date,
  ): Promise<boolean>;
  isRunSubmissionValid(
    run: RunLeaseIdentity,
    workerId: string,
  ): Promise<boolean>;
  updatePhoneSnapshot(phoneId: string, phone: DuoPlusPhone): Promise<void>;
  claimPhonePowerOnAttempt?(
    phoneId: string,
    runId: string,
    attemptedAt: Date,
  ): Promise<boolean>;
  markPhonePowerRequested?(
    phoneId: string,
    runId: string,
    requestedAt: Date,
  ): Promise<boolean>;
  confirmPhoneSchedulerPoweredOn?(
    phoneId: string,
    runId: string,
    observedAt: Date,
  ): Promise<boolean>;
  claimIdleSchedulerPoweredOnPhones?(options: {
    workerId: string;
    idleSeconds: number;
    limit: number;
    claimSeconds: number;
  }): Promise<SchedulerPowerOffCandidate[]>;
  loadPowerManagementConnection?(
    connectionId: string,
    organizationId: string,
  ): Promise<DuoConnectionRow>;
  completeSchedulerPowerOff?(
    phoneId: string,
    workerId: string,
    claimToken: string,
    observedStatus: number,
  ): Promise<boolean>;
  consumeSchedulerPowerOffOwnership?(
    phoneId: string,
    workerId: string,
    claimToken: string,
  ): Promise<boolean>;
  releaseSchedulerPowerOffClaim?(
    phoneId: string,
    workerId: string,
    claimToken: string,
    options?: { abandonOwnership?: boolean; errorMessage?: string | null },
  ): Promise<boolean>;
  updatePhoneLocation(
    phoneId: string,
    settings: {
      gpsMode: number | null;
      latitude: number | null;
      longitude: number | null;
      timezone: string | null;
      language: string | null;
    },
  ): Promise<void>;
  markConnectionInvalid(
    connectionId: string,
    expectedCredentialGeneration: number,
    message: string,
  ): Promise<void>;
  recordEvent(
    runId: string,
    eventType: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  finishOpenAttempt?(
    runId: string,
    status: "succeeded" | "failed" | "abandoned" | "cancelled",
    stage: string,
    errorMessage?: string | null,
    duoPlusTaskId?: string | null,
  ): Promise<void>;
  startAttempt?(
    runId: string,
    phoneId: string | null,
    attemptNumber: number,
    workerId: string,
    stage: string,
    duoPlusTaskId?: string | null,
  ): Promise<void>;
  pruneHistory?(): Promise<void>;
}

export class SupabaseSchedulerRepository implements SchedulerRepository {
  private readonly organizationByRunId = new Map<string, string>();

  constructor(readonly supabase: SupabaseClient) {}

  async listSchedulesToMaterialize(
    horizonEnd: Date,
    limit: number,
  ): Promise<SchedulerScheduleRow[]> {
    const { data, error } = await this.supabase
      .from("scheduler_schedules")
      .select("*")
      .eq("enabled", true)
      .eq("source_kind", "calendar")
      .lte("next_run_at", horizonEnd.toISOString())
      .order("next_run_at", { ascending: true })
      .limit(limit);
    assertNoError(error, "List schedules to materialize");
    return (data ?? []) as SchedulerScheduleRow[];
  }

  async materializeScheduleRuns(
    scheduleId: string,
    occurrences: Date[],
    nextRunAt: Date,
  ): Promise<number> {
    if (occurrences.length === 0) return 0;
    const { data, error } = await this.supabase.rpc("materialize_schedule_runs", {
      p_schedule_id: scheduleId,
      p_occurrences: occurrences.map((value) => value.toISOString()),
      p_next_run_at: nextRunAt.toISOString(),
    });
    assertNoError(error, "Materialize schedule runs");
    if (Array.isArray(data)) return data.length;
    if (typeof data === "number") return data;
    return occurrences.length;
  }

  async claimDueRuns(options: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
    horizonEnd: Date;
  }): Promise<SchedulerRunRow[]> {
    const { data, error } = await this.supabase.rpc("claim_due_runs", {
      p_worker_id: options.workerId,
      p_limit: options.limit,
      p_lease_seconds: options.leaseSeconds,
      p_horizon_end: options.horizonEnd.toISOString(),
    });
    assertNoError(error, "Claim due runs");
    const runs = (Array.isArray(data) ? data : []) as SchedulerRunRow[];
    for (const run of runs) {
      if (!run.lease_token || run.lease_owner !== options.workerId) {
        throw new Error(`Claim due runs returned an unfenced lease for ${run.id}`);
      }
      this.organizationByRunId.set(run.id, run.organization_id);
    }
    return runs;
  }

  async loadRunContext(run: SchedulerRunRow): Promise<SchedulerRunContext> {
    const [scheduleResult, templateResult, connectionResult] = await Promise.all([
        this.supabase.from("scheduler_schedules").select("*").eq("id", run.schedule_id).single(),
        this.supabase.from("duo_templates").select("*").eq("id", run.template_id).single(),
        this.supabase.from("duo_connections").select("*").eq("id", run.connection_id).single(),
      ]);

    assertNoError(scheduleResult.error, "Load run schedule");
    assertNoError(templateResult.error, "Load run template");
    assertNoError(connectionResult.error, "Load run DuoPlus connection");

    const schedule = scheduleResult.data as SchedulerScheduleRow;
    const template = templateResult.data as DuoTemplateRow;
    const connection = connectionResult.data as DuoConnectionRow;
    const selectedPhoneId = run.phone_id ?? schedule.phone_id;
    let phone: DuoPhoneRow | null = null;
    if (selectedPhoneId) {
      const phoneResult = await this.supabase
        .from("duo_phones")
        .select("*")
        .eq("id", selectedPhoneId)
        .single();
      assertNoError(phoneResult.error, "Load run phone");
      phone = phoneResult.data as DuoPhoneRow;
    }
    const tenantIds = [
      schedule.organization_id,
      phone?.organization_id,
      template.organization_id,
      connection.organization_id,
    ].filter(Boolean);
    if (tenantIds.some((id) => id !== run.organization_id)) {
      throw new Error(`Tenant boundary mismatch for run ${run.id}`);
    }
    if (
      schedule.connection_id !== connection.id ||
      (phone && phone.connection_id !== connection.id) ||
      template.connection_id !== connection.id
    ) {
      throw new Error(`DuoPlus connection mismatch for run ${run.id}`);
    }
    this.organizationByRunId.set(run.id, run.organization_id);
    return { run, schedule, phone, template, connection };
  }

  async getRunPhaseGate(run: SchedulerRunRow): Promise<SchedulerPhaseGate | null> {
    if (!run.device_cycle_id) return null;
    const { data, error } = await this.supabase.rpc("get_scheduler_run_phase_gate", {
      p_organization_id: run.organization_id,
      p_run_id: run.id,
    });
    assertNoError(error, "Check profile phase prerequisites");
    // Null is reserved by the database for legacy programs. An unrecognized
    // response must never allow new device work to bypass prerequisites.
    if (data === null) return null;
    if (
      !data || typeof data !== "object" || Array.isArray(data) ||
      typeof data.allowed !== "boolean" ||
      !["ready", "waiting", "recovery_required"].includes(data.status) ||
      data.allowed !== (data.status === "ready") ||
      !(data.blockedPhase === null || ["baseline", "warmup", "money", "final_squeeze", "after_action"].includes(data.blockedPhase)) ||
      !Number.isInteger(data.missingRequiredRuns) || data.missingRequiredRuns < 0 ||
      (data.allowed && (data.blockedPhase !== null || data.missingRequiredRuns !== 0)) ||
      !Array.isArray(data.requirements) ||
      !data.requirements.every((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const requirement = item as Record<string, unknown>;
        return typeof requirement.appKind === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(requirement.appKind) &&
          typeof requirement.met === "boolean" &&
          ["minSuccessfulRuns", "minActiveDays", "successfulRuns", "activeDays"].every(
            (key) => Number.isInteger(requirement[key]) && (requirement[key] as number) >= 0,
          );
      })
    ) {
      throw new Error("Profile phase prerequisites returned an invalid response");
    }
    return data as SchedulerPhaseGate;
  }

  async listCandidatePhones(context: SchedulerRunContext): Promise<DuoPhoneRow[]> {
    const now = new Date();
    const isExistingTask = Boolean(
      context.run.duoplus_task_id ||
        context.run.submission_state !== "never" ||
        ["queued", "running", "paused"].includes(context.run.status) ||
        ["resolve_task", "monitor_task", "fetch_logs", "cancel_task"].includes(
          context.run.stage,
        ),
    );
    if (context.phone) {
      if (isExistingTask) {
        return context.run.phone_id === context.phone.id ? [context.phone] : [];
      }
      return isPhoneEligibleForNewWork(context.phone, now) ? [context.phone] : [];
    }
    // A remote task must always be reconciled against the phone persisted on
    // that run. Never substitute a newly selected phone if that association is
    // corrupt or missing.
    if (isExistingTask) return [];
    let query = this.supabase
      .from("duo_phones")
      .select("*")
      .eq("organization_id", context.run.organization_id)
      .eq("connection_id", context.run.connection_id)
      .eq("enabled", true)
      .eq("provider_present", true)
      .not("status", "in", "(3,4)")
      .or(`client_id.is.null,client_id.eq.${context.run.client_id}`)
      .limit(100);
    if (context.schedule.phone_id) query = query.eq("id", context.schedule.phone_id);
    const { data, error } = await query;
    assertNoError(error, "List candidate phones");
    return ((data ?? []) as DuoPhoneRow[])
      .filter((phone) => isPhoneEligibleForNewWork(phone, now))
      .sort((left, right) => {
        const activeScore = (phone: DuoPhoneRow) =>
          [1, 10, 11].includes(phone.status) ? 0 : 1;
        const byActiveState = activeScore(left) - activeScore(right);
        if (byActiveState !== 0) return byActiveState;
        const clientScore = (phone: DuoPhoneRow) =>
          phone.client_id === context.run.client_id ? 0 : 1;
        const byClient = clientScore(left) - clientScore(right);
        if (byClient !== 0) return byClient;
        const leftBusy = left.busy_until
          ? new Date(left.busy_until).getTime()
          : 0;
        const rightBusy = right.busy_until
          ? new Date(right.busy_until).getTime()
          : 0;
        return leftBusy - rightBusy;
      });
  }

  async acquirePhoneLease(
    phoneId: string,
    run: RunLeaseIdentity,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const runLeaseToken = requireRunLeaseToken(run);
    const { data, error } = await this.supabase.rpc("acquire_phone_lease", {
      p_phone_id: phoneId,
      p_run_id: run.id,
      p_worker_id: workerId,
      p_run_lease_token: runLeaseToken,
      p_lease_seconds: leaseSeconds,
    });
    assertNoError(error, "Acquire phone lease");
    return firstBoolean(data);
  }

  async releasePhoneLease(
    phoneId: string,
    run: RunLeaseIdentity,
    workerId: string,
  ): Promise<void> {
    const runLeaseToken = requireRunLeaseToken(run);
    const { data, error } = await this.supabase.rpc("release_phone_lease", {
      p_phone_id: phoneId,
      p_run_id: run.id,
      p_worker_id: workerId,
      p_run_lease_token: runLeaseToken,
    });
    assertNoError(error, "Release phone lease");
    if (!firstBoolean(data)) throw new Error(`Phone lease lost for ${run.id}`);
  }

  async releaseRunLease(
    run: RunLeaseIdentity,
    workerId: string,
  ): Promise<void> {
    const runLeaseToken = requireRunLeaseToken(run);
    const { data, error } = await this.supabase.rpc("release_run_lease", {
      p_run_id: run.id,
      p_worker_id: workerId,
      p_run_lease_token: runLeaseToken,
    });
    assertNoError(error, "Release run lease");
    if (!firstBoolean(data)) throw new Error(`Run lease lost for ${run.id}`);
  }

  async renewRunLease(
    run: RunLeaseIdentity,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const runLeaseToken = requireRunLeaseToken(run);
    const { data, error } = await this.supabase.rpc("renew_run_lease", {
      p_run_id: run.id,
      p_worker_id: workerId,
      p_run_lease_token: runLeaseToken,
      p_lease_seconds: leaseSeconds,
    });
    assertNoError(error, "Renew run lease");
    return firstBoolean(data);
  }

  async updateRun(
    run: RunLeaseIdentity,
    workerId: string,
    update: RunUpdate,
  ): Promise<void> {
    const runLeaseToken = requireRunLeaseToken(run);
    const { data, error } = await this.supabase
      .from("scheduler_runs")
      .update(update)
      .eq("id", run.id)
      .eq("lease_owner", workerId)
      .eq("lease_token", runLeaseToken)
      .select("id")
      .maybeSingle();
    assertNoError(error, "Update scheduler run");
    if (!data) throw new Error(`Run lease lost for ${run.id}`);
  }

  async creditProfileRun(runId: string, workerId: string): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("credit_profile_run", {
      p_run_id: runId,
      p_worker_id: workerId,
    });
    assertNoError(error, "Credit successful profile run");
    return firstBoolean(data);
  }

  async reconcileProfileScoreCredits(limit: number): Promise<number> {
    const { data, error } = await this.supabase.rpc(
      "reconcile_profile_score_credits",
      { p_limit: limit },
    );
    assertNoError(error, "Reconcile profile score credits");
    return typeof data === "number" ? data : 0;
  }

  async beginRunSubmission(
    run: RunLeaseIdentity,
    workerId: string,
    startedAt: Date,
  ): Promise<boolean> {
    const runLeaseToken = requireRunLeaseToken(run);
    const { data, error } = await this.supabase.rpc("authorize_run_submission", {
      p_run_id: run.id,
      p_worker_id: workerId,
      p_run_lease_token: runLeaseToken,
      p_submission_started_at: startedAt.toISOString(),
    });
    assertNoError(error, "Begin authorized DuoPlus task submission");
    return firstBoolean(data);
  }

  async isRunSubmissionValid(
    run: RunLeaseIdentity,
    workerId: string,
  ): Promise<boolean> {
    const runLeaseToken = requireRunLeaseToken(run);
    const { data, error } = await this.supabase.rpc(
      "validate_run_after_submission",
      {
        p_run_id: run.id,
        p_worker_id: workerId,
        p_run_lease_token: runLeaseToken,
      },
    );
    assertNoError(error, "Validate accepted DuoPlus task submission");
    return firstBoolean(data);
  }

  async updatePhoneSnapshot(phoneId: string, phone: DuoPlusPhone): Promise<void> {
    const { error } = await this.supabase
      .from("duo_phones")
      .update({
        name: phone.name ?? undefined,
        status: phone.status,
        adb_endpoint: phone.adb ?? undefined,
        ip_address:
          phone.ip === undefined
            ? undefined
            : normalizeDuoPlusIpAddress(phone.ip),
        os_version: phone.os ?? undefined,
        expired_at:
          phone.expired_at === undefined
            ? undefined
            : normalizeDuoPlusProviderTimestamp(phone.expired_at),
        last_seen_at: new Date().toISOString(),
        // Phone payloads can contain adb_password. Persist only a bounded,
        // recursively redacted diagnostic snapshot.
        metadata: compactDuoPlusAuditValue(phone) as JsonValue,
        ...(phone.status === 1
          ? {
              startup_slot_run_id: null,
              startup_slot_reserved_until: null,
              startup_power_attempted_at: null,
            }
          : {}),
      })
      .eq("id", phoneId);
    assertNoError(error, "Update phone snapshot");
  }

  async claimPhonePowerOnAttempt(
    phoneId: string,
    runId: string,
    attemptedAt: Date,
  ): Promise<boolean> {
    const timestamp = attemptedAt.toISOString();
    const { data, error } = await this.supabase
      .from("duo_phones")
      .update({ startup_power_attempted_at: timestamp })
      .eq("id", phoneId)
      .eq("lease_run_id", runId)
      .gt("lease_expires_at", timestamp)
      .eq("startup_slot_run_id", runId)
      .gt("startup_slot_reserved_until", timestamp)
      .is("startup_power_attempted_at", null)
      .select("id")
      .maybeSingle();
    assertNoError(error, "Claim phone power-on attempt");
    return Boolean(data);
  }

  async markPhonePowerRequested(
    phoneId: string,
    runId: string,
    requestedAt: Date,
  ): Promise<boolean> {
    const timestamp = requestedAt.toISOString();
    const { data, error } = await this.supabase
      .from("duo_phones")
      .update({
        scheduler_power_requested_at: timestamp,
        scheduler_powered_on_at: null,
        scheduler_powered_on_run_id: runId,
        scheduler_last_activity_at: timestamp,
        scheduler_poweroff_lease_owner: null,
        scheduler_poweroff_lease_token: null,
        scheduler_poweroff_lease_expires_at: null,
        scheduler_poweroff_last_error: null,
      })
      .eq("id", phoneId)
      .eq("lease_run_id", runId)
      // An inventory refresh may observe booting/on in the narrow interval
      // between DuoPlus accepting powerOn and this ownership write. The
      // durable run-bound attempt claim still proves this scheduler initiated
      // the transition, so retain shutdown ownership across that race.
      .in("status", [1, 2, 10, 11])
      .is("scheduler_power_requested_at", null)
      .select("id")
      .maybeSingle();
    assertNoError(error, "Record scheduler phone power request");
    return Boolean(data);
  }

  async confirmPhoneSchedulerPoweredOn(
    phoneId: string,
    runId: string,
    observedAt: Date,
  ): Promise<boolean> {
    const timestamp = observedAt.toISOString();
    const { data, error } = await this.supabase
      .from("duo_phones")
      .update({
        scheduler_powered_on_at: timestamp,
        scheduler_last_activity_at: timestamp,
        scheduler_poweroff_last_error: null,
      })
      .eq("id", phoneId)
      .eq("scheduler_powered_on_run_id", runId)
      .not("scheduler_power_requested_at", "is", null)
      .is("scheduler_powered_on_at", null)
      .select("id")
      .maybeSingle();
    assertNoError(error, "Confirm scheduler-started phone");
    return Boolean(data);
  }

  async claimIdleSchedulerPoweredOnPhones(options: {
    workerId: string;
    idleSeconds: number;
    limit: number;
    claimSeconds: number;
  }): Promise<SchedulerPowerOffCandidate[]> {
    const { data, error } = await this.supabase.rpc(
      "claim_idle_scheduler_powered_phones",
      {
        p_worker_id: options.workerId,
        p_idle_seconds: options.idleSeconds,
        p_limit: options.limit,
        p_claim_seconds: options.claimSeconds,
      },
    );
    assertNoError(error, "Claim idle scheduler-started phones");
    return (Array.isArray(data) ? data : []) as SchedulerPowerOffCandidate[];
  }

  async loadPowerManagementConnection(
    connectionId: string,
    organizationId: string,
  ): Promise<DuoConnectionRow> {
    const { data, error } = await this.supabase
      .from("duo_connections")
      .select("*")
      .eq("id", connectionId)
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .single();
    assertNoError(error, "Load phone power-management connection");
    return data as DuoConnectionRow;
  }

  async completeSchedulerPowerOff(
    phoneId: string,
    workerId: string,
    claimToken: string,
    observedStatus: number,
  ): Promise<boolean> {
    const { data, error } = await this.supabase.rpc(
      "complete_scheduler_phone_power_off",
      {
        p_phone_id: phoneId,
        p_worker_id: workerId,
        p_claim_token: claimToken,
        p_observed_status: observedStatus,
      },
    );
    assertNoError(error, "Complete scheduler phone power-off");
    return firstBoolean(data);
  }

  async consumeSchedulerPowerOffOwnership(
    phoneId: string,
    workerId: string,
    claimToken: string,
  ): Promise<boolean> {
    const { data, error } = await this.supabase.rpc(
      "consume_scheduler_phone_poweroff_ownership",
      {
        p_phone_id: phoneId,
        p_worker_id: workerId,
        p_claim_token: claimToken,
        p_extension_seconds: 600,
      },
    );
    assertNoError(error, "Consume scheduler phone power ownership");
    return firstBoolean(data);
  }

  async releaseSchedulerPowerOffClaim(
    phoneId: string,
    workerId: string,
    claimToken: string,
    options: { abandonOwnership?: boolean; errorMessage?: string | null } = {},
  ): Promise<boolean> {
    const { data, error } = await this.supabase.rpc(
      "release_scheduler_phone_poweroff_claim",
      {
        p_phone_id: phoneId,
        p_worker_id: workerId,
        p_claim_token: claimToken,
        p_abandon_ownership: options.abandonOwnership ?? false,
        p_error_message: options.errorMessage ?? null,
        p_quarantine_seconds: 600,
      },
    );
    assertNoError(error, "Release scheduler phone power-off claim");
    return firstBoolean(data);
  }

  async updatePhoneLocation(
    phoneId: string,
    settings: {
      gpsMode: number | null;
      latitude: number | null;
      longitude: number | null;
      timezone: string | null;
      language: string | null;
    },
  ): Promise<void> {
    const { error } = await this.supabase
      .from("duo_phones")
      .update({
        gps_mode: settings.gpsMode,
        gps_latitude: settings.latitude,
        gps_longitude: settings.longitude,
        locale_timezone: settings.timezone,
        locale_language: settings.language,
      })
      .eq("id", phoneId);
    assertNoError(error, "Update phone location");
  }

  async markConnectionInvalid(
    connectionId: string,
    expectedCredentialGeneration: number,
    message: string,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("duo_connections")
      .update({ status: "invalid", last_error: message })
      .eq("id", connectionId)
      .eq("credential_generation", expectedCredentialGeneration);
    assertNoError(error, "Mark DuoPlus connection invalid");
  }

  async recordEvent(
    runId: string,
    eventType: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    let organizationId = this.organizationByRunId.get(runId);
    if (!organizationId) {
      const { data, error: lookupError } = await this.supabase
        .from("scheduler_runs")
        .select("organization_id")
        .eq("id", runId)
        .single();
      assertNoError(lookupError, "Resolve scheduler event organization");
      organizationId = (data as { organization_id: string }).organization_id;
      this.organizationByRunId.set(runId, organizationId);
    }
    const { error } = await this.supabase.from("scheduler_run_events").insert({
      organization_id: organizationId,
      run_id: runId,
      event_type: eventType,
      message,
      metadata,
    });
    assertNoError(error, "Record scheduler event");
  }

  async finishOpenAttempt(
    runId: string,
    status: "succeeded" | "failed" | "abandoned" | "cancelled",
    stage: string,
    errorMessage: string | null = null,
    duoPlusTaskId: string | null = null,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("scheduler_run_attempts")
      .update({
        status,
        stage,
        error_message: errorMessage,
        duoplus_task_id: duoPlusTaskId,
        finished_at: new Date().toISOString(),
      })
      .eq("run_id", runId)
      .eq("status", "started");
    assertNoError(error, "Finish scheduler attempt");
  }

  async startAttempt(
    runId: string,
    phoneId: string | null,
    attemptNumber: number,
    workerId: string,
    stage: string,
    duoPlusTaskId: string | null = null,
  ): Promise<void> {
    let organizationId = this.organizationByRunId.get(runId);
    if (!organizationId) {
      const { data, error: lookupError } = await this.supabase
        .from("scheduler_runs")
        .select("organization_id")
        .eq("id", runId)
        .single();
      assertNoError(lookupError, "Resolve scheduler attempt organization");
      organizationId = (data as { organization_id: string }).organization_id;
      this.organizationByRunId.set(runId, organizationId);
    }
    const { error } = await this.supabase.from("scheduler_run_attempts").insert({
      organization_id: organizationId,
      run_id: runId,
      phone_id: phoneId,
      attempt_number: attemptNumber,
      worker_id: workerId,
      stage,
      status: "started",
      duoplus_task_id: duoPlusTaskId,
    });
    assertNoError(error, "Start scheduler retry attempt");
  }

  async pruneHistory(): Promise<void> {
    const { error } = await this.supabase.rpc("prune_scheduler_history");
    assertNoError(error, "Prune scheduler history");
  }
}

export class SupabaseDuoPlusOutboundLogger implements DuoPlusOutboundLogger {
  private resolvedOrganizationId?: string;

  constructor(
    private readonly supabase: SupabaseClient,
    organizationId?: string,
  ) {
    this.resolvedOrganizationId = organizationId;
  }

  async log(meta: DuoPlusRequestMeta): Promise<void> {
    if (!this.resolvedOrganizationId) {
      const { data, error: lookupError } = await this.supabase
        .from("duo_connections")
        .select("organization_id")
        .eq("id", meta.connectionId)
        .single();
      assertNoError(lookupError, "Resolve outbound log organization");
      this.resolvedOrganizationId = (data as { organization_id: string })
        .organization_id;
    }
    const { error } = await this.supabase.from("duo_outbound_logs").insert({
      organization_id: this.resolvedOrganizationId,
      connection_id: meta.connectionId,
      endpoint: meta.endpoint,
      // Treat the persistence boundary as hostile even though DuoPlusClient
      // already redacts its normal logger payload. Other callers must not be
      // able to persist adb_password, authorization, tokens, or proxy secrets.
      request_body: compactDuoPlusAuditValue(meta.requestBody) as JsonValue,
      response_body: compactDuoPlusAuditValue(meta.responseBody) as JsonValue,
      http_status: meta.httpStatus,
      duo_code: meta.duoCode,
      ok: meta.ok,
      error_message: meta.errorMessage ?? null,
      started_at: meta.startedAt.toISOString(),
      finished_at: meta.finishedAt.toISOString(),
    });
    assertNoError(error, "Record DuoPlus outbound call");
  }
}
