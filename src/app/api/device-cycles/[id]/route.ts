import { after } from "next/server";
import { z } from "zod";

import { requireSchedulerManager } from "@/lib/auth/context";
import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";

const inputSchema = z.object({
  status: z.enum(["active", "paused", "cancelled"]),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrganization(request, async (context) => {
    requireSchedulerManager(context);
    const { id } = await params;
    let input: z.infer<typeof inputSchema>;
    try {
      input = inputSchema.parse(await request.json());
    } catch {
      throw new ApiError(
        400,
        "INVALID_CYCLE_STATUS",
        "Choose pause, resume, or cancel for this device cycle.",
      );
    }

    const { data, error } = await context.admin.rpc(
      "set_device_cycle_operating_status",
      {
        p_organization_id: context.organizationId,
        p_cycle_id: id,
        p_status: input.status,
      },
    );
    if (error) {
      if (error.code === "P0002") {
        throw new ApiError(404, "CYCLE_NOT_FOUND", "Device cycle not found.");
      }
      if (error.code === "22023") {
        throw new ApiError(
          409,
          "INVALID_CYCLE_TRANSITION",
          error.message || "That device cycle status cannot be changed.",
        );
      }
      throw new ApiError(
        503,
        "CYCLE_STATUS_FAILED",
        "The device cycle status could not be changed.",
      );
    }

    const result = (Array.isArray(data) ? data[0] : data) as
      | {
          cycleId?: string;
          status?: "active" | "paused" | "cancelled";
          cancellationRequested?: number;
        }
      | null;

    if (input.status === "cancelled") {
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
            limit: 100,
          });
        } catch {
          // The recurring dispatcher owns durable cancellation retries.
        }
      });
    }

    return dataResponse({
      cycleId: result?.cycleId ?? id,
      status: result?.status ?? input.status,
      cancellationRequested: result?.cancellationRequested ?? 0,
    });
  });
}
