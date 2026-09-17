import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";

import { presentRun, type RunRow } from "./_shared";

const RUN_FIELDS =
  "id, client_id, connection_id, schedule_id, phone_id, template_id, scheduled_for, issue_at, expected_duration_seconds, status, stage, next_action_at, attempt_count, max_attempts, task_name, duoplus_task_id, duoplus_status, started_at, finished_at, last_error, cancellation_requested, cancellation_requested_at, log_json, screenshots, device_cycle_id, program_rule_id, cycle_day, occurrence_key, window_start_at, window_end_at, submission_state, created_at, updated_at";

export async function GET(request: Request) {
  return withOrganization(request, async (context) => {
    if (context.demo) {
      const now = new Date();
      return dataResponse({
        runs: [
          {
            id: "demo-run-1",
            clientId: "00000000-0000-4000-8000-000000000001",
            clientName: "Harbor Injury Law",
            connectionId: "demo-connection",
            scheduleId: "demo-schedule-1",
            scheduleName: "Miami PI morning scan",
            keyword: "car accident lawyer",
            sourceKind: "calendar",
            phoneId: "00000000-0000-4000-8000-000000000101",
            phoneName: "Field phone 01",
            templateId: "00000000-0000-4000-8000-000000000201",
            templateName: "Chrome SERP observation",
            scheduledFor: new Date(now.getTime() - 18 * 60_000).toISOString(),
            issueAt: new Date(now.getTime() - 18 * 60_000).toISOString(),
            expectedDurationSeconds: 600,
            status: "succeeded",
            stage: "complete",
            nextActionAt: now.toISOString(),
            attemptCount: 1,
            maxAttempts: 3,
            hasDuoPlusTask: true,
            duoPlusStatus: 3,
            startedAt: new Date(now.getTime() - 18 * 60_000).toISOString(),
            finishedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
            lastError: null,
            cancellationRequested: false,
            cancellationRequestedAt: null,
            log: null,
            screenshots: [],
            createdAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
            updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
          },
        ],
      });
    }

    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const clientId = url.searchParams.get("clientId");
    const scheduleId = url.searchParams.get("scheduleId");
    const from = url.searchParams.get("from");
    const through = url.searchParams.get("through");
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1),
      500,
    );

    let query = context.admin
      .from("scheduler_runs")
      .select(RUN_FIELDS)
      .eq("organization_id", context.organizationId)
      .order("issue_at", { ascending: false })
      .limit(limit);
    if (status) query = query.eq("status", status);
    if (clientId) query = query.eq("client_id", clientId);
    if (scheduleId) query = query.eq("schedule_id", scheduleId);
    if (from) {
      const parsed = new Date(from);
      if (Number.isNaN(parsed.getTime())) {
        throw new ApiError(400, "INVALID_RUN_WINDOW", "The run window start is invalid.");
      }
      query = query.gte("issue_at", parsed.toISOString());
    }
    if (through) {
      const parsed = new Date(through);
      if (Number.isNaN(parsed.getTime())) {
        throw new ApiError(400, "INVALID_RUN_WINDOW", "The run window end is invalid.");
      }
      query = query.lte("issue_at", parsed.toISOString());
    }

    const { data, error } = await query;
    if (error) {
      throw new ApiError(503, "RUN_LIST_FAILED", "Runs could not be loaded.");
    }

    const rows = (data ?? []) as RunRow[];
    const [clients, schedules, phones, templates] = await Promise.all([
      context.admin
        .from("clients")
        .select("id, name")
        .eq("organization_id", context.organizationId),
      context.admin
        .from("scheduler_schedules")
        .select("id, name, keyword, source_kind")
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
    if (clients.error || schedules.error || phones.error || templates.error) {
      throw new ApiError(503, "RUN_RELATIONS_FAILED", "Run labels could not be loaded.");
    }

    const clientNames = new Map((clients.data ?? []).map((row) => [row.id, row.name]));
    const schedulesById = new Map(
      (schedules.data ?? []).map((row) => [row.id, row]),
    );
    const phoneNames = new Map((phones.data ?? []).map((row) => [row.id, row.name]));
    const templateNames = new Map(
      (templates.data ?? []).map((row) => [row.id, row.name]),
    );

    return dataResponse({
      runs: rows.map((row) => {
        const schedule = schedulesById.get(row.schedule_id);
        return presentRun(row, {
          client: clientNames.get(row.client_id),
          schedule: schedule?.name,
          keyword: schedule?.keyword,
          sourceKind: schedule?.source_kind as
            | "calendar"
            | "device_cycle"
            | undefined,
          phone: row.phone_id ? phoneNames.get(row.phone_id) : undefined,
          template: templateNames.get(row.template_id),
        });
      }),
    });
  });
}
