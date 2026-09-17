import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";

type ProfileState =
  | "new"
  | "warming"
  | "ready"
  | "completed"
  | "needs_attention"
  | "retired";

type ProfileRow = {
  id: string;
  client_id: string;
  phone_id: string;
  device_cycle_id: string;
  label: string;
  state: ProfileState;
  started_on: string;
  duration_days: number;
  timezone: string;
  earned_points: number | string;
  possible_points: number | string;
  ready_day: number;
  ready_score_threshold: number | string;
  completion_score_threshold: number | string;
  successful_days: number | string;
  last_success_at: string | null;
  ready_at: string | null;
  completed_at: string | null;
  retired_at: string | null;
  status_reason: string | null;
  created_at: string;
};

type CycleRow = {
  id: string;
  name: string;
  program_id: string;
  status: string;
  last_error: string | null;
};

type AppScoreRow = {
  profile_id: string;
  app_kind: string;
  earned_points: number | string;
  possible_points: number | string;
};

type PhaseGateRow = {
  device_cycle_id: string;
  current_phase: string | null;
  phase_gate: Record<string, unknown> | null;
};

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateInTimezone(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function currentCycleDay(profile: ProfileRow, now = new Date()): number {
  const today = dateInTimezone(now, profile.timezone);
  if (today < profile.started_on) return 0;
  const start = Date.parse(`${profile.started_on}T00:00:00.000Z`);
  const current = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(current)) return 0;
  return Math.min(
    Math.max(Math.floor((current - start) / 86_400_000) + 1, 0),
    Math.max(profile.duration_days, 0),
  );
}

function defaultStatusReason(profile: ProfileRow): string {
  const score = numberValue(profile.earned_points);
  if (profile.state === "new") return "No successful scored activity yet.";
  if (profile.state === "warming") {
    const remaining = Math.max(numberValue(profile.ready_score_threshold) - score, 0);
    return remaining > 0
      ? `${remaining} more points needed for Ready.`
      : `Point target met; readiness gates continue through day ${profile.ready_day}.`;
  }
  if (profile.state === "ready") return "Ready threshold and activity gates reached.";
  if (profile.state === "completed") return "Completion threshold and required activity reached.";
  if (profile.state === "needs_attention") return "Review failures or missed required activity.";
  return "Profile retired from active cycles.";
}

function emptySummary() {
  return {
    total: 0,
    new: 0,
    warming: 0,
    ready: 0,
    completed: 0,
    needsAttention: 0,
  };
}

function demoProfiles() {
  const now = new Date();
  const startedOn = new Date(now.getTime() - 11 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const profiles = [
    {
      id: "demo-profile-1",
      label: "Lakeland profile A",
      clientId: "00000000-0000-4000-8000-000000000001",
      clientName: "Harbor Injury Law",
      phoneId: "00000000-0000-4000-8000-000000000101",
      phoneName: "Field phone 01",
      cycleId: "demo-cycle-1",
      cycleName: "Lakeland visibility — Phone 01",
      programId: "demo-cycle-program",
      programName: "30-day local presence cycle",
      state: "ready" as const,
      startedOn,
      currentDay: 12,
      durationDays: 30,
      score: 402,
      possibleScore: 1_030,
      readyDay: 10,
      readyScore: 360,
      completionScore: 927,
      successfulDays: 11,
      appScores: [
        { app: "chrome", score: 160, possible: 420 },
        { app: "discover", score: 126, possible: 315 },
        { app: "maps", score: 116, possible: 295 },
      ],
      lastSuccessAt: new Date(now.getTime() - 18 * 60_000).toISOString(),
      readyAt: new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
      completedAt: null,
      retiredAt: null,
      statusReason: "Ready threshold and activity gates reached.",
    },
    {
      id: "demo-profile-2",
      label: "Lakeland profile B",
      clientId: "00000000-0000-4000-8000-000000000001",
      clientName: "Harbor Injury Law",
      phoneId: "00000000-0000-4000-8000-000000000102",
      phoneName: "Field phone 02",
      cycleId: "demo-cycle-2",
      cycleName: "Lakeland visibility — Phone 02",
      programId: "demo-cycle-program",
      programName: "30-day local presence cycle",
      state: "warming" as const,
      startedOn,
      currentDay: 12,
      durationDays: 30,
      score: 338,
      possibleScore: 1_030,
      readyDay: 10,
      readyScore: 360,
      completionScore: 927,
      successfulDays: 10,
      appScores: [
        { app: "chrome", score: 140, possible: 420 },
        { app: "discover", score: 105, possible: 315 },
        { app: "maps", score: 93, possible: 295 },
      ],
      lastSuccessAt: new Date(now.getTime() - 26 * 60_000).toISOString(),
      readyAt: null,
      completedAt: null,
      retiredAt: null,
      statusReason: "22 more points needed for Ready.",
    },
  ];

  return {
    profiles,
    summary: {
      ...emptySummary(),
      total: profiles.length,
      warming: 1,
      ready: 1,
    },
  };
}

export async function GET(request: Request) {
  return withOrganization(request, async (context) => {
    if (context.demo) return dataResponse(demoProfiles());

    const [profilesResult, clientsResult, phonesResult, cyclesResult, programsResult, appScoresResult, phaseGatesResult] =
      await Promise.all([
        context.admin
          .from("device_profiles")
          .select(
            "id, client_id, phone_id, device_cycle_id, label, state, started_on, duration_days, timezone, earned_points, possible_points, ready_day, ready_score_threshold, completion_score_threshold, successful_days, last_success_at, ready_at, completed_at, retired_at, status_reason, created_at",
          )
          .eq("organization_id", context.organizationId)
          .order("created_at", { ascending: false })
          .limit(300),
        context.admin
          .from("clients")
          .select("id, name")
          .eq("organization_id", context.organizationId),
        context.admin
          .from("duo_phones")
          .select("id, name")
          .eq("organization_id", context.organizationId),
        context.admin
          .from("device_cycles")
          .select("id, name, program_id, status, last_error")
          .eq("organization_id", context.organizationId),
        context.admin
          .from("cycle_programs")
          .select("id, name, phase_plan")
          .eq("organization_id", context.organizationId),
        context.admin.rpc("get_profile_app_scores", {
          p_organization_id: context.organizationId,
        }),
        context.admin.rpc("get_device_cycle_phase_gates", {
          p_organization_id: context.organizationId,
        }),
      ]);

    if (
      profilesResult.error ||
      clientsResult.error ||
      phonesResult.error ||
      cyclesResult.error ||
      programsResult.error ||
      appScoresResult.error ||
      phaseGatesResult.error
    ) {
      throw new ApiError(
        503,
        "PROFILE_READINESS_LIST_FAILED",
        "Profile readiness could not be loaded.",
      );
    }

    const clientNames = new Map((clientsResult.data ?? []).map((row) => [row.id, row.name]));
    const phoneNames = new Map((phonesResult.data ?? []).map((row) => [row.id, row.name]));
    const cycles = new Map(
      ((cyclesResult.data ?? []) as CycleRow[]).map((row) => [row.id, row]),
    );
    const programNames = new Map((programsResult.data ?? []).map((row) => [row.id, row.name]));
    const phasePlans = new Map((programsResult.data ?? []).map((row) => [row.id, row.phase_plan ?? null]));
    const phaseGates = new Map<string, PhaseGateRow>(((phaseGatesResult.data ?? []) as PhaseGateRow[])
      .map((row) => [row.device_cycle_id, row]));
    const appScores = new Map<string, Array<{ app: string; score: number; possible: number }>>();
    for (const row of (appScoresResult.data ?? []) as AppScoreRow[]) {
      const scores = appScores.get(row.profile_id) ?? [];
      scores.push({
        app: row.app_kind,
        score: numberValue(row.earned_points),
        possible: numberValue(row.possible_points),
      });
      appScores.set(row.profile_id, scores);
    }

    const rows = (profilesResult.data ?? []) as ProfileRow[];
    const now = new Date();
    const profiles = rows.map((row) => {
      const cycle = cycles.get(row.device_cycle_id);
      const programId = cycle?.program_id ?? null;
      const day = currentCycleDay(row, now);
      const lastSuccessTime = row.last_success_at
        ? new Date(row.last_success_at).getTime()
        : Number.NaN;
      const staleAfterReadyDay =
        day > row.ready_day &&
        (!Number.isFinite(lastSuccessTime) ||
          now.getTime() - lastSuccessTime > 48 * 60 * 60_000);
      const cycleNeedsAttention =
        cycle?.status === "blocked" || cycle?.status === "paused";
      const phasePlan = programId ? (phasePlans.get(programId) ?? null) : null;
      const phase = phaseGates.get(row.device_cycle_id);
      const phaseProgressMissing = Boolean(phasePlan && !phase?.phase_gate);
      const phaseNeedsRecovery = Boolean(phasePlan && phase?.phase_gate?.status === "recovery_required");
      let state: ProfileState =
        (cycleNeedsAttention || staleAfterReadyDay) &&
        row.state !== "completed" &&
        row.state !== "retired"
          ? ("needs_attention" as const)
          : row.state;
      if (phasePlan && row.state !== "retired") {
        if (phaseNeedsRecovery || phaseProgressMissing) state = "needs_attention";
        else if (phase?.current_phase === "warmup" && (state === "ready" || state === "completed")) {
          state = numberValue(row.earned_points) > 0 ? "warming" : "new";
        }
      }
      return {
        id: row.id,
        label: row.label,
        clientId: row.client_id,
        clientName: clientNames.get(row.client_id) ?? "Unknown client",
        phoneId: row.phone_id,
        phoneName: phoneNames.get(row.phone_id) ?? "Unknown phone",
        cycleId: row.device_cycle_id,
        cycleName: cycle?.name ?? "Unknown cycle",
        programId,
        programName: programId ? (programNames.get(programId) ?? "Unknown program") : null,
        phasePlan,
        currentPhase: phase?.current_phase ?? null,
        phaseGate: phase?.phase_gate ?? null,
        state,
        startedOn: row.started_on,
        currentDay: day,
        durationDays: row.duration_days,
        score: numberValue(row.earned_points),
        possibleScore: numberValue(row.possible_points),
        readyDay: row.ready_day,
        readyScore: numberValue(row.ready_score_threshold),
        completionScore: numberValue(row.completion_score_threshold),
        successfulDays: numberValue(row.successful_days),
        appScores: (appScores.get(row.id) ?? []).sort((a, b) =>
          a.app.localeCompare(b.app),
        ),
        lastSuccessAt: row.last_success_at,
        readyAt: row.ready_at,
        completedAt: row.completed_at,
        retiredAt: row.retired_at,
        statusReason:
          (phaseProgressMissing ? "Phase completion progress could not be loaded. Refresh before relying on this profile's readiness." : null) ||
          (phaseNeedsRecovery && typeof phase?.phase_gate?.reason === "string" ? phase.phase_gate.reason : null) ||
          (state === "needs_attention" ? cycle?.last_error : null) ||
          (cycleNeedsAttention && state === "needs_attention"
            ? `The device cycle is ${cycle?.status}.`
            : null) ||
          (staleAfterReadyDay && state === "needs_attention"
            ? "No successful scored activity was recorded in the last 48 hours."
            : null) ||
          row.status_reason ||
          defaultStatusReason({ ...row, state }),
      };
    });

    const summary = emptySummary();
    summary.total = profiles.length;
    for (const profile of profiles) {
      if (profile.state === "new") summary.new += 1;
      if (profile.state === "warming") summary.warming += 1;
      if (profile.state === "ready") summary.ready += 1;
      if (profile.state === "completed") summary.completed += 1;
      if (profile.state === "needs_attention") summary.needsAttention += 1;
    }

    return dataResponse({ profiles, summary });
  });
}
