import { randomUUID } from "node:crypto";

import { after } from "next/server";

import { ApiError, dataResponse } from "@/lib/auth/errors";
import { requireSchedulerManager } from "@/lib/auth/context";
import { withOrganization } from "@/lib/auth/route";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrganization(request, async (context) => {
    requireSchedulerManager(context);
    const { id } = await params;
    const now = new Date();
    const issueAt = new Date(now.getTime() + 2 * 60_000);

    const runId = randomUUID();
    const { data, error: runError } = await context.admin.rpc(
      "enqueue_schedule_run_now",
      {
        p_organization_id: context.organizationId,
        p_schedule_id: id,
        p_run_id: runId,
        p_scheduled_for: now.toISOString(),
        p_issue_at: issueAt.toISOString(),
      },
    );
    const run = (Array.isArray(data) ? data[0] : data) as
      | {
          id: string;
          schedule_id: string;
          status: string;
          stage: string;
          issue_at: string;
          created_at: string;
        }
      | null;
    if (runError || !run) {
      if (runError?.code === "P0002") {
        throw new ApiError(404, "SCHEDULE_NOT_FOUND", "Schedule not found.");
      }
      if (runError?.code === "P4201") {
        throw new ApiError(
          409,
          "SCHEDULE_RUN_IN_PROGRESS",
          "This schedule already has an unfinished run. Wait for it to finish or cancel it before running again.",
        );
      }
      if (runError?.code === "22023") {
        throw new ApiError(
          409,
          "SCHEDULE_PAUSED",
          "Enable the schedule before running it now.",
        );
      }
      throw new ApiError(
        runError?.code === "23P01" ? 409 : 503,
        runError?.code === "23P01" ? "PHONE_TIME_CONFLICT" : "RUN_CREATE_FAILED",
        runError?.code === "23P01"
          ? "That phone already has work in this time window."
          : "The run could not be queued.",
      );
    }

    after(async () => {
      try {
        const { runSchedulerTick } = await import("@/lib/scheduler/worker");
        const { createSupabaseSchedulerRuntime } = await import(
          "@/lib/scheduler/runtime"
        );
        await runSchedulerTick({
          ...createSupabaseSchedulerRuntime(context.admin),
          now: new Date(),
          mode: "minute",
          limit: 10,
        });
      } catch {
        // The scheduled cron safely retries pending work.
      }
    });

    return dataResponse(
      {
        run: {
          id: run.id,
          scheduleId: run.schedule_id,
          status: run.status,
          stage: run.stage,
          issueAt: run.issue_at,
          createdAt: run.created_at,
        },
      },
      { status: 202 },
    );
  });
}
