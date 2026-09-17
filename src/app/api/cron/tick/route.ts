import { timingSafeEqual } from "node:crypto";

import {
  createSupabaseSchedulerRuntime,
  refreshStaleSubscriptionCapacities,
} from "@/lib/scheduler/runtime";
import { runSchedulerTick, type SchedulerTickMode } from "@/lib/scheduler/worker";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isDemoMode } from "@/lib/supabase/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(authorization);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function positiveInteger(value: string | null, fallback: number, maximum: number): number {
  const safeFallback =
    Number.isInteger(fallback) && fallback > 0
      ? Math.min(fallback, maximum)
      : 1;
  if (!value) return safeFallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : safeFallback;
}

async function handleTick(request: Request): Promise<Response> {
  if (isDemoMode()) {
    return Response.json(
      { ok: false, error: "Demo mode is read-only", code: "demo_mode_read_only" },
      { status: 503 },
    );
  }
  if (!process.env.CRON_SECRET) {
    return Response.json({ ok: false, error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const requestedMode = url.searchParams.get("mode");
  if (requestedMode && requestedMode !== "horizon" && requestedMode !== "minute") {
    return Response.json(
      { ok: false, error: "mode must be horizon or minute" },
      { status: 400 },
    );
  }
  // Railway runs automatic ticks directly. This authenticated endpoint remains
  // available for deliberate operational probes and recovery.
  const mode: SchedulerTickMode = requestedMode === "minute" ? "minute" : "horizon";
  const fallbackLimit = mode === "horizon" ? 100 : 20;
  const configuredLimit =
    mode === "horizon"
      ? process.env.HORIZON_DISPATCH_BATCH_SIZE
      : process.env.DISPATCH_BATCH_SIZE;
  const defaultLimit = positiveInteger(
    configuredLimit ?? null,
    fallbackLimit,
    1_000,
  );
  const limit = positiveInteger(
    url.searchParams.get("limit"),
    defaultLimit,
    1_000,
  );
  const defaultLookahead = positiveInteger(
    process.env.DISPATCH_LOOKAHEAD_MINUTES ?? null,
    15,
    180,
  );

  try {
    const supabase = createSupabaseAdminClient();
    const capacitySync = await refreshStaleSubscriptionCapacities(supabase);
    const scheduler = createSupabaseSchedulerRuntime(supabase);
    const summary = await runSchedulerTick({
      ...scheduler,
      mode,
      limit,
      horizonHours: positiveInteger(url.searchParams.get("hours"), 26, 48),
      lookaheadMinutes: positiveInteger(
        url.searchParams.get("lookahead"),
        defaultLookahead,
        180,
      ),
    });
    return Response.json({ ok: true, capacitySync, summary });
  } catch {
    // Provider and database failures are already captured by the scheduler's
    // redacted audit trail. Do not reflect upstream messages from this public
    // HTTP boundary, because they may contain credentials or tenant data.
    return Response.json(
      { ok: false, error: "Scheduler tick failed", code: "scheduler_tick_failed" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleTick(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleTick(request);
}
