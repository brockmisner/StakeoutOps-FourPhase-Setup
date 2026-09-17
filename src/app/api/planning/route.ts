import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";
import type { PlanningRun, PlanningSchedule, PlanningSnapshot } from "@/lib/scheduler/fleet-planning";

export const dynamic = "force-dynamic";
const RUN_FIELDS = "id,schedule_id,client_id,phone_id,template_id,scheduled_for,issue_at,status,stage,expected_duration_seconds,started_at,finished_at,window_end_at,next_action_at,attempt_count,max_attempts,last_error,device_cycle_id";
const SCHEDULE_FIELDS = "id,client_id,phone_id,template_id,name,keyword,cron_expression,timezone,enabled,next_run_at,expected_duration_seconds,max_attempts";
const OPEN = ["pending", "preparing", "queued", "running", "retry_wait", "paused"];
type Row = Record<string, unknown>;
function string(row: Row, key: string) { return String(row[key] ?? ""); }
function optional(row: Row, key: string) { return row[key] == null ? null : String(row[key]); }
function presentRun(row: Row): PlanningRun {
  return { id: string(row,"id"), scheduleId: string(row,"schedule_id"), clientId: string(row,"client_id"), phoneId: optional(row,"phone_id"), templateId: string(row,"template_id"),
    scheduledFor: string(row,"scheduled_for"), issueAt: string(row,"issue_at"), status: string(row,"status"), stage: string(row,"stage"),
    expectedDurationSeconds: Number(row.expected_duration_seconds), startedAt: optional(row,"started_at"), finishedAt: optional(row,"finished_at"), windowEndAt: optional(row,"window_end_at"), nextActionAt: optional(row,"next_action_at"),
    attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts), lastError: optional(row,"last_error"), deviceCycleId: optional(row,"device_cycle_id") };
}
function presentSchedule(row: Row): PlanningSchedule {
  return { id: string(row,"id"), clientId: string(row,"client_id"), phoneId: optional(row,"phone_id"), templateId: string(row,"template_id"), name: string(row,"name"), keyword: string(row,"keyword"),
    cronExpression: string(row,"cron_expression"), timezone: string(row,"timezone"), enabled: row.enabled === true, nextRunAt: optional(row,"next_run_at"),
    expectedDurationSeconds: Number(row.expected_duration_seconds), maxAttempts: Number(row.max_attempts) };
}
export async function GET(request: Request) {
  return withOrganization(request, async context => {
    const url = new URL(request.url);
    const from = Date.parse(url.searchParams.get("from") ?? "");
    const through = Date.parse(url.searchParams.get("through") ?? "");
    if (!Number.isFinite(from) || !Number.isFinite(through) || through <= from || through - from > 8 * 86400_000) {
      throw new ApiError(400, "INVALID_PLANNING_WINDOW", "Choose a planning window of up to eight days.");
    }
    if (context.demo) return dataResponse({ runs: [], schedules: [], truncated: false, loadedAt: new Date().toISOString() } satisfies PlanningSnapshot);
    const { admin, organizationId } = context;
    async function readRuns(kind: "window" | "backlog") {
      const rows: Row[] = [];
      for (let offset = 0; offset < 10000; offset += 1000) {
        let query = admin.from("scheduler_runs").select(RUN_FIELDS).eq("organization_id", organizationId);
        if (kind === "window") query = query.gte("scheduled_for", new Date(from).toISOString()).lt("scheduled_for", new Date(through).toISOString());
        else query = query.lt("scheduled_for", new Date(from).toISOString()).in("status", OPEN);
        const { data, error } = await query.order("id", { ascending: true }).range(offset, offset + 999);
        if (error) throw new ApiError(503, "PLANNING_LOAD_FAILED", "The complete planning window could not be loaded. Try refreshing.");
        rows.push(...(data ?? []) as unknown as Row[]);
        if ((data?.length ?? 0) < 1000) return { rows, truncated: false };
      }
      return { rows, truncated: true };
    }
    async function readSchedules() {
      const rows: Row[] = [];
      for (let offset = 0; offset < 5000; offset += 1000) {
        const { data, error } = await admin.from("scheduler_schedules").select(SCHEDULE_FIELDS)
          .eq("organization_id", organizationId).eq("source_kind", "calendar").order("id", { ascending: true }).range(offset, offset + 999);
        if (error) throw new ApiError(503, "PLANNING_LOAD_FAILED", "Recurring schedules could not be loaded. Try refreshing.");
        rows.push(...(data ?? []) as unknown as Row[]);
        if ((data?.length ?? 0) < 1000) return { rows, truncated: false };
      }
      return { rows, truncated: true };
    }
    const [window, backlog, schedules] = await Promise.all([readRuns("window"), readRuns("backlog"), readSchedules()]);
    return dataResponse({ runs: [...window.rows, ...backlog.rows].map(presentRun), schedules: schedules.rows.map(presentSchedule),
      truncated: window.truncated || backlog.truncated || schedules.truncated, loadedAt: new Date().toISOString() } satisfies PlanningSnapshot);
  });
}
