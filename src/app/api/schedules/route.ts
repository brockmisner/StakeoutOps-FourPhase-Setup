import { randomUUID } from "node:crypto";

import { after } from "next/server";

import { ApiError, dataResponse } from "@/lib/auth/errors";
import { requireSchedulerManager } from "@/lib/auth/context";
import { taskConfigIssueMessage } from "@/lib/duoplus/task-config";
import { withOrganization } from "@/lib/auth/route";

import {
  calculateNextRun,
  presentSchedule,
  resolveScheduleReferences,
  scheduleCreateSchema,
  type ScheduleRow,
} from "./_shared";

const SCHEDULE_FIELDS =
  "id, client_id, connection_id, phone_id, template_id, name, keyword, config, cron_expression, timezone, next_run_at, last_enqueued_at, enabled, gps_latitude, gps_longitude, gps_mode, locale_timezone, locale_language, max_attempts, expected_duration_seconds, created_at, updated_at";

export async function GET(request: Request) {
  return withOrganization(request, async (context) => {
    if (context.demo) {
      const now = new Date();
      return dataResponse({
        schedules: [
          {
            id: "demo-schedule-1",
            clientId: "00000000-0000-4000-8000-000000000001",
            clientName: "Harbor Injury Law",
            connectionId: "demo-connection",
            phoneId: "00000000-0000-4000-8000-000000000101",
            phoneName: "Field phone 01",
            templateId: "00000000-0000-4000-8000-000000000201",
            templateName: "Chrome SERP observation",
            name: "Miami PI morning scan",
            keyword: "car accident lawyer",
            config: {},
            cronExpression: "0 9 * * *",
            timezone: "America/New_York",
            nextRunAt: new Date(now.getTime() + 55 * 60_000).toISOString(),
            lastEnqueuedAt: null,
            enabled: true,
            gpsLatitude: 25.7907,
            gpsLongitude: -80.13,
            gpsMode: 2,
            localeTimezone: "America/New_York",
            localeLanguage: "en-US",
            maxAttempts: 3,
            expectedDurationSeconds: 600,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        ],
      });
    }

    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    const enabled = url.searchParams.get("enabled");
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1),
      500,
    );

    let query = context.admin
      .from("scheduler_schedules")
      .select(SCHEDULE_FIELDS)
      .eq("organization_id", context.organizationId)
      .eq("source_kind", "calendar")
      .order("next_run_at", { ascending: true })
      .limit(limit);
    if (clientId) query = query.eq("client_id", clientId);
    if (enabled === "true" || enabled === "false") {
      query = query.eq("enabled", enabled === "true");
    }

    const { data, error } = await query;
    if (error) {
      throw new ApiError(503, "SCHEDULE_LIST_FAILED", "Schedules could not be loaded.");
    }

    const rows = (data ?? []) as ScheduleRow[];
    const [clients, phones, templates] = await Promise.all([
      context.admin
        .from("clients")
        .select("id, name")
        .eq("organization_id", context.organizationId),
      context.admin
        .from("duo_phones")
        .select("id, name")
        .eq("organization_id", context.organizationId),
      context.admin
        .from("duo_templates")
        .select("id, name")
        .eq("organization_id", context.organizationId),
    ]);
    if (clients.error || phones.error || templates.error) {
      throw new ApiError(503, "SCHEDULE_RELATIONS_FAILED", "Schedule labels could not be loaded.");
    }

    const clientNames = new Map((clients.data ?? []).map((row) => [row.id, row.name]));
    const phoneNames = new Map((phones.data ?? []).map((row) => [row.id, row.name]));
    const templateNames = new Map(
      (templates.data ?? []).map((row) => [row.id, row.name]),
    );

    return dataResponse({
      schedules: rows.map((row) =>
        presentSchedule(row, {
          client: clientNames.get(row.client_id),
          phone: row.phone_id ? phoneNames.get(row.phone_id) : undefined,
          template: templateNames.get(row.template_id),
        }),
      ),
    });
  });
}

export async function POST(request: Request) {
  return withOrganization(request, async (context) => {
    requireSchedulerManager(context);
    let input;
    try {
      input = scheduleCreateSchema.parse(await request.json());
    } catch (error) {
      const configMessage = taskConfigIssueMessage(error);
      if (configMessage) {
        throw new ApiError(400, "INVALID_TASK_CONFIG", configMessage);
      }
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "Check the client, phone, template, cadence, task config, and location fields.",
      );
    }

    if (context.demo) {
      const now = new Date().toISOString();
      return dataResponse(
        {
          schedule: {
            id: randomUUID(),
            ...input,
            clientName: "Preview client",
            phoneName: input.phoneId ? "Preview phone" : null,
            templateName: "Preview template",
            connectionId: "demo-connection",
            name: input.name || input.keyword,
            nextRunAt: calculateNextRun(
              input.cronExpression,
              input.timezone,
              input.nextRunAt,
            ),
            lastEnqueuedAt: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        { status: 201 },
      );
    }

    const connection = await resolveScheduleReferences(context, input);
    const nextRunAt = calculateNextRun(
      input.cronExpression,
      input.timezone,
      input.nextRunAt,
    );
    const { data, error } = await context.admin
      .from("scheduler_schedules")
      .insert({
        organization_id: context.organizationId,
        client_id: input.clientId,
        connection_id: connection.id,
        phone_id: input.phoneId ?? null,
        template_id: input.templateId,
        name: input.name || input.keyword,
        keyword: input.keyword,
        config: input.config,
        cron_expression: input.cronExpression,
        timezone: input.timezone,
        next_run_at: nextRunAt,
        enabled: input.enabled,
        gps_latitude: input.gpsLatitude ?? null,
        gps_longitude: input.gpsLongitude ?? null,
        gps_mode: input.gpsMode,
        locale_timezone: input.localeTimezone ?? null,
        locale_language: input.localeLanguage ?? null,
        max_attempts: input.maxAttempts,
        expected_duration_seconds: input.expectedDurationSeconds,
        created_by: context.user.id,
      })
      .select(SCHEDULE_FIELDS)
      .single();

    if (error || !data) {
      throw new ApiError(
        503,
        "SCHEDULE_CREATE_FAILED",
        "The schedule could not be created.",
      );
    }

    if (input.enabled) {
      after(async () => {
        try {
          const { runSchedulerTick } = await import("@/lib/scheduler/worker");
          const { createSupabaseSchedulerRuntime } = await import(
            "@/lib/scheduler/runtime"
          );
          await runSchedulerTick({
            ...createSupabaseSchedulerRuntime(context.admin),
            now: new Date(),
            mode: "horizon",
            limit: 10,
          });
        } catch {
          // The scheduled cron safely materializes and retries pending work.
        }
      });
    }

    return dataResponse(
      { schedule: presentSchedule(data as ScheduleRow) },
      { status: 201 },
    );
  });
}
