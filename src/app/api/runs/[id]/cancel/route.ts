import { after } from "next/server";

import { ApiError, dataResponse } from "@/lib/auth/errors";
import { requireSchedulerManager } from "@/lib/auth/context";
import { withOrganization } from "@/lib/auth/route";

import { cancelRuns, type CancellableRun } from "../../_shared";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrganization(request, async (context) => {
    requireSchedulerManager(context);
    const { id } = await params;
    if (context.demo) {
      return dataResponse({ runId: id, status: "cancelled", preview: true });
    }

    const { data, error } = await context.admin
      .from("scheduler_runs")
      .select("id, duoplus_task_id, status")
      .eq("id", id)
      .eq("organization_id", context.organizationId)
      .maybeSingle();
    if (error) throw new ApiError(503, "RUN_LOOKUP_FAILED", "The run could not be loaded.");
    if (!data) throw new ApiError(404, "RUN_NOT_FOUND", "Run not found.");
    if (["succeeded", "failed", "cancelled"].includes(data.status)) {
      throw new ApiError(409, "RUN_ALREADY_FINISHED", "Finished runs cannot be cancelled.");
    }

    const result = await cancelRuns(context, [data as CancellableRun]);
    if (result.cancellationRequested !== 1) {
      const { data: current } = await context.admin
        .from("scheduler_runs")
        .select("status")
        .eq("id", id)
        .eq("organization_id", context.organizationId)
        .maybeSingle();
      if (current && ["succeeded", "failed", "cancelled"].includes(current.status)) {
        throw new ApiError(
          409,
          "RUN_ALREADY_FINISHED",
          `The run became ${current.status} before cancellation was saved.`,
        );
      }
      throw new ApiError(
        409,
        "CANCELLATION_NOT_SAVED",
        "The run changed before cancellation was saved. Refresh and try again.",
      );
    }
    after(async () => {
      try {
        const [{ runSchedulerTick }, { createSupabaseSchedulerRuntime }] =
          await Promise.all([
            import("@/lib/scheduler/worker"),
            import("@/lib/scheduler/runtime"),
          ]);
        await runSchedulerTick({
          ...createSupabaseSchedulerRuntime(context.admin),
          mode: "minute",
          limit: 10,
        });
      } catch {
        // The minute cron retries the durable request.
      }
    });

    return dataResponse({
      runId: id,
      status: "cancellation_requested",
      cancellationRequested: true,
    });
  });
}
