import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";

import { presentRun, type RunRow } from "../_shared";

const RUN_FIELDS =
  "id, client_id, connection_id, schedule_id, phone_id, template_id, scheduled_for, issue_at, expected_duration_seconds, status, stage, next_action_at, attempt_count, max_attempts, task_name, duoplus_task_id, duoplus_status, started_at, finished_at, last_error, cancellation_requested, cancellation_requested_at, log_json, screenshots, device_cycle_id, program_rule_id, cycle_day, occurrence_key, window_start_at, window_end_at, submission_state, created_at, updated_at";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrganization(request, async (context) => {
    const { id } = await params;
    if (context.demo) {
      return dataResponse({
        run: {
          id,
          status: "succeeded",
          stage: "complete",
          log: null,
          screenshots: [],
          preview: true,
        },
      });
    }

    const { data, error } = await context.admin
      .from("scheduler_runs")
      .select(RUN_FIELDS)
      .eq("id", id)
      .eq("organization_id", context.organizationId)
      .maybeSingle();
    if (error) throw new ApiError(503, "RUN_LOOKUP_FAILED", "The run could not be loaded.");
    if (!data) throw new ApiError(404, "RUN_NOT_FOUND", "Run not found.");

    return dataResponse({ run: presentRun(data as RunRow) });
  });
}
