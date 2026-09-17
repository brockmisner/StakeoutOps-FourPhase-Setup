import { z } from "zod";

import {
  requireSchedulerManager,
  type AuthContext,
} from "@/lib/auth/context";
import { createOrganizationDuoClient } from "@/lib/auth/duoplus";
import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";
import {
  duoPlusTaskConfigSchema,
  taskConfigIssueMessage,
} from "@/lib/duoplus/task-config";
import {
  ProgramConfigBindingError,
  resolveProgramTaskConfig,
} from "@/lib/scheduler/program-config";
import {
  isPhoneEligibleForNewWork,
  isPhoneEligibleThroughCycle,
} from "@/lib/scheduler/phone-safety";

type LiveAuthContext = Exclude<AuthContext, { demo: true }>;

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const createCycleSchema = z
  .object({
    programId: z.string().uuid(),
    clientId: z.string().uuid(),
    phoneId: z.string().uuid(),
    name: z.string().trim().min(2).max(160),
    keyword: z.string().trim().min(1).max(500),
    startDate: z.string().regex(datePattern),
    timezone: z.string().trim().min(1).max(80),
    targetCountry: z.string().trim().length(2).transform((value) => value.toUpperCase()),
    targetRegion: z.string().trim().min(1).max(120),
    targetCity: z.string().trim().min(1).max(120),
    targetLatitude: z.number().min(-90).max(90).nullable().optional(),
    targetLongitude: z.number().min(-180).max(180).nullable().optional(),
    profileLabel: z.string().trim().min(1).max(160),
    variables: duoPlusTaskConfigSchema.default({}),
  })
  .superRefine((value, context) => {
    const hasLatitude = value.targetLatitude !== undefined && value.targetLatitude !== null;
    const hasLongitude = value.targetLongitude !== undefined && value.targetLongitude !== null;
    if (hasLatitude !== hasLongitude) {
      context.addIssue({
        code: "custom",
        path: ["targetLatitude"],
        message: "Latitude and longitude must be supplied together.",
      });
    }
  });

type CycleRow = {
  id: string;
  client_id: string;
  connection_id: string;
  program_id: string;
  phone_id: string;
  name: string;
  keyword: string;
  profile_label: string | null;
  starts_on: string;
  ends_on: string;
  duration_days: number;
  timezone: string;
  status: string;
  proxy_mode: "managed" | "preconfigured";
  target_country: string;
  target_region: string;
  target_city: string;
  target_latitude: number | null;
  target_longitude: number | null;
  activated_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
};

type BindingRow = {
  device_cycle_id: string;
  configured_city: string;
  configured_region: string;
  configured_isp: string;
  diversity_status: string;
  health: string;
  observed_ip_masked: string | null;
  observed_city: string | null;
  observed_isp: string | null;
  distance_km: number | null;
  checked_at: string | null;
  released_at: string | null;
};

type CountRow = {
  device_cycle_id: string;
  total: number | string;
  done: number | string;
  running: number | string;
  failed: number | string;
  pending: number | string;
};

type PhaseGateRow = {
  device_cycle_id: string;
  current_phase: string | null;
  phase_gate: Record<string, unknown> | null;
};

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid calendar date");
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function validCalendarDate(date: string): boolean {
  try {
    return addDays(date, 0) === date;
  } catch {
    return false;
  }
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function dateInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function cycleDay(row: Pick<CycleRow, "starts_on" | "ends_on" | "duration_days" | "timezone">): number {
  const today = dateInTimezone(row.timezone);
  if (today < row.starts_on) return 0;
  if (today > row.ends_on) return row.duration_days;
  const start = Date.parse(`${row.starts_on}T00:00:00.000Z`);
  const current = Date.parse(`${today}T00:00:00.000Z`);
  return Math.floor((current - start) / 86_400_000) + 1;
}

function numberValue(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadCycles(context: LiveAuthContext) {
  const [cyclesResult, clientsResult, phonesResult, programsResult, bindingsResult, packageResult, countsResult, phaseGatesResult] =
    await Promise.all([
      context.admin
        .from("device_cycles")
        .select(
          "id, client_id, connection_id, program_id, phone_id, name, keyword, profile_label, starts_on, ends_on, duration_days, timezone, status, proxy_mode, target_country, target_region, target_city, target_latitude, target_longitude, activated_at, completed_at, last_error, created_at",
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
        .from("cycle_programs")
        .select("id, name, phase_plan")
        .eq("organization_id", context.organizationId),
      context.admin
        .from("phone_proxy_bindings")
        .select(
          "device_cycle_id, configured_city, configured_region, configured_isp, diversity_status, health, observed_ip_masked, observed_city, observed_isp, distance_km, checked_at, released_at",
        )
        .eq("organization_id", context.organizationId),
      context.admin
        .from("proxy_package_snapshots")
        .select("is_active, auto_renew, expired_on, traffic_limit_bytes, traffic_used_bytes, traffic_left_bytes, synced_at, last_error")
        .eq("organization_id", context.organizationId)
        .maybeSingle(),
      context.admin.rpc("get_device_cycle_run_counts", {
        p_organization_id: context.organizationId,
      }),
      context.admin.rpc("get_device_cycle_phase_gates", {
        p_organization_id: context.organizationId,
      }),
    ]);

  if (
    cyclesResult.error ||
    clientsResult.error ||
    phonesResult.error ||
    programsResult.error ||
    bindingsResult.error ||
    packageResult.error ||
    countsResult.error ||
    phaseGatesResult.error
  ) {
    throw new ApiError(503, "CYCLE_LIST_FAILED", "Device cycles could not be loaded.");
  }

  const clientNames = new Map((clientsResult.data ?? []).map((row) => [row.id, row.name]));
  const phoneNames = new Map((phonesResult.data ?? []).map((row) => [row.id, row.name]));
  const programNames = new Map((programsResult.data ?? []).map((row) => [row.id, row.name]));
  const phasePlans = new Map((programsResult.data ?? []).map((row) => [row.id, row.phase_plan ?? null]));
  const phaseGates = new Map<string, PhaseGateRow>(((phaseGatesResult.data ?? []) as PhaseGateRow[])
    .map((row) => [row.device_cycle_id, row]));
  const bindings = new Map(
    ((bindingsResult.data ?? []) as BindingRow[])
      .filter((row) => row.released_at === null)
      .map((row) => [row.device_cycle_id, row]),
  );
  const counts = new Map(
    ((countsResult.data ?? []) as CountRow[]).map((row) => [row.device_cycle_id, row]),
  );

  const cycleRows = (cyclesResult.data ?? []) as CycleRow[];
  const cycles = cycleRows.map((row) => {
    const binding = bindings.get(row.id);
    const count = counts.get(row.id);
    return {
      id: row.id,
      name: row.name,
      clientId: row.client_id,
      clientName: clientNames.get(row.client_id) ?? "Unknown client",
      connectionId: row.connection_id,
      phoneId: row.phone_id,
      phoneName: phoneNames.get(row.phone_id) ?? "Unknown phone",
      programId: row.program_id,
      programName: programNames.get(row.program_id) ?? "Unknown program",
      phasePlan: phasePlans.get(row.program_id) ?? null,
      currentPhase: phaseGates.get(row.id)?.current_phase ?? null,
      phaseGate: phaseGates.get(row.id)?.phase_gate ?? null,
      status: row.status,
      proxyMode: row.proxy_mode,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      durationDays: row.duration_days,
      currentDay: cycleDay(row),
      keyword: row.keyword,
      profileLabel: row.profile_label,
      activatedAt: row.activated_at,
      completedAt: row.completed_at,
      lastError: row.last_error,
      target: {
        country: row.target_country,
        region: row.target_region,
        city: row.target_city,
        latitude: row.target_latitude,
        longitude: row.target_longitude,
      },
      runCounts: {
        total: numberValue(count?.total),
        done: numberValue(count?.done),
        running: numberValue(count?.running),
        failed: numberValue(count?.failed),
        pending: numberValue(count?.pending),
      },
      proxy: binding
        ? {
            mode: "managed" as const,
            configuredCity: binding.configured_city,
            configuredRegion: binding.configured_region,
            configuredIsp: binding.configured_isp,
            diversityStatus: binding.diversity_status,
            health: binding.health,
            observedIpMasked: binding.observed_ip_masked,
            observedCity: binding.observed_city,
            observedIsp: binding.observed_isp,
            distanceKm: binding.distance_km,
            checkedAt: binding.checked_at,
          }
        : row.proxy_mode === "preconfigured"
          ? {
              mode: "preconfigured" as const,
              configuredCity: null,
              configuredRegion: null,
              configuredIsp: null,
              diversityStatus: "unknown" as const,
              health: null,
              verificationStatus: "not_performed" as const,
              managedBy: "device" as const,
              observedIpMasked: null,
              observedCity: null,
              observedIsp: null,
              distanceKm: null,
              checkedAt: null,
            }
          : null,
    };
  });

  const activeBindings = [...bindings.values()];
  const preconfiguredAssignments = cycleRows.filter(
    (row) =>
      row.proxy_mode === "preconfigured" &&
      (row.status === "active" || row.status === "paused"),
  ).length;
  const packageRow = packageResult.data;
  return {
    cycles,
    proxySummary: {
      activeBindings: activeBindings.length,
      aligned: activeBindings.filter((row) => row.health === "aligned" || row.health === "nearby").length,
      needsVerification: activeBindings.filter((row) => row.health === "unverified" || row.health === "stale").length,
      mismatches: activeBindings.filter((row) => row.health === "mismatch" || row.health === "error").length,
      uniqueIsps: new Set(activeBindings.map((row) => row.configured_isp)).size,
      preconfiguredAssignments,
      package: packageRow
        ? {
            isActive: packageRow.is_active,
            autoRenew: packageRow.auto_renew,
            expiredOn: packageRow.expired_on,
            trafficLimitBytes: packageRow.traffic_limit_bytes,
            trafficUsedBytes: packageRow.traffic_used_bytes,
            trafficLeftBytes: packageRow.traffic_left_bytes,
            syncedAt: packageRow.synced_at,
            lastError: packageRow.last_error,
          }
        : null,
    },
  };
}

function demoCycles() {
  return {
    cycles: [
      {
        id: "demo-cycle-1",
        name: "Lakeland visibility — Phone 01",
        clientId: "00000000-0000-4000-8000-000000000001",
        clientName: "Harbor Injury Law",
        connectionId: "demo-connection",
        phoneId: "00000000-0000-4000-8000-000000000101",
        phoneName: "Field phone 01",
        programId: "demo-cycle-program",
        programName: "30-day local presence cycle",
        status: "active",
        proxyMode: "preconfigured",
        startsOn: addDays(new Date().toISOString().slice(0, 10), -11),
        endsOn: addDays(new Date().toISOString().slice(0, 10), 18),
        durationDays: 30,
        currentDay: 12,
        keyword: "car accident lawyer",
        profileLabel: "Lakeland profile A",
        activatedAt: new Date().toISOString(),
        completedAt: null,
        lastError: null,
        target: { country: "US", region: "Florida", city: "Lakeland", latitude: 28.0395, longitude: -81.9498 },
        runCounts: { total: 159, done: 58, running: 1, failed: 1, pending: 99 },
        proxy: {
          mode: "preconfigured",
          configuredCity: null,
          configuredRegion: null,
          configuredIsp: null,
          diversityStatus: "unknown",
          health: null,
          verificationStatus: "not_performed",
          managedBy: "device",
          observedIpMasked: null,
          observedCity: null,
          observedIsp: null,
          distanceKm: null,
          checkedAt: null,
        },
      },
      {
        id: "demo-cycle-2",
        name: "Lakeland visibility — Phone 02",
        clientId: "00000000-0000-4000-8000-000000000001",
        clientName: "Harbor Injury Law",
        connectionId: "demo-connection",
        phoneId: "00000000-0000-4000-8000-000000000102",
        phoneName: "Field phone 02",
        programId: "demo-cycle-program",
        programName: "30-day local presence cycle",
        status: "active",
        proxyMode: "preconfigured",
        startsOn: addDays(new Date().toISOString().slice(0, 10), -11),
        endsOn: addDays(new Date().toISOString().slice(0, 10), 18),
        durationDays: 30,
        currentDay: 12,
        keyword: "personal injury lawyer",
        profileLabel: "Lakeland profile B",
        activatedAt: new Date().toISOString(),
        completedAt: null,
        lastError: null,
        target: { country: "US", region: "Florida", city: "Lakeland", latitude: 28.061, longitude: -81.957 },
        runCounts: { total: 159, done: 59, running: 0, failed: 0, pending: 100 },
        proxy: {
          mode: "preconfigured",
          configuredCity: null,
          configuredRegion: null,
          configuredIsp: null,
          diversityStatus: "unknown",
          health: null,
          verificationStatus: "not_performed",
          managedBy: "device",
          observedIpMasked: null,
          observedCity: null,
          observedIsp: null,
          distanceKm: null,
          checkedAt: null,
        },
      },
    ],
    proxySummary: {
      activeBindings: 0,
      aligned: 0,
      needsVerification: 0,
      mismatches: 0,
      uniqueIsps: 0,
      preconfiguredAssignments: 2,
      package: null,
    },
  };
}

export async function GET(request: Request) {
  return withOrganization(request, async (context) => {
    if (context.demo) return dataResponse(demoCycles());
    return dataResponse(await loadCycles(context));
  });
}

export async function POST(request: Request) {
  return withOrganization(request, async (context) => {
    requireSchedulerManager(context);
    let input: z.infer<typeof createCycleSchema>;
    try {
      input = createCycleSchema.parse(await request.json());
    } catch (error) {
      const configMessage = taskConfigIssueMessage(error);
      if (configMessage) {
        throw new ApiError(400, "INVALID_PROGRAM_VARIABLES", configMessage);
      }
      throw new ApiError(
        400,
        "INVALID_DEVICE_CYCLE",
        "Check the profile label, program, client, dedicated phone, cycle dates, and target location.",
      );
    }
    if (!validCalendarDate(input.startDate)) {
      throw new ApiError(400, "INVALID_START_DATE", "Use a valid calendar date.");
    }
    if (!validTimezone(input.timezone)) {
      throw new ApiError(400, "INVALID_TIMEZONE", "Use a valid IANA timezone.");
    }
    const localToday = dateInTimezone(input.timezone);
    if (input.startDate < localToday || input.startDate > addDays(localToday, 90)) {
      throw new ApiError(
        400,
        "INVALID_START_DATE",
        "Choose a cycle start date from today through the next 90 days.",
      );
    }
    const proxyMode = "preconfigured" as const;

    if (context.demo) {
      return dataResponse(
        {
          cycle: {
            id: crypto.randomUUID(),
            ...input,
            status: "active",
            proxyMode,
            proxy: {
              mode: proxyMode,
              health: null,
              verificationStatus: "not_performed",
              city: null,
              isp: null,
              diversityStatus: "unknown",
            },
            note: "Preview only — no provider credentials or external requests were used.",
          },
        },
        { status: 201 },
      );
    }

    const [programResult, phoneResult, clientResult, rulesResult] = await Promise.all([
      context.admin
        .from("cycle_programs")
        .select("id, connection_id, duration_days, phase_plan, status")
        .eq("organization_id", context.organizationId)
        .eq("id", input.programId)
        .maybeSingle(),
      context.admin
        .from("duo_phones")
        .select("id, connection_id, client_id, status, enabled, provider_present, expired_at")
        .eq("organization_id", context.organizationId)
        .eq("id", input.phoneId)
        .maybeSingle(),
      context.admin
        .from("clients")
        .select("id, status")
        .eq("organization_id", context.organizationId)
        .eq("id", input.clientId)
        .maybeSingle(),
      context.admin
        .from("cycle_program_rules")
        .select("config")
        .eq("organization_id", context.organizationId)
        .eq("program_id", input.programId),
    ]);
    if (programResult.error || phoneResult.error || clientResult.error || rulesResult.error) {
      throw new ApiError(503, "CYCLE_REFERENCES_FAILED", "Cycle references could not be checked.");
    }
    const program = programResult.data;
    const phone = phoneResult.data;
    const client = clientResult.data;
    if (!program || program.status !== "published") {
      throw new ApiError(409, "PROGRAM_UNAVAILABLE", "Choose a published cycle program.");
    }
    if (!client || client.status !== "active") {
      throw new ApiError(409, "CLIENT_UNAVAILABLE", "Choose an active client.");
    }
    if (program.phase_plan && (input.targetLatitude == null || input.targetLongitude == null)) {
      throw new ApiError(400, "DEVICE_COORDINATES_REQUIRED", "Set this phone's dedicated latitude and longitude before starting its four-phase cycle.");
    }
    const endsOn = addDays(input.startDate, program.duration_days - 1);
    try {
      for (const rule of rulesResult.data ?? []) {
        resolveProgramTaskConfig(
          (rule.config ?? {}) as Record<string, unknown>,
          input.variables,
        );
      }
    } catch (error) {
      if (error instanceof ProgramConfigBindingError) {
        throw new ApiError(400, "INVALID_PROGRAM_VARIABLES", error.message);
      }
      throw error;
    }
    if (
      !phone ||
      !isPhoneEligibleForNewWork(phone) ||
      phone.client_id !== input.clientId ||
      phone.connection_id !== program.connection_id
    ) {
      throw new ApiError(
        409,
        "PHONE_UNAVAILABLE",
        "Choose an enabled, non-expired phone assigned to this client and DuoPlus connection.",
      );
    }
    if (!isPhoneEligibleThroughCycle(phone, endsOn, input.timezone)) {
      throw new ApiError(
        409,
        "PHONE_EXPIRES_DURING_CYCLE",
        "Choose a phone whose DuoPlus subscription remains active through the full cycle.",
      );
    }

    const { connection } = await createOrganizationDuoClient(context);
    if (connection.id !== program.connection_id) {
      throw new ApiError(409, "CONNECTION_MISMATCH", "The program is not on the active DuoPlus connection.");
    }
    const { data: inserted, error: insertError } = await context.admin
      .from("device_cycles")
      .insert({
        organization_id: context.organizationId,
        client_id: input.clientId,
        connection_id: connection.id,
        program_id: program.id,
        phone_id: phone.id,
        name: input.name,
        keyword: input.keyword,
        variables: input.variables,
        profile_label: input.profileLabel || null,
        starts_on: input.startDate,
        ends_on: endsOn,
        duration_days: program.duration_days,
        timezone: input.timezone,
        status: "provisioning",
        proxy_mode: proxyMode,
        proxy_diversity_status: "unknown",
        target_country: input.targetCountry,
        target_region: input.targetRegion,
        target_city: input.targetCity,
        target_latitude: input.targetLatitude ?? null,
        target_longitude: input.targetLongitude ?? null,
        created_by: context.user.id,
      })
      .select(
        "id, organization_id, client_id, connection_id, program_id, phone_id, ends_on, proxy_mode, target_country, target_region, target_city, target_latitude, target_longitude, timezone",
      )
      .single();
    if (insertError || !inserted) {
      const insertMessage = insertError?.message?.toLowerCase() ?? "";
      if (insertMessage.includes("dedicated") || insertMessage.includes("city assignment")) {
        throw new ApiError(409, "PHONE_CITY_ASSIGNMENT_CONFLICT", "This phone is dedicated to another client or city. Choose a phone dedicated to this client and city.");
      }
      throw new ApiError(
        409,
        "CYCLE_CREATE_FAILED",
        "This phone may already have an open cycle. Complete or cancel it before starting another.",
      );
    }

    try {
      const { data: runCount, error: activationError } = await context.admin.rpc(
        "activate_device_cycle",
        {
          p_organization_id: context.organizationId,
          p_cycle_id: inserted.id,
        },
      );
      if (activationError) throw new Error("Cycle activation failed");
      return dataResponse(
        {
          cycle: {
            id: inserted.id,
            status: "active",
            proxyMode,
            startsOn: input.startDate,
            endsOn,
            materializedRuns: numberValue(runCount),
            proxy: {
              mode: proxyMode,
              city: null,
              isp: null,
              diversityStatus: "unknown",
              health: null,
              verificationStatus: "not_performed",
            },
          },
        },
        { status: 201 },
      );
    } catch {
      await context.admin
        .from("device_cycles")
        .update({
          status: "blocked",
          last_error:
            "Activation did not finish. Check the published program and dedicated DuoPlus phone.",
        })
        .eq("organization_id", context.organizationId)
        .eq("id", inserted.id);
      throw new ApiError(
        502,
        "CYCLE_ACTIVATION_BLOCKED",
        "The cycle was saved as blocked because activation did not finish. No tasks were activated.",
        { cycleId: inserted.id },
      );
    }
  });
}
