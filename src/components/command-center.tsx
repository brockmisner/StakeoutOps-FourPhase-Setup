"use client";

import {
  Activity,
  AlertTriangle,
  Award,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Globe2,
  KeyRound,
  LockKeyhole,
  MapPin,
  MoreHorizontal,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  Trophy,
  Trash2,
  UserRoundCheck,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  resolvedTemplateConfigSchema,
  type DuoPlusTemplateConfigSchema,
  type DuoPlusTemplateInput,
} from "@/lib/duoplus/template-schema";

import {
  extractProgramVariables,
  programTaskConfigForTemplateSchema,
  type ProgramVariableDefinition,
} from "@/lib/scheduler/program-config";
import { planWorkload } from "@/lib/scheduler/workload-planner";
import { plannedCycleRunCount } from "@/lib/scheduler/cycles";
import {
  buildPhaseTaskSlots,
  defaultPhasePlan,
  phasePlanDuration,
  phaseWindows,
  type PhasePlan,
  type PhaseTaskCounts,
  type RulePhaseKind,
} from "@/lib/scheduler/phase-plan";

type CommandScheduleStatus = "Running" | "Scheduled" | "Paused" | "Needs attention" | "Queued";

export type CommandSchedule = {
  id: string;
  phoneId?: string | null;
  title: string;
  keyword: string;
  client: string;
  device: string;
  status: CommandScheduleStatus;
  nextRun: string;
  lastRun: string;
  duration?: string;
  gpsLatitude?: string;
  gpsLongitude?: string;
};

export type CommandRun = {
  id: string;
  clientId?: string;
  clientName?: string | null;
  scheduleId: string;
  scheduleName?: string | null;
  keyword?: string | null;
  sourceKind?: "calendar" | "device_cycle";
  phoneId?: string | null;
  phoneName?: string | null;
  templateId?: string;
  templateName?: string | null;
  deviceCycleId?: string | null;
  cycleDay?: number | null;
  status: "pending" | "preparing" | "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled" | "retry_wait";
  stage: string;
  issueAt: string;
  expectedDurationSeconds?: number;
  windowStartAt?: string | null;
  windowEndAt?: string | null;
  attemptCount?: number;
  maxAttempts?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastError?: string | null;
  log?: unknown;
  screenshots?: unknown[];
  createdAt?: string;
};

export type CommandPhone = {
  id: string;
  clientId?: string | null;
  imageId?: string;
  name: string;
  status: number;
  enabled: boolean;
  busyUntil?: string | null;
  gpsLatitude?: number | null;
  gpsLongitude?: number | null;
  timezone?: string | null;
  lastSeenAt?: string | null;
  expiredAt?: string | null;
  providerPresent?: boolean;
};

export type CommandClientOption = {
  id: string;
  name: string;
};

export type CycleProgramOption = {
  id: string;
  name: string;
  durationDays: number;
  timezone: string;
  status: "draft" | "published" | "retired";
  readyDay?: number;
  readyThresholdPercent?: number;
  completionThresholdPercent?: number;
  phasePlan?: PhasePlan | null;
  rules?: Array<{
    id: string;
    name: string;
    startDay?: number;
    endDay?: number;
    ruleKind?: "daily_range" | "day_range" | "window_once";
    phaseKind?: RulePhaseKind | null;
    templateId?: string;
    templateName?: string | null;
    templateType?: 1 | 2 | null;
    templateSource?: "official" | "custom" | null;
    duoplusTemplateId?: string | null;
    appKind?: string;
    points?: number;
    config?: Record<string, unknown>;
    expectedDurationSeconds?: number;
    maxAttempts?: number;
    required?: boolean;
  }>;
};

export type CycleTemplateOption = {
  /** Internal duo_templates.id used by cycle_program_rules.template_id. */
  id: string;
  duoplusTemplateId?: string;
  templateType: 1 | 2;
  templateSource?: "official" | "custom";
  name: string;
  configSchema?: DuoPlusTemplateConfigSchema | null;
};

function templateSourceLabel(template: Pick<CycleTemplateOption, "templateType" | "templateSource">) {
  if (template.templateSource === "official" || template.templateType === 1) return "Official";
  return "Custom";
}

export type CycleProgramRuleInput = {
  name: string;
  templateId: string;
  ruleKind: "daily_range" | "day_range" | "window_once";
  startDay: number;
  endDay: number;
  localTime: string;
  sequence: number;
  config: Record<string, unknown>;
  expectedDurationSeconds: number;
  maxAttempts: number;
  required: boolean;
  appKind: string;
  phaseKind?: RulePhaseKind;
  points: number;
};

export type CreateCycleProgramInput = {
  name: string;
  durationDays: number;
  timezone: string;
  readyDay: number;
  readyThresholdPercent: number;
  completionThresholdPercent: number;
  phasePlan?: PhasePlan;
  rules: CycleProgramRuleInput[];
};

export type ProfileReadinessState =
  | "new"
  | "warming"
  | "ready"
  | "completed"
  | "needs_attention"
  | "retired";

export type CommandPhaseGate = {
  allowed: boolean;
  status: "ready" | "waiting" | "recovery_required";
  blockedPhase: string | null;
  missingRequiredRuns: number;
  requirements: Array<{
    appKind: string;
    minSuccessfulRuns: number;
    minActiveDays: number;
    successfulRuns: number;
    activeDays: number;
    met: boolean;
  }>;
  earliestStartAt: string | null;
  reason: string | null;
};

export type CommandProfileReadiness = {
  id: string;
  label: string;
  clientId: string;
  clientName: string;
  phoneId: string;
  phoneName: string;
  cycleId: string;
  cycleName: string;
  programId?: string;
  programName?: string;
  phasePlan?: PhasePlan | null;
  currentPhase?: string | null;
  phaseGate?: CommandPhaseGate | null;
  state: ProfileReadinessState;
  currentDay: number;
  durationDays: number;
  score: number;
  readyScore: number;
  completionScore: number;
  possibleScore: number;
  successfulDays: number;
  appScores: Array<{ app: string; score: number; possible: number }>;
  lastSuccessAt: string | null;
  statusReason: string | null;
};

export type CommandProfileSummary = {
  total: number;
  new: number;
  warming: number;
  ready: number;
  completed: number;
  needsAttention: number;
  retired?: number;
};

export type ProxyHealth =
  | "unverified"
  | "aligned"
  | "nearby"
  | "mismatch"
  | "stale"
  | "error"
  | "released";

export type CommandDeviceCycle = {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  phoneId: string;
  phoneName: string;
  programId: string;
  programName: string;
  phasePlan?: PhasePlan | null;
  currentPhase?: string | null;
  phaseGate?: CommandPhaseGate | null;
  status: "provisioning" | "active" | "paused" | "blocked" | "completed" | "cancelled";
  startsOn: string;
  endsOn: string;
  durationDays: number;
  currentDay: number;
  keyword: string;
  target: {
    country: string;
    region: string;
    city: string;
    latitude: number | null;
    longitude: number | null;
  };
  runCounts: {
    total: number;
    done: number;
    running: number;
    failed: number;
    pending: number;
  };
  proxyMode?: "managed" | "preconfigured";
  proxy: {
    mode?: "managed" | "preconfigured";
    configuredCity: string | null;
    configuredIsp: string | null;
    diversityStatus: "unique" | "reused" | "unknown" | null;
    health: ProxyHealth | null;
    checkedAt: string | null;
    distanceKm: number | null;
  } | null;
};

export type DeviceCycleOperatingStatus = "active" | "paused" | "cancelled";

export type CommandProxySummary = {
  activeBindings: number;
  aligned: number;
  needsVerification: number;
  mismatches: number;
  uniqueIsps: number;
  preconfiguredAssignments?: number;
  package: {
    isActive: boolean;
    expiredOn: string | null;
    trafficLeftBytes: number | string | null;
    syncedAt: string | null;
  } | null;
};

export type LaunchCycleInput = {
  programId: string;
  clientId: string;
  phoneId: string;
  name: string;
  keyword: string;
  startDate: string;
  timezone: string;
  targetCountry: string;
  targetRegion: string;
  targetCity: string;
  targetLatitude?: number;
  targetLongitude?: number;
  profileLabel: string;
  variables?: Record<string, unknown>;
};

type MapPoint = {
  id: string;
  name: string;
  client: string;
  latitude: number;
  longitude: number;
  locationSource: "phone" | "schedule" | "cycle";
  status: number;
  cycleDay?: number;
  cycleDuration?: number;
  targetCity?: string;
  proxyMode?: "managed" | "preconfigured";
  proxyCity?: string | null;
  proxyIsp?: string | null;
  proxyHealth?: ProxyHealth | null;
  proxyDistanceKm?: number | null;
  proxyCheckedAt?: string | null;
};

type MapTarget = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
};

type Operation = {
  id: string;
  schedule: CommandSchedule;
  run?: CommandRun;
  sample: boolean;
  stage: string;
  tone: "green" | "blue" | "gray" | "amber" | "red";
  progress: number;
  elapsed: string;
};

type WorkloadRow = {
  id: string;
  device: string;
  client: string;
  scheduleId?: string;
  run?: CommandRun;
  start: number;
  duration: number;
  tone: number;
  conflict: boolean;
  timeLabel?: string;
  planningLabel?: string;
  startAt: string;
  endAt: string;
  lane: number;
  current: boolean;
  occupancy?: boolean;
};

type WorkerSlotLane = {
  index: number;
  jobs: WorkloadRow[];
  currentJob: WorkloadRow | null;
  nextJob: WorkloadRow | null;
  nextFreeAt: string | null;
};

type AttentionItem = {
  id: string;
  type: "phone" | "key" | "run";
  title: string;
  detail: string;
  client: string;
  detected: string;
  action: string;
  schedule?: CommandSchedule;
  run?: CommandRun;
};

type DeviceDisplay = { name: string; status: string; detail: string };

const EMPTY_PENDING_RUN_IDS: ReadonlySet<string> = new Set<string>();
const OPEN_RUN_STATUSES: ReadonlySet<CommandRun["status"]> = new Set([
  "pending",
  "preparing",
  "queued",
  "running",
  "paused",
  "retry_wait",
]);
const CURRENT_WORKER_RUN_STATUSES: ReadonlySet<CommandRun["status"]> = new Set([
  "preparing",
  "queued",
  "running",
  "paused",
]);

function runIsOpen(run: CommandRun | undefined) {
  return Boolean(run && OPEN_RUN_STATUSES.has(run.status));
}

type CommandCenterProps = {
  schedules: CommandSchedule[];
  runs: CommandRun[];
  phones: CommandPhone[];
  devices: DeviceDisplay[];
  clients: string[];
  clientOptions: CommandClientOption[];
  cycles: CommandDeviceCycle[];
  profiles: CommandProfileReadiness[];
  profileSummary: CommandProfileSummary;
  cyclePrograms: CycleProgramOption[];
  templateOptions: CycleTemplateOption[];
  proxySummary: CommandProxySummary | null;
  demo: boolean;
  loading: boolean;
  pendingRunIds?: ReadonlySet<string>;
  integrationConnected: boolean;
  systemReady?: boolean;
  integrationVerifiedAt?: string;
  subscriptionCapacity?: number | null;
  subscriptionInUse?: number | null;
  subscriptionAvailable?: number | null;
  subscriptionSyncedAt?: string | null;
  successRate: string;
  initialNow: string;
  onRefresh: () => void;
  onRun: (scheduleId: string) => void;
  onViewSchedule: (scheduleId: string) => void;
  onOpenSchedules?: () => void;
  onViewRun: (run: CommandRun) => void;
  onOpenIntegration: () => void;
  onLaunchCycle: (input: LaunchCycleInput) => Promise<void> | void;
  onCreateCycleProgram: (input: CreateCycleProgramInput) => Promise<CycleProgramOption>;
  onSetCycleStatus?: (cycleId: string, status: DeviceCycleOperatingStatus) => Promise<void>;
  onNotify: (message: string) => void;
};

const DEMO_STAGES = [
  ["Running", "green", 66, "12 min"],
  ["Preparing location", "blue", 28, "6 min"],
  ["Powering on", "blue", 22, "3 min"],
  ["Waiting", "gray", 8, "18 min"],
  ["Collecting proof", "green", 82, "24 min"],
  ["Needs attention", "red", 46, "37 min"],
  ["Queued", "gray", 4, "—"],
  ["Waiting", "gray", 10, "52 min"],
] as const;

const DEMO_ATTENTION: Omit<AttentionItem, "schedule">[] = [
  {
    id: "attention-phone",
    type: "phone",
    title: "Expired phone",
    detail: "DuoPlus-08",
    client: "Riverside Injury Law",
    detected: "12 min ago",
    action: "Fix",
  },
  {
    id: "attention-key",
    type: "key",
    title: "Invalid API key",
    detail: "Reconnect DuoPlus",
    client: "Metro Plumbing Co.",
    detected: "28 min ago",
    action: "Reconnect",
  },
  {
    id: "attention-run",
    type: "run",
    title: "Failed run",
    detail: "Timeout during proof collection",
    client: "Harrison & Cole",
    detected: "1 hour ago",
    action: "Retry",
  },
];

const DEMO_TIMELINE_ROWS = [
  ["DuoPlus-01", "10.3", "2.0", "Riverside Injury Law"],
  ["DuoPlus-02", "11.1", "1.8", "Metro Plumbing Co."],
  ["DuoPlus-03", "10.8", "2.2", "Harrison & Cole"],
  ["DuoPlus-04", "12.4", "1.9", "Lakeview Home Services"],
  ["DuoPlus-05", "9.8", "2.7", "Summit Roofing"],
  ["DuoPlus-06", "14.0", "2.4", "CoolBreeze HVAC"],
] as const;

function stageFromRun(run: CommandRun) {
  const normalized = run.stage.toLowerCase().replaceAll("_", " ");
  if (run.status === "failed") return "Needs attention";
  if (run.status === "retry_wait") return "Retry waiting";
  if (run.status === "queued" || run.status === "pending") return "Queued";
  if (run.status === "paused") return "Paused";
  if (run.status === "succeeded") return "Completed";
  if (normalized.includes("power")) return "Powering on";
  if (normalized.includes("gps") || normalized.includes("locale") || normalized.includes("location")) return "Preparing location";
  if (normalized.includes("log") || normalized.includes("proof") || normalized.includes("screenshot")) return "Collecting proof";
  if (normalized.includes("task") || run.status === "running") return "Running";
  return run.status === "preparing" ? "Preparing device" : "Waiting";
}

function stageTone(stage: string): Operation["tone"] {
  if (stage === "Needs attention") return "red";
  if (stage === "Retry waiting") return "amber";
  if (["Running", "Collecting proof", "Completed"].includes(stage)) return "green";
  if (["Preparing location", "Powering on", "Preparing device"].includes(stage)) return "blue";
  return "gray";
}

function stageProgress(stage: string) {
  const values: Record<string, number> = {
    Queued: 5,
    Waiting: 10,
    "Powering on": 20,
    "Preparing device": 30,
    "Preparing location": 38,
    Running: 66,
    "Collecting proof": 86,
    Completed: 100,
    "Retry waiting": 18,
    "Needs attention": 46,
  };
  return values[stage] ?? 12;
}

function elapsedTime(run: CommandRun | undefined, initialNow: string) {
  if (!run) return "—";
  const start = new Date(run.startedAt ?? run.createdAt ?? run.issueAt).getTime();
  const end = new Date(run.finishedAt ?? initialNow).getTime();
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function readableTime(value: string | null | undefined, fallback = "—") {
  if (!value) return fallback;
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function scheduleDurationHours(value: string | undefined): number {
  if (!value) return 10 / 60;
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) return 10 / 60;
  return value.toLowerCase().includes("hour") ? amount : amount / 60;
}

function workloadAxisLabel(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function readableDate(value: string | null | undefined, fallback = "—") {
  if (!value) return fallback;
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function proxyHealthLabel(health: ProxyHealth | null | undefined) {
  const labels: Record<ProxyHealth, string> = {
    unverified: "Needs verification",
    aligned: "Geo aligned",
    nearby: "Nearby",
    mismatch: "Geo mismatch",
    stale: "Check stale",
    error: "Proxy error",
    released: "Released",
  };
  return health ? labels[health] : "Not bound";
}

function proxyHealthTone(health: ProxyHealth | null | undefined) {
  if (health === "aligned") return "green";
  if (["nearby", "unverified", "stale"].includes(health ?? "")) return "amber";
  if (["mismatch", "error"].includes(health ?? "")) return "red";
  return "gray";
}

function usesExternalDeviceProxy(
  value: Pick<CommandDeviceCycle, "proxyMode" | "proxy"> | Pick<MapPoint, "proxyMode">,
) {
  if ("proxy" in value && value.proxy?.mode) return value.proxy.mode === "preconfigured";
  return value.proxyMode === "preconfigured";
}

function phaseLabel(kind: string): string {
  return ({ warmup: "Warmup", money: "Money", final_squeeze: "Final squeeze", after_action: "After action", completed: "Completed" } as Record<string, string>)[kind] ?? variableLabel(kind);
}

function cycleMilestone(cycle: CommandDeviceCycle, plan?: PhasePlan | null) {
  if (cycle.phaseGate?.status === "recovery_required") return `${phaseLabel(cycle.currentPhase ?? "warmup")} · recovery needed`;
  if (cycle.currentPhase) return phaseLabel(cycle.currentPhase);
  if (cycle.status === "blocked") return "Blocked — action needed";
  if (plan) {
    if (cycle.status === "completed") return "Cycle completed";
    if (cycle.currentDay < 1) return "Awaiting start";
    const phase = phaseWindows(plan).find((window) => cycle.currentDay >= window.startDay && cycle.currentDay <= window.endDay);
    return phase ? `${phase.label} · planned` : "Awaiting completion";
  }
  if (cycle.currentDay >= cycle.durationDays) return "Ready for rollover";
  if (cycle.durationDays - cycle.currentDay <= 1) return "Rollover due tomorrow";
  if (cycle.currentDay < 10) return `Special window in ${10 - cycle.currentDay}d`;
  if (cycle.currentDay === 10) return "Day 10 special window";
  if (cycle.currentDay <= 13) return `Day ${cycle.currentDay} special scripts`;
  return "Daily sequence active";
}

function profileStateLabel(state: ProfileReadinessState) {
  const labels: Record<ProfileReadinessState, string> = {
    new: "New",
    warming: "Warming",
    ready: "Ready",
    completed: "Completed",
    needs_attention: "Needs attention",
    retired: "Retired",
  };
  return labels[state];
}

function profileStateTone(state: ProfileReadinessState) {
  if (state === "completed") return "purple";
  if (state === "ready") return "green";
  if (state === "warming") return "blue";
  if (state === "needs_attention") return "red";
  return "gray";
}

function profileScorePercent(profile: CommandProfileReadiness) {
  const target = Math.max(profile.completionScore, 1);
  return Math.min(100, Math.max(0, Math.round((profile.score / target) * 100)));
}

function activityAge(value: string | null, initialNow: string) {
  if (!value) return "No successful activity yet";
  const elapsedMinutes = Math.max(0, Math.floor((new Date(initialNow).getTime() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 1) return "Activity just now";
  if (elapsedMinutes < 60) return `Activity ${elapsedMinutes}m ago`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `Activity ${hours}h ago`;
  return `Activity ${Math.floor(hours / 24)}d ago`;
}

function latestRunsBySchedule(runs: CommandRun[]) {
  const map = new Map<string, CommandRun>();
  for (const run of runs) {
    if (!map.has(run.scheduleId)) map.set(run.scheduleId, run);
  }
  return map;
}

function statusFromCommandRun(run: CommandRun): CommandScheduleStatus {
  if (["preparing", "running"].includes(run.status)) return "Running";
  if (["pending", "queued", "retry_wait"].includes(run.status)) return "Queued";
  if (run.status === "failed") return "Needs attention";
  if (run.status === "paused" || run.status === "cancelled") return "Paused";
  return "Scheduled";
}

/**
 * Cycle schedules are intentionally excluded from the editable Schedules API.
 * Build a read-only display record from the enriched run DTO so their live
 * state, proof, and failures are not dropped from the Command Center.
 */
function displayScheduleForRun(
  run: CommandRun,
  schedulesById: Map<string, CommandSchedule>,
): CommandSchedule {
  const schedule = schedulesById.get(run.scheduleId);
  if (schedule) return schedule;
  const cycleContext = run.cycleDay ? `Cycle day ${run.cycleDay}` : "Cycle task";
  return {
    id: run.scheduleId,
    phoneId: run.phoneId,
    title: run.scheduleName ?? run.templateName ?? cycleContext,
    keyword: run.keyword ?? run.templateName ?? cycleContext,
    client: run.clientName ?? "Unknown client",
    device: run.phoneName ?? "Assigned phone",
    status: statusFromCommandRun(run),
    nextRun: readableTime(run.issueAt, "Time unavailable"),
    lastRun: readableTime(run.finishedAt ?? run.startedAt, "Not finished"),
    duration: `${Math.max(1, Math.round((run.expectedDurationSeconds ?? 600) / 60))} minutes`,
  };
}

function operationStageMatches(operation: Operation, filter: string, now: string | number = Date.now()) {
  if (filter === "All stages") return true;
  if (!operation.sample && operation.run) {
    if (filter === "Due now") {
      const issueTime = new Date(operation.run.issueAt).getTime();
      const nowTime = typeof now === "number" ? now : new Date(now).getTime();
      return ["pending", "retry_wait"].includes(operation.run.status)
        && Number.isFinite(issueTime)
        && Number.isFinite(nowTime)
        && issueTime <= nowTime;
    }
    if (filter === "Running") {
      return ["preparing", "running"].includes(operation.run.status);
    }
    if (filter === "Queued") return operation.run.status === "queued";
    if (filter === "Needs attention") return operation.run.status === "failed";
  }
  if (filter === "Due now") {
    return operation.stage === "Waiting" || operation.stage === "Retry waiting";
  }
  if (filter === "Running") {
    return ["Running", "Collecting proof", "Preparing device", "Preparing location", "Powering on"].includes(operation.stage);
  }
  if (filter === "Queued") return operation.stage === "Queued";
  return operation.stage === filter;
}

function finiteCoordinate(value: number | string | null | undefined) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) ? coordinate : null;
}

function coordinatePair(
  latitudeValue: number | string | null | undefined,
  longitudeValue: number | string | null | undefined,
) {
  const latitude = finiteCoordinate(latitudeValue);
  const longitude = finiteCoordinate(longitudeValue);
  if (
    latitude == null
    || longitude == null
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
  ) return null;
  return { latitude, longitude };
}

function coordinatesMatch(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
) {
  return Math.abs(left.latitude - right.latitude) < 0.000001
    && Math.abs(left.longitude - right.longitude) < 0.000001;
}

function mapMarkerOffset(
  point: MapPoint,
  pointIndex: number,
  points: MapPoint[],
  targets: MapTarget[],
) {
  const overlapping = points.filter((candidate) => coordinatesMatch(point, candidate));
  const targetOverlap = targets.some((target) => coordinatesMatch(point, target));
  if (overlapping.length < 2 && !targetOverlap) return { x: 0, y: 0 };
  const index = overlapping.findIndex((candidate) => candidate.id === points[pointIndex].id);
  // Keep a separate hit target for every phone at the same saved coordinate.
  // These are display offsets only; the stored GPS values never change.
  const radius = Math.max(32, overlapping.length * 36 / (2 * Math.PI));
  const angle = (-45 + index * 360 / overlapping.length) * (Math.PI / 180);
  return {
    x: Math.round(Math.cos(angle) * radius),
    y: Math.round(Math.sin(angle) * radius),
  };
}

function locationSourceLabel(source: MapPoint["locationSource"]) {
  if (source === "phone") return "Saved phone GPS";
  if (source === "schedule") return "Planned schedule GPS";
  return "Cycle target fallback";
}

function mapZoomFor(
  points: Array<{ latitude: number; longitude: number }>,
  width = 640,
  height = 360,
) {
  if (points.length < 2) return 12;
  const projected = points.map((point) => mercatorPoint(point.latitude, point.longitude, 0));
  const spanX = Math.max(...projected.map((point) => point.x)) - Math.min(...projected.map((point) => point.x));
  const spanY = Math.max(...projected.map((point) => point.y)) - Math.min(...projected.map((point) => point.y));
  if (spanX === 0 && spanY === 0) return 12;
  const scaleX = spanX ? Math.max(1, width - 128) / spanX : Number.POSITIVE_INFINITY;
  const scaleY = spanY ? Math.max(1, height - 128) / spanY : Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(17, Math.floor(Math.log2(Math.min(scaleX, scaleY)))));
}

function mercatorPoint(latitude: number, longitude: number, zoom: number) {
  const constrainedLatitude = Math.max(-85.0511, Math.min(85.0511, latitude));
  const scale = 2 ** zoom * 256;
  const sine = Math.sin((constrainedLatitude * Math.PI) / 180);
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale,
  };
}

export function CommandCenter({
  schedules,
  runs,
  phones,
  devices,
  clients,
  clientOptions,
  cycles,
  profiles,
  profileSummary,
  cyclePrograms,
  templateOptions,
  proxySummary,
  demo,
  loading,
  pendingRunIds = EMPTY_PENDING_RUN_IDS,
  integrationConnected,
  systemReady = false,
  integrationVerifiedAt,
  subscriptionCapacity,
  subscriptionInUse,
  subscriptionAvailable,
  subscriptionSyncedAt,
  successRate,
  initialNow,
  onRefresh,
  onRun,
  onViewSchedule,
  onOpenSchedules,
  onViewRun,
  onOpenIntegration,
  onLaunchCycle,
  onCreateCycleProgram,
  onSetCycleStatus,
  onNotify,
}: CommandCenterProps) {
  const [clientFilter, setClientFilter] = useState("All clients");
  const [stageFilter, setStageFilter] = useState("All stages");
  const [deviceFilter, setDeviceFilter] = useState("All devices");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quickRunOpen, setQuickRunOpen] = useState(false);
  const [quickRunQuery, setQuickRunQuery] = useState("");
  const quickRunButtonRef = useRef<HTMLButtonElement>(null);
  const [nowMs, setNowMs] = useState(() => {
    const parsed = new Date(initialNow).getTime();
    return Number.isFinite(parsed) ? parsed : Date.now();
  });
  const [launchCycleOpen, setLaunchCycleOpen] = useState(false);
  const [cancelCycle, setCancelCycle] = useState<CommandDeviceCycle | null>(null);
  const [pendingCycleAction, setPendingCycleAction] = useState<{
    cycleId: string;
    status: DeviceCycleOperatingStatus;
  } | null>(null);
  const [profileStateFilter, setProfileStateFilter] = useState<ProfileReadinessState | "all">("all");

  useEffect(() => {
    const clock = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(clock);
  }, []);

  const nowIso = new Date(nowMs).toISOString();

  const runMap = useMemo(() => latestRunsBySchedule(runs), [runs]);
  const schedulesById = useMemo(
    () => new Map(schedules.map((schedule) => [schedule.id, schedule])),
    [schedules],
  );
  const runnableSchedules = useMemo(
    () => schedules.filter(
      (schedule) => schedule.status !== "Paused" && !runIsOpen(runMap.get(schedule.id)),
    ),
    [runMap, schedules],
  );
  const filteredRunnableSchedules = useMemo(() => {
    const normalized = quickRunQuery.trim().toLowerCase();
    if (!normalized) return runnableSchedules;
    return runnableSchedules.filter((schedule) =>
      [schedule.keyword, schedule.client, schedule.device, schedule.title]
        .some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [quickRunQuery, runnableSchedules]);
  const operations = useMemo<Operation[]>(() => {
    if (demo) {
      return schedules.map((schedule, index): Operation => {
        const run = runMap.get(schedule.id);
        const [stage, tone, progress, elapsed] = DEMO_STAGES[index < 2 ? index : index === 2 ? 4 : index < 6 ? 5 : 6];
        return { id: schedule.id, schedule, run, sample: true, stage, tone, progress, elapsed };
      });
    }

    const statusPriority: Record<CommandRun["status"], number> = {
      failed: 0,
      running: 1,
      preparing: 1,
      retry_wait: 2,
      queued: 3,
      pending: 3,
      paused: 4,
      succeeded: 5,
      cancelled: 6,
    };
    return runs
      .toSorted((left, right) =>
        statusPriority[left.status] - statusPriority[right.status]
        || new Date(right.issueAt).getTime() - new Date(left.issueAt).getTime(),
      )
      .map((run): Operation => {
      const schedule = displayScheduleForRun(run, schedulesById);
      const stage = stageFromRun(run);
      return {
        id: run.id,
        schedule,
        run,
        sample: false,
        stage,
        tone: stageTone(stage),
        progress: stageProgress(stage),
        elapsed: elapsedTime(run, nowIso),
      };
    });
  }, [demo, nowIso, runMap, runs, schedules, schedulesById]);

  const filteredOperations = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return operations.filter((operation) => {
      const matchesQuery = !normalized || [operation.schedule.client, operation.schedule.keyword, operation.schedule.device, operation.stage]
        .some((value) => value.toLowerCase().includes(normalized));
      return matchesQuery
        && (clientFilter === "All clients" || operation.schedule.client === clientFilter)
        && (deviceFilter === "All devices" || operation.schedule.device === deviceFilter)
        && operationStageMatches(operation, stageFilter, nowIso);
    });
  }, [clientFilter, deviceFilter, nowIso, operations, query, stageFilter]);

  const attentionItems = useMemo<AttentionItem[]>(() => {
    if (demo) {
      return DEMO_ATTENTION.map((item, index) => ({ ...item, schedule: schedules[[4, 6, 3][index]] ?? schedules[index] }));
    }
    const items: AttentionItem[] = [];
    if (!integrationConnected) {
      items.push({ id: "connection", type: "key", title: "DuoPlus disconnected", detail: "API access is required", client: "Workspace", detected: "Now", action: "Reconnect" });
    }
    for (const phone of phones.filter((item) => [3, 4, 12].includes(item.status)).slice(0, 2)) {
      items.push({ id: `phone-${phone.id}`, type: "phone", title: phone.status === 12 ? "Phone setup failed" : "Expired phone", detail: phone.name, client: "Workspace", detected: readableTime(phone.lastSeenAt, "Time unavailable"), action: "Fix" });
    }
    for (const run of runs.filter((item) => item.status === "failed").slice(0, 3)) {
      const schedule = displayScheduleForRun(run, schedulesById);
      items.push({ id: `run-${run.id}`, type: "run", title: run.deviceCycleId ? "Failed cycle run" : "Failed run", detail: run.lastError ?? "DuoPlus task failed", client: schedule.client, detected: readableTime(run.finishedAt, "Time unavailable"), action: "View", schedule, run });
    }
    return items.slice(0, 4);
  }, [demo, integrationConnected, phones, runs, schedules, schedulesById]);

  const metricOperations = useMemo(
    () => operations.filter((operation) =>
      (clientFilter === "All clients" || operation.schedule.client === clientFilter) &&
      (deviceFilter === "All devices" || operation.schedule.device === deviceFilter),
    ),
    [clientFilter, deviceFilter, operations],
  );
  const liveCounts = useMemo(() => { return {
    due: metricOperations.filter((operation) => operationStageMatches(operation, "Due now", nowIso)).length,
    running: metricOperations.filter((operation) => operationStageMatches(operation, "Running", nowIso)).length,
    queued: metricOperations.filter((operation) => operationStageMatches(operation, "Queued", nowIso)).length,
    attention: metricOperations.filter((operation) => operationStageMatches(operation, "Needs attention", nowIso)).length,
  }; }, [metricOperations, nowIso]);

  const uniqueDevices = useMemo(
    () => Array.from(new Set([
      ...schedules.map((schedule) => schedule.device),
      ...runs.map((run) => run.phoneName ?? ""),
    ])).filter(Boolean).sort(),
    [runs, schedules],
  );
  const filteredCycles = useMemo(() => cycles.filter((cycle) =>
    ["provisioning", "active", "paused", "blocked"].includes(cycle.status)
    && (clientFilter === "All clients" || cycle.clientName === clientFilter),
  ), [clientFilter, cycles]);
  const clientProfiles = useMemo(() => profiles.filter((profile) =>
    clientFilter === "All clients" || profile.clientName === clientFilter,
  ), [clientFilter, profiles]);
  const filteredProfiles = useMemo(() => clientProfiles.filter((profile) =>
    profileStateFilter === "all"
    || profile.state === profileStateFilter
    || (profileStateFilter === "warming" && profile.state === "new"),
  ), [clientProfiles, profileStateFilter]);
  const visibleProfileSummary = useMemo<CommandProfileSummary>(() => {
    if (clientFilter === "All clients") return profileSummary;
    return clientProfiles.reduce<CommandProfileSummary>((summary, profile) => {
      summary.total += 1;
      if (profile.state === "needs_attention") summary.needsAttention += 1;
      else if (profile.state !== "retired") summary[profile.state] += 1;
      return summary;
    }, { total: 0, new: 0, warming: 0, ready: 0, completed: 0, needsAttention: 0 });
  }, [clientFilter, clientProfiles, profileSummary]);
  const online = demo ? 3 : phones.filter((phone) => phone.enabled && phone.status === 1).length;
  const busy = demo ? 3 : phones.filter((phone) => phone.status === 1 && Boolean(phone.busyUntil) && new Date(phone.busyUntil as string).getTime() > nowMs).length;
  const powering = demo ? 0 : phones.filter((phone) => [10, 11].includes(phone.status)).length;
  const offline = demo ? 47 : phones.filter((phone) => !phone.enabled || [0, 2, 3, 4, 12].includes(phone.status)).length;
  const idle = demo ? 0 : Math.max(0, online - busy);
  const visibleDevices = devices.slice(0, 6);
  const completedRuns = runs
    .filter((run) => run.status === "succeeded")
    .slice(0, 3);
  const recentProofItems = demo
    ? schedules.slice(1, 4).map((schedule) => ({ schedule, run: null }))
    : completedRuns.map((run) => ({
        schedule: displayScheduleForRun(run, schedulesById),
        run,
      }));
  const subscriptionLimit = demo ? 3 : subscriptionCapacity ?? null;
  const subscriptionUsed = demo ? 3 : subscriptionInUse ?? null;
  const subscriptionFree = demo ? 0 : subscriptionAvailable ?? null;
  const subscriptionPercent = subscriptionLimit && subscriptionUsed != null
    ? Math.min(100, Math.round((subscriptionUsed / subscriptionLimit) * 100))
    : 0;
  const workloadWindowStart = nowMs;
  const workloadAxis = useMemo(
    () => demo
      ? ["8 AM", "10 AM", "12 PM", "2 PM", "4 PM", "6 PM", "8 PM"]
      : Array.from({ length: 7 }, (_, index) =>
          workloadAxisLabel(workloadWindowStart + index * 4 * 60 * 60_000),
        ),
    [demo, workloadWindowStart],
  );
  const workerSlotCount = demo
    ? 3
    : subscriptionLimit != null && subscriptionLimit > 0
      ? Math.floor(subscriptionLimit)
      : 3;
  const workloadRows = useMemo<WorkloadRow[]>(() => {
    if (demo) {
      const dayStart = new Date(workloadWindowStart);
      dayStart.setHours(8, 0, 0, 0);
      const demoTasks = DEMO_TIMELINE_ROWS.map(([device, start, duration, client]) => ({
        id: `sample-${device}`,
        clientId: client,
        phoneId: device,
        preferredStart: new Date(dayStart.getTime() + (Number(start) - 8) * 3_600_000).toISOString(),
        durationSeconds: Number(duration) * 3_600,
      }));
      const demoPlan = planWorkload(demoTasks, {
        capacity: workerSlotCount,
        minimumSpacingMinutes: 15,
      });
      const plannedById = new Map(demoPlan.planned.map((item) => [item.id, item]));
      return DEMO_TIMELINE_ROWS.flatMap(([device, , , client], index) => {
        const planned = plannedById.get(`sample-${device}`);
        if (!planned) return [];
        const startMs = new Date(planned.startAt).getTime();
        const endMs = new Date(planned.endAt).getTime();
        return [{
          id: planned.id,
          device,
          client,
          start: 8 + (startMs - dayStart.getTime()) / 3_600_000,
          duration: (endMs - startMs) / 3_600_000,
          tone: index % 3,
          conflict: planned.shiftedByMinutes > 0,
          timeLabel: readableTime(planned.startAt),
          planningLabel: planned.shiftedByMinutes > 0
            ? `Planner moved this job ${planned.shiftedByMinutes} minutes`
            : "Fits the three-worker plan",
          startAt: planned.startAt,
          endAt: planned.endAt,
          lane: planned.lane,
          current: startMs <= workloadWindowStart && endMs > workloadWindowStart,
        } satisfies WorkloadRow];
      });
    }

    const windowEnd = workloadWindowStart + 24 * 60 * 60_000;
    const currentRunPhoneIds = new Set<string>();
    const currentRunPhoneNames = new Set<string>();
    const currentRunPhysicalKeys = new Set<string>();
    for (const run of runs) {
      const issueTime = new Date(run.issueAt).getTime();
      if (
        !CURRENT_WORKER_RUN_STATUSES.has(run.status)
        || !Number.isFinite(issueTime)
        || issueTime > workloadWindowStart
      ) continue;
      if (run.phoneId) {
        currentRunPhoneIds.add(run.phoneId);
        currentRunPhysicalKeys.add(`id:${run.phoneId}`);
      } else if (run.phoneName) {
        currentRunPhysicalKeys.add(`name:${run.phoneName}`);
      } else {
        currentRunPhysicalKeys.add(`run:${run.id}`);
      }
      if (run.phoneName) currentRunPhoneNames.add(run.phoneName);
    }

    const clientNames = new Map(clientOptions.map((client) => [client.id, client.name]));
    const seenOccupiedPhones = new Set<string>();
    const remainingOccupancySlots = Math.max(
      0,
      workerSlotCount - Math.min(workerSlotCount, currentRunPhysicalKeys.size),
    );
    const knownOccupiedSlots = phones
      .filter((phone) =>
        phone.enabled
        && phone.providerPresent !== false
        && [1, 10, 11].includes(phone.status)
        && !currentRunPhoneIds.has(phone.id)
        && !currentRunPhoneNames.has(phone.name),
      )
      .flatMap((phone) => {
        const physicalKey = phone.imageId ? `image:${phone.imageId}` : `id:${phone.id}`;
        if (seenOccupiedPhones.has(physicalKey)) return [];
        seenOccupiedPhones.add(physicalKey);
        return [{
          id: `occupancy-${physicalKey}`,
          phoneId: physicalKey,
          device: phone.name,
          client: phone.clientId ? clientNames.get(phone.clientId) ?? "Assigned phone" : "Unassigned phone",
          description: [10, 11].includes(phone.status)
            ? "Phone is starting without an active run"
            : "Phone is on without an active run",
        }];
      })
      .slice(0, remainingOccupancySlots);
    const providerOccupiedTarget = subscriptionUsed != null && Number.isFinite(subscriptionUsed)
      ? Math.min(workerSlotCount, Math.max(0, Math.floor(subscriptionUsed)))
      : 0;
    const unknownOccupiedCount = Math.min(
      Math.max(0, remainingOccupancySlots - knownOccupiedSlots.length),
      Math.max(
        0,
        providerOccupiedTarget - currentRunPhysicalKeys.size - knownOccupiedSlots.length,
      ),
    );
    const occupiedSlots = [
      ...knownOccupiedSlots,
      ...Array.from({ length: unknownOccupiedCount }, (_, index) => ({
        id: `occupancy-provider-${index + 1}`,
        phoneId: `provider-slot-${index + 1}`,
        device: "Provider-active phone",
        client: "DuoPlus account",
        description: "Provider reports this Startup slot in use without a matching active run",
      })),
    ];
    const candidates = runs
      .filter((run) => !["succeeded", "failed", "cancelled"].includes(run.status))
      .map((run) => ({ run, issueTime: new Date(run.issueAt).getTime() }))
      .filter(({ issueTime }) =>
        Number.isFinite(issueTime) &&
        issueTime <= windowEnd,
      )
      .sort((left, right) => left.issueTime - right.issueTime)
      .flatMap(({ run, issueTime }) => {
        const schedule = displayScheduleForRun(run, schedulesById);
        if (clientFilter !== "All clients" && schedule.client !== clientFilter) return [];
        const current = CURRENT_WORKER_RUN_STATUSES.has(run.status)
          && issueTime <= workloadWindowStart;
        const durationSeconds = run.expectedDurationSeconds
          ?? Math.round(scheduleDurationHours(schedule.duration) * 3_600);
        // `startedAt` begins during phone preparation, before the RPA runtime
        // itself. Do not subtract that preparation time from the estimate or
        // the lane can advertise a free slot earlier than is safe.
        const plannedDurationSeconds = durationSeconds;
        const preferredStart = new Date(Math.max(issueTime, workloadWindowStart)).toISOString();
        return [{
          run,
          issueTime,
          schedule,
          current,
          plannedDurationSeconds,
          preferredStart,
        }];
      });

    const occupancyStart = new Date(workloadWindowStart - 1_000).toISOString();
    const plan = planWorkload([
      ...occupiedSlots.map((slot) => ({
        id: slot.id,
        clientId: slot.client,
        phoneId: slot.phoneId,
        preferredStart: occupancyStart,
        earliestStart: occupancyStart,
        deadline: new Date(windowEnd).toISOString(),
        durationSeconds: 24 * 60 * 60,
      })),
      ...candidates.map(({
        run,
        schedule,
        current,
        plannedDurationSeconds,
        preferredStart,
      }) => ({
          id: run.id,
          clientId: run.clientId ?? schedule.client,
          phoneId: run.phoneId,
          preferredStart,
          earliestStart: current ? preferredStart : run.windowStartAt ?? preferredStart,
          deadline: current
            ? new Date(Math.max(windowEnd, workloadWindowStart + plannedDurationSeconds * 1_000)).toISOString()
            : run.windowEndAt ?? new Date(windowEnd).toISOString(),
          durationSeconds: plannedDurationSeconds,
        })),
    ], {
          capacity: workerSlotCount,
          minimumSpacingMinutes: 15,
        });
    const plannedById = new Map(plan.planned.map((item) => [item.id, item]));

    const runRows = candidates
      .flatMap(({ run, schedule, current }, index): WorkloadRow[] => {
        const planned = plannedById.get(run.id);
        if (!planned) return [];
        const plannedStartMs = new Date(planned.startAt).getTime();
        const plannedEndMs = new Date(planned.endAt).getTime();
        const visibleStartMs = Math.max(workloadWindowStart, plannedStartMs);
        const visibleEndMs = Math.min(windowEnd, plannedEndMs);
        const offsetHours = (visibleStartMs - workloadWindowStart) / 3_600_000;
        const visibleDurationHours = Math.max(0, visibleEndMs - visibleStartMs) / 3_600_000;
        const planningLabel = planned.shiftedByMinutes > 0
          ? `Planner recommends ${readableTime(planned.startAt)} (${planned.shiftedByMinutes} min later)`
          : "Fits the capacity plan";
        return [{
          id: run.id,
          device: run.phoneName || schedule.device || "Auto-assign",
          client: schedule.client,
          scheduleId: schedule.id,
          run,
          // The existing track is twelve CSS units wide. Scale the real
          // twenty-four-hour window into it instead of implying sample times.
          start: 8 + offsetHours / 2,
          duration: Math.max(0.125, visibleDurationHours / 2),
          tone: ["preparing", "running"].includes(run.status)
            ? 1
            : ["retry_wait", "paused"].includes(run.status)
              ? 2
              : index % 3,
          conflict: planned.shiftedByMinutes > 0,
          timeLabel: readableTime(planned.startAt),
          planningLabel,
          startAt: planned.startAt,
          endAt: planned.endAt,
          lane: planned.lane,
          current,
        }];
      });
    const occupancyRows = occupiedSlots.flatMap((slot): WorkloadRow[] => {
      const planned = plannedById.get(slot.id);
      if (!planned) return [];
      return [{
        id: slot.id,
        device: slot.device,
        client: slot.client,
        start: 8,
        duration: 12,
        tone: 2,
        conflict: false,
        timeLabel: "Occupied now",
        planningLabel: slot.description,
        startAt: planned.startAt,
        endAt: planned.endAt,
        lane: planned.lane,
        current: true,
        occupancy: true,
      }];
    });
    return [...occupancyRows, ...runRows];
  }, [clientFilter, clientOptions, demo, phones, runs, schedulesById, subscriptionUsed, workerSlotCount, workloadWindowStart]);
  const workerSlots = useMemo<WorkerSlotLane[]>(() => {
    return Array.from({ length: workerSlotCount }, (_, index) => {
      const jobs = workloadRows
        .filter((row) => row.lane === index)
        .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime());
      const currentJob = jobs.find((row) => row.current) ?? null;
      const nextJob = jobs.find((row) =>
        !row.current && new Date(row.endAt).getTime() > workloadWindowStart,
      ) ?? null;
      return {
        index,
        jobs,
        currentJob,
        nextJob,
        nextFreeAt: currentJob && !currentJob.occupancy
          ? new Date(new Date(currentJob.endAt).getTime() + 15 * 60_000).toISOString()
          : null,
      };
    });
  }, [workerSlotCount, workloadRows, workloadWindowStart]);
  const occupiedWorkerCount = workloadRows.filter((row) => row.occupancy).length;
  const plannedWorkloadCount = workloadRows.length - occupiedWorkerCount;
  const clientNameById = useMemo(
    () => new Map(clientOptions.map((client) => [client.id, client.name])),
    [clientOptions],
  );
  const deviceAssignments = useMemo(() => {
    const assignments = new Map<string, string>();
    for (const phone of phones) {
      const schedule = schedules.find(
        (item) => item.phoneId === phone.id || item.device === phone.name,
      );
      const client =
        (phone.clientId ? clientNameById.get(phone.clientId) : undefined) ??
        schedule?.client;
      if (client) assignments.set(phone.name, client);
    }
    for (const schedule of schedules) {
      if (schedule.device && schedule.device !== "Auto-assign") {
        assignments.set(schedule.device, schedule.client);
      }
    }
    return assignments;
  }, [clientNameById, phones, schedules]);
  const externalProxyCycles = proxySummary?.preconfiguredAssignments
    ?? filteredCycles.filter((cycle) => usesExternalDeviceProxy(cycle)).length;

  function chooseMetric(filter: string) {
    setStageFilter((current) => current === filter ? "All stages" : filter);
  }

  function handleAttention(item: AttentionItem) {
    if (item.type === "key" || item.type === "phone") {
      onOpenIntegration();
      return;
    }
    if (item.run) onViewRun(item.run);
  }

  async function setCycleStatus(cycle: CommandDeviceCycle, status: DeviceCycleOperatingStatus) {
    if (!onSetCycleStatus || pendingCycleAction) return;
    setPendingCycleAction({ cycleId: cycle.id, status });
    try {
      await onSetCycleStatus(cycle.id, status);
      if (status === "cancelled") setCancelCycle(null);
    } catch {
      // OperationsDashboard owns the error toast. Keep a failed cancellation
      // dialog open so the operator can retry or close it deliberately.
    } finally {
      setPendingCycleAction(null);
    }
  }

  return (
    <section className="workspace-inner command-center" aria-label="Command center dashboard">
      <div className="command-heading">
        <div>
          <h1>Command center</h1>
          <p>{demo ? "Sample workspace · 10 clients · 50 phones · 250 daily tasks · 3 Startup slots." : "Monitor today’s DuoPlus operations."}</p>
        </div>
        <div className="command-heading-actions">
          <label className="command-select">
            <span className="sr-only">Filter command center by client</span>
            <select value={clientFilter} onChange={(event) => setClientFilter(event.target.value)} aria-label="Filter command center by client">
              <option>All clients</option>
              {clients.map((client) => <option key={client}>{client}</option>)}
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </label>
          <button className="icon-button command-refresh" type="button" onClick={onRefresh} aria-label="Refresh command center">
            <RefreshCw size={17} className={loading ? "spin" : ""} />
          </button>
          <div className="quick-run-wrap">
            <button ref={quickRunButtonRef} className="primary-button" type="button" disabled={!runnableSchedules.length} onClick={() => setQuickRunOpen((current) => !current)} aria-haspopup="dialog" aria-controls="quick-run-dialog" aria-expanded={quickRunOpen}>
              <Play size={17} /> Run now
            </button>
            {quickRunOpen ? (
              <div
                id="quick-run-dialog"
                className="quick-run-menu"
                role="dialog"
                aria-labelledby="quick-run-title"
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setQuickRunOpen(false);
                  setQuickRunQuery("");
                  quickRunButtonRef.current?.focus();
                }}
              >
                <strong id="quick-run-title">Choose a schedule</strong>
                <div className="quick-run-search">
                  <Search size={14} aria-hidden="true" />
                  <label className="sr-only" htmlFor="quick-run-search-input">Search quick-run schedules</label>
                  <input
                    id="quick-run-search-input"
                    type="search"
                    value={quickRunQuery}
                    onChange={(event) => setQuickRunQuery(event.target.value)}
                    placeholder="Search schedules…"
                    autoFocus
                  />
                </div>
                <div className="quick-run-options">
                {filteredRunnableSchedules.map((schedule) => {
                  const pending = pendingRunIds.has(schedule.id);
                  return (
                  <button key={schedule.id} type="button" disabled={pending} aria-busy={pending} onClick={() => {
                    if (pending) return;
                    onRun(schedule.id);
                    setQuickRunOpen(false);
                    setQuickRunQuery("");
                    quickRunButtonRef.current?.focus();
                  }}>
                    <span><b>{schedule.keyword}</b><small>{schedule.client} · {schedule.device}</small></span>
                    {pending ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
                  </button>
                  );
                })}
                {!filteredRunnableSchedules.length ? <span className="quick-run-empty">No schedules match.</span> : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="health-strip" aria-label="System health">
        <span className={demo ? "health-warn" : integrationConnected ? "health-ok" : "health-error"}><i />{demo ? "Sample data — DuoPlus disconnected" : integrationConnected ? "DuoPlus connected" : "DuoPlus disconnected"}</span>
        <span className={demo || !systemReady ? "health-warn" : "health-ok"}><i />{demo ? "Scheduler inactive in sample" : systemReady ? "Scheduler configured" : "Scheduler setup incomplete"}</span>
        <span className={demo || !subscriptionSyncedAt ? "health-warn" : "health-ok"}><i />{demo ? "Read-only preview" : subscriptionSyncedAt ? `Inventory synced ${readableTime(subscriptionSyncedAt)}` : integrationVerifiedAt ? `Connected ${readableTime(integrationVerifiedAt)} · sync required` : "Inventory not synced"}</span>
        <span className={demo ? "health-warn" : subscriptionLimit != null ? "health-ok" : "health-warn"}><i />{demo ? "Sample capacity" : "Startup slots"} {subscriptionUsed ?? "—"} / {subscriptionLimit ?? "sync required"}</span>
        <span className="health-ok"><i />Device proxies untouched</span>
      </div>

      <section className="command-metrics" aria-label="Live operations summary">
        <CommandMetric label="Due now" value={String(liveCounts.due)} caption="runs waiting" active={stageFilter === "Due now"} onClick={() => chooseMetric("Due now")} />
        <CommandMetric label="Running" value={String(liveCounts.running)} caption="runs in progress" active={stageFilter === "Running"} onClick={() => chooseMetric("Running")} />
        <CommandMetric label="Queued" value={String(liveCounts.queued)} caption="runs in queue" active={stageFilter === "Queued"} onClick={() => chooseMetric("Queued")} />
        <CommandMetric label="Needs attention" value={String(liveCounts.attention)} caption={demo ? "sample items" : "failed runs"} tone="amber" active={stageFilter === "Needs attention"} onClick={() => chooseMetric("Needs attention")} />
        <CommandMetric label="Success rate" value={successRate} caption="last 7 days" active={stageFilter === "All stages"} onClick={() => setStageFilter("All stages")} />
      </section>

      <section className="command-panel profile-readiness-panel" aria-label="Profile readiness">
        <div className="command-panel-heading profile-readiness-heading">
          <div>
            <h2>Profile readiness</h2>
            <span>{visibleProfileSummary.total} profiles · successful RPA activity only</span>
          </div>
          <div className="profile-readiness-key"><Award size={15} /><span>Stakeout Readiness Score</span></div>
        </div>
        <div className="profile-summary-strip" aria-label="Profile readiness summary">
          <ProfileSummaryButton label="All profiles" value={visibleProfileSummary.total} state="all" selected={profileStateFilter === "all"} onSelect={setProfileStateFilter} />
          <ProfileSummaryButton label="New / warming" value={visibleProfileSummary.new + visibleProfileSummary.warming} state="warming" selected={profileStateFilter === "warming"} onSelect={setProfileStateFilter} />
          <ProfileSummaryButton label="Ready" value={visibleProfileSummary.ready} state="ready" selected={profileStateFilter === "ready"} onSelect={setProfileStateFilter} />
          <ProfileSummaryButton label="Completed" value={visibleProfileSummary.completed} state="completed" selected={profileStateFilter === "completed"} onSelect={setProfileStateFilter} />
          <ProfileSummaryButton label="Needs attention" value={visibleProfileSummary.needsAttention} state="needs_attention" selected={profileStateFilter === "needs_attention"} onSelect={setProfileStateFilter} />
        </div>
        <div className="profile-readiness-scroll">
          <table className="profile-readiness-table">
            <thead><tr><th>Profile</th><th>Dedicated phone</th><th>Cycle</th><th>Readiness score</th><th>App coverage</th><th>Status</th></tr></thead>
            <tbody>
              {filteredProfiles.map((profile) => (
                <ProfileReadinessRow profile={profile} now={nowIso} key={profile.id} />
              ))}
            </tbody>
          </table>
          {!loading && filteredProfiles.length === 0 ? (
            <div className="profile-readiness-empty">
              <UserRoundCheck size={20} />
              <span><strong>{clientProfiles.length ? "No profiles match this status" : "No profile cycles yet"}</strong><small>{clientProfiles.length ? "Choose All profiles to return to the full readiness board." : "Launch a device cycle and attach a profile label to start scoring."}</small></span>
              {clientProfiles.length ? <button type="button" onClick={() => setProfileStateFilter("all")}>Clear filter</button> : <button type="button" onClick={() => setLaunchCycleOpen(true)}>Launch cycle</button>}
            </div>
          ) : null}
        </div>
        <div className="profile-readiness-note"><ShieldCheck size={14} /><span><strong>Idempotent scoring</strong> Points are credited once per successful run. Failed, cancelled, retry, and ADB diagnostic activity earns zero points.</span></div>
      </section>

      <div className="command-primary-grid">
        <section className="command-panel live-operations-panel" aria-label="Live operations">
          <div className="command-panel-heading command-live-toolbar">
            <h2>Live operations</h2>
            <label className="command-compact-select">
              <span className="sr-only">Filter by stage</span>
              <select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)} aria-label="Filter live operations by stage">
                <option>All stages</option>
                <option>Due now</option>
                <option>Running</option>
                <option>Queued</option>
                <option>Waiting</option>
                <option>Powering on</option>
                <option>Preparing location</option>
                <option>Collecting proof</option>
                <option>Needs attention</option>
              </select>
              <ChevronDown size={14} />
            </label>
            <label className="command-compact-select">
              <span className="sr-only">Filter by device</span>
              <select value={deviceFilter} onChange={(event) => setDeviceFilter(event.target.value)} aria-label="Filter live operations by device">
                <option>All devices</option>
                {uniqueDevices.map((device) => <option key={device}>{device}</option>)}
              </select>
              <ChevronDown size={14} />
            </label>
            <label className="command-search">
              <Search size={15} />
              <span className="sr-only">Search live operations</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search clients, keywords, or devices…" />
            </label>
          </div>

          <div className="command-table-scroll" aria-busy={loading} style={demo ? { maxHeight: 580, overflowY: "auto" } : undefined}>
            <table className="command-table">
              <thead><tr><th>Client</th><th>Keyword</th><th>Phone</th><th>Current stage</th><th>Progress</th><th>Elapsed</th><th>Action</th></tr></thead>
              <tbody>
                {filteredOperations.map((operation) => (
                  <OperationRows
                    key={operation.id}
                    operation={operation}
                    runPending={pendingRunIds.has(operation.schedule.id)}
                    runBlocked={runIsOpen(operation.run)}
                    selected={selectedId === operation.id}
                    onSelect={() => setSelectedId((current) => current === operation.id ? null : operation.id)}
                    onView={() => operation.run ? onViewRun(operation.run) : onViewSchedule(operation.schedule.id)}
                    onRun={() => onRun(operation.schedule.id)}
                  />
                ))}
              </tbody>
            </table>
            {!loading && filteredOperations.length === 0 ? <div className="command-empty"><Activity size={19} /><strong>{operations.length ? "No operations match" : "No live operations"}</strong><span>{operations.length ? "Clear a filter to see today’s work." : "Queued and active run records will appear here."}</span></div> : null}
          </div>
        </section>

        <section className="command-panel attention-panel" aria-label="Attention queue">
          <div className="command-panel-heading">
            <h2>Attention queue</h2>
            <span className="attention-count">{attentionItems.length}</span>
            <button type="button" onClick={() => chooseMetric("Needs attention")}>View all <span aria-hidden="true">→</span></button>
          </div>
          <div className="attention-list">
            {attentionItems.length ? attentionItems.map((item) => (
              <article key={item.id} className="attention-item">
                <span className={`attention-icon attention-${item.type}`}>
                  {item.type === "key" ? <KeyRound size={16} /> : item.type === "phone" ? <Smartphone size={16} /> : <XCircle size={17} />}
                </span>
                <div className="attention-copy"><strong>{item.title}</strong><small>{item.detail}</small></div>
                <div className="attention-context"><strong>{item.client}</strong><small>{item.detected}</small></div>
                <button type="button" onClick={() => handleAttention(item)}>{item.action}</button>
              </article>
            )) : (
              <div className="attention-clear"><CheckCircle2 size={22} /><strong>All clear</strong><span>No operation needs attention.</span></div>
            )}
          </div>
        </section>
      </div>

      <div className="command-location-grid">
        <FleetLocationPanel
          phones={phones}
          schedules={schedules}
          cycles={filteredCycles}
          clientOptions={clientOptions}
          clientFilter={clientFilter}
          onOpenIntegration={onOpenIntegration}
        />

        <section className="command-panel subscription-panel" aria-label="DuoPlus Subscription Startup capacity">
          <div className="command-panel-heading">
            <div><h2>Subscription capacity</h2><span>DuoPlus Startup slots</span></div>
            <ShieldCheck size={18} className="subscription-shield" />
          </div>
          <div className="subscription-number">
            <strong>{subscriptionUsed ?? "—"}<small> / {subscriptionLimit ?? "—"}</small></strong>
            <span>phones on or assigned</span>
          </div>
          <div className="subscription-track" aria-label={`${subscriptionPercent}% of Subscription Startup capacity in use`}>
            <i style={{ width: `${subscriptionPercent}%` }} />
          </div>
          <div className="subscription-stats">
            <div><span>Available now</span><strong>{subscriptionFree ?? "—"}</strong></div>
            <div><span>Hard dispatch limit</span><strong>{subscriptionLimit ?? "Sync"}</strong></div>
          </div>
          {demo || (subscriptionLimit != null && subscriptionFree != null && subscriptionFree <= 0) ? (
            <div className="temporary-startup-lock"><LockKeyhole size={16} /><span><strong>Temporary Startup blocked</strong><small>New power-ons wait when every subscription slot is occupied.</small></span></div>
          ) : subscriptionLimit == null ? (
            <div className="temporary-startup-lock"><RefreshCw size={16} /><span><strong>Capacity not synced</strong><small>Sync DuoPlus before relying on startup availability.</small></span></div>
          ) : (
            <div className="temporary-startup-lock"><ShieldCheck size={16} /><span><strong>Startup capacity available</strong><small>{subscriptionFree} subscription {subscriptionFree === 1 ? "slot remains" : "slots remain"}.</small></span></div>
          )}
          <button type="button" className="subscription-sync" onClick={onOpenIntegration}>
            <RefreshCw size={14} /> {demo ? "Sample capacity" : subscriptionSyncedAt ? `Synced ${readableTime(subscriptionSyncedAt)}` : "Sync subscription count"}
          </button>
        </section>
      </div>

      <div className="command-cycle-grid">
        <section className="command-panel cycle-panel" aria-label="Active device cycles">
          <div className="command-panel-heading">
            <div><h2>Active device cycles</h2><span>{filteredCycles.length} in view · relative-day automation</span></div>
            <button type="button" onClick={() => setLaunchCycleOpen(true)}><Plus size={13} /> Launch cycle</button>
          </div>
          <div className="cycle-list">
            {filteredCycles.map((cycle) => (
              <CycleRow
                cycle={cycle}
                phasePlan={cycle.phasePlan ?? cyclePrograms.find((program) => program.id === cycle.programId)?.phasePlan}
                controlsDisabled={!onSetCycleStatus || Boolean(pendingCycleAction)}
                pendingStatus={pendingCycleAction?.cycleId === cycle.id ? pendingCycleAction.status : null}
                onPause={() => void setCycleStatus(cycle, "paused")}
                onResume={() => void setCycleStatus(cycle, "active")}
                onCancel={() => setCancelCycle(cycle)}
                key={cycle.id}
              />
            ))}
            {!filteredCycles.length ? (
              <div className="cycle-empty">
                <CalendarRange size={21} />
                <span><strong>No active device cycles</strong><small>Launch a four-phase program on a dedicated phone.</small></span>
                <button type="button" onClick={() => setLaunchCycleOpen(true)}>Launch cycle</button>
              </div>
            ) : null}
          </div>
        </section>

        <section className="command-panel proxy-alignment-panel" aria-label="Device proxy policy">
          <div className="command-panel-heading">
            <div><h2>Device proxy policy</h2><span>Existing proxy · left untouched</span></div>
            <Network size={17} className="proxy-panel-ok" />
          </div>
          <div className="proxy-score">
            <strong>{externalProxyCycles}<small> devices</small></strong>
            <span>cycles use the device&apos;s existing proxy</span>
          </div>
          <div className="proxy-mini-stats">
            <div><span>Created here</span><strong>0</strong></div>
            <div><span>Changed here</span><strong>0</strong></div>
            <div><span>Inspected here</span><strong>0</strong></div>
          </div>
          <div className="proxy-package-note">
            <Globe2 size={16} />
            <span>
              <strong>Externally managed</strong>
              <small>The scheduler never creates, rotates, updates, verifies, or health-checks device proxies.</small>
            </span>
          </div>
          <button className="proxy-refresh" type="button" onClick={onRefresh}><RefreshCw size={13} /> Refresh cycles</button>
        </section>
      </div>

      <div className="command-secondary-grid">
        <section className="command-panel command-capacity" aria-label="Device capacity overview">
          <div className="command-panel-heading"><h2>Device capacity</h2><span>{online} / {phones.length} online</span>{demo ? <button type="button" onClick={onOpenIntegration}>View all devices <span aria-hidden="true">→</span></button> : <span>{phones.length} synced devices</span>}</div>
          <div className="capacity-stats">
            <CapacityStat label="Online" value={online} tone="green" />
            <CapacityStat label="Busy" value={busy} tone="blue" />
            <CapacityStat label="Idle" value={idle} tone="gray" />
            <CapacityStat label="Powering on" value={powering} tone="blue" />
            <CapacityStat label="Offline" value={offline} tone="gray" />
          </div>
          <div className="command-device-strip">
            {visibleDevices.map((device, index) => <CommandDevice key={device.name} device={device} index={index} sample={demo} assignment={deviceAssignments.get(device.name)} />)}
          </div>
        </section>

        <section className="command-panel workload-panel" aria-label="Next 24 hours workload">
          <div className="command-panel-heading">
            <div><h2>Next 24 hours</h2><span>{workerSlotCount} worker {workerSlotCount === 1 ? "slot" : "slots"} · {plannedWorkloadCount} planned {plannedWorkloadCount === 1 ? "job" : "jobs"}{occupiedWorkerCount ? ` · ${occupiedWorkerCount} occupied` : ""}</span></div>
            {onOpenSchedules ? <button type="button" onClick={onOpenSchedules}>View full schedule <span aria-hidden="true">→</span></button> : null}
          </div>
          <div className="workload-axis">{workloadAxis.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>
          <div className="workload-grid">
            {workerSlots.map((slot) => (
              <div className="workload-row" key={slot.index} aria-label={`Worker slot ${slot.index + 1}`}>
                <div className="worker-slot-label">
                  <strong>Slot {slot.index + 1}</strong>
                  <span>{slot.currentJob?.device ?? "Idle"}</span>
                  <small>
                    {slot.currentJob?.occupancy
                      ? "Occupied · no active run"
                      : slot.nextFreeAt
                      ? `Free ~ ${readableTime(slot.nextFreeAt)}`
                      : slot.nextJob
                        ? `Free now · next ${readableTime(slot.nextJob.startAt)}`
                        : "Free now"}
                  </small>
                </div>
                <span className="workload-track">
                  {slot.jobs.map((row) => (
                    <button
                      type="button"
                      className={`workload-block workload-tone-${row.tone}${row.current ? " is-current" : ""}${row.conflict ? " has-conflict" : ""}${row.occupancy ? " is-occupancy" : ""}`}
                      key={row.id}
                      style={{ "--work-start": row.start, "--work-duration": row.duration } as React.CSSProperties}
                      onClick={() => row.run
                        ? onViewRun(row.run)
                        : row.scheduleId
                          ? onViewSchedule(row.scheduleId)
                          : row.occupancy
                            ? onNotify(`${row.device} is consuming a Startup slot without an active scheduler run`)
                            : onNotify(`${row.client} sample workload selected`)}
                      title={[row.device, row.client, row.timeLabel, row.planningLabel].filter(Boolean).join(" · ")}
                      aria-label={row.occupancy
                        ? `${row.device}, Startup slot occupied without an active run`
                        : `${row.device}, ${row.client}, ${row.current ? "running" : `starts ${row.timeLabel}`}`}
                    >
                      {row.device} · {row.client}{row.conflict ? <AlertTriangle size={12} /> : null}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
          {!workloadRows.length ? <div className="worker-pool-empty">All {workerSlotCount} slots are free. Due work will be placed here automatically.</div> : null}
        </section>
      </div>

      <section className="command-panel recent-proof" aria-label="Recent proof">
        <div className="command-panel-heading"><h2>Recent proof</h2>{demo ? <button type="button" onClick={() => onNotify("Open a completed run to inspect its screenshots and logs")}>View all proof <span aria-hidden="true">→</span></button> : <span>{recentProofItems.length} completed runs shown</span>}</div>
        <div className="proof-grid">
          {recentProofItems.map(({ schedule, run }, index) => (
            <article className="proof-card" key={run?.id ?? `${schedule.id}-sample-${index}`}>
              <div className="proof-preview" aria-hidden="true"><span /><span /><span /><i><Check size={12} /></i></div>
              <div><strong>{schedule.client}</strong><span>{schedule.keyword}</span><small>Completed {demo ? ["12 min ago", "28 min ago", "1 hour ago"][index] : readableTime(run?.finishedAt, "time unavailable")}</small></div>
              <button type="button" onClick={() => run ? onViewRun(run) : onViewSchedule(schedule.id)}>View proof <ExternalLink size={12} /></button>
            </article>
          ))}
          {!demo && recentProofItems.length === 0 ? <div className="proof-empty"><ShieldCheck size={19} /><span>Completed-run proof will appear here.</span></div> : null}
        </div>
      </section>
      {cancelCycle ? (
        <div className="modal-backdrop">
          <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="cancel-cycle-title" aria-describedby="cancel-cycle-description">
            <span className="danger-icon"><Trash2 size={20} /></span>
            <h2 id="cancel-cycle-title">Cancel this device cycle?</h2>
            <p id="cancel-cycle-description"><strong>{cancelCycle.name}</strong> will stop all future work in this cycle. Open runs will be marked for cancellation and run history will be preserved. This cannot be undone.</p>
            <div>
              <button className="secondary-button" type="button" disabled={pendingCycleAction?.status === "cancelled"} onClick={() => setCancelCycle(null)}>Keep cycle</button>
              <button className="danger-button" type="button" disabled={pendingCycleAction?.status === "cancelled"} onClick={() => void setCycleStatus(cancelCycle, "cancelled")}>
                {pendingCycleAction?.status === "cancelled" ? <RefreshCw size={15} className="spin" /> : <Trash2 size={15} />}
                {pendingCycleAction?.status === "cancelled" ? "Cancelling…" : "Cancel cycle"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {launchCycleOpen ? (
        <LaunchCycleDialog
          clients={clientOptions}
          phones={phones}
          programs={cyclePrograms}
          templates={templateOptions}
          cycles={cycles}
          preferredClientName={clientFilter === "All clients" ? null : clientFilter}
          onClose={() => setLaunchCycleOpen(false)}
          onSubmit={onLaunchCycle}
          onCreateProgram={onCreateCycleProgram}
        />
      ) : null}
    </section>
  );
}

function ProfileSummaryButton({
  label,
  value,
  state,
  selected,
  onSelect,
}: {
  label: string;
  value: number;
  state: ProfileReadinessState | "all";
  selected: boolean;
  onSelect: (state: ProfileReadinessState | "all") => void;
}) {
  return (
    <button className={selected ? "is-selected" : ""} type="button" onClick={() => onSelect(state)} aria-pressed={selected}>
      <span className={`profile-summary-dot profile-summary-${state}`} />
      <small>{label}</small>
      <strong>{value}</strong>
    </button>
  );
}

function ProfileReadinessRow({ profile, now }: { profile: CommandProfileReadiness; now: string }) {
  const scorePercent = profileScorePercent(profile);
  const completionTarget = Math.max(profile.completionScore, 1);
  const readyMarker = Math.min(100, Math.max(0, (profile.readyScore / completionTarget) * 100));
  const tone = profileStateTone(profile.state);
  return (
    <tr className={`profile-readiness-row profile-tone-${tone}`}>
      <td>
        <span className="profile-identity">
          <span className="profile-avatar"><UserRoundCheck size={14} /></span>
          <span><strong>{profile.label}</strong><small>{profile.clientName}</small></span>
        </span>
      </td>
      <td><strong>{profile.phoneName}</strong><small>Dedicated · {profile.successfulDays} active days</small></td>
      <td><strong>Day {profile.currentDay} / {profile.durationDays}</strong><small>{profile.currentPhase ? `${phaseLabel(profile.currentPhase)} · ${profile.cycleName}` : profile.cycleName}</small></td>
      <td>
        <div className="profile-score-copy"><strong>{profile.score}<small> pts</small></strong><span>{scorePercent}%</span></div>
        <span className="profile-score-track" aria-label={`${profile.score} points; ready at ${profile.readyScore}; completed at ${profile.completionScore}`}>
          <i style={{ width: `${scorePercent}%` }} />
          <b style={{ left: `${readyMarker}%` }} title={`Ready at ${profile.readyScore} points`} />
        </span>
        <small>Ready {profile.readyScore} · Complete {profile.completionScore}</small>
      </td>
      <td>
        <span className="profile-app-scores">
          {profile.appScores.map((app) => {
            const appPercent = Math.min(100, Math.max(0, Math.round((app.score / Math.max(app.possible, 1)) * 100)));
            return (
              <span className="profile-app-score" key={app.app} title={`${app.app}: ${app.score} of ${app.possible} points`}>
                <span><strong>{app.app}</strong><small>{app.score}</small></span>
                <i><b style={{ width: `${appPercent}%` }} /></i>
              </span>
            );
          })}
          {!profile.appScores.length ? <small>No successful app activity</small> : null}
          {(profile.phaseGate?.requirements ?? []).map((requirement) => (
            <span className={`profile-app-requirement${requirement.met ? " is-complete" : ""}`} key={`requirement-${requirement.appKind}`}>
              <strong>{phaseLabel(requirement.appKind)} {requirement.met ? <CheckCircle2 size={10} /> : <AlertTriangle size={10} />}</strong>
              <small>{requirement.minSuccessfulRuns > 0 ? `${requirement.successfulRuns} / ${requirement.minSuccessfulRuns} runs` : `${requirement.successfulRuns} runs`} · {requirement.minActiveDays > 0 ? `${requirement.activeDays} / ${requirement.minActiveDays} days` : `${requirement.activeDays} days`}</small>
            </span>
          ))}
        </span>
      </td>
      <td>
        <span className={`profile-state profile-state-${tone}`}>
          {profile.state === "completed" ? <Trophy size={11} /> : profile.state === "ready" ? <CheckCircle2 size={11} /> : profile.state === "needs_attention" ? <AlertTriangle size={11} /> : null}
          {profileStateLabel(profile.state)}
        </span>
        <small title={profile.phaseGate?.reason ?? profile.statusReason ?? undefined}>{profile.phaseGate?.reason ?? profile.statusReason ?? activityAge(profile.lastSuccessAt, now)}</small>
      </td>
    </tr>
  );
}

function CycleRow({
  cycle,
  phasePlan,
  controlsDisabled,
  pendingStatus,
  onPause,
  onResume,
  onCancel,
}: {
  cycle: CommandDeviceCycle;
  phasePlan?: PhasePlan | null;
  controlsDisabled: boolean;
  pendingStatus: DeviceCycleOperatingStatus | null;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  const progress = Math.min(100, Math.max(0, Math.round((cycle.currentDay / cycle.durationDays) * 100)));
  const statusTone = cycle.status === "active"
    ? "green"
    : cycle.status === "provisioning"
      ? "blue"
      : cycle.status === "blocked"
        ? "red"
        : "gray";
  const externalProxy = usesExternalDeviceProxy(cycle);
  const proxyTone = externalProxy ? "gray" : proxyHealthTone(cycle.proxy?.health);
  return (
    <article className="cycle-row">
      <div className="cycle-device">
        <span><Smartphone size={15} /></span>
        <div><strong>{cycle.phoneName}</strong><small>{cycle.clientName}</small></div>
      </div>
      <div className="cycle-progress-copy">
        <div><strong>Day {cycle.currentDay} / {cycle.durationDays}</strong><small>{progress}%</small></div>
        <span className="cycle-progress-track"><i style={{ width: `${progress}%` }} /></span>
      </div>
      <div className="cycle-run-counts">
        <strong>{cycle.runCounts.done}<small> / {cycle.runCounts.total}</small></strong>
        <span>{cycle.runCounts.pending} pending · {cycle.runCounts.failed} failed</span>
      </div>
      <div className="cycle-milestone">
        <strong>{cycleMilestone(cycle, phasePlan)}</strong>
        <small title={cycle.phaseGate?.reason ?? undefined}>{cycle.phaseGate?.reason ?? `Ends ${readableDate(cycle.endsOn)}`}</small>
      </div>
      <div className="cycle-proxy-copy">
        <span className={`proxy-status proxy-status-${proxyTone}`}><i />{externalProxy ? "Existing device proxy" : proxyHealthLabel(cycle.proxy?.health)}</span>
        <small>{externalProxy ? "Externally managed · not inspected" : `${cycle.proxy?.configuredIsp ?? "Proxy pending"}${cycle.proxy?.configuredCity ? ` · ${cycle.proxy.configuredCity}` : ""}`}</small>
      </div>
      <div
        className="cycle-state"
        style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, padding: 0, background: "transparent" }}
        role="group"
        aria-label={`${cycle.name} controls`}
        aria-busy={pendingStatus !== null}
      >
        <span className={`cycle-state cycle-state-${statusTone}`}>{cycle.status}</span>
        {cycle.status === "active" ? (
          <button
            className="icon-button"
            style={{ width: "auto", minWidth: 22, height: 22, padding: "0 5px", gap: 3, fontSize: 7 }}
            type="button"
            disabled={controlsDisabled}
            onClick={onPause}
            aria-label={`Pause ${cycle.name}`}
          >
            {pendingStatus === "paused" ? <RefreshCw size={11} className="spin" /> : <Pause size={11} />}
            Pause
          </button>
        ) : cycle.status === "paused" ? (
          <button
            className="icon-button"
            style={{ width: "auto", minWidth: 22, height: 22, padding: "0 5px", gap: 3, fontSize: 7 }}
            type="button"
            disabled={controlsDisabled}
            onClick={onResume}
            aria-label={`Resume ${cycle.name}`}
          >
            {pendingStatus === "active" ? <RefreshCw size={11} className="spin" /> : <Play size={11} />}
            Resume
          </button>
        ) : null}
        {["provisioning", "active", "paused", "blocked"].includes(cycle.status) ? (
          <button
            className="icon-button"
            style={{ width: "auto", minWidth: 22, height: 22, padding: "0 5px", gap: 3, fontSize: 7, color: "var(--red)" }}
            type="button"
            disabled={controlsDisabled}
            onClick={onCancel}
            aria-label={`Cancel ${cycle.name}`}
          >
            <Trash2 size={11} />
            Cancel
          </button>
        ) : null}
      </div>
    </article>
  );
}

type LaunchCycleDraft = {
  clientId: string;
  programId: string;
  phoneId: string;
  name: string;
  keyword: string;
  startDate: string;
  timezone: string;
  targetCountry: string;
  targetRegion: string;
  targetCity: string;
  targetLatitude: string;
  targetLongitude: string;
  profileLabel: string;
};

const PROGRAM_APPS = [
  { kind: "chrome", label: "Chrome" },
  { kind: "maps", label: "Maps" },
  { kind: "google", label: "Google" },
  { kind: "waze", label: "Waze" },
  { kind: "gmail", label: "Gmail" },
  { kind: "discover", label: "Discover" },
  { kind: "other", label: "Other" },
] as const;

const PHASE_DURATION_FIELDS = [
  { key: "warmupDays", label: "Warmup", min: 10, max: 14 },
  { key: "moneyDays", label: "Money", min: 2, max: 5 },
  { key: "finalSqueezeDays", label: "Final squeeze", min: 1, max: 3 },
  { key: "afterActionDays", label: "After action", min: 10, max: 14 },
] as const;

const PHASE_COUNT_FIELDS = [
  { key: "baseline", label: "Daily routine tasks", min: 5, max: 40 },
  { key: "money", label: "Money tasks", min: 3, max: 4 },
  { key: "final_squeeze", label: "Final squeeze tasks", min: 4, max: 7 },
  { key: "after_action", label: "After action tasks", min: 3, max: 5 },
] as const;

function boundedPreviewNumber(value: string, min: number, max: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.trunc(numeric))) : min;
}

function programRunEstimate(program?: CycleProgramOption): number | null {
  if (!program?.rules?.length) return null;
  const windows = program.rules.flatMap((rule) => rule.ruleKind && rule.startDay != null && rule.endDay != null
    ? [{ ruleKind: rule.ruleKind, startDay: rule.startDay, endDay: rule.endDay }]
    : []);
  if (windows.length !== program.rules.length) return null;
  try {
    return plannedCycleRunCount(windows, program.durationDays);
  } catch {
    return null;
  }
}

function inferredTemplateIdForApp(
  appKind: CycleProgramRuleInput["appKind"],
  templates: CycleTemplateOption[],
) {
  if (appKind === "other") return "";
  const matches = templates.filter((template) => {
    const words = new Set(template.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    return words.has(appKind);
  });

  // A single explicit app-name match is safe to suggest. Zero or multiple
  // matches require a deliberate choice; inventory order is never intent.
  return matches.length === 1 ? matches[0].id : "";
}

type PhaseTaskDraft = {
  templateId: string;
  localTime: string;
  appKind: string;
  points: string;
  expectedMinutes: string;
};

type PhaseProgramDraft = {
  name: string;
  timezone: string;
  readyDay: string;
  readyThresholdPercent: string;
  completionThresholdPercent: string;
  warmupDays: string;
  moneyDays: string;
  finalSqueezeDays: string;
  afterActionDays: string;
  continueDailyTasks: boolean;
  counts: Record<"baseline" | "money" | "final_squeeze" | "after_action", string>;
  tasks: Record<string, Partial<PhaseTaskDraft>>;
  appRequirements: Record<string, { minSuccessfulRuns: string; minActiveDays: string }>;
};

function isEligibleCyclePhone(
  phone: CommandPhone,
  clientId: string | undefined,
  openCyclePhoneIds: Set<string>,
): boolean {
  const expiration = phone.expiredAt ? new Date(phone.expiredAt).getTime() : null;
  return phone.enabled
    && phone.providerPresent !== false
    && ![3, 4].includes(phone.status)
    && (expiration === null || (Number.isFinite(expiration) && expiration > Date.now()))
    && !openCyclePhoneIds.has(phone.id)
    && phone.clientId === clientId;
}

function variableLabel(name: string): string {
  return name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function programVariableResult(program: CycleProgramOption | undefined): {
  variables: ProgramVariableDefinition[];
  error: string | null;
} {
  if (!program) return { variables: [], error: null };
  try {
    return {
      variables: extractProgramVariables(
        (program.rules ?? []).map((rule) => rule.config ?? {}),
      ),
      error: null,
    };
  } catch (error) {
    return {
      variables: [],
      error: error instanceof Error ? error.message : "Program variables are invalid.",
    };
  }
}

function variableEntry(
  definition: ProgramVariableDefinition,
  source: string,
): Record<string, unknown> {
  const value = definition.type === "boolean"
    ? source === "true"
    : definition.type === "file"
      ? source.split("\n").map((item) => item.trim()).filter(Boolean)
      : source;
  return {
    key: definition.name,
    type: definition.type,
    required: definition.required,
    value,
  };
}

function LaunchCycleDialog({
  clients,
  phones,
  programs,
  templates,
  cycles,
  preferredClientName,
  onClose,
  onSubmit,
  onCreateProgram,
}: {
  clients: CommandClientOption[];
  phones: CommandPhone[];
  programs: CycleProgramOption[];
  templates: CycleTemplateOption[];
  cycles: CommandDeviceCycle[];
  preferredClientName: string | null;
  onClose: () => void;
  onSubmit: (input: LaunchCycleInput) => Promise<void> | void;
  onCreateProgram: (input: CreateCycleProgramInput) => Promise<CycleProgramOption>;
}) {
  const [createdProgram, setCreatedProgram] = useState<CycleProgramOption | null>(null);
  const publishedPrograms = programs.filter((program) => program.status === "published");
  if (createdProgram && !publishedPrograms.some((program) => program.id === createdProgram.id)) publishedPrograms.push(createdProgram);
  const preferredClient = clients.find((client) => client.name === preferredClientName) ?? clients[0];
  const initialProgram = publishedPrograms[0];
  const openCyclePhoneIds = new Set(cycles
    .filter((cycle) => ["provisioning", "active", "paused", "blocked"].includes(cycle.status))
    .map((cycle) => cycle.phoneId));
  const firstPhone = phones.find((phone) =>
    isEligibleCyclePhone(phone, preferredClient?.id, openCyclePhoneIds),
  );
  const [draft, setDraft] = useState<LaunchCycleDraft>(() => ({
    clientId: preferredClient?.id ?? "",
    programId: initialProgram?.id ?? "",
    phoneId: firstPhone?.id ?? "",
    name: preferredClient && initialProgram ? `${preferredClient.name} — ${initialProgram.name}` : "",
    keyword: "",
    startDate: new Date().toISOString().slice(0, 10),
    timezone: initialProgram?.timezone ?? "America/New_York",
    targetCountry: "US",
    targetRegion: "",
    targetCity: "",
    targetLatitude: firstPhone?.gpsLatitude == null ? "" : String(firstPhone.gpsLatitude),
    targetLongitude: firstPhone?.gpsLongitude == null ? "" : String(firstPhone.gpsLongitude),
    profileLabel: "",
  }));
  const [submitting, setSubmitting] = useState(false);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [creatingProgram, setCreatingProgram] = useState(false);
  const [programBuilderOpen, setProgramBuilderOpen] = useState(!publishedPrograms.length);
  const [programTemplateQuery, setProgramTemplateQuery] = useState("");
  const [error, setError] = useState("");
  const [programDraft, setProgramDraft] = useState<PhaseProgramDraft>(() => ({
    name: "Four-phase local presence",
    timezone: "America/New_York",
    readyDay: String(defaultPhasePlan.warmupDays),
    readyThresholdPercent: "80",
    completionThresholdPercent: "90",
    warmupDays: String(defaultPhasePlan.warmupDays),
    moneyDays: String(defaultPhasePlan.moneyDays),
    finalSqueezeDays: String(defaultPhasePlan.finalSqueezeDays),
    afterActionDays: String(defaultPhasePlan.afterActionDays),
    continueDailyTasks: true,
    counts: { baseline: "5", money: "4", final_squeeze: "6", after_action: "4" },
    tasks: {},
    appRequirements: Object.fromEntries(PROGRAM_APPS.map((app) => [app.kind, { minSuccessfulRuns: "0", minActiveDays: "0" }])),
  }));
  const previewPlan: PhasePlan = {
    version: 1,
    warmupDays: boundedPreviewNumber(programDraft.warmupDays, 10, 14),
    moneyDays: boundedPreviewNumber(programDraft.moneyDays, 2, 5),
    finalSqueezeDays: boundedPreviewNumber(programDraft.finalSqueezeDays, 1, 3),
    afterActionDays: boundedPreviewNumber(programDraft.afterActionDays, 10, 14),
    continueDailyTasks: programDraft.continueDailyTasks,
    appRequirements: [],
  };
  const previewCounts: PhaseTaskCounts = {
    baseline: boundedPreviewNumber(programDraft.counts.baseline, 5, 40),
    money: boundedPreviewNumber(programDraft.counts.money, 3, 4),
    final_squeeze: boundedPreviewNumber(programDraft.counts.final_squeeze, 4, 7),
    after_action: boundedPreviewNumber(programDraft.counts.after_action, 3, 5),
  };
  const programTasks = buildPhaseTaskSlots(previewPlan, previewCounts).map((task) => ({
    ...task,
    draft: {
      templateId: inferredTemplateIdForApp(task.appKind, templates),
      localTime: task.localTime,
      appKind: task.appKind,
      points: String(task.points),
      expectedMinutes: String(task.expectedDurationSeconds / 60),
      ...programDraft.tasks[task.id],
    } as PhaseTaskDraft,
  }));
  const previewDuration = phasePlanDuration(previewPlan);
  const previewRuns = plannedCycleRunCount(programTasks, previewDuration);
  const selectedTemplateIds = programTasks.map((task) => task.draft.templateId);
  const selectedTemplateKey = selectedTemplateIds.join("|");
  const previewTaskMinutes = programTasks.reduce((total, task) => total + (task.endDay - task.startDay + 1) * (Number(task.draft.expectedMinutes) || 0), 0);

  function updateProgramTask(id: string, changes: Partial<PhaseTaskDraft>) {
    setProgramDraft((current) => ({ ...current, tasks: { ...current.tasks, [id]: { ...current.tasks[id], ...changes } } }));
  }
  const selectedClient = clients.find((client) => client.id === draft.clientId);
  const selectedProgram = publishedPrograms.find((program) => program.id === draft.programId);
  const normalizedTemplateQuery = programTemplateQuery.trim().toLowerCase();
  const selectedProgramTemplateIds = new Set(selectedTemplateIds.filter(Boolean));
  const programTemplateMatches = templates
      .filter((template) => {
        if (!normalizedTemplateQuery || selectedProgramTemplateIds.has(template.id)) return true;
        const source = templateSourceLabel(template).toLowerCase();
        return [template.name, template.id, template.duoplusTemplateId ?? "", source]
          .some((value) => value.toLowerCase().includes(normalizedTemplateQuery));
      })
      .toSorted((left, right) => left.name.localeCompare(right.name));
  const officialProgramTemplates = programTemplateMatches.filter((template) => template.templateType === 1);
  const customProgramTemplates = programTemplateMatches.filter((template) => template.templateType === 2);
  const selectedProgramTemplateSchemas = (() => {
    const seen = new Set<string>();
    return selectedTemplateKey.split("|").flatMap((templateId) => {
      if (!templateId || seen.has(templateId)) return [];
      seen.add(templateId);
      const template = templates.find((candidate) => candidate.id === templateId);
      if (!template) return [];
      const schema = resolvedTemplateConfigSchema(template.name, template.configSchema);
      return schema ? [{ template, schema }] : [];
    });
  })();
  const selectedVariableResult = programVariableResult(selectedProgram);
  const eligiblePhones = phones.filter((phone) =>
    isEligibleCyclePhone(phone, draft.clientId, openCyclePhoneIds),
  );
  const estimatedRuns = programRunEstimate(selectedProgram);

  function chooseClient(clientId: string) {
    const client = clients.find((item) => item.id === clientId);
    const availablePhone = phones.find((phone) =>
      isEligibleCyclePhone(phone, clientId, openCyclePhoneIds),
    );
    setDraft((current) => ({
      ...current,
      clientId,
      phoneId: availablePhone?.id ?? "",
      targetCity: "",
      targetRegion: "",
      targetLatitude: availablePhone?.gpsLatitude == null ? "" : String(availablePhone.gpsLatitude),
      targetLongitude: availablePhone?.gpsLongitude == null ? "" : String(availablePhone.gpsLongitude),
      profileLabel: "",
      name: client && selectedProgram ? `${client.name} — ${selectedProgram.name}` : current.name,
    }));
  }

  function chooseProgram(programId: string) {
    const program = publishedPrograms.find((item) => item.id === programId);
    setDraft((current) => ({
      ...current,
      programId,
      timezone: program?.timezone ?? current.timezone,
      name: selectedClient && program ? `${selectedClient.name} — ${program.name}` : current.name,
    }));
    setVariableValues({});
  }

  async function createPhaseProgram(event: FormEvent<HTMLButtonElement>) {
    event.preventDefault();
    setError("");
    for (const field of PHASE_DURATION_FIELDS) {
      const value = Number(programDraft[field.key]);
      if (!Number.isInteger(value) || value < field.min || value > field.max) {
        setError(`${field.label} duration must be between ${field.min} and ${field.max} whole days.`);
        return;
      }
    }
    for (const field of PHASE_COUNT_FIELDS) {
      const value = Number(programDraft.counts[field.key]);
      if (!Number.isInteger(value) || value < field.min || value > field.max) {
        setError(`${field.label} must be between ${field.min} and ${field.max}.`);
        return;
      }
    }
    if (programTasks.length > 50) {
      setError("A program supports up to 50 task mappings. Reduce the daily routine or phase task counts.");
      return;
    }
    const durationDays = previewDuration;
    const availableTemplateIds = new Set(templates.map((template) => template.id));
    if (selectedTemplateIds.some((templateId) => !availableTemplateIds.has(templateId))) {
      setError(`Choose a currently synced RPA template for all ${programTasks.length} program tasks.`);
      return;
    }
    const readyDay = Number(programDraft.readyDay);
    const readyThresholdPercent = Number(programDraft.readyThresholdPercent);
    const completionThresholdPercent = Number(programDraft.completionThresholdPercent);
    if (!Number.isInteger(readyDay) || readyDay < 1 || readyDay > durationDays) {
      setError("Ready day must fit inside the program duration.");
      return;
    }
    if (![readyThresholdPercent, completionThresholdPercent].every((value) => Number.isInteger(value) && value >= 1 && value <= 100)) {
      setError("Readiness thresholds must be whole percentages from 1 to 100.");
      return;
    }
    if (completionThresholdPercent < readyThresholdPercent) {
      setError("Completed threshold must be equal to or higher than Ready threshold.");
      return;
    }
    if (programTasks.some((task) => !Number.isInteger(Number(task.draft.points)) || Number(task.draft.points) < 1 || Number(task.draft.points) > 100)) {
      setError("Every task needs a point value from 1 to 100.");
      return;
    }
    if (programTasks.some((task) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.draft.localTime))) {
      setError("Every task needs a valid local time.");
      return;
    }
    if (programTasks.some((task) => !Number.isFinite(Number(task.draft.expectedMinutes)) || Number(task.draft.expectedMinutes) < 0.5 || Number(task.draft.expectedMinutes) > 360)) {
      setError("Every task needs an estimated duration between 0.5 and 360 minutes.");
      return;
    }
    const appRequirements = PROGRAM_APPS.map((app) => ({
      appKind: app.kind,
      minSuccessfulRuns: Number(programDraft.appRequirements[app.kind].minSuccessfulRuns),
      minActiveDays: Number(programDraft.appRequirements[app.kind].minActiveDays),
    }));
    if (appRequirements.some((requirement) => !Number.isInteger(requirement.minSuccessfulRuns) || requirement.minSuccessfulRuns < 0 || requirement.minSuccessfulRuns > 1800 || !Number.isInteger(requirement.minActiveDays) || requirement.minActiveDays < 0 || requirement.minActiveDays > previewPlan.warmupDays)) {
      setError(`App requirements must be whole numbers: 0–1800 successful runs and 0–${previewPlan.warmupDays} active days before Money starts.`);
      return;
    }
    const phasePlan: PhasePlan = { ...previewPlan, appRequirements: appRequirements.filter((requirement) => requirement.minSuccessfulRuns > 0 || requirement.minActiveDays > 0) };
    let ruleConfigs: Record<string, unknown>[];
    try {
      ruleConfigs = selectedTemplateIds.map((templateId) => {
        const template = templates.find((candidate) => candidate.id === templateId);
        if (!template) throw new Error("A selected DuoPlus template is no longer available.");
        const schema = resolvedTemplateConfigSchema(template.name, template.configSchema);
        return schema ? programTaskConfigForTemplateSchema(schema) : {};
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "A template input definition is invalid.");
      return;
    }
    setCreatingProgram(true);
    try {
      const program = await onCreateProgram({
        name: programDraft.name.trim(),
        durationDays,
        timezone: programDraft.timezone.trim(),
        readyDay,
        readyThresholdPercent,
        completionThresholdPercent,
        phasePlan,
        rules: programTasks.map((task, index) => ({
          name: task.name,
          templateId: task.draft.templateId,
          ruleKind: task.ruleKind,
          phaseKind: task.phaseKind,
          startDay: task.startDay,
          endDay: task.endDay,
          localTime: task.draft.localTime,
          sequence: index + 1,
          config: ruleConfigs[index],
          expectedDurationSeconds: Math.round(Number(task.draft.expectedMinutes) * 60),
          maxAttempts: 3,
          required: true,
          appKind: task.draft.appKind,
          points: Number(task.draft.points),
        })),
      });
      setCreatedProgram(program);
      setDraft((current) => ({
        ...current,
        programId: program.id,
        timezone: program.timezone,
        name: selectedClient ? `${selectedClient.name} — ${program.name}` : program.name,
      }));
      setProgramBuilderOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cycle program could not be created.");
    } finally {
      setCreatingProgram(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const latitudeSet = draft.targetLatitude.trim() !== "";
    const longitudeSet = draft.targetLongitude.trim() !== "";
    if (selectedProgram?.phasePlan && (!latitudeSet || !longitudeSet)) {
      setError("Enter the dedicated phone's latitude and longitude for this four-phase program.");
      return;
    }
    if (latitudeSet !== longitudeSet) {
      setError("Enter both target latitude and longitude, or leave both blank.");
      return;
    }
    if (selectedVariableResult.error) {
      setError(selectedVariableResult.error);
      return;
    }
    const missingVariable = selectedVariableResult.variables.find(
      (variable) => variable.required && !(variableValues[variable.name] ?? "").trim(),
    );
    if (missingVariable) {
      setError(`${variableLabel(missingVariable.name)} is required by this program.`);
      return;
    }
    const variables = Object.fromEntries(
      selectedVariableResult.variables
        .filter((variable) => (variableValues[variable.name] ?? "").trim())
        .map((variable) => [
          variable.name,
          variableEntry(variable, variableValues[variable.name]),
        ]),
    );
    setSubmitting(true);
    try {
      await onSubmit({
        programId: draft.programId,
        clientId: draft.clientId,
        phoneId: draft.phoneId,
        name: draft.name.trim(),
        keyword: draft.keyword.trim(),
        startDate: draft.startDate,
        timezone: draft.timezone.trim(),
        targetCountry: draft.targetCountry.trim().toUpperCase(),
        targetRegion: draft.targetRegion.trim(),
        targetCity: draft.targetCity.trim(),
        ...(latitudeSet ? { targetLatitude: Number(draft.targetLatitude), targetLongitude: Number(draft.targetLongitude) } : {}),
        profileLabel: draft.profileLabel.trim(),
        variables,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cycle could not be launched.");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = Boolean(
    draft.clientId
    && draft.programId
    && draft.phoneId
    && draft.name.trim()
    && draft.keyword.trim()
    && draft.startDate
    && draft.timezone.trim()
    && draft.targetCountry.trim().length === 2
    && draft.targetRegion.trim()
    && draft.targetCity.trim()
    && draft.profileLabel.trim()
    && (!selectedProgram?.phasePlan || (draft.targetLatitude.trim() !== "" && draft.targetLongitude.trim() !== ""))
    && !selectedVariableResult.error
    && selectedVariableResult.variables.every(
      (variable) => !variable.required || Boolean((variableValues[variable.name] ?? "").trim()),
    )
  );

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="cycle-launch-dialog" role="dialog" aria-modal="true" aria-labelledby="cycle-launch-title">
        <div className="modal-header">
          <span className="modal-icon"><CalendarRange size={20} /></span>
          <div><p>Device cycle</p><h2 id="cycle-launch-title">Launch a new cycle</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close cycle setup"><X size={19} /></button>
        </div>
        <form onSubmit={!programBuilderOpen ? handleSubmit : (event) => event.preventDefault()}>
          {programBuilderOpen ? (
            <>
              <p className="integration-intro">Build a reusable four-phase program. Each phone keeps its client, city, and profile while shared startup slots rotate through the scheduled work.</p>
              <div className="cycle-launch-grid standard-program-fields">
                <label className="field-label"><span>Program name</span><input required maxLength={120} value={programDraft.name} onChange={(event) => setProgramDraft((current) => ({ ...current, name: event.target.value }))} /></label>
                <label className="field-label"><span>Timezone</span><input required maxLength={80} value={programDraft.timezone} onChange={(event) => setProgramDraft((current) => ({ ...current, timezone: event.target.value }))} /></label>
                {PHASE_DURATION_FIELDS.map((field) => (
                  <label className="field-label" key={field.key}><span>{field.label} days <small>{field.min}–{field.max}</small></span><input aria-label={`${field.label} days`} required type="number" min={field.min} max={field.max} value={programDraft[field.key]} onChange={(event) => setProgramDraft((current) => ({ ...current, [field.key]: event.target.value, ...(field.key === "warmupDays" ? { readyDay: event.target.value } : {}) }))} /></label>
                ))}
                <label className="phase-program-check cycle-launch-wide"><input type="checkbox" checked={programDraft.continueDailyTasks} onChange={(event) => setProgramDraft((current) => ({ ...current, continueDailyTasks: event.target.checked }))} /><span><strong>Continue daily routine through every phase</strong><small>{programDraft.continueDailyTasks ? "Phase tasks are added to the daily routine." : "The daily routine ends after warmup. Later phases run their own tasks."}</small></span></label>
                {PHASE_COUNT_FIELDS.map((field) => (
                  <label className="field-label" key={field.key}><span>{field.label} <small>per day</small></span><input aria-label={field.label} required type="number" min={field.min} max={field.max} value={programDraft.counts[field.key]} onChange={(event) => setProgramDraft((current) => ({ ...current, counts: { ...current.counts, [field.key]: event.target.value } }))} /></label>
                ))}
              </div>
              <section className="phase-program-preview" aria-label="Program phase preview">
                <div className="standard-program-heading"><strong>{previewDuration}-day program · {previewRuns} runs per phone</strong><span>{(previewTaskMinutes / 60).toFixed(1)} task hours · before startup and retries</span></div>
                <table className="phase-program-table"><thead><tr><th>Phase</th><th>Cycle days</th><th>Tasks / day</th><th>Runs</th></tr></thead><tbody>
                  {phaseWindows(previewPlan).map((phase) => {
                    const dailyCount = (phase.kind === "warmup" || previewPlan.continueDailyTasks ? previewCounts.baseline : 0) + (phase.kind === "warmup" ? 0 : previewCounts[phase.kind]);
                    return <tr key={phase.kind}><th scope="row">{phase.label}</th><td>Days {phase.startDay}–{phase.endDay}</td><td>{dailyCount}</td><td>{dailyCount * phase.days}</td></tr>;
                  })}
                </tbody></table>
                <p>These are planned dates. Missing required successes keep later phase tasks on hold.</p>
              </section>
              <section className="phase-app-requirements" aria-label="App completion requirements">
                <div className="standard-program-heading"><strong>App completion requirements</strong><span>Per profile · required before Money starts</span></div>
                <p>Set your own minimums. Zero means no requirement. Failed attempts and retries never add completed runs; active days count dates with confirmed success.</p>
                <table className="phase-program-table"><thead><tr><th>App</th><th>Successful runs</th><th>Distinct active days</th></tr></thead><tbody>
                  {PROGRAM_APPS.map((app) => (
                    <tr key={app.kind}><th scope="row">{app.label}</th>{(["minSuccessfulRuns", "minActiveDays"] as const).map((field) => (
                      <td key={field}><input aria-label={`${app.label} minimum ${field === "minSuccessfulRuns" ? "successful runs" : "active days"}`} type="number" min="0" max={field === "minActiveDays" ? previewPlan.warmupDays : 1800} step="1" value={programDraft.appRequirements[app.kind][field]} onChange={(event) => setProgramDraft((current) => ({ ...current, appRequirements: { ...current.appRequirements, [app.kind]: { ...current.appRequirements[app.kind], [field]: event.target.value } } }))} /></td>
                    ))}</tr>
                  ))}
                </tbody></table>
              </section>
              <details className="phase-scoring-settings">
                <summary>Readiness score settings <ChevronDown size={13} /></summary>
                <div className="cycle-launch-grid">
                  <label className="field-label"><span>Ready threshold <small>% of points through warmup</small></span><input required type="number" min="1" max="100" value={programDraft.readyThresholdPercent} onChange={(event) => setProgramDraft((current) => ({ ...current, readyThresholdPercent: event.target.value }))} /></label>
                  <label className="field-label"><span>Completed threshold <small>% of full-cycle points</small></span><input required type="number" min="1" max="100" value={programDraft.completionThresholdPercent} onChange={(event) => setProgramDraft((current) => ({ ...current, completionThresholdPercent: event.target.value }))} /></label>
                </div>
              </details>
              <div className="standard-program-heading"><strong>RPA task mapping · {programTasks.length} tasks</strong><span>Choose a synced template, app, duration, and local time</span></div>
              <div className="program-template-search">
                <Search size={15} aria-hidden="true" />
                <label className="sr-only" htmlFor="program-template-search-input">Search program templates</label>
                <input
                  id="program-template-search-input"
                  type="search"
                  value={programTemplateQuery}
                  onChange={(event) => setProgramTemplateQuery(event.target.value)}
                  placeholder="Filter all template lists by name, source, or ID…"
                />
                {programTemplateQuery ? <button type="button" onClick={() => setProgramTemplateQuery("")} aria-label="Clear program template search"><X size={14} /></button> : null}
                <small aria-live="polite">{programTemplateMatches.length} of {templates.length}</small>
              </div>
              <div className="standard-program-tasks phase-program-tasks">
                {programTasks.map((task) => (
                  <div className="standard-program-task phase-program-task" key={task.id}>
                    <span><strong>{task.name}</strong><small>Each day {task.startDay}–{task.endDay}</small></span>
                    <select className="phase-task-template" aria-label={`${task.name} RPA template`} value={task.draft.templateId} onChange={(event) => updateProgramTask(task.id, { templateId: event.target.value })}>
                      <option value="">{templates.length ? "Select template" : "Sync templates first"}</option>
                      {officialProgramTemplates.length ? <optgroup label={`Official (${officialProgramTemplates.length})`}>{officialProgramTemplates.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</optgroup> : null}
                      {customProgramTemplates.length ? <optgroup label={`Custom (${customProgramTemplates.length})`}>{customProgramTemplates.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</optgroup> : null}
                    </select>
                    <label className="phase-task-field"><span>App</span><select aria-label={`${task.name} app`} value={task.draft.appKind} onChange={(event) => updateProgramTask(task.id, { appKind: event.target.value })}>
                      {PROGRAM_APPS.map((app) => <option key={app.kind} value={app.kind}>{app.label}</option>)}
                    </select></label>
                    <label className="phase-task-field"><span>Minutes</span><input aria-label={`${task.name} estimated minutes`} type="number" min="0.5" max="360" step="0.5" required value={task.draft.expectedMinutes} onChange={(event) => updateProgramTask(task.id, { expectedMinutes: event.target.value })} /></label>
                    <label className="phase-task-field"><span>Local time</span><input aria-label={`${task.name} local time`} type="time" required value={task.draft.localTime} onChange={(event) => updateProgramTask(task.id, { localTime: event.target.value })} /></label>
                    <label className="phase-task-field"><span>Points</span><input aria-label={`${task.name} points`} type="number" min="1" max="100" required value={task.draft.points} onChange={(event) => updateProgramTask(task.id, { points: event.target.value })} /></label>
                  </div>
                ))}
              </div>
              {selectedProgramTemplateSchemas.length ? (
                <section className="program-input-groups" aria-label="Program template inputs">
                  <div className="standard-program-heading"><strong>Reusable template bindings</strong><span>Programs store placeholders only · client values are entered when a cycle launches</span></div>
                  {selectedProgramTemplateSchemas.map(({ template, schema }) => {
                    const operatorInputs = schema.inputs.filter((input) => input.role === "operator");
                    const constantInputs = schema.inputs.filter((input) => input.role === "constant");
                    return (
                      <article className="program-input-group" key={template.id}>
                        <div className="program-input-title">
                          <span><strong>{template.name}</strong><small>{operatorInputs.length ? `${operatorInputs.length} cycle variable${operatorInputs.length === 1 ? "" : "s"}` : "No client values needed"}</small></span>
                          <i>{schema.source === "bundled-export" ? "Verified" : "Imported"}</i>
                        </div>
                        {operatorInputs.length ? <div className="program-input-grid">{operatorInputs.map((input) => (
                          <div className="field-label" key={input.key}>
                            <span><strong>{input.label}{input.required ? " *" : ""}</strong><code>{`{{${input.key}}}`}</code></span>
                            <small>{input.required ? "Required" : "Optional"} {input.type} value · collected at cycle launch</small>
                          </div>
                        ))}</div> : <div className="program-no-inputs"><CheckCircle2 size={14} />No values needed for this template.</div>}
                        {constantInputs.length ? <details className="program-input-defaults"><summary>{constantInputs.length} selector default{constantInputs.length === 1 ? "" : "s"}<ChevronDown size={13} /></summary><div className="program-input-grid">{constantInputs.map((input) => (
                          <ProgramTemplateInputField
                            key={input.key}
                            input={input}
                            value={Array.isArray(input.defaultValue) ? input.defaultValue.join("\n") : input.defaultValue}
                          />
                        ))}</div></details> : null}
                      </article>
                    );
                  })}
                </section>
              ) : null}
              <div className="cycle-readiness-strategy"><Award size={17} /><span><strong>Reusable, client-neutral readiness model</strong><small>Programs keep task structure, scoring, placeholders, and safe selector defaults. Business names, keywords, emails, and other operator values are supplied per cycle.</small></span></div>
              {error ? <div className="form-error" role="alert"><AlertTriangle size={16} />{error}</div> : null}
              <div className="cycle-launch-actions"><button className="secondary-button" type="button" onClick={() => publishedPrograms.length ? setProgramBuilderOpen(false) : onClose()}>{publishedPrograms.length ? "Back" : "Cancel"}</button><button className="primary-button" type="button" onClick={createPhaseProgram} disabled={creatingProgram || !templates.length}>{creatingProgram ? <RefreshCw size={16} className="spin" /> : <Plus size={16} />}{creatingProgram ? "Creating…" : "Create four-phase program"}</button></div>
            </>
          ) : (
            <>
              <div className="cycle-program-picker-row"><p className="integration-intro">Assign this phone to one client, city, and profile for the full program. Available startup slots determine when its work runs.</p><button type="button" onClick={() => { setError(""); setProgramBuilderOpen(true); }}><Plus size={13} /> New readiness program</button></div>
              <div className="cycle-launch-grid">
                <label className="field-label"><span>Client</span><select required value={draft.clientId} onChange={(event) => chooseClient(event.target.value)}><option value="">Select client</option>{clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select></label>
                <label className="field-label"><span>Program</span><select required value={draft.programId} onChange={(event) => chooseProgram(event.target.value)}><option value="">Select program</option>{publishedPrograms.map((program) => <option value={program.id} key={program.id}>{program.name} · {program.durationDays} days{program.readyDay ? ` · Ready day ${program.readyDay}` : ""}</option>)}</select></label>
                <label className="field-label"><span>Dedicated phone</span><select required disabled={!draft.clientId || !eligiblePhones.length} value={draft.phoneId} onChange={(event) => {
                  const phone = eligiblePhones.find((candidate) => candidate.id === event.target.value);
                  setDraft((current) => ({ ...current, phoneId: event.target.value, targetLatitude: phone?.gpsLatitude == null ? "" : String(phone.gpsLatitude), targetLongitude: phone?.gpsLongitude == null ? "" : String(phone.gpsLongitude), profileLabel: "" }));
                }}><option value="">{eligiblePhones.length ? "Select phone" : "Assign a phone to this client first"}</option>{eligiblePhones.map((phone) => <option value={phone.id} key={phone.id}>{phone.name}</option>)}</select></label>
                <label className="field-label"><span>Start date</span><input required type="date" value={draft.startDate} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))} /></label>
                <label className="field-label cycle-launch-wide"><span>Cycle name</span><input required maxLength={160} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Client — 30-day cycle" /></label>
                <label className="field-label cycle-launch-wide"><span>Keyword</span><input required maxLength={500} value={draft.keyword} onChange={(event) => setDraft((current) => ({ ...current, keyword: event.target.value }))} placeholder="Primary local search keyword" /></label>
                {selectedVariableResult.variables.length ? (
                  <div className="standard-program-heading cycle-launch-wide">
                    <strong>Client task values</strong>
                    <span>Used by this cycle only · never enter passwords, tokens, cookies, or proxy credentials</span>
                  </div>
                ) : null}
                {selectedVariableResult.variables.map((variable) => {
                  const value = variableValues[variable.name] ?? "";
                  const update = (nextValue: string) => setVariableValues((current) => ({
                    ...current,
                    [variable.name]: nextValue,
                  }));
                  return (
                    <label className="field-label cycle-launch-wide" key={variable.name}>
                      <span>{variableLabel(variable.name)} <small>{variable.required ? "required" : "optional"} · client value</small></span>
                      {variable.type === "boolean" ? (
                        <select required={variable.required} value={value} onChange={(event) => update(event.target.value)}>
                          <option value="">Select value</option>
                          <option value="true">Yes</option>
                          <option value="false">No</option>
                        </select>
                      ) : ["textarea", "file", "excel"].includes(variable.type) ? (
                        <textarea required={variable.required} value={value} onChange={(event) => update(event.target.value)} placeholder={variable.type === "file" ? "One safe file reference per line" : "Enter the safe task value"} />
                      ) : (
                        <input required={variable.required} type={variable.type === "number" ? "number" : "text"} value={value} onChange={(event) => update(event.target.value)} placeholder="Enter the safe task value" />
                      )}
                    </label>
                  );
                })}
                <label className="field-label"><span>Target country</span><input required maxLength={2} value={draft.targetCountry} onChange={(event) => setDraft((current) => ({ ...current, targetCountry: event.target.value }))} placeholder="US" /></label>
                <label className="field-label"><span>Target region</span><input required maxLength={120} value={draft.targetRegion} onChange={(event) => setDraft((current) => ({ ...current, targetRegion: event.target.value }))} placeholder="Florida" /></label>
                <label className="field-label"><span>Target city</span><input required maxLength={120} value={draft.targetCity} onChange={(event) => setDraft((current) => ({ ...current, targetCity: event.target.value }))} placeholder="Lakeland" /></label>
                <label className="field-label"><span>Timezone</span><input required maxLength={80} value={draft.timezone} onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))} placeholder="America/New_York" /></label>
                <label className="field-label"><span>Latitude <small>{selectedProgram?.phasePlan ? "required" : "optional"}</small></span><input required={Boolean(selectedProgram?.phasePlan)} type="number" min="-90" max="90" step="any" value={draft.targetLatitude} onChange={(event) => setDraft((current) => ({ ...current, targetLatitude: event.target.value }))} placeholder="28.0395" /></label>
                <label className="field-label"><span>Longitude <small>{selectedProgram?.phasePlan ? "required" : "optional"}</small></span><input required={Boolean(selectedProgram?.phasePlan)} type="number" min="-180" max="180" step="any" value={draft.targetLongitude} onChange={(event) => setDraft((current) => ({ ...current, targetLongitude: event.target.value }))} placeholder="-81.9498" /></label>
                <label className="field-label cycle-launch-wide"><span>Profile label <small>required · never enter the password</small></span><input required maxLength={160} value={draft.profileLabel} onChange={(event) => setDraft((current) => ({ ...current, profileLabel: event.target.value }))} placeholder="Email alias or profile reference" /></label>
              </div>
              {selectedProgram?.phasePlan ? (
                <section className="phase-program-preview" aria-label="Selected program phases">
                  <div className="standard-program-heading"><strong>Four-phase schedule</strong><span>{selectedProgram.durationDays} days · one dedicated profile</span></div>
                  <table className="phase-program-table"><thead><tr><th>Phase</th><th>Planned days</th><th>Duration</th></tr></thead><tbody>{phaseWindows(selectedProgram.phasePlan).map((phase) => <tr key={phase.kind}><th scope="row">{phase.label}</th><td>{phase.startDay}–{phase.endDay}</td><td>{phase.days} days</td></tr>)}</tbody></table>
                  <p>Required successful work and app minimums control phase advancement. These coordinates record this phone’s assigned location; confirm the device uses that location before launch.</p>
                </section>
              ) : null}
              {selectedVariableResult.error ? <div className="form-error" role="alert"><AlertTriangle size={16} />{selectedVariableResult.error}</div> : null}
              <div className="cycle-readiness-strategy"><Award size={17} /><span><strong>Profile scoring starts with this cycle</strong><small>Only successful RPA runs add points. ADB and UI-dump backup remains diagnostic and never changes readiness.</small></span></div>
              <div className="cycle-proxy-strategy"><Network size={17} /><span><strong>Existing device proxy stays untouched</strong><small>No proxy creation, rotation, update, verification, or health check. Program volume: {estimatedRuns == null ? "available after program rules are synced" : `${estimatedRuns} runs on this phone`}.</small></span></div>
              {error ? <div className="form-error" role="alert"><AlertTriangle size={16} />{error}</div> : null}
              <div className="cycle-launch-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={!canSubmit || submitting}>{submitting ? <RefreshCw size={16} className="spin" /> : <Play size={16} />}{submitting ? "Launching…" : "Launch cycle"}</button></div>
            </>
          )}
        </form>
      </section>
    </div>
  );
}

function ProgramTemplateInputField({
  input,
  value,
}: {
  input: DuoPlusTemplateInput;
  value: string | number | boolean;
}) {
  const placeholder = Array.isArray(input.defaultValue)
    ? input.defaultValue.join("\n")
    : String(input.defaultValue ?? "");
  if (input.type === "boolean") {
    return (
      <label className="field-label">
        <span>{input.label}{input.required ? " *" : ""}<code>{input.key}</code></span>
        <select value={value === true ? "true" : "false"} disabled aria-label={`${input.label} selector default`}>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
        {input.description ? <small>{input.description}</small> : null}
      </label>
    );
  }
  const multiline = input.type === "textarea" || input.type === "excel" || input.type === "file";
  return (
    <label className="field-label">
      <span>{input.label}{input.required ? " *" : ""}<code>{input.key}</code></span>
      {multiline ? (
        <textarea rows={3} value={String(value)} readOnly aria-label={`${input.label} selector default`} placeholder={placeholder || "One value per line"} />
      ) : (
        <input type={input.type === "number" ? "number" : "text"} value={String(value)} readOnly aria-label={`${input.label} selector default`} placeholder={placeholder} />
      )}
      {input.description ? <small>{input.description}</small> : null}
    </label>
  );
}

export function FleetLocationPanel({
  phones,
  schedules,
  cycles,
  clientOptions,
  clientFilter,
  onOpenIntegration,
}: {
  phones: CommandPhone[];
  schedules: CommandSchedule[];
  cycles: CommandDeviceCycle[];
  clientOptions: CommandClientOption[];
  clientFilter: string;
  onOpenIntegration: () => void;
}) {
  const filteredCycles = useMemo(() => cycles.filter((cycle) =>
    ["provisioning", "active", "paused", "blocked"].includes(cycle.status)
    && (clientFilter === "All clients" || cycle.clientName === clientFilter),
  ), [clientFilter, cycles]);
  const mapPoints = useMemo<MapPoint[]>(() => {
    const cycleByPhone = new Map(filteredCycles.map((cycle) => [cycle.phoneId, cycle]));
    const clientById = new Map(clientOptions.map((client) => [client.id, client.name]));
    return phones.flatMap((phone) => {
      const cycle = cycleByPhone.get(phone.id);
      const assignedSchedules = schedules.filter((item) =>
        item.phoneId === phone.id || item.device === phone.name,
      );
      const schedule = assignedSchedules[0];
      const scheduleWithLocation = assignedSchedules.find((item) =>
        coordinatePair(item.gpsLatitude, item.gpsLongitude) != null,
      );
      const client = cycle?.clientName
        ?? (phone.clientId ? clientById.get(phone.clientId) : undefined)
        ?? schedule?.client
        ?? "Unassigned";
      if (clientFilter !== "All clients" && client !== clientFilter) return [];
      const phoneCoordinates = coordinatePair(phone.gpsLatitude, phone.gpsLongitude);
      const scheduleCoordinates = coordinatePair(
        scheduleWithLocation?.gpsLatitude,
        scheduleWithLocation?.gpsLongitude,
      );
      const cycleCoordinates = coordinatePair(cycle?.target.latitude, cycle?.target.longitude);
      const resolvedLocation = phoneCoordinates
        ? { ...phoneCoordinates, source: "phone" as const }
        : scheduleCoordinates
          ? { ...scheduleCoordinates, source: "schedule" as const }
          : cycleCoordinates
            ? { ...cycleCoordinates, source: "cycle" as const }
            : null;
      if (!resolvedLocation) return [];
      return [{
        id: phone.id,
        name: phone.name,
        client,
        latitude: resolvedLocation.latitude,
        longitude: resolvedLocation.longitude,
        locationSource: resolvedLocation.source,
        status: phone.status,
        cycleDay: cycle?.currentDay,
        cycleDuration: cycle?.durationDays,
        targetCity: cycle?.target.city,
        proxyMode: cycle?.proxyMode ?? cycle?.proxy?.mode,
        proxyCity: cycle?.proxy?.configuredCity,
        proxyIsp: cycle?.proxy?.configuredIsp,
        proxyHealth: cycle?.proxy?.health,
        proxyDistanceKm: cycle?.proxy?.distanceKm,
        proxyCheckedAt: cycle?.proxy?.checkedAt,
      }];
    });
  }, [clientFilter, clientOptions, filteredCycles, phones, schedules]);
  const mapTargets = useMemo<MapTarget[]>(() => {
    const targets = new Map<string, MapTarget>();
    for (const cycle of filteredCycles) {
      const coordinates = coordinatePair(cycle.target.latitude, cycle.target.longitude);
      if (!coordinates) continue;
      const coordinateKey = `${cycle.clientId}:${coordinates.latitude}:${coordinates.longitude}`;
      if (targets.has(coordinateKey)) continue;
      targets.set(coordinateKey, {
        id: `cycle-${coordinateKey}`,
        name: cycle.clientName,
        ...coordinates,
      });
    }
    for (const schedule of schedules) {
      if (clientFilter !== "All clients" && schedule.client !== clientFilter) continue;
      const coordinates = coordinatePair(schedule.gpsLatitude, schedule.gpsLongitude);
      if (!coordinates) continue;
      const coordinateKey = `${schedule.client}:${coordinates.latitude}:${coordinates.longitude}`;
      if (targets.has(coordinateKey)) continue;
      targets.set(coordinateKey, {
        id: `schedule-${schedule.id}`,
        name: schedule.client,
        ...coordinates,
      });
    }
    return Array.from(targets.values());
  }, [clientFilter, filteredCycles, schedules]);

  return (
    <section className="command-panel location-panel" aria-label="Device location map">
      <div className="command-panel-heading location-heading">
        <div><h2>Device locations</h2><span>{mapPoints.length} devices · {mapTargets.length} targets · {clientFilter}</span></div>
        <div className="map-legend" aria-label="Map legend"><span><i className="legend-business" />Target</span><span><i className="legend-device" />Devices</span><span><i className="legend-proxy" />Proxy external</span></div>
      </div>
      <DeviceLocationMap points={mapPoints} targets={mapTargets} onSetDeviceLocations={onOpenIntegration} />
    </section>
  );
}

function DeviceLocationMap({
  points,
  targets,
  onSetDeviceLocations,
}: {
  points: MapPoint[];
  targets: MapTarget[];
  onSetDeviceLocations: () => void;
}) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const [mapSize, setMapSize] = useState({ width: 640, height: 360 });
  const allCoordinates = [...points, ...targets];
  const fittedZoom = mapZoomFor(allCoordinates, mapSize.width, mapSize.height);
  const coordinateKey = [
    ...points.map((point) => `device:${point.id}:${point.latitude}:${point.longitude}`),
    ...targets.map((target) => `target:${target.id}:${target.latitude}:${target.longitude}`),
  ].sort().join("|") + `@${mapSize.width}x${mapSize.height}`;
  const [zoomState, setZoomState] = useState(() => ({ coordinateKey, value: fittedZoom }));
  const zoom = zoomState.coordinateKey === coordinateKey ? zoomState.value : fittedZoom;
  const [selectedPoint, setSelectedPoint] = useState<string | null>(points[0]?.id ?? null);
  const previousPointIds = useRef("");
  const pointIdsKey = points.map((point) => point.id).sort().join("|");
  const tileRenderKey = `${coordinateKey}@${zoom}`;
  const [tileLoadState, setTileLoadState] = useState<{
    key: string;
    loaded: Set<string>;
    failed: Set<string>;
  }>(() => ({ key: tileRenderKey, loaded: new Set(), failed: new Set() }));

  useEffect(() => {
    const element = mapElementRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setMapSize((current) => current.width === width && current.height === height
        ? current : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [coordinateKey]);

  useEffect(() => {
    setSelectedPoint((current) => {
      if (current && points.some((point) => point.id === current)) return current;
      if (current == null && previousPointIds.current) return null;
      return points[0]?.id ?? null;
    });
    previousPointIds.current = pointIdsKey;
  }, [pointIdsKey, points]);

  if (allCoordinates.length === 0) {
    return (
      <div className="map-empty">
        <MapPin size={22} />
        <strong>No device coordinates yet</strong>
        <span>Add latitude and longitude in DuoPlus setup, or launch a cycle with a target location.</span>
        <button type="button" onClick={onSetDeviceLocations}>Set device locations</button>
      </div>
    );
  }

  const projected = allCoordinates.map((point) => mercatorPoint(point.latitude, point.longitude, zoom));
  const center = {
    x: (Math.min(...projected.map((point) => point.x)) + Math.max(...projected.map((point) => point.x))) / 2,
    y: (Math.min(...projected.map((point) => point.y)) + Math.max(...projected.map((point) => point.y))) / 2,
  };
  const scaleTiles = 2 ** zoom;
  const centerTileX = Math.floor(center.x / 256);
  const centerTileY = Math.floor(center.y / 256);
  const tileRadiusX = Math.ceil(mapSize.width / 512);
  const tileRadiusY = Math.ceil(mapSize.height / 512);
  const tileOffsetsX = Array.from({ length: tileRadiusX * 2 + 1 }, (_, index) => index - tileRadiusX);
  const tileOffsetsY = Array.from({ length: tileRadiusY * 2 + 1 }, (_, index) => index - tileRadiusY);
  const tiles = tileOffsetsX.flatMap((offsetX) =>
    tileOffsetsY.map((offsetY) => {
      const rawX = centerTileX + offsetX;
      const rawY = centerTileY + offsetY;
      const tileX = ((rawX % scaleTiles) + scaleTiles) % scaleTiles;
      const tileY = Math.max(0, Math.min(scaleTiles - 1, rawY));
      return {
        key: `${tileRenderKey}:${rawX}-${rawY}`,
        x: centerTileX + offsetX,
        y: centerTileY + offsetY,
        url: `https://tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png`,
      };
    }),
  );
  const loadedTiles = tileLoadState.key === tileRenderKey ? tileLoadState.loaded : new Set<string>();
  const failedTiles = tileLoadState.key === tileRenderKey ? tileLoadState.failed : new Set<string>();
  const allTilesFailed = tiles.length > 0 && failedTiles.size === tiles.length && loadedTiles.size === 0;
  const activePoint = selectedPoint
    ? points.find((point) => point.id === selectedPoint) ?? null
    : null;

  function updateTileState(tileKey: string, status: "loaded" | "failed") {
    setTileLoadState((current) => {
      const loaded = current.key === tileRenderKey ? new Set(current.loaded) : new Set<string>();
      const failed = current.key === tileRenderKey ? new Set(current.failed) : new Set<string>();
      if (status === "loaded") {
        loaded.add(tileKey);
        failed.delete(tileKey);
      } else {
        failed.add(tileKey);
        loaded.delete(tileKey);
      }
      return { key: tileRenderKey, loaded, failed };
    });
  }

  return (
    <div ref={mapElementRef} className="device-map" role="region" aria-label={`Map showing ${points.length} DuoPlus device locations and ${targets.length} targets`}>
      <div className="map-tiles" aria-hidden="true">
        {tiles.map((tile) => (
          // OpenStreetMap serves raster tiles; Next Image optimization is not appropriate for dynamic tile coordinates.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="map-tile"
            key={tile.key}
            alt=""
            src={tile.url}
            style={{
              left: `calc(50% + ${tile.x * 256 - center.x}px)`,
              top: `calc(50% + ${tile.y * 256 - center.y}px)`,
            }}
            onLoad={() => updateTileState(tile.key, "loaded")}
            onError={() => updateTileState(tile.key, "failed")}
          />
        ))}
      </div>
      {loadedTiles.size === 0 ? (
        <div className={`map-tile-status${allTilesFailed ? " is-error" : ""}`} role="status">
          {allTilesFailed ? "Map tiles unavailable — location pins are still accurate" : "Loading map…"}
        </div>
      ) : null}
      {targets.map((target) => {
        const world = mercatorPoint(target.latitude, target.longitude, zoom);
        return (
          <span
            className="map-pin map-business-pin"
            key={target.id}
            style={{
              left: `calc(50% + ${world.x - center.x}px)`,
              top: `calc(50% + ${world.y - center.y}px)`,
            }}
            aria-label={`${target.name} target location`}
            title={`${target.name} target location`}
          >
            <MapPin size={25} />
          </span>
        );
      })}
      {points.map((point, pointIndex) => {
        const world = mercatorPoint(point.latitude, point.longitude, zoom);
        const markerOffset = mapMarkerOffset(point, pointIndex, points, targets);
        const selected = point.id === selectedPoint;
        const externalProxy = usesExternalDeviceProxy(point);
        const proxyTone = externalProxy ? "gray" : proxyHealthTone(point.proxyHealth);
        const proxyLabel = externalProxy ? "existing device proxy, externally managed" : proxyHealthLabel(point.proxyHealth);
        return (
          <button
            className={`map-pin map-device-pin proxy-${proxyTone} ${selected ? "is-selected" : ""} ${point.status === 1 ? "is-online" : "is-offline"}`}
            key={point.id}
            type="button"
            style={{
              left: `calc(50% + ${world.x - center.x}px)`,
              top: `calc(50% + ${world.y - center.y}px)`,
              "--map-pin-offset-x": `${markerOffset.x}px`,
              "--map-pin-offset-y": `${markerOffset.y}px`,
            } as React.CSSProperties}
            onClick={() => setSelectedPoint((current) => current === point.id ? null : point.id)}
            aria-label={`${point.name}, ${point.client}, ${point.status === 1 ? "online" : "offline"}, ${proxyLabel}`}
          >
            <Smartphone size={13} />
          </button>
        );
      })}
      {activePoint ? (
        <div className="map-popover">
          <button className="map-popover-close" type="button" onClick={() => setSelectedPoint(null)} aria-label="Close device details"><X size={12} /></button>
          <div className="map-popover-statuses">
            <span className={activePoint.status === 1 ? "map-status-online" : "map-status-offline"}><i />{activePoint.status === 1 ? "Online" : "Offline"}</span>
            <span className={`proxy-status proxy-status-${usesExternalDeviceProxy(activePoint) ? "gray" : proxyHealthTone(activePoint.proxyHealth)}`}><i />{usesExternalDeviceProxy(activePoint) ? "Existing device proxy" : proxyHealthLabel(activePoint.proxyHealth)}</span>
          </div>
          <strong>{activePoint.name}</strong>
          <small>{activePoint.client}</small>
          {activePoint.cycleDay ? <small>Cycle day {activePoint.cycleDay} / {activePoint.cycleDuration}</small> : null}
          <dl className="map-proxy-details">
            <div>
              <dt>{activePoint.locationSource === "cycle" ? "Target" : "Location"}</dt>
              <dd>{activePoint.locationSource === "cycle" && activePoint.targetCity
                ? activePoint.targetCity
                : `${activePoint.latitude.toFixed(4)}, ${activePoint.longitude.toFixed(4)}`}</dd>
            </div>
            {usesExternalDeviceProxy(activePoint) ? (
              <>
                <div><dt>Proxy</dt><dd>Already on device</dd></div>
                <div><dt>Ownership</dt><dd>External</dd></div>
                <div><dt>Inspection</dt><dd>Not performed</dd></div>
              </>
            ) : (
              <>
                <div><dt>Proxy</dt><dd>{activePoint.proxyCity ?? "Not verified"}</dd></div>
                <div><dt>ISP</dt><dd>{activePoint.proxyIsp ?? "—"}</dd></div>
                <div><dt>Distance</dt><dd>{activePoint.proxyDistanceKm == null ? "—" : `${activePoint.proxyDistanceKm.toFixed(1)} km`}</dd></div>
              </>
            )}
          </dl>
          <code>{locationSourceLabel(activePoint.locationSource)} · {activePoint.latitude.toFixed(4)}, {activePoint.longitude.toFixed(4)}</code>
          {!usesExternalDeviceProxy(activePoint) && activePoint.proxyCheckedAt ? <small>Checked {readableTime(activePoint.proxyCheckedAt)}</small> : null}
        </div>
      ) : null}
      <div className="map-controls" aria-label="Map zoom controls">
        <button type="button" onClick={() => setZoomState({ coordinateKey, value: fittedZoom })} aria-label="Fit all devices"><RefreshCw size={15} /></button>
        <button type="button" onClick={() => setZoomState({ coordinateKey, value: Math.min(17, zoom + 1) })} aria-label="Zoom in"><ZoomIn size={15} /></button>
        <button type="button" onClick={() => setZoomState({ coordinateKey, value: Math.max(1, zoom - 1) })} aria-label="Zoom out"><ZoomOut size={15} /></button>
      </div>
      <a className="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
    </div>
  );
}

function CommandMetric({ label, value, caption, tone, active, onClick }: { label: string; value: string; caption: string; tone?: "amber"; active: boolean; onClick: () => void }) {
  return (
    <button className={`command-metric ${active ? "is-active" : ""}`} type="button" onClick={onClick} aria-pressed={active}>
      <span>{label}</span><strong className={tone === "amber" ? "metric-amber" : ""}>{value}</strong><small>{caption}</small>
    </button>
  );
}

function OperationRows({ operation, selected, runPending, runBlocked, onSelect, onView, onRun }: { operation: Operation; selected: boolean; runPending: boolean; runBlocked: boolean; onSelect: () => void; onView: () => void; onRun: () => void }) {
  const steps = [
    { label: "Powering on", done: operation.progress >= 20 },
    { label: "Preparing location", done: operation.progress >= 38 },
    { label: "Running search", done: operation.progress >= 66 },
    { label: "Collecting proof", done: operation.progress >= 86 },
  ];
  const allComplete = operation.run?.status === "succeeded";
  const waitingToStart = Boolean(
    operation.run &&
    ["pending", "queued", "retry_wait", "paused"].includes(operation.run.status),
  );
  const firstPendingIndex = steps.findIndex((step) => !step.done);
  const activeIndex = firstPendingIndex === -1 ? steps.length : firstPendingIndex;
  const timingLabel = operation.sample
    ? `Started ${readableTime(operation.run?.startedAt, "9:14 AM")}`
    : operation.run?.startedAt
      ? `Started ${readableTime(operation.run.startedAt)}`
      : operation.run
        ? `Scheduled ${readableTime(operation.run.issueAt)}`
        : "No run attempt";
  return (
    <>
      <tr className={`command-operation-row ${selected ? "is-selected" : ""}`}>
        <td><button className="operation-client" type="button" onClick={onSelect} aria-expanded={selected}>{operation.schedule.client}</button></td>
        <td title={operation.schedule.keyword}>{operation.schedule.keyword}</td>
        <td>{operation.schedule.device}</td>
        <td><span className={`operation-stage stage-${operation.tone}`}><i />{operation.stage}</span></td>
        <td><span className={`operation-progress progress-${operation.tone}`}><i style={{ width: `${operation.progress}%` }} /></span></td>
        <td className="operation-elapsed">{operation.elapsed}</td>
        <td>
          <button className="operation-view" type="button" onClick={onView}>{operation.run ? "View run" : "View schedule"}</button>
          {!operation.run?.deviceCycleId ? (
            <button
              className="operation-more"
              type="button"
              onClick={onRun}
              disabled={runPending || runBlocked}
              aria-label={runPending
                ? `Queueing ${operation.schedule.keyword}`
                : runBlocked
                  ? `${operation.schedule.keyword} already has an unfinished run`
                  : `Run ${operation.schedule.keyword} now`}
              title={runPending
                ? "Queueing run"
                : runBlocked
                  ? "Wait for the current run to finish"
                  : "Run now"}
            >
              {runPending ? <RefreshCw size={16} className="spin" /> : <MoreHorizontal size={16} />}
            </button>
          ) : null}
        </td>
      </tr>
      {selected && (operation.sample || operation.run) ? (
        <tr className="command-operation-detail"><td colSpan={7}>
          <div className="command-attempt-heading"><strong>{operation.sample ? "Sample run" : "Run attempt"} — {operation.schedule.client} — {operation.schedule.keyword}</strong><span>{timingLabel}</span></div>
          <div className="command-run-timeline">
            {steps.map((step, index) => {
              const complete = allComplete || (step.done && index < activeIndex);
              const active = !allComplete && !waitingToStart && index === activeIndex;
              return <div className={`command-run-step ${complete ? "is-complete" : active ? "is-active" : ""}`} key={step.label}><span className="command-run-marker">{complete ? <Check size={12} /> : null}</span>{index < steps.length - 1 ? <span className="command-run-line" /> : null}<strong>{step.label}</strong><small>{complete ? "Complete" : active ? "In progress" : "Waiting"}</small></div>;
            })}
          </div>
        </td></tr>
      ) : null}
    </>
  );
}

function CapacityStat({ label, value, tone }: { label: string; value: number; tone: "green" | "blue" | "gray" }) {
  return <div className="capacity-stat"><span className={`capacity-dot dot-${tone}`} /> <small>{label}</small><strong>{value}</strong></div>;
}

function CommandDevice({ device, index, sample, assignment }: { device: DeviceDisplay; index: number; sample: boolean; assignment?: string }) {
  const online = device.status.toLowerCase() === "online";
  const busy = device.detail.toLowerCase().includes("busy");
  const sampleAssignment = ["Riverside Injury Law", "Metro Plumbing Co.", "Summit Roofing"][index % 3];
  const detail = busy
    ? device.detail.replace("Busy until", "Next:")
    : sample && online
      ? sampleAssignment
      : assignment ?? (online ? device.detail || "Idle" : "No assignment");
  return <article className="command-device"><Smartphone size={16} /><div><strong>{device.name}</strong><span className={online ? busy ? "device-busy" : "device-online" : "device-offline"}><i />{online ? busy ? "Busy" : "Online" : "Offline"}</span><small>{detail}</small></div></article>;
}
