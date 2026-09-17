import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

import type { AuthContext } from "@/lib/auth/context";
import { ApiError, dataResponse } from "@/lib/auth/errors";
import { requireSchedulerManager } from "@/lib/auth/context";
import { withOrganization } from "@/lib/auth/route";
import { taskConfigIssueMessage } from "@/lib/duoplus/task-config";

import { cancelRuns, type CancellableRun } from "../../runs/_shared";
import {
  calculateNextRun,
  presentSchedule,
  resolveScheduleReferences,
  scheduleUpdateSchema,
  type ScheduleRow,
} from "../_shared";

const SCHEDULE_FIELDS =
  "id, client_id, connection_id, phone_id, template_id, name, keyword, config, cron_expression, timezone, next_run_at, last_enqueued_at, enabled, gps_latitude, gps_longitude, gps_mode, locale_timezone, locale_language, max_attempts, expected_duration_seconds, created_at, updated_at";

function affectsMaterializedRuns(input: Record<string, unknown>): boolean {
  return [
    "clientId",
    "phoneId",
    "templateId",
    "keyword",
    "config",
    "cronExpression",
    "timezone",
    "nextRunAt",
    "gpsLatitude",
    "gpsLongitude",
    "gpsMode",
    "localeTimezone",
    "localeLanguage",
    "maxAttempts",
    "expectedDurationSeconds",
  ].some((key) => key in input);
}

function triggerTick(admin: SupabaseClient, mode: "minute" | "horizon"): void {
  after(async () => {
    try {
      const [{ runSchedulerTick }, { createSupabaseSchedulerRuntime }] =
        await Promise.all([
          import("@/lib/scheduler/worker"),
          import("@/lib/scheduler/runtime"),
        ]);
      await runSchedulerTick({
        ...createSupabaseSchedulerRuntime(admin),
        mode,
        limit: 25,
      });
    } catch {
      // The minute cron retries durable cancellation requests.
    }
  });
}

async function openRunsForSchedule(
  context: Exclude<AuthContext, { demo: true }>,
  scheduleId: string,
): Promise<CancellableRun[]> {
  const { data, error } = await context.admin
    .from("scheduler_runs")
    .select("id, duoplus_task_id, status, attempt_count, lease_owner")
    .eq("organization_id", context.organizationId)
    .eq("schedule_id", scheduleId)
    .in("status", [
      "pending",
      "preparing",
      "queued",
      "running",
      "paused",
      "retry_wait",
    ]);
  if (error) {
    throw new ApiError(
      503,
      "RUN_LOOKUP_FAILED",
      "Pending schedule runs could not be checked.",
    );
  }
  return (data ?? []) as CancellableRun[];
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrganization(request, async (context) => {
    requireSchedulerManager(context);
    const { id } = await params;
    let input;
    try {
      input = scheduleUpdateSchema.parse(await request.json());
    } catch (error) {
      const configMessage = taskConfigIssueMessage(error);
      if (configMessage) {
        throw new ApiError(400, "INVALID_TASK_CONFIG", configMessage);
      }
      throw new ApiError(400, "INVALID_REQUEST", "No valid schedule changes were supplied.");
    }

    if (context.demo) {
      return dataResponse({
        schedule: {
          id,
          ...input,
          updatedAt: new Date().toISOString(),
          preview: true,
        },
      });
    }

    const { data: currentData, error: currentError } = await context.admin
      .from("scheduler_schedules")
      .select(SCHEDULE_FIELDS)
      .eq("id", id)
      .eq("organization_id", context.organizationId)
      .eq("source_kind", "calendar")
      .maybeSingle();
    if (currentError) {
      throw new ApiError(503, "SCHEDULE_LOOKUP_FAILED", "The schedule could not be loaded.");
    }
    if (!currentData) throw new ApiError(404, "SCHEDULE_NOT_FOUND", "Schedule not found.");

    const current = currentData as ScheduleRow;
    const clientId = input.clientId ?? current.client_id;
    const templateId = input.templateId ?? current.template_id;
    const phoneId = input.phoneId !== undefined ? input.phoneId : current.phone_id;
    if (!phoneId) {
      throw new ApiError(
        409,
        "SCHEDULE_PHONE_REQUIRED",
        "Choose a required phone before updating this legacy schedule.",
      );
    }
    await resolveScheduleReferences(context, { clientId, templateId, phoneId });

    const timezone = input.timezone ?? current.timezone;
    const cronExpression = input.cronExpression ?? current.cron_expression;
    const materialEdit = affectsMaterializedRuns(input);
    const shouldRecalculate =
      input.nextRunAt !== undefined ||
      input.cronExpression !== undefined ||
      input.timezone !== undefined ||
      materialEdit ||
      (input.enabled === true && !current.enabled);
    const nextRunAt = shouldRecalculate
      ? calculateNextRun(cronExpression, timezone, input.nextRunAt)
      : current.next_run_at;
    const latitude =
      input.gpsLatitude !== undefined ? input.gpsLatitude : current.gps_latitude;
    const longitude =
      input.gpsLongitude !== undefined ? input.gpsLongitude : current.gps_longitude;
    const gpsMode = input.gpsMode ?? current.gps_mode;
    if ((latitude == null) !== (longitude == null) || (gpsMode === 2 && latitude == null)) {
      throw new ApiError(
        400,
        "INVALID_COORDINATES",
        "Explicit GPS requires both latitude and longitude.",
      );
    }

    // A run is a durable snapshot of its client/phone/template/timing. Editing
    // those fields while work is open would silently mix old and new intent.
    // Request cancellation first, leave the schedule unchanged, then let the
    // caller retry the edit once the worker has made every run terminal.
    if (materialEdit) {
      const openRuns = await openRunsForSchedule(context, id);
      const pristinePlans = openRuns.filter(
        (run) =>
          run.status === "pending" &&
          !run.duoplus_task_id &&
          (run.attempt_count ?? 0) === 0 &&
          !run.lease_owner,
      );
      const inFlight = openRuns.filter(
        (run) => !pristinePlans.some((candidate) => candidate.id === run.id),
      );

      if (inFlight.length > 0) {
        const cancellation = await cancelRuns(context, inFlight);
        triggerTick(context.admin, "minute");
        throw new ApiError(
          409,
          "OPEN_RUNS_RECONCILING",
          "In-flight runs are being cancelled. Retry this edit after they finish.",
          {
            openRunCount: inFlight.length,
            cancellationRequested: cancellation.cancellationRequested,
          },
        );
      }

      if (pristinePlans.length > 0) {
        const { data: removedPlans, error: removeError } = await context.admin
          .from("scheduler_runs")
          .delete()
          .eq("organization_id", context.organizationId)
          .eq("schedule_id", id)
          .eq("status", "pending")
          .eq("attempt_count", 0)
          .is("duoplus_task_id", null)
          .is("lease_owner", null)
          .in(
            "id",
            pristinePlans.map((run) => run.id),
          )
          .select("id");
        if (removeError || removedPlans?.length !== pristinePlans.length) {
          throw new ApiError(
            409,
            "RUN_EDIT_RACE",
            "A run started while this schedule was being edited. Try again.",
          );
        }
      }
    }

    const updates: Record<string, unknown> = {
      client_id: clientId,
      phone_id: phoneId,
      template_id: templateId,
      cron_expression: cronExpression,
      timezone,
      next_run_at: nextRunAt,
      gps_latitude: latitude,
      gps_longitude: longitude,
      gps_mode: gpsMode,
      updated_at: new Date().toISOString(),
    };
    if (input.name !== undefined) updates.name = input.name;
    if (input.keyword !== undefined) updates.keyword = input.keyword;
    if (input.config !== undefined) updates.config = input.config;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.localeTimezone !== undefined) updates.locale_timezone = input.localeTimezone;
    if (input.localeLanguage !== undefined) updates.locale_language = input.localeLanguage;
    if (input.maxAttempts !== undefined) updates.max_attempts = input.maxAttempts;
    if (input.expectedDurationSeconds !== undefined) {
      updates.expected_duration_seconds = input.expectedDurationSeconds;
    }

    const { data, error } = await context.admin
      .from("scheduler_schedules")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", context.organizationId)
      .eq("source_kind", "calendar")
      .select(SCHEDULE_FIELDS)
      .maybeSingle();
    if (error) {
      throw new ApiError(503, "SCHEDULE_UPDATE_FAILED", "The schedule could not be updated.");
    }
    if (!data) throw new ApiError(404, "SCHEDULE_NOT_FOUND", "Schedule not found.");

    let cancellationRequested = 0;
    let removedPendingPlans = 0;
    if (input.enabled === false) {
      const openRuns = await openRunsForSchedule(context, id);
      const pristinePlans = openRuns.filter(
        (run) =>
          run.status === "pending" &&
          !run.duoplus_task_id &&
          (run.attempt_count ?? 0) === 0 &&
          !run.lease_owner,
      );
      if (pristinePlans.length > 0) {
        const { data: removed, error: removeError } = await context.admin
          .from("scheduler_runs")
          .delete()
          .eq("organization_id", context.organizationId)
          .eq("schedule_id", id)
          .eq("status", "pending")
          .eq("attempt_count", 0)
          .is("duoplus_task_id", null)
          .is("lease_owner", null)
          .in(
            "id",
            pristinePlans.map((run) => run.id),
          )
          .select("id");
        if (removeError) {
          throw new ApiError(
            503,
            "PENDING_PLAN_REMOVE_FAILED",
            "The schedule was paused, but pending plans could not be removed.",
          );
        }
        removedPendingPlans = removed?.length ?? 0;
      }

      // Reload after the guarded delete. Anything that started concurrently is
      // now a durable cancellation request owned by the worker.
      const remainingRuns = await openRunsForSchedule(context, id);
      const cancellation = await cancelRuns(context, remainingRuns);
      cancellationRequested = cancellation.cancellationRequested;
      if (cancellationRequested > 0) triggerTick(context.admin, "minute");
    }
    if (
      (data as ScheduleRow).enabled &&
      (input.enabled === true || materialEdit)
    ) {
      triggerTick(context.admin, "horizon");
    }

    return dataResponse({
      schedule: presentSchedule(data as ScheduleRow),
      cancellationRequested,
      removedPendingPlans,
    });
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrganization(request, async (context) => {
    requireSchedulerManager(context);
    const { id } = await params;
    if (context.demo) {
      return dataResponse({ scheduleId: id, enabled: false, cancelledRuns: 0, preview: true });
    }

    const { data: schedule, error } = await context.admin
      .from("scheduler_schedules")
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", context.organizationId)
      .eq("source_kind", "calendar")
      .select("id")
      .maybeSingle();
    if (error) {
      throw new ApiError(503, "SCHEDULE_DISABLE_FAILED", "The schedule could not be removed.");
    }
    if (!schedule) throw new ApiError(404, "SCHEDULE_NOT_FOUND", "Schedule not found.");

    const openRuns = await openRunsForSchedule(context, id);
    const cancellation = await cancelRuns(context, openRuns);
    if (cancellation.cancellationRequested > 0) {
      triggerTick(context.admin, "minute");
    }
    return dataResponse({
      scheduleId: id,
      enabled: false,
      cancellationRequested: cancellation.cancellationRequested,
    });
  });
}
