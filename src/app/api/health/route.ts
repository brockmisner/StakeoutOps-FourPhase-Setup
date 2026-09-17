import { NextResponse } from "next/server";

import {
  deploymentReadinessChecks,
  isDeploymentReady,
} from "@/lib/runtime-readiness";
import { isDemoMode } from "@/lib/supabase/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const demo = isDemoMode();
  const checks = deploymentReadinessChecks();
  const ready = !demo && isDeploymentReady();

  return NextResponse.json(
    {
      ok: ready,
      ready,
      mode: demo ? "demo" : ready ? "live" : "setup-required",
      checks,
      timestamp: new Date().toISOString(),
    },
    {
      status: ready ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
