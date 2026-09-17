"use client";

import {
  Activity,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Cloud,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  Globe2,
  Home,
  KeyRound,
  LogOut,
  MapPin,
  Menu,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  Settings,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { CronExpressionParser } from "cron-parser";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CommandCenter,
  type CommandDeviceCycle,
  type CommandRun,
  type CommandProfileReadiness,
  type CommandProfileSummary,
  type CommandProxySummary,
  type CreateCycleProgramInput,
  type CycleProgramOption,
  type DeviceCycleOperatingStatus,
  type LaunchCycleInput,
} from "@/components/command-center";
import { isDuoPlusEvidenceAction } from "@/lib/duoplus/action-types";
import { isSchedulablePhone } from "@/lib/duoplus/phone-eligibility";
import { sanitizeDuoPlusTaskConfig } from "@/lib/duoplus/task-config";
import {
  defaultTaskConfigForSchema,
  extractDuoPlusTemplateConfigSchema,
  normalizeDuoPlusTemplateName,
  resolvedTemplateConfigSchema,
  type DuoPlusTemplateConfigSchema,
  type DuoPlusTemplateInput,
} from "@/lib/duoplus/template-schema";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/config";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type ScheduleStatus = "Running" | "Scheduled" | "Paused" | "Needs attention" | "Queued";
type Cadence = "Daily" | "Weekly" | "Monthly" | "Custom";
type PrimaryView = "command" | "schedules";

type Schedule = {
  id: string;
  clientId?: string;
  phoneId?: string | null;
  templateId?: string;
  title: string;
  keyword: string;
  client: string;
  device: string;
  template: string;
  cadence: Cadence;
  cronExpression?: string;
  nextRun: string;
  lastRun: string;
  status: ScheduleStatus;
  runTime: string;
  timezone: string;
  duration: string;
  retryPolicy: string;
  config?: Record<string, unknown>;
  gpsMode?: "unchanged" | "proxy" | "coordinates";
  gpsLatitude?: string;
  gpsLongitude?: string;
  localeTimezone?: string;
  localeLanguage?: string;
  latestRun?: ApiRun;
};

type DraftSchedule = Pick<
  Schedule,
  "client" | "keyword" | "cadence" | "runTime" | "timezone" | "duration" | "retryPolicy"
> & {
  /** Internal duo_templates.id, not a display name or DuoPlus template id. */
  templateId: string;
  device: string;
  customCron: string;
  weeklyDay: string;
  monthlyDay: string;
  configJson: string;
  gpsMode: "unchanged" | "proxy" | "coordinates";
  gpsLatitude: string;
  gpsLongitude: string;
  localeTimezone: string;
  localeLanguage: string;
};

type Integration = {
  connected: boolean;
  keyHint?: string;
  verifiedAt?: string;
  inventorySyncedAt?: string;
  subscriptionCapacity?: number | null;
  subscriptionInUse?: number | null;
  subscriptionAvailable?: number | null;
  subscriptionSyncedAt?: string | null;
  workerCapacityLimit?: number | null;
  activeWorkerCount?: number | null;
  availableWorkerSlots?: number | null;
  providerSubscriptionCapacity?: number | null;
  providerSubscriptionInUse?: number | null;
  providerSubscriptionAvailable?: number | null;
};

type InventorySyncSummary = {
  phoneCount: number;
  templateCount: number;
  customTemplateCount: number;
  officialTemplateCount: number;
  subscriptionCapacity: number | null;
  subscriptionInUse: number | null;
  subscriptionAvailable: number | null;
  syncedAt?: string | null;
};

type TemplateSchemaImportSummary = {
  updated: Array<{ id: string; name: string; inputCount: number }>;
  unmatched: string[];
};

type ClientRecord = { id: string; name: string };
type PhoneRecord = {
  id: string;
  connectionId?: string;
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
};
type TemplateRecord = {
  /** Internal duo_templates.id used by schedules and program rules. */
  id: string;
  /** Remote DuoPlus template id; metadata only. */
  duoplusTemplateId?: string;
  templateType: 1 | 2;
  templateSource?: "official" | "custom";
  name: string;
  description?: string | null;
  configSchema?: DuoPlusTemplateConfigSchema | null;
  enabled: boolean;
};

type ApiSchedule = {
  id: string;
  clientId: string;
  clientName: string | null;
  phoneId: string | null;
  phoneName: string | null;
  templateId: string;
  templateName: string | null;
  name: string;
  keyword: string;
  config?: Record<string, unknown>;
  cronExpression: string;
  timezone: string;
  nextRunAt: string;
  lastEnqueuedAt: string | null;
  enabled: boolean;
  maxAttempts: number;
  expectedDurationSeconds: number;
  gpsLatitude?: number | null;
  gpsLongitude?: number | null;
  gpsMode?: number;
  localeTimezone?: string | null;
  localeLanguage?: string | null;
};

type ApiRun = {
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
  scheduledFor?: string;
  status: "pending" | "preparing" | "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled" | "retry_wait";
  stage: string;
  issueAt: string;
  expectedDurationSeconds?: number;
  windowStartAt?: string | null;
  windowEndAt?: string | null;
  deviceCycleId?: string | null;
  cycleDay?: number | null;
  attemptCount?: number;
  maxAttempts?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastError?: string | null;
  log?: unknown;
  screenshots?: unknown[];
  createdAt?: string;
};

const OPEN_RUN_STATUSES: ReadonlySet<ApiRun["status"]> = new Set([
  "pending",
  "preparing",
  "queued",
  "running",
  "paused",
  "retry_wait",
]);

function runIsOpen(run: ApiRun | undefined) {
  return Boolean(run && OPEN_RUN_STATUSES.has(run.status));
}

const DEMO_MODE =
  process.env.NEXT_PUBLIC_DEMO_MODE === "true" &&
  !hasSupabaseBrowserConfig();

const INITIAL_SCHEDULES: Schedule[] = [
  {
    id: "sch_01",
    title: "Car accident lawyer — downtown",
    keyword: "car accident lawyer",
    client: "Riverside Injury Law",
    device: "DuoPlus-03",
    template: "Local Search — Standard",
    cadence: "Daily",
    nextRun: "in 12 min",
    lastRun: "2 hours ago",
    status: "Running",
    runTime: "9:00 AM",
    timezone: "America/New_York",
    duration: "25 minutes",
    retryPolicy: "Retry up to 2 times",
  },
  {
    id: "sch_02",
    title: "Emergency plumber — near me",
    keyword: "emergency plumber",
    client: "Metro Plumbing Co.",
    device: "DuoPlus-07",
    template: "Local Search — Standard",
    cadence: "Daily",
    nextRun: "in 28 min",
    lastRun: "5 hours ago",
    status: "Scheduled",
    runTime: "9:30 AM",
    timezone: "America/New_York",
    duration: "20 minutes",
    retryPolicy: "Retry up to 2 times",
  },
  {
    id: "sch_03",
    title: "Roof repair near me",
    keyword: "roof repair near me",
    client: "Summit Roofing",
    device: "DuoPlus-12",
    template: "Local Search — Standard",
    cadence: "Daily",
    nextRun: "in 43 min",
    lastRun: "6 hours ago",
    status: "Scheduled",
    runTime: "10:00 AM",
    timezone: "America/New_York",
    duration: "25 minutes",
    retryPolicy: "Retry up to 2 times",
  },
  {
    id: "sch_04",
    title: "Personal injury lawyer",
    keyword: "personal injury lawyer",
    client: "Harrison & Cole",
    device: "DuoPlus-05",
    template: "Local Search — Deep Scan",
    cadence: "Weekly",
    nextRun: "in 2 hours",
    lastRun: "1 day ago",
    status: "Paused",
    runTime: "11:00 AM",
    timezone: "America/New_York",
    duration: "35 minutes",
    retryPolicy: "Retry up to 3 times",
  },
  {
    id: "sch_05",
    title: "Slip and fall lawyer",
    keyword: "slip and fall lawyer",
    client: "Riverside Injury Law",
    device: "DuoPlus-08",
    template: "Local Search — Standard",
    cadence: "Daily",
    nextRun: "in 3 hours",
    lastRun: "23 hours ago",
    status: "Scheduled",
    runTime: "12:00 PM",
    timezone: "America/New_York",
    duration: "25 minutes",
    retryPolicy: "Retry up to 2 times",
  },
  {
    id: "sch_06",
    title: "Emergency HVAC repair",
    keyword: "emergency HVAC repair",
    client: "CoolBreeze HVAC",
    device: "DuoPlus-11",
    template: "Local Search — Standard",
    cadence: "Daily",
    nextRun: "in 4 hours",
    lastRun: "1 day ago",
    status: "Needs attention",
    runTime: "1:00 PM",
    timezone: "America/New_York",
    duration: "25 minutes",
    retryPolicy: "Retry up to 2 times",
  },
  {
    id: "sch_07",
    title: "Plumber near me",
    keyword: "plumber near me",
    client: "Metro Plumbing Co.",
    device: "DuoPlus-02",
    template: "Local Search — Standard",
    cadence: "Daily",
    nextRun: "in 5 hours",
    lastRun: "1 day ago",
    status: "Scheduled",
    runTime: "2:00 PM",
    timezone: "America/New_York",
    duration: "20 minutes",
    retryPolicy: "Retry up to 2 times",
  },
  {
    id: "sch_08",
    title: "Roofing contractor",
    keyword: "roofing contractor",
    client: "Summit Roofing",
    device: "DuoPlus-09",
    template: "Local Search — Deep Scan",
    cadence: "Weekly",
    nextRun: "in 7 hours",
    lastRun: "2 days ago",
    status: "Paused",
    runTime: "3:00 PM",
    timezone: "America/New_York",
    duration: "35 minutes",
    retryPolicy: "Retry up to 3 times",
  },
  {
    id: "sch_09",
    title: "Workers comp lawyer",
    keyword: "workers comp lawyer",
    client: "Harrison & Cole",
    device: "DuoPlus-10",
    template: "Local Search — Standard",
    cadence: "Daily",
    nextRun: "in 8 hours",
    lastRun: "1 day ago",
    status: "Scheduled",
    runTime: "4:00 PM",
    timezone: "America/New_York",
    duration: "25 minutes",
    retryPolicy: "Retry up to 2 times",
  },
  {
    id: "sch_10",
    title: "Water heater repair",
    keyword: "water heater repair",
    client: "Lakeview Home Services",
    device: "DuoPlus-04",
    template: "Local Search — Standard",
    cadence: "Daily",
    nextRun: "in 9 hours",
    lastRun: "1 day ago",
    status: "Scheduled",
    runTime: "5:00 PM",
    timezone: "America/New_York",
    duration: "20 minutes",
    retryPolicy: "Retry up to 2 times",
  },
];

const DEVICES = [
  { name: "DuoPlus-01", status: "Online", detail: "Idle" },
  { name: "DuoPlus-02", status: "Online", detail: "Busy until 11:32 AM" },
  { name: "DuoPlus-03", status: "Online", detail: "Busy until 10:42 AM" },
  { name: "DuoPlus-04", status: "Online", detail: "Idle" },
  { name: "DuoPlus-05", status: "Offline", detail: "—" },
  { name: "DuoPlus-07", status: "Online", detail: "Busy until 11:15 AM" },
];

const CLIENTS = [
  "Metro Plumbing Co.",
  "Riverside Injury Law",
  "Summit Roofing",
  "Harrison & Cole",
  "CoolBreeze HVAC",
  "Lakeview Home Services",
];

const DEMO_CLIENT_RECORDS: ClientRecord[] = CLIENTS.map((name, index) => ({ id: `demo-client-${index + 1}`, name }));
const DEMO_PHONE_RECORDS: PhoneRecord[] = DEVICES.map((device, index) => ({
  id: `demo-phone-${index + 1}`,
  clientId: [`demo-client-2`, `demo-client-1`, `demo-client-4`, `demo-client-6`, `demo-client-3`, `demo-client-5`][index] ?? null,
  imageId: `DEMO${String(index + 1).padStart(2, "0")}`,
  name: device.name,
  status: device.status === "Online" ? 1 : 2,
  enabled: true,
  busyUntil: null,
  gpsLatitude: [28.0748, 28.026, 28.008, 28.049, 28.062, 28.019][index],
  gpsLongitude: [-81.956, -81.902, -81.949, -81.884, -81.925, -81.985][index],
}));
const DEMO_TEMPLATE_RECORDS: TemplateRecord[] = [
  { id: "demo-template-standard", templateType: 2, templateSource: "custom", name: "Local Search — Standard", enabled: true },
  { id: "demo-template-deep", templateType: 2, templateSource: "custom", name: "Local Search — Deep Scan", enabled: true },
  { id: "demo-template-maps", templateType: 1, templateSource: "official", name: "Maps — Finder Scan", enabled: true },
];

const DEMO_CYCLE_PROGRAMS: CycleProgramOption[] = [
  { id: "demo-cycle-program-30", name: "30-day local presence", durationDays: 30, timezone: "America/New_York", status: "published", readyDay: 10, readyThresholdPercent: 80, completionThresholdPercent: 90, rules: [] },
  { id: "demo-cycle-program-20", name: "20-day local presence", durationDays: 20, timezone: "America/New_York", status: "published", readyDay: 10, readyThresholdPercent: 80, completionThresholdPercent: 90, rules: [] },
  { id: "demo-cycle-program-15", name: "15-day local presence", durationDays: 15, timezone: "America/New_York", status: "published", readyDay: 10, readyThresholdPercent: 80, completionThresholdPercent: 90, rules: [] },
];

const DEMO_DEVICE_CYCLES: CommandDeviceCycle[] = [
  {
    id: "demo-cycle-1", name: "Riverside September cycle", clientId: "demo-client-2", clientName: "Riverside Injury Law",
    phoneId: "demo-phone-1", phoneName: "DuoPlus-01", programId: "demo-cycle-program-30", programName: "30-day local presence",
    status: "active", startsOn: "2026-08-25", endsOn: "2026-09-23", durationDays: 30, currentDay: 12, keyword: "car accident lawyer", proxyMode: "preconfigured",
    target: { country: "US", region: "Florida", city: "Lakeland", latitude: 28.0395, longitude: -81.9498 },
    runCounts: { total: 159, done: 61, running: 1, failed: 0, pending: 97 },
    proxy: { mode: "preconfigured", configuredCity: null, configuredIsp: null, diversityStatus: "unknown", health: "unverified", checkedAt: null, distanceKm: null },
  },
  {
    id: "demo-cycle-2", name: "Metro September cycle", clientId: "demo-client-1", clientName: "Metro Plumbing Co.",
    phoneId: "demo-phone-2", phoneName: "DuoPlus-02", programId: "demo-cycle-program-30", programName: "30-day local presence",
    status: "active", startsOn: "2026-08-27", endsOn: "2026-09-25", durationDays: 30, currentDay: 10, keyword: "emergency plumber", proxyMode: "preconfigured",
    target: { country: "US", region: "Florida", city: "Lakeland", latitude: 28.044, longitude: -81.953 },
    runCounts: { total: 159, done: 50, running: 1, failed: 0, pending: 108 },
    proxy: { mode: "preconfigured", configuredCity: null, configuredIsp: null, diversityStatus: "unknown", health: "unverified", checkedAt: null, distanceKm: null },
  },
  {
    id: "demo-cycle-3", name: "Summit August cycle", clientId: "demo-client-3", clientName: "Summit Roofing",
    phoneId: "demo-phone-5", phoneName: "DuoPlus-05", programId: "demo-cycle-program-30", programName: "30-day local presence",
    status: "completed", startsOn: "2026-08-08", endsOn: "2026-09-06", durationDays: 30, currentDay: 30, keyword: "roof repair near me", proxyMode: "preconfigured",
    target: { country: "US", region: "Florida", city: "Lakeland", latitude: 28.026, longitude: -81.902 },
    runCounts: { total: 159, done: 158, running: 0, failed: 1, pending: 0 },
    proxy: { mode: "preconfigured", configuredCity: null, configuredIsp: null, diversityStatus: "unknown", health: "unverified", checkedAt: null, distanceKm: null },
  },
  {
    id: "demo-cycle-4", name: "Harrison profile cycle", clientId: "demo-client-4", clientName: "Harrison & Cole",
    phoneId: "demo-phone-3", phoneName: "DuoPlus-03", programId: "demo-cycle-program-15", programName: "15-day local presence",
    status: "blocked", startsOn: "2026-08-26", endsOn: "2026-09-09", durationDays: 15, currentDay: 11, keyword: "personal injury lawyer", proxyMode: "preconfigured",
    target: { country: "US", region: "Florida", city: "Lakeland", latitude: 28.008, longitude: -81.949 },
    runCounts: { total: 84, done: 58, running: 0, failed: 2, pending: 24 },
    proxy: { mode: "preconfigured", configuredCity: null, configuredIsp: null, diversityStatus: "unknown", health: "unverified", checkedAt: null, distanceKm: null },
  },
];

const DEMO_PROFILE_READINESS: CommandProfileReadiness[] = [
  {
    id: "demo-profile-1", label: "riverside.profile.01", clientId: "demo-client-2", clientName: "Riverside Injury Law",
    phoneId: "demo-phone-1", phoneName: "DuoPlus-01", cycleId: "demo-cycle-1", cycleName: "Riverside September cycle",
    programId: "demo-cycle-program-30", programName: "30-day local presence", state: "ready", currentDay: 12, durationDays: 30,
    score: 342, readyScore: 237, completionScore: 795, possibleScore: 883, successfulDays: 12,
    appScores: [{ app: "Chrome", score: 120, possible: 320 }, { app: "Discover", score: 165, possible: 427 }, { app: "Maps", score: 57, possible: 136 }],
    lastSuccessAt: "2026-09-05T14:18:00.000Z", statusReason: "Ready gate reached · daily cycle continues",
  },
  {
    id: "demo-profile-2", label: "metro.profile.03", clientId: "demo-client-1", clientName: "Metro Plumbing Co.",
    phoneId: "demo-phone-2", phoneName: "DuoPlus-02", cycleId: "demo-cycle-2", cycleName: "Metro September cycle",
    programId: "demo-cycle-program-30", programName: "30-day local presence", state: "warming", currentDay: 10, durationDays: 30,
    score: 224, readyScore: 237, completionScore: 795, possibleScore: 883, successfulDays: 9,
    appScores: [{ app: "Chrome", score: 80, possible: 320 }, { app: "Discover", score: 110, possible: 427 }, { app: "Maps", score: 34, possible: 136 }],
    lastSuccessAt: "2026-09-05T13:41:00.000Z", statusReason: "13 points to Ready · special tasks pending",
  },
  {
    id: "demo-profile-3", label: "summit.profile.02", clientId: "demo-client-3", clientName: "Summit Roofing",
    phoneId: "demo-phone-5", phoneName: "DuoPlus-05", cycleId: "demo-cycle-3", cycleName: "Summit August cycle",
    programId: "demo-cycle-program-30", programName: "30-day local presence", state: "completed", currentDay: 30, durationDays: 30,
    score: 812, readyScore: 237, completionScore: 795, possibleScore: 883, successfulDays: 29,
    appScores: [{ app: "Chrome", score: 300, possible: 320 }, { app: "Discover", score: 390, possible: 427 }, { app: "Maps", score: 122, possible: 136 }],
    lastSuccessAt: "2026-09-05T12:32:00.000Z", statusReason: "Completion gate reached · ready for rollover",
  },
  {
    id: "demo-profile-4", label: "harrison.profile.04", clientId: "demo-client-4", clientName: "Harrison & Cole",
    phoneId: "demo-phone-3", phoneName: "DuoPlus-03", cycleId: "demo-cycle-4", cycleName: "Harrison profile cycle",
    programId: "demo-cycle-program-15", programName: "15-day local presence", state: "needs_attention", currentDay: 11, durationDays: 15,
    score: 246, readyScore: 237, completionScore: 417, possibleScore: 463, successfulDays: 9,
    appScores: [{ app: "Chrome", score: 90, possible: 170 }, { app: "Discover", score: 120, possible: 217 }, { app: "Maps", score: 36, possible: 76 }],
    lastSuccessAt: "2026-09-04T16:08:00.000Z", statusReason: "Two required runs failed · retry queued",
  },
];

const DEMO_PROFILE_SUMMARY: CommandProfileSummary = {
  total: 4,
  new: 0,
  warming: 1,
  ready: 1,
  completed: 1,
  needsAttention: 1,
};

const DEMO_PROXY_SUMMARY: CommandProxySummary = {
  activeBindings: 4,
  aligned: 0,
  needsVerification: 0,
  mismatches: 0,
  uniqueIsps: 0,
  preconfiguredAssignments: 4,
  package: null,
};

const EMPTY_DRAFT: DraftSchedule = {
  client: "Metro Plumbing Co.",
  keyword: "",
  templateId: "demo-template-standard",
  device: "",
  cadence: "Daily",
  runTime: "09:00",
  timezone: "America/New_York",
  duration: "25 minutes",
  retryPolicy: "Retry up to 2 times",
  customCron: "0 9 * * 1-5",
  weeklyDay: "2",
  monthlyDay: "1",
  configJson: "{}",
  gpsMode: "unchanged",
  gpsLatitude: "",
  gpsLongitude: "",
  localeTimezone: "",
  localeLanguage: "",
};

const NAVIGATION: Array<{
  label: string;
  icon: typeof Home;
  enabled: boolean;
  view: PrimaryView | null;
}> = [
  { label: "Command center", icon: Home, enabled: true, view: "command" },
  { label: "Schedules", icon: CalendarDays, enabled: true, view: "schedules" },
  { label: "Runs", icon: Activity, enabled: false, view: null },
  { label: "Devices", icon: Smartphone, enabled: false, view: null },
  { label: "Clients", icon: Users, enabled: false, view: null },
  { label: "Templates", icon: FileCode2, enabled: false, view: null },
  { label: "Settings", icon: Settings, enabled: false, view: null },
];

const STATUS_ORDER: ScheduleStatus[] = ["Running", "Scheduled", "Queued", "Paused", "Needs attention"];

function statusClass(status: ScheduleStatus) {
  return status.toLowerCase().replace(" ", "-");
}

function titleFromKeyword(keyword: string) {
  if (!keyword.trim()) return "Untitled schedule";
  return keyword.trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type ParsedTaskConfig =
  | { config: Record<string, unknown>; error: null }
  | { config: null; error: string };

function parseTaskConfigJson(source: string): ParsedTaskConfig {
  const candidate = source.trim() || "{}";
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return { config: null, error: "Task configuration must be valid JSON." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { config: null, error: "Task configuration must be a JSON object." };
  }
  try {
    return { config: sanitizeDuoPlusTaskConfig(value), error: null };
  } catch (error) {
    return {
      config: null,
      error: error instanceof Error ? error.message : "Task configuration is invalid.",
    };
  }
}

function formatTaskConfig(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function configJsonForTemplate(
  template: TemplateRecord | undefined,
  existing?: Record<string, unknown>,
): string {
  const schema = template
    ? resolvedTemplateConfigSchema(template.name, template.configSchema)
    : null;
  return formatTaskConfig({
    ...(schema ? defaultTaskConfigForSchema(schema) : {}),
    ...(existing ?? {}),
  });
}

function taskConfigEntryValue(
  source: string,
  input: DuoPlusTemplateInput,
): string | boolean {
  const parsed = parseTaskConfigJson(source);
  if (!parsed.config) return input.type === "boolean" ? false : "";
  const candidate = parsed.config[input.key];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return input.type === "boolean" ? false : "";
  }
  const value = (candidate as { value?: unknown }).value;
  if (input.type === "boolean") return value === true || value === "true";
  if (Array.isArray(value)) return value.join("\n");
  return value === undefined || value === null ? "" : String(value);
}

function updateTaskConfigEntry(
  source: string,
  input: DuoPlusTemplateInput,
  rawValue: string | boolean,
): string {
  const parsed = parseTaskConfigJson(source);
  const config = parsed.config ? { ...parsed.config } : {};
  const value = input.type === "file" && typeof rawValue === "string"
    ? rawValue.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    : rawValue;
  config[input.key] = {
    key: input.key,
    value,
    type: input.type,
    required: input.required,
  };
  return formatTaskConfig(config);
}

function missingRequiredTemplateInputs(
  schema: DuoPlusTemplateConfigSchema | null,
  config: Record<string, unknown> | null,
): string[] {
  if (!schema) return [];
  return schema.inputs.filter((input) => {
    if (!input.required) return false;
    const candidate = config?.[input.key];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
    const value = (candidate as { value?: unknown }).value;
    if (Array.isArray(value)) return value.length === 0;
    return value === undefined || value === null || String(value).trim() === "";
  }).map((input) => input.label);
}

function firstTaskInputValue(
  schema: DuoPlusTemplateConfigSchema | null,
  config: Record<string, unknown>,
): string {
  if (!schema) return "";
  for (const input of schema.inputs.filter((candidate) => candidate.role === "operator")) {
    const candidate = config[input.key];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = (candidate as { value?: unknown }).value;
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text === "string" && text.trim()) return text.trim().split(/\r?\n/)[0] ?? "";
  }
  return "";
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: init?.body
      ? { "Content-Type": "application/json", ...init.headers }
      : init?.headers,
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok || body.data === undefined) {
    throw new Error(body.error?.message ?? "The workspace could not be updated.");
  }
  return body.data;
}

function duoPhoneStatusLabel(phone: PhoneRecord): string {
  if (!phone.enabled) return "Unavailable";
  return ({
    0: "Not configured",
    1: "Online",
    2: "Offline",
    3: "Expired",
    4: "Renewal overdue",
    10: "Powering on",
    11: "Configuring",
    12: "Configuration failed",
  } as Record<number, string>)[phone.status] ?? "Status unavailable";
}

function relativeTime(iso: string | null, fallback: string) {
  if (!iso) return fallback;
  const deltaMinutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  const absolute = Math.abs(deltaMinutes);
  if (absolute < 1) return deltaMinutes >= 0 ? "now" : "Just now";
  if (absolute < 60) return deltaMinutes >= 0 ? `in ${absolute} min` : `${absolute} min ago`;
  const hours = Math.round(absolute / 60);
  if (hours < 24) return deltaMinutes >= 0 ? `in ${hours} hours` : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return deltaMinutes >= 0 ? `in ${days} days` : `${days} days ago`;
}

function clockTime(iso: string | null | undefined, fallback: string) {
  if (!iso) return fallback;
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function cadenceFromCron(cron: string): Cadence {
  const fields = cron.trim().split(/\s+/);
  if (fields.length < 5) return "Custom";
  if (/^(?:[1-9]|[12]\d|3[01])$/.test(fields[2]) && fields[4] === "*") return "Monthly";
  if (fields[2] === "*" && fields[4] === "*") return "Daily";
  if (fields[2] === "*" && /^[0-6]$/.test(fields[4])) return "Weekly";
  return "Custom";
}

function timeFromCron(cron: string) {
  const [minute = "0", hour = "9"] = cron.trim().split(/\s+/);
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function statusFromRun(run: ApiRun | undefined, enabled: boolean): ScheduleStatus {
  if (!enabled) return "Paused";
  if (!run) return "Scheduled";
  if (["preparing", "running"].includes(run.status)) return "Running";
  if (["pending", "queued", "retry_wait"].includes(run.status)) return "Queued";
  if (run.status === "failed") return "Needs attention";
  if (run.status === "paused") return "Paused";
  return "Scheduled";
}

function mapApiSchedule(apiSchedule: ApiSchedule, fallback?: Partial<Schedule>, latestRun?: ApiRun): Schedule {
  const cadence = cadenceFromCron(apiSchedule.cronExpression);
  return {
    id: apiSchedule.id,
    clientId: apiSchedule.clientId,
    phoneId: apiSchedule.phoneId,
    templateId: apiSchedule.templateId,
    title: apiSchedule.name || fallback?.title || titleFromKeyword(apiSchedule.keyword),
    keyword: apiSchedule.keyword,
    client: apiSchedule.clientName || fallback?.client || "Unassigned client",
    device: apiSchedule.phoneName || fallback?.device || "Auto-assign",
    template: apiSchedule.templateName || fallback?.template || "Synced template",
    cadence,
    cronExpression: apiSchedule.cronExpression,
    nextRun: relativeTime(apiSchedule.nextRunAt, "Not scheduled"),
    lastRun: relativeTime(latestRun?.finishedAt ?? latestRun?.startedAt ?? apiSchedule.lastEnqueuedAt, "Never"),
    status: statusFromRun(latestRun, apiSchedule.enabled),
    runTime: timeFromCron(apiSchedule.cronExpression),
    timezone: apiSchedule.timezone,
    duration: `${Math.round(apiSchedule.expectedDurationSeconds / 60)} minutes`,
    retryPolicy:
      apiSchedule.maxAttempts <= 1
        ? "Do not retry"
        : `Retry up to ${apiSchedule.maxAttempts - 1} times`,
    config: apiSchedule.config ?? fallback?.config ?? {},
    gpsMode: apiSchedule.gpsMode === 2 ? "coordinates" : apiSchedule.gpsMode === 1 ? "proxy" : "unchanged",
    gpsLatitude: apiSchedule.gpsLatitude == null ? "" : String(apiSchedule.gpsLatitude),
    gpsLongitude: apiSchedule.gpsLongitude == null ? "" : String(apiSchedule.gpsLongitude),
    localeTimezone: apiSchedule.localeTimezone ?? "",
    localeLanguage: apiSchedule.localeLanguage ?? "",
    latestRun,
  };
}

function cronFromDraft(draft: DraftSchedule) {
  if (draft.cadence === "Custom") return draft.customCron.trim() || "0 9 * * 1-5";
  const [hour, minute] = normalizeInputTime(draft.runTime).split(":");
  if (draft.cadence === "Monthly") {
    return `${Number(minute)} ${Number(hour)} ${draft.monthlyDay} * *`;
  }
  const dayOfWeek = draft.cadence === "Weekly" ? draft.weeklyDay : "*";
  return `${Number(minute)} ${Number(hour)} * * ${dayOfWeek}`;
}

function upcomingRuns(draft: DraftSchedule, anchor: string) {
  try {
    const expression = CronExpressionParser.parse(cronFromDraft(draft), {
      currentDate: new Date(anchor),
      tz: draft.timezone,
    });
    return Array.from({ length: 3 }, () => {
      const next = expression.next().toDate();
      return {
        iso: next.toISOString(),
        date: new Intl.DateTimeFormat("en-US", {
          timeZone: draft.timezone,
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(next),
        time: new Intl.DateTimeFormat("en-US", {
          timeZone: draft.timezone,
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(next),
      };
    });
  } catch {
    return [];
  }
}

function durationSeconds(value: string) {
  return (Number.parseInt(value, 10) || 25) * 60;
}

function maxAttempts(value: string) {
  const retries = Number.parseInt(value.match(/\d+/)?.[0] ?? "0", 10);
  return Math.max(1, retries + 1);
}

function normalizeInputTime(value: string) {
  if (/^\d{2}:\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return "09:00";
  let hour = Number(match[1]);
  if (match[3].toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (match[3].toUpperCase() === "AM" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

export function OperationsDashboard({ initialNow, systemReady }: { initialNow: string; systemReady: boolean }) {
  const router = useRouter();
  const [activeView, setActiveView] = useState<PrimaryView>("command");
  const [schedules, setSchedules] = useState<Schedule[]>(() => (DEMO_MODE ? INITIAL_SCHEDULES : []));
  const [clientRecords, setClientRecords] = useState<ClientRecord[]>(() => (DEMO_MODE ? DEMO_CLIENT_RECORDS : []));
  const [phones, setPhones] = useState<PhoneRecord[]>(() => (DEMO_MODE ? DEMO_PHONE_RECORDS : []));
  const [templates, setTemplates] = useState<TemplateRecord[]>(() => (DEMO_MODE ? DEMO_TEMPLATE_RECORDS : []));
  const [recentRuns, setRecentRuns] = useState<ApiRun[]>([]);
  const [selectedRunDetail, setSelectedRunDetail] = useState<CommandRun | null>(null);
  const [deviceCycles, setDeviceCycles] = useState<CommandDeviceCycle[]>(() => (DEMO_MODE ? DEMO_DEVICE_CYCLES : []));
  const [profileReadiness, setProfileReadiness] = useState<CommandProfileReadiness[]>(() => (DEMO_MODE ? DEMO_PROFILE_READINESS : []));
  const [profileSummary, setProfileSummary] = useState<CommandProfileSummary>(() => (DEMO_MODE ? DEMO_PROFILE_SUMMARY : { total: 0, new: 0, warming: 0, ready: 0, completed: 0, needsAttention: 0 }));
  const [cyclePrograms, setCyclePrograms] = useState<CycleProgramOption[]>(() => (DEMO_MODE ? DEMO_CYCLE_PROGRAMS : []));
  const [proxySummary, setProxySummary] = useState<CommandProxySummary | null>(() => (DEMO_MODE ? DEMO_PROXY_SUMMARY : null));
  const [dashboardLoading, setDashboardLoading] = useState(!DEMO_MODE);
  const [dashboardError, setDashboardError] = useState("");
  const [query, setQuery] = useState("");
  const [clientFilter, setClientFilter] = useState("All clients");
  const [statusFilter, setStatusFilter] = useState("All statuses");
  const [cadenceFilter, setCadenceFilter] = useState("All cadences");
  const [selectedId, setSelectedId] = useState<string | null>(DEMO_MODE ? "sch_01" : null);
  const [checkedIds, setCheckedIds] = useState<string[]>(DEMO_MODE ? ["sch_01"] : []);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftSchedule>(EMPTY_DRAFT);
  const [deleteTarget, setDeleteTarget] = useState<Schedule | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [integrationOpen, setIntegrationOpen] = useState(false);
  const [integration, setIntegration] = useState<Integration>({ connected: false });
  const [integrationLoading, setIntegrationLoading] = useState(!DEMO_MODE);
  const [integrationError, setIntegrationError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [phoneAssignmentSavingIds, setPhoneAssignmentSavingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [syncSummary, setSyncSummary] = useState<InventorySyncSummary | null>(null);
  const [pendingRunIds, setPendingRunIds] = useState<Set<string>>(() => new Set());
  const pendingRunIdsRef = useRef<Set<string>>(new Set());
  const globalSearchRef = useRef<HTMLInputElement>(null);
  const lastSilentRefreshErrorRef = useRef("");

  function blockDemoMutation(): boolean {
    if (!DEMO_MODE) return false;
    const message = "This is a read-only sample. Configure the working Preview for live mode before saving or dispatching anything.";
    setIntegrationError(message);
    setIntegrationOpen(true);
    showToast("Read-only sample — no changes were saved", "error");
    return true;
  }

  const refreshDashboard = useCallback(async (silent = false) => {
    if (DEMO_MODE) return;
    if (!silent) {
      setDashboardLoading(true);
      setDashboardError("");
    }
    try {
      const [scheduleData, clientData] = await Promise.all([
        apiRequest<{ schedules: ApiSchedule[] }>("/api/schedules?limit=500"),
        apiRequest<{ clients: ClientRecord[] }>("/api/clients"),
      ]);
      const [phoneResult, templateResult, runResult, integrationResult, cycleResult, programResult, profileResult] = await Promise.allSettled([
        apiRequest<{ phones: PhoneRecord[] }>("/api/inventory/phones"),
        apiRequest<{ templates: TemplateRecord[] }>("/api/inventory/templates"),
        apiRequest<{ runs: ApiRun[] }>("/api/runs?limit=200"),
        apiRequest<Integration>("/api/integrations/duoplus"),
        apiRequest<{ cycles: CommandDeviceCycle[]; proxySummary: CommandProxySummary | null }>("/api/device-cycles"),
        apiRequest<{ programs: CycleProgramOption[] }>("/api/cycle-programs"),
        apiRequest<{ profiles: CommandProfileReadiness[]; summary: CommandProfileSummary }>("/api/device-profiles"),
      ]);
      const failedSections: string[] = [];
      const latestRunBySchedule = new Map<string, ApiRun>();
      if (runResult.status === "fulfilled") {
        for (const run of runResult.value.runs) {
          if (!latestRunBySchedule.has(run.scheduleId)) latestRunBySchedule.set(run.scheduleId, run);
        }
        setRecentRuns(runResult.value.runs);
      } else {
        failedSections.push("runs");
      }
      setSchedules((current) => {
        const currentById = new Map(current.map((schedule) => [schedule.id, schedule]));
        return scheduleData.schedules.map((schedule) => {
          const previous = currentById.get(schedule.id);
          const latestRun = runResult.status === "fulfilled"
            ? latestRunBySchedule.get(schedule.id)
            : previous?.latestRun;
          return mapApiSchedule(schedule, previous, latestRun);
        });
      });
      setClientRecords(clientData.clients);
      if (phoneResult.status === "fulfilled") {
        setPhones(phoneResult.value.phones);
      } else {
        failedSections.push("phones");
      }
      if (templateResult.status === "fulfilled") {
        setTemplates(templateResult.value.templates.filter((template) => template.enabled));
      } else {
        failedSections.push("templates");
      }
      if (integrationResult.status === "fulfilled") {
        setIntegration(integrationResult.value);
      } else {
        failedSections.push("DuoPlus connection");
      }
      if (cycleResult.status === "fulfilled") {
        setDeviceCycles(cycleResult.value.cycles);
        setProxySummary(cycleResult.value.proxySummary);
      } else {
        failedSections.push("device cycles");
      }
      if (programResult.status === "fulfilled") {
        setCyclePrograms(programResult.value.programs);
      } else {
        failedSections.push("cycle programs");
      }
      if (profileResult.status === "fulfilled") {
        setProfileReadiness(profileResult.value.profiles);
        setProfileSummary(profileResult.value.summary);
      } else {
        failedSections.push("profile readiness");
      }
      const scheduleIds = new Set(scheduleData.schedules.map((schedule) => schedule.id));
      setSelectedId((current) => current && scheduleIds.has(current) ? current : scheduleData.schedules[0]?.id ?? null);
      setCheckedIds((current) => current.filter((id) => scheduleIds.has(id)));
      setDraft((current) => {
        const next = {
          ...current,
          client: clientData.clients.some((client) => client.name === current.client)
            ? current.client
            : clientData.clients[0]?.name ?? "",
        };
        if (templateResult.status !== "fulfilled") return next;
        const enabledTemplates = templateResult.value.templates.filter((template) => template.enabled);
        const existingTemplate = enabledTemplates.find((template) => template.id === current.templateId);
        const selectedTemplate = existingTemplate ?? enabledTemplates[0];
        return {
          ...next,
          templateId: selectedTemplate?.id ?? "",
          configJson: existingTemplate ? current.configJson : configJsonForTemplate(selectedTemplate),
        };
      });

      if (failedSections.length) {
        const message = `Live refresh incomplete: ${failedSections.join(", ")}. Existing data is still shown.`;
        if (silent) {
          if (lastSilentRefreshErrorRef.current !== message) {
            setToast({ message, tone: "error" });
          }
          lastSilentRefreshErrorRef.current = message;
        } else {
          lastSilentRefreshErrorRef.current = message;
          setDashboardError(message);
        }
      } else {
        lastSilentRefreshErrorRef.current = "";
        setDashboardError("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The workspace could not be loaded.";
      if (silent) {
        if (lastSilentRefreshErrorRef.current !== message) {
          setToast({ message: `Live refresh failed: ${message} Existing data is still shown.`, tone: "error" });
        }
        lastSilentRefreshErrorRef.current = message;
      } else {
        lastSilentRefreshErrorRef.current = message;
        setDashboardError(message);
      }
    } finally {
      if (!silent) setDashboardLoading(false);
      setIntegrationLoading(false);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void refreshDashboard());
    return () => window.cancelAnimationFrame(frame);
  }, [refreshDashboard]);

  useEffect(() => {
    if (DEMO_MODE) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshDashboard(true);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [refreshDashboard]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        globalSearchRef.current?.focus();
      }
      if (event.key === "Escape") setMenuId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const clients = useMemo(() => clientRecords.map((client) => client.name).sort(), [clientRecords]);
  const activePhones = useMemo(
    () => phones.filter((phone) => phone.enabled),
    [phones],
  );
  const schedulablePhones = useMemo(
    () => activePhones.filter((phone) => isSchedulablePhone(phone)),
    [activePhones],
  );

  const filteredSchedules = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return schedules.filter((schedule) => {
      const matchesQuery =
        !normalizedQuery ||
        [schedule.title, schedule.keyword, schedule.client, schedule.device].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        );
      const matchesClient = clientFilter === "All clients" || schedule.client === clientFilter;
      const matchesStatus = statusFilter === "All statuses" || schedule.status === statusFilter;
      const matchesCadence = cadenceFilter === "All cadences" || schedule.cadence === cadenceFilter;
      return matchesQuery && matchesClient && matchesStatus && matchesCadence;
    });
  }, [cadenceFilter, clientFilter, query, schedules, statusFilter]);

  const runningCount = DEMO_MODE ? 6 : recentRuns.filter((run) => ["preparing", "running"].includes(run.status)).length;
  const dashboardNowMs = new Date(initialNow).getTime();
  const dueNowCount = DEMO_MODE ? 4 : recentRuns.filter((run) =>
    ["pending", "queued", "retry_wait"].includes(run.status)
    && new Date(run.issueAt).getTime() <= dashboardNowMs,
  ).length;
  const sevenDaysAgo = new Date(initialNow).getTime() - 7 * 24 * 60 * 60 * 1000;
  const finishedRuns = recentRuns.filter(
    (run) =>
      ["succeeded", "failed"].includes(run.status) &&
      new Date(run.finishedAt ?? run.createdAt ?? run.issueAt).getTime() >= sevenDaysAgo,
  );
  const successRate = DEMO_MODE
    ? "96.8%"
    : finishedRuns.length
      ? `${((finishedRuns.filter((run) => run.status === "succeeded").length / finishedRuns.length) * 100).toFixed(1)}%`
      : "—";
  const onlinePhoneCount = schedulablePhones.filter((phone) => phone.status === 1).length;
  const subscriptionLimit = DEMO_MODE ? 24 : integration.subscriptionCapacity;
  const subscriptionUsed = DEMO_MODE ? 18 : integration.subscriptionInUse ?? onlinePhoneCount;
  const capacityValue = subscriptionLimit == null ? `${subscriptionUsed} / sync` : `${subscriptionUsed} / ${subscriptionLimit}`;
  const capacityPercent = subscriptionLimit
    ? Math.min(100, Math.round((subscriptionUsed / subscriptionLimit) * 100))
    : 0;
  const deviceDisplays = DEMO_MODE
    ? DEVICES
    : schedulablePhones.map((phone) => ({
        name: phone.name,
        status: phone.status === 1 ? "Online" : "Offline",
        detail: phone.busyUntil ? `Busy until ${new Date(phone.busyUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : phone.status === 1 ? "Idle" : "—",
      }));
  const displayedSyncSummary: InventorySyncSummary | null = syncSummary
    ? { ...syncSummary, phoneCount: activePhones.length }
    : integration.connected && integration.inventorySyncedAt
      ? {
          phoneCount: activePhones.length,
          templateCount: templates.length,
          officialTemplateCount: templates.filter((template) => template.templateType === 1).length,
          customTemplateCount: templates.filter((template) => template.templateType === 2).length,
          subscriptionCapacity: integration.subscriptionCapacity ?? null,
          subscriptionInUse: integration.subscriptionInUse ?? null,
          subscriptionAvailable: integration.subscriptionAvailable ?? null,
          syncedAt: integration.inventorySyncedAt,
        }
      : null;
  const allVisibleChecked = filteredSchedules.length > 0 && filteredSchedules.every((item) => checkedIds.includes(item.id));

  function showToast(message: string, tone: "success" | "error" = "success") {
    setToast({ message, tone });
  }

  function openAddDrawer() {
    const template = templates[0];
    setEditingId(null);
    setDraft({
      ...EMPTY_DRAFT,
      client: clientRecords[0]?.name ?? "",
      device: schedulablePhones[0]?.name ?? "",
      templateId: template?.id ?? "",
      configJson: configJsonForTemplate(template),
    });
    setDrawerOpen(true);
  }

  function openEditDrawer(schedule: Schedule) {
    const templateId = schedule.templateId ??
      templates.find((template) => template.name === schedule.template)?.id ??
      "";
    const template = templates.find((candidate) => candidate.id === templateId);
    setEditingId(schedule.id);
    setDraft({
      client: schedule.client,
      keyword: schedule.keyword,
      templateId,
      device: schedule.device,
      cadence: schedule.cadence,
      runTime: schedule.runTime,
      timezone: schedule.timezone,
      duration: schedule.duration,
      retryPolicy: schedule.retryPolicy,
      customCron: schedule.cronExpression ?? "0 9 * * 1-5",
      weeklyDay: schedule.cronExpression?.trim().split(/\s+/)[4] ?? "2",
      monthlyDay: schedule.cronExpression?.trim().split(/\s+/)[2] ?? "1",
      configJson: configJsonForTemplate(template, schedule.config),
      gpsMode: schedule.gpsMode ?? "unchanged",
      gpsLatitude: schedule.gpsLatitude ?? "",
      gpsLongitude: schedule.gpsLongitude ?? "",
      localeTimezone: schedule.localeTimezone ?? "",
      localeLanguage: schedule.localeLanguage ?? "",
    });
    setDrawerOpen(true);
    setMenuId(null);
  }

  async function submitSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blockDemoMutation()) return;

    const client = clientRecords.find((item) => item.name === draft.client);
    const template = templates.find((item) => item.id === draft.templateId);
    const phone = schedulablePhones.find((item) => item.name === draft.device);
    const taskConfig = parseTaskConfigJson(draft.configJson);
    if (!taskConfig.config) {
      showToast(taskConfig.error, "error");
      return;
    }
    if (!DEMO_MODE && (!client || !template || !phone)) {
      setIntegrationError(
        !integration.connected
          ? "Connect DuoPlus, sync inventory, and choose a template before creating a schedule."
          : "Choose an eligible phone and synced template for this per-device queue.",
      );
      setIntegrationOpen(true);
      return;
    }
    const templateSchema = template
      ? resolvedTemplateConfigSchema(template.name, template.configSchema)
      : null;
    const missingInputs = missingRequiredTemplateInputs(templateSchema, taskConfig.config);
    if (missingInputs.length) {
      showToast(`Complete required RPA inputs: ${missingInputs.join(", ")}`, "error");
      return;
    }
    const scheduleSubject = (
      draft.keyword.trim() ||
      firstTaskInputValue(templateSchema, taskConfig.config) ||
      template?.name ||
      "Scheduled RPA task"
    ).slice(0, 500);

    const payload = {
      clientId: client?.id,
      phoneId: phone?.id ?? null,
      templateId: template?.id,
      name: titleFromKeyword(scheduleSubject),
      keyword: scheduleSubject,
      config: taskConfig.config,
      cronExpression: cronFromDraft(draft),
      timezone: draft.timezone,
      maxAttempts: maxAttempts(draft.retryPolicy),
      expectedDurationSeconds: durationSeconds(draft.duration),
      ...(draft.gpsMode === "proxy" ? { gpsMode: 1 as const } : {}),
      ...(draft.gpsMode === "coordinates"
        ? {
            gpsMode: 2 as const,
            gpsLatitude: Number(draft.gpsLatitude),
            gpsLongitude: Number(draft.gpsLongitude),
          }
        : {}),
      ...(draft.localeTimezone.trim() ? { localeTimezone: draft.localeTimezone.trim() } : {}),
      ...(draft.localeLanguage.trim() ? { localeLanguage: draft.localeLanguage.trim() } : {}),
    };

    if (editingId) {
      const previous = schedules.find((schedule) => schedule.id === editingId);
      if (!previous) return;
      const submittedView: Schedule = {
        ...previous,
        ...draft,
        clientId: client?.id ?? previous.clientId,
        templateId: template?.id ?? previous.templateId,
        template: template?.name ?? previous.template,
        phoneId: phone?.id ?? null,
        device: draft.device.startsWith("Auto-assign") ? "Auto-assign" : draft.device,
        title: titleFromKeyword(scheduleSubject),
        keyword: scheduleSubject,
        cronExpression: cronFromDraft(draft),
        config: taskConfig.config,
      };
      try {
        const editPayload = {
          ...payload,
          ...(draft.gpsMode === "unchanged"
            ? { gpsMode: 0 as const, gpsLatitude: null, gpsLongitude: null }
            : draft.gpsMode === "proxy"
              ? { gpsMode: 1 as const, gpsLatitude: null, gpsLongitude: null }
              : {}),
          localeTimezone: draft.localeTimezone.trim() || null,
          localeLanguage: draft.localeLanguage.trim() || null,
        };
        const data = await apiRequest<{ schedule: ApiSchedule }>(`/api/schedules/${previous.id}`, {
          method: "PATCH",
          body: JSON.stringify(editPayload),
        });
        setSchedules((current) => current.map((item) =>
          item.id === previous.id
            ? mapApiSchedule(data.schedule, submittedView, item.latestRun)
            : item,
        ));
        setDrawerOpen(false);
        setEditingId(null);
        showToast("Schedule changes saved");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Schedule changes were not saved", "error");
      }
    } else {
      const submittedView: Partial<Schedule> = {
        clientId: client?.id,
        phoneId: phone?.id ?? null,
        templateId: template?.id,
        title: titleFromKeyword(scheduleSubject),
        keyword: scheduleSubject,
        client: draft.client,
        device: draft.device.startsWith("Auto-assign") ? "Auto-assign" : draft.device,
        template: template?.name ?? "Synced template",
        cadence: draft.cadence,
        cronExpression: cronFromDraft(draft),
        nextRun: "tomorrow",
        lastRun: "Never",
        status: "Scheduled",
        runTime: draft.runTime,
        timezone: draft.timezone,
        duration: draft.duration,
        retryPolicy: draft.retryPolicy,
        config: taskConfig.config,
        gpsMode: draft.gpsMode,
        gpsLatitude: draft.gpsLatitude,
        gpsLongitude: draft.gpsLongitude,
        localeTimezone: draft.localeTimezone,
        localeLanguage: draft.localeLanguage,
      };
      try {
        const data = await apiRequest<{ schedule: ApiSchedule }>("/api/schedules", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const saved = mapApiSchedule(data.schedule, submittedView);
        setSchedules((current) => [saved, ...current]);
        setSelectedId(saved.id);
        setDrawerOpen(false);
        setEditingId(null);
        showToast("Schedule created");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Schedule could not be created", "error");
      }
    }
  }

  async function togglePause(schedule: Schedule) {
    if (blockDemoMutation()) return;
    const nextStatus: ScheduleStatus = schedule.status === "Paused" ? "Scheduled" : "Paused";
    setMenuId(null);
    try {
      const data = await apiRequest<{ schedule: ApiSchedule }>(`/api/schedules/${schedule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: nextStatus !== "Paused" }),
      });
      setSchedules((current) => current.map((item) =>
        item.id === schedule.id
          ? { ...mapApiSchedule(data.schedule, item, item.latestRun), status: nextStatus }
          : item,
      ));
      showToast(nextStatus === "Paused" ? "Schedule paused" : "Schedule enabled");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Schedule status could not be changed", "error");
    }
  }

  async function runNow(schedule: Schedule) {
    if (blockDemoMutation()) return;
    if (runIsOpen(schedule.latestRun)) {
      showToast("This schedule already has an unfinished run. Wait for it to finish or cancel it first.", "error");
      return;
    }
    if (pendingRunIdsRef.current.has(schedule.id)) return;
    pendingRunIdsRef.current.add(schedule.id);
    setPendingRunIds((current) => new Set(current).add(schedule.id));
    setMenuId(null);
    try {
      const data = await apiRequest<{ run: ApiRun }>(`/api/schedules/${schedule.id}/run-now`, { method: "POST" });
      setRecentRuns((current) => [data.run, ...current]);
      setSchedules((current) => current.map((item) =>
        item.id === schedule.id
          ? {
              ...item,
              latestRun: data.run,
              status: statusFromRun(data.run, true),
              lastRun: relativeTime(data.run.finishedAt ?? data.run.startedAt ?? data.run.createdAt ?? null, "Just now"),
            }
          : item,
      ));
      setSelectedId(schedule.id);
      showToast(`Run queued for ${schedule.title}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Run could not be queued", "error");
    } finally {
      pendingRunIdsRef.current.delete(schedule.id);
      setPendingRunIds((current) => {
        const next = new Set(current);
        next.delete(schedule.id);
        return next;
      });
    }
  }

  async function launchDeviceCycle(input: LaunchCycleInput) {
    if (DEMO_MODE) {
      blockDemoMutation();
      throw new Error("The sample workspace is read-only.");
    }

    await apiRequest<{ cycle: { id: string; status: string } }>("/api/device-cycles", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const phone = schedulablePhones.find((item) => item.id === input.phoneId);
    showToast(`Cycle provisioning started for ${phone?.name ?? "the selected phone"}`);
    await refreshDashboard(true);
  }

  async function setDeviceCycleStatus(cycleId: string, status: DeviceCycleOperatingStatus) {
    if (blockDemoMutation()) {
      return;
    }

    let accepted: {
      cycleId: string;
      status: DeviceCycleOperatingStatus;
      cancellationRequested: number;
    } | null = null;
    let cycleListRefreshed = false;
    try {
      accepted = await apiRequest<{
        cycleId: string;
        status: DeviceCycleOperatingStatus;
        cancellationRequested: number;
      }>(`/api/device-cycles/${cycleId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });

      const refreshed = await apiRequest<{
        cycles: CommandDeviceCycle[];
        proxySummary: CommandProxySummary | null;
      }>("/api/device-cycles");
      setDeviceCycles(refreshed.cycles);
      setProxySummary(refreshed.proxySummary);
      cycleListRefreshed = true;
      const confirmed = refreshed.cycles.find((cycle) => cycle.id === accepted?.cycleId);
      if (!confirmed || confirmed.status !== status) {
        throw new Error("The refreshed device cycle did not confirm the requested status.");
      }

      if (status === "cancelled") {
        const count = accepted.cancellationRequested;
        showToast(count > 0
          ? `Cycle cancelled. Cancellation requested for ${count} open ${count === 1 ? "run" : "runs"}.`
          : "Cycle cancelled. No open runs needed cancellation.");
      } else {
        showToast(status === "paused" ? "Cycle paused" : "Cycle resumed");
      }

      // Refresh schedules, runs, and readiness after the cycle status itself is
      // confirmed. The cycle controls never claim success before this point.
      void refreshDashboard(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The device cycle status could not be changed.";
      if (accepted) {
        if (!cycleListRefreshed) {
          setDeviceCycles((current) => current.map((cycle) =>
            cycle.id === accepted?.cycleId ? { ...cycle, status: accepted.status } : cycle,
          ));
        }
        showToast(`The cycle change was accepted, but refreshed state could not be confirmed. ${message}`, "error");
        return;
      }
      showToast(message, "error");
      throw error;
    }
  }

  async function createCycleProgram(input: CreateCycleProgramInput): Promise<CycleProgramOption> {
    if (DEMO_MODE) {
      blockDemoMutation();
      throw new Error("The sample workspace is read-only.");
    }
    const data = await apiRequest<{ program: CycleProgramOption }>("/api/cycle-programs", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setCyclePrograms((current) => [data.program, ...current.filter((program) => program.id !== data.program.id)]);
    showToast("Standard cycle program created");
    return data.program;
  }

  async function confirmRemove() {
    if (!deleteTarget) return;
    if (blockDemoMutation()) {
      setDeleteTarget(null);
      return;
    }
    const target = deleteTarget;
    try {
      const data = await apiRequest<{ cancellationRequested?: number }>(`/api/schedules/${target.id}`, { method: "DELETE" });
      setSchedules((current) => current.filter((schedule) => schedule.id !== target.id));
      setCheckedIds((current) => current.filter((id) => id !== target.id));
      if (selectedId === target.id) setSelectedId(null);
      setDeleteTarget(null);
      showToast(data.cancellationRequested
        ? `Schedule removed; cancellation requested for ${data.cancellationRequested} open ${data.cancellationRequested === 1 ? "run" : "runs"}`
        : "Schedule removed; no open runs needed cancellation");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Schedule could not be removed", "error");
    }
  }

  async function addClient(name: string): Promise<ClientRecord> {
    const existing = clientRecords.find((client) => client.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    if (DEMO_MODE) {
      blockDemoMutation();
      throw new Error("The sample workspace is read-only.");
    }
    const data = await apiRequest<{ client: ClientRecord }>("/api/clients", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    setClientRecords((current) => [...current, data.client]);
    showToast(`${name} added`);
    return data.client;
  }

  async function syncDuoPlusInventory(): Promise<InventorySyncSummary> {
    const summary = await apiRequest<InventorySyncSummary>("/api/inventory/sync", {
      method: "POST",
    });
    setSyncSummary(summary);
    setIntegration((current) => ({
      ...current,
      inventorySyncedAt: summary.syncedAt ?? current.inventorySyncedAt,
      subscriptionCapacity: summary.subscriptionCapacity,
      subscriptionInUse: summary.subscriptionInUse,
      subscriptionAvailable: summary.subscriptionAvailable,
      subscriptionSyncedAt: summary.syncedAt ?? null,
    }));

    const [phoneData, templateData] = await Promise.all([
      apiRequest<{ phones: PhoneRecord[] }>("/api/inventory/phones"),
      apiRequest<{ templates: TemplateRecord[] }>("/api/inventory/templates"),
    ]);
    const enabledTemplates = templateData.templates.filter((template) => template.enabled);
    setPhones(phoneData.phones);
    setTemplates(enabledTemplates);
    setDraft((current) => ({
      ...current,
      templateId: enabledTemplates.some((template) => template.id === current.templateId)
        ? current.templateId
        : enabledTemplates[0]?.id ?? "",
      configJson: enabledTemplates.some((template) => template.id === current.templateId)
        ? current.configJson
        : configJsonForTemplate(enabledTemplates[0]),
    }));
    return summary;
  }

  async function connectDuoPlus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blockDemoMutation()) return;
    if (apiKey.trim().length < 8) {
      setIntegrationError("Enter the API key from DuoPlus Automation → API.");
      return;
    }
    setIntegrationLoading(true);
    setIntegrationError("");
    let connectionVerified = false;
    try {
      const connected = await apiRequest<Integration>("/api/integrations/duoplus", {
        method: "POST",
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      connectionVerified = true;
      setIntegration(connected);
      setApiKey("");
      const summary = await syncDuoPlusInventory();
      showToast(
        `DuoPlus connected · ${summary.phoneCount} phones · ${summary.officialTemplateCount} official + ${summary.customTemplateCount} custom templates`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not connect DuoPlus.";
      setIntegrationError(connectionVerified
        ? `DuoPlus connected, but the automatic inventory sync failed. ${message}`
        : message);
    } finally {
      setIntegrationLoading(false);
    }
  }

  async function syncInventory() {
    if (blockDemoMutation()) return;
    setIntegrationLoading(true);
    setIntegrationError("");
    try {
      const summary = await syncDuoPlusInventory();
      showToast(
        `${summary.phoneCount} phones · ${summary.officialTemplateCount} official + ${summary.customTemplateCount} custom templates synced`,
      );
    } catch (error) {
      setIntegrationError(error instanceof Error ? error.message : "Sync failed.");
    } finally {
      setIntegrationLoading(false);
    }
  }

  async function saveWorkerCapacity(workerCapacityLimit: number) {
    if (blockDemoMutation()) return;
    setIntegrationLoading(true);
    setIntegrationError("");
    try {
      const updated = await apiRequest<Integration>("/api/integrations/duoplus", {
        method: "PATCH",
        body: JSON.stringify({ workerCapacityLimit }),
      });
      setIntegration((current) => ({ ...current, ...updated }));
      setSyncSummary((current) => current ? {
        ...current,
        subscriptionCapacity: updated.subscriptionCapacity ?? current.subscriptionCapacity,
        subscriptionInUse: updated.subscriptionInUse ?? current.subscriptionInUse,
        subscriptionAvailable: updated.subscriptionAvailable ?? current.subscriptionAvailable,
      } : current);
      showToast(`Concurrent Startup worker slots set to ${workerCapacityLimit}`);
    } catch (error) {
      setIntegrationError(error instanceof Error ? error.message : "Worker capacity could not be saved.");
      throw error;
    } finally {
      setIntegrationLoading(false);
    }
  }

  async function savePhoneLocation(
    phoneId: string,
    gpsLatitude: number | null,
    gpsLongitude: number | null,
  ) {
    if (blockDemoMutation()) return;
    setPhoneAssignmentSavingIds((current) => new Set(current).add(phoneId));
    setIntegrationError("");
    try {
      const result = await apiRequest<{ phone: PhoneRecord }>(
        `/api/inventory/phones/${phoneId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ gpsLatitude, gpsLongitude }),
        },
      );
      setPhones((current) => current.map((phone) =>
        phone.id === phoneId ? { ...phone, ...result.phone } : phone,
      ));
      showToast(gpsLatitude === null ? "Device location cleared" : "Device location saved");
    } catch (error) {
      setIntegrationError(error instanceof Error ? error.message : "Device location could not be saved.");
      throw error;
    } finally {
      setPhoneAssignmentSavingIds((current) => {
        const next = new Set(current);
        next.delete(phoneId);
        return next;
      });
    }
  }

  async function importTemplateSchemas(files: File[]): Promise<TemplateSchemaImportSummary> {
    if (blockDemoMutation()) return { updated: [], unmatched: [] };
    if (!files.length) return { updated: [], unmatched: [] };
    const exports = await Promise.all(files.map(async (file) => {
      if (file.size > 2_000_000) throw new Error(`${file.name} is larger than 2 MB.`);
      let definition: unknown;
      try {
        definition = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name} is not valid JSON.`);
      }
      const schema = extractDuoPlusTemplateConfigSchema(definition, file.name);
      const normalizedName = normalizeDuoPlusTemplateName(file.name);
      const matches = templates.filter((template) =>
        normalizeDuoPlusTemplateName(template.name) === normalizedName
      );
      const target = matches.find((template) => template.templateType === 2) ??
        (matches.length === 1 ? matches[0] : undefined);
      return {
        fileName: file.name,
        ...(target ? { templateId: target.id } : {}),
        schema,
      };
    }));
    const summary = await apiRequest<TemplateSchemaImportSummary>(
      "/api/inventory/template-schemas",
      { method: "POST", body: JSON.stringify({ exports }) },
    );
    const templateData = await apiRequest<{ templates: TemplateRecord[] }>(
      "/api/inventory/templates",
    );
    setTemplates(templateData.templates.filter((template) => template.enabled));
    showToast(
      summary.updated.length
        ? `${summary.updated.length} template input definition${summary.updated.length === 1 ? "" : "s"} imported`
        : "No template names matched the selected exports",
      summary.updated.length ? "success" : "error",
    );
    return summary;
  }

  async function assignPhoneClient(phoneId: string, clientId: string | null) {
    if (blockDemoMutation()) return;
    if (phoneAssignmentSavingIds.has(phoneId)) return;

    setPhoneAssignmentSavingIds((current) => {
      const next = new Set(current);
      next.add(phoneId);
      return next;
    });
    setIntegrationError("");
    try {
      const data = await apiRequest<{ phone: PhoneRecord }>(
        `/api/inventory/phones/${phoneId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ clientId }),
        },
      );
      setPhones((current) => current.map((phone) =>
        phone.id === phoneId ? { ...phone, ...data.phone } : phone,
      ));

      const client = clientId
        ? clientRecords.find((candidate) => candidate.id === clientId)
        : null;
      showToast(client
        ? `${data.phone.name} assigned to ${client.name}`
        : `${data.phone.name} marked unassigned`);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "The phone client assignment could not be saved.";
      setIntegrationError(message);
      showToast(message, "error");
    } finally {
      setPhoneAssignmentSavingIds((current) => {
        const next = new Set(current);
        next.delete(phoneId);
        return next;
      });
    }
  }

  async function disconnectDuoPlus() {
    if (blockDemoMutation()) return;
    setIntegrationLoading(true);
    setIntegrationError("");
    try {
      const response = await fetch("/api/integrations/duoplus", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not disconnect DuoPlus.");
      setIntegration({ connected: false });
      setSyncSummary(null);
      if (!DEMO_MODE) {
        setPhones([]);
        setTemplates([]);
      }
      showToast("DuoPlus disconnected");
    } catch (error) {
      setIntegrationError(error instanceof Error ? error.message : "Could not disconnect DuoPlus.");
    } finally {
      setIntegrationLoading(false);
    }
  }

  async function signOut() {
    if (DEMO_MODE) return;
    try {
      await createSupabaseBrowserClient().auth.signOut();
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div className="app-shell">
      <Sidebar
        integration={integration}
        activeView={activeView}
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        onNavigate={(view) => {
          setActiveView(view);
          setMobileNavOpen(false);
          setMenuId(null);
        }}
        onOpenIntegration={() => {
          setIntegrationError("");
          setIntegrationOpen(true);
        }}
        demo={DEMO_MODE}
        onSignOut={signOut}
      />

      <main className={`workspace ${drawerOpen && activeView === "schedules" ? "has-drawer" : ""}`}>
        <header className="mobile-header">
          <button className="icon-button" type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
            <Menu size={19} />
          </button>
          <Brand compact />
          <span className="avatar avatar-small" aria-label={DEMO_MODE ? "Demo member" : "Workspace member"}>{DEMO_MODE ? "DM" : "WM"}</span>
        </header>

        {activeView === "schedules" ? <section className="workspace-inner" aria-label="Schedules dashboard">
          {!integrationLoading && !integration.connected ? (
            <button className="setup-banner" type="button" onClick={() => setIntegrationOpen(true)}>
              <span className="setup-banner-icon"><KeyRound size={17} /></span>
              <span>
                <strong>{DEMO_MODE ? "Read-only sample workspace" : "Connect DuoPlus to start"}</strong>
                <small>{DEMO_MODE ? "Sample records are clearly marked and cannot be changed." : "Connect your own DuoPlus account to sync phones and start dispatching."}</small>
              </span>
              <span className="setup-banner-action">{DEMO_MODE ? "Why it is read-only" : "Connect DuoPlus"} <span aria-hidden="true">→</span></span>
            </button>
          ) : null}

          <div className="page-heading">
            <div>
              <h1>Schedules</h1>
              <p>Plan recurring work. DuoPlus handles execution.</p>
            </div>
            <div className="heading-actions">
              <label className="global-search">
                <span className="sr-only">Search schedules, clients, or keywords</span>
                <Search size={17} aria-hidden="true" />
                <input
                  ref={globalSearchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search schedules, clients, or keywords…"
                />
                <kbd>⌘ K</kbd>
              </label>
              <button className="icon-button heading-refresh" type="button" onClick={() => {
                if (DEMO_MODE) {
                  setSchedules(INITIAL_SCHEDULES);
                  showToast("Demo workspace refreshed");
                } else {
                  void refreshDashboard();
                }
              }} aria-label="Refresh workspace" title="Refresh workspace">
                <RefreshCw size={17} className={dashboardLoading ? "spin" : ""} />
              </button>
              <button className="primary-button" type="button" onClick={openAddDrawer}>
                <Plus size={18} /> Add schedule
              </button>
            </div>
          </div>

          <section className="metric-grid" aria-label="Schedule summary">
            <MetricCard label="Due now" value={String(dueNowCount)} caption="runs waiting" />
            <MetricCard label="Running" value={String(runningCount)} caption="runs in progress" />
            <MetricCard
              label="Device capacity"
              value={capacityValue}
              caption={subscriptionLimit == null ? "sync startup slots" : "startup slots in use"}
              progress={capacityPercent}
            />
            <MetricCard label="Success rate" value={successRate} caption="last 7 days" />
          </section>

          <section className="schedule-panel">
            <div className="filter-bar">
              <SelectFilter value={clientFilter} onChange={setClientFilter} ariaLabel="Filter by client">
                <option>All clients</option>
                {clients.map((client) => <option key={client}>{client}</option>)}
              </SelectFilter>
              <SelectFilter value={statusFilter} onChange={setStatusFilter} ariaLabel="Filter by status">
                <option>All statuses</option>
                {STATUS_ORDER.map((status) => <option key={status}>{status}</option>)}
              </SelectFilter>
              <SelectFilter value={cadenceFilter} onChange={setCadenceFilter} ariaLabel="Filter by cadence">
                <option>All cadences</option>
                <option>Daily</option>
                <option>Weekly</option>
                <option>Monthly</option>
                <option>Custom</option>
              </SelectFilter>
              <label className="table-search">
                <Search size={16} />
                <span className="sr-only">Search schedules</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search schedules…" />
              </label>
              <div className="timezone"><Globe2 size={16} /> <strong>Schedule-local times</strong></div>
            </div>

            {dashboardError ? (
              <div className="dashboard-error" role="alert">
                <CircleAlert size={17} />
                <span><strong>Workspace refresh needs attention</strong><small>{dashboardError}</small></span>
                <button type="button" onClick={() => void refreshDashboard()}><RefreshCw size={14} /> Try again</button>
              </div>
            ) : null}

            <div className="table-scroll" aria-busy={dashboardLoading}>
              {dashboardLoading ? (
                <div className="loading-state" role="status"><RefreshCw className="spin" size={18} /><span>Loading your workspace…</span></div>
              ) : null}
              <table className="schedule-table">
                <thead>
                  <tr>
                    <th className="checkbox-column">
                      <input
                        type="checkbox"
                        aria-label="Select all visible schedules"
                        checked={allVisibleChecked}
                        onChange={(event) => {
                          const visibleIds = filteredSchedules.map((item) => item.id);
                          setCheckedIds((current) =>
                            event.target.checked
                              ? Array.from(new Set([...current, ...visibleIds]))
                              : current.filter((id) => !visibleIds.includes(id)),
                          );
                        }}
                      />
                    </th>
                    <th>Schedule</th>
                    <th>Client</th>
                    <th>Device</th>
                    <th>Cadence</th>
                    <th>Next run <span aria-hidden="true">↑</span></th>
                    <th>Last run</th>
                    <th>Status</th>
                    <th className="actions-column">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSchedules.map((schedule) => (
                    <ScheduleRows
                      key={schedule.id}
                      schedule={schedule}
                      runPending={pendingRunIds.has(schedule.id)}
                      runBlocked={runIsOpen(schedule.latestRun)}
                      selected={schedule.id === selectedId}
                      checked={checkedIds.includes(schedule.id)}
                      menuOpen={menuId === schedule.id}
                      onCheck={() =>
                        setCheckedIds((current) =>
                          current.includes(schedule.id)
                            ? current.filter((id) => id !== schedule.id)
                            : [...current, schedule.id],
                        )
                      }
                      onSelect={() => setSelectedId((current) => (current === schedule.id ? null : schedule.id))}
                      onMenu={() => setMenuId((current) => (current === schedule.id ? null : schedule.id))}
                      onRun={() => runNow(schedule)}
                      onToggle={() => togglePause(schedule)}
                      onEdit={() => openEditDrawer(schedule)}
                      onRemove={() => {
                        setDeleteTarget(schedule);
                        setMenuId(null);
                      }}
                    />
                  ))}
                </tbody>
              </table>
              {!dashboardLoading && !dashboardError && filteredSchedules.length === 0 ? (
                <div className="empty-state">
                  <span>{schedules.length ? <Search size={20} /> : <CalendarDays size={20} />}</span>
                  <strong>{schedules.length ? "No schedules match these filters" : "No schedules yet"}</strong>
                  <p>{schedules.length ? "Clear a filter or try a different keyword." : "Create your first recurring DuoPlus job."}</p>
                  <button type="button" onClick={() => {
                    if (!schedules.length) {
                      openAddDrawer();
                      return;
                    }
                    setQuery("");
                    setClientFilter("All clients");
                    setStatusFilter("All statuses");
                    setCadenceFilter("All cadences");
                  }}>{schedules.length ? "Clear filters" : "Create schedule"}</button>
                </div>
              ) : null}
            </div>
          </section>

          <DeviceCapacity devices={deviceDisplays} onlineCount={subscriptionUsed} totalCount={subscriptionLimit ?? 0} syncedCount={activePhones.length} onSetup={() => setIntegrationOpen(true)} />
        </section> : (
          <CommandCenter
            schedules={schedules}
            runs={recentRuns}
            phones={schedulablePhones}
            devices={deviceDisplays}
            clients={clients}
            clientOptions={clientRecords}
            cycles={deviceCycles}
            profiles={profileReadiness}
            profileSummary={profileSummary}
            cyclePrograms={cyclePrograms}
            templateOptions={templates}
            proxySummary={proxySummary}
            demo={DEMO_MODE}
            loading={dashboardLoading}
            pendingRunIds={pendingRunIds}
            integrationConnected={integration.connected}
            systemReady={systemReady}
            integrationVerifiedAt={integration.verifiedAt}
            subscriptionCapacity={integration.subscriptionCapacity}
            subscriptionInUse={integration.subscriptionInUse}
            subscriptionAvailable={integration.subscriptionAvailable}
            subscriptionSyncedAt={integration.subscriptionSyncedAt}
            successRate={successRate}
            initialNow={initialNow}
            onAddSchedule={() => { setActiveView("schedules"); openAddDrawer(); }}
            onRefresh={() => {
              if (DEMO_MODE) {
                setSchedules(INITIAL_SCHEDULES);
                showToast("Command center refreshed");
              } else {
                void refreshDashboard();
              }
            }}
            onRun={(scheduleId) => {
              const schedule = schedules.find((item) => item.id === scheduleId);
              if (schedule) void runNow(schedule);
            }}
            onViewSchedule={(scheduleId) => {
              setSelectedId(scheduleId);
              setDrawerOpen(false);
              setActiveView("schedules");
            }}
            onViewRun={setSelectedRunDetail}
            onOpenIntegration={() => {
              setIntegrationError("");
              setIntegrationOpen(true);
            }}
            onLaunchCycle={launchDeviceCycle}
            onCreateCycleProgram={createCycleProgram}
            onSetCycleStatus={setDeviceCycleStatus}
            onNotify={showToast}
          />
        )}
      </main>

      {drawerOpen && activeView === "schedules" ? (
        <ScheduleDrawer
          draft={draft}
          editing={Boolean(editingId)}
          clients={clientRecords.map((client) => client.name)}
          phones={schedulablePhones.map((phone) => phone.name)}
          templates={templates}
          integrationConnected={integration.connected}
          subscriptionCapacity={integration.subscriptionCapacity}
          eligiblePhoneCount={schedulablePhones.length}
          previewAnchor={initialNow}
          onChange={setDraft}
          onAddClient={addClient}
          onOpenIntegration={() => setIntegrationOpen(true)}
          onClose={() => {
            setDrawerOpen(false);
            setEditingId(null);
          }}
          onSubmit={submitSchedule}
        />
      ) : null}

      {selectedRunDetail ? (
        <RunLogDialog
          run={selectedRunDetail}
          schedule={{
            title: selectedRunDetail.scheduleName
              ?? selectedRunDetail.templateName
              ?? selectedRunDetail.keyword
              ?? "DuoPlus run",
          }}
          onClose={() => setSelectedRunDetail(null)}
        />
      ) : null}

      {mobileNavOpen ? <button className="page-scrim nav-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} /> : null}
      {drawerOpen && activeView === "schedules" ? <button className="page-scrim drawer-scrim" aria-label="Close schedule panel" onClick={() => setDrawerOpen(false)} /> : null}

      {integrationOpen ? (
        <IntegrationDialog
          key={integration.subscriptionCapacity ?? "capacity-loading"}
          demoMode={DEMO_MODE}
          integration={integration}
          loading={integrationLoading}
          error={integrationError}
          apiKey={apiKey}
          showKey={showKey}
          syncSummary={displayedSyncSummary}
          phones={activePhones}
          clients={clientRecords}
          phoneAssignmentSavingIds={phoneAssignmentSavingIds}
          onApiKeyChange={setApiKey}
          onToggleKey={() => setShowKey((current) => !current)}
          onConnect={connectDuoPlus}
          onSync={syncInventory}
          onSaveCapacity={saveWorkerCapacity}
          onImportTemplateSchemas={importTemplateSchemas}
          onAssignPhone={assignPhoneClient}
          onSavePhoneLocation={savePhoneLocation}
          onDisconnect={disconnectDuoPlus}
          onClose={() => {
            setIntegrationOpen(false);
            setIntegrationError("");
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog schedule={deleteTarget} onCancel={() => setDeleteTarget(null)} onConfirm={confirmRemove} />
      ) : null}

      {toast ? (
        <div className="toast" role={toast.tone === "error" ? "alert" : "status"}>
          {toast.tone === "error"
            ? <CircleAlert size={17} style={{ color: "var(--red)" }} />
            : <CheckCircle2 size={17} />}
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <span className="brand-mark" aria-hidden="true"><span /></span>
      <span>Stakeout Ops</span>
    </div>
  );
}

function Sidebar({
  integration,
  activeView,
  open,
  demo,
  onClose,
  onNavigate,
  onOpenIntegration,
  onSignOut,
}: {
  integration: Integration;
  activeView: PrimaryView;
  open: boolean;
  demo: boolean;
  onClose: () => void;
  onNavigate: (view: PrimaryView) => void;
  onOpenIntegration: () => void;
  onSignOut: () => void;
}) {
  return (
    <aside className={`sidebar ${open ? "sidebar-open" : ""}`} aria-label="Primary navigation">
      <div className="sidebar-top">
        <Brand />
        <button className="icon-button sidebar-close" type="button" onClick={onClose} aria-label="Close navigation"><X size={18} /></button>
      </div>
      <nav>
        {NAVIGATION.filter((item) => item.enabled).map((item) => {
          const Icon = item.icon;
          const destination = item.view;
          const active = item.enabled && destination === activeView;
          return (
            <button
              key={item.label}
              className={`nav-item ${active ? "nav-item-active" : ""}`}
              type="button"
              disabled={!item.enabled}
              onClick={item.enabled && destination ? () => onNavigate(destination) : undefined}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={18} strokeWidth={1.9} />
              <span>{item.label}</span>
              {!item.enabled ? <small className="nav-coming-soon">Coming soon</small> : null}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <button className="connection-card" type="button" onClick={onOpenIntegration}>
          <span className={`connection-icon ${integration.connected ? "is-connected" : ""}`}>
            {integration.connected ? <ShieldCheck size={17} /> : <Cloud size={17} />}
          </span>
          <span>
            <strong>{integration.connected ? "DuoPlus connected" : demo ? "Demo workspace" : "DuoPlus not connected"}</strong>
            <small>{integration.connected ? integration.keyHint ?? "Private API key" : "Connect your account"}</small>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="profile-card">
          <span className="avatar">{demo ? "DM" : "WM"}</span>
          <span><strong>{demo ? "Preview member" : "Workspace member"}</strong><small>{demo ? "Demo mode" : "Signed in"}</small></span>
          {demo ? <span className="demo-chip">Demo</span> : <button className="signout-button" type="button" onClick={onSignOut} aria-label="Sign out" title="Sign out"><LogOut size={15} /></button>}
        </div>
      </div>
    </aside>
  );
}

function MetricCard({
  label,
  value,
  caption,
  progress,
}: {
  label: string;
  value: string;
  caption: string;
  progress?: number;
}) {
  return (
    <article className="metric-card">
      <div className="metric-label">{label}</div>
      <strong className="metric-value">{value}</strong>
      {progress ? (
        <div className="metric-progress-row">
          <span className="progress-track"><span style={{ width: `${progress}%` }} /></span>
          <span>{progress}%</span>
        </div>
      ) : null}
      <p>{caption}</p>
    </article>
  );
}

function SelectFilter({
  value,
  onChange,
  ariaLabel,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <label className="select-filter">
      <span className="sr-only">{ariaLabel}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel}>
        {children}
      </select>
      <ChevronDown size={15} aria-hidden="true" />
    </label>
  );
}

function ScheduleRows({
  schedule,
  runPending,
  runBlocked,
  selected,
  checked,
  menuOpen,
  onCheck,
  onSelect,
  onMenu,
  onRun,
  onToggle,
  onEdit,
  onRemove,
}: {
  schedule: Schedule;
  runPending: boolean;
  runBlocked: boolean;
  selected: boolean;
  checked: boolean;
  menuOpen: boolean;
  onCheck: () => void;
  onSelect: () => void;
  onMenu: () => void;
  onRun: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <>
      <tr className={`schedule-row ${selected ? "schedule-row-selected" : ""}`}>
        <td className="checkbox-column">
          <input type="checkbox" checked={checked} onChange={onCheck} aria-label={`Select ${schedule.title}`} />
        </td>
        <td>
          <button className="schedule-name" type="button" onClick={onSelect} aria-expanded={selected}>
            <span>{schedule.title}</span>
            <small>{schedule.keyword}</small>
          </button>
        </td>
        <td data-label="Client">{schedule.client}</td>
        <td data-label="Device"><span className="device-name"><Smartphone size={14} />{schedule.device}</span></td>
        <td data-label="Cadence">{schedule.cadence}</td>
        <td data-label="Next run" className="tabular">{schedule.nextRun}</td>
        <td data-label="Last run" className="tabular">{schedule.lastRun}</td>
        <td data-label="Status"><StatusBadge status={schedule.status} /></td>
        <td className="actions-column">
          <div className="action-menu-wrap">
            <button className="row-menu-button" type="button" onClick={onMenu} aria-label={`Actions for ${schedule.title}`} aria-expanded={menuOpen}>
              <MoreHorizontal size={18} />
            </button>
            {menuOpen ? (
              <div className="action-menu" role="menu">
                <button type="button" role="menuitem" onClick={onRun} disabled={runPending || runBlocked} title={runBlocked ? "Wait for the current run to finish" : undefined}>
                  {runPending ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}
                  {runPending ? "Queueing…" : runBlocked ? "Run in progress" : "Run now"}
                </button>
                <button type="button" role="menuitem" onClick={onToggle}>
                  {schedule.status === "Paused" ? <Check size={15} /> : <Pause size={15} />}
                  {schedule.status === "Paused" ? "Enable" : "Pause"}
                </button>
                <button type="button" role="menuitem" onClick={onEdit}><Pencil size={15} /> Edit</button>
                <button type="button" role="menuitem" className="danger-menu-item" onClick={onRemove}><Trash2 size={15} /> Remove</button>
              </div>
            ) : null}
          </div>
        </td>
      </tr>
      {selected ? (
        <tr className="attempt-row">
          <td colSpan={9}>
            <AttemptTimeline schedule={schedule} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function StatusBadge({ status }: { status: ScheduleStatus }) {
  return <span className={`status-badge status-${statusClass(status)}`}><span />{status}</span>;
}

type TimelineStep = { name: string; time: string; note: string; state: "complete" | "active" | "pending" | "error" | "paused" };

function liveTimelineSteps(run: ApiRun, schedule: Schedule): TimelineStep[] {
  const stageProgress: Record<string, number> = {
    pending: 0,
    prepare_phone: 1,
    wait_phone: 1,
    apply_settings: 1,
    submit_task: 2,
    resolve_task: 2,
    monitor_task: 3,
    fetch_logs: 3,
    cancel_task: 3,
    complete: 4,
    error: 3,
  };
  let progress = stageProgress[run.stage] ?? 0;
  if (run.status === "queued") progress = Math.max(progress, 2);
  if (run.status === "running") progress = Math.max(progress, 3);
  if (run.status === "succeeded") progress = 4;

  const finalName =
    run.status === "succeeded"
      ? "Completed"
      : run.status === "failed"
        ? "Failed"
        : run.status === "cancelled"
          ? "Cancelled"
          : run.status === "retry_wait"
            ? "Retry waiting"
            : "Running on device";
  const base = [
    {
      name: "Claimed",
      time: clockTime(run.createdAt, "—"),
      note: `Attempt ${run.attemptCount ?? 1} of ${run.maxAttempts ?? (schedule.retryPolicy.replace(/\D/g, "") || "3")}`,
    },
    {
      name: "Device prepared",
      time: clockTime(run.startedAt, "—"),
      note: run.phoneName || schedule.device || "Auto-assigned device",
    },
    {
      name: "DuoPlus task",
      time: clockTime(run.issueAt, "—"),
      note: run.status === "queued" ? "Waiting in DuoPlus" : "Dispatch submitted",
    },
    {
      name: finalName,
      time: clockTime(run.finishedAt ?? run.startedAt, "—"),
      note: run.lastError || (run.status === "succeeded" ? "Logs and screenshots collected" : run.stage.replaceAll("_", " ")),
    },
  ];

  return base.map((step, index) => {
    let state: TimelineStep["state"] = index < progress ? "complete" : index === progress ? "active" : "pending";
    if (run.status === "failed" && index === Math.min(progress, 3)) state = "error";
    if (run.status === "cancelled" && index === Math.min(progress, 3)) state = "paused";
    if (run.status === "retry_wait" && index === Math.min(progress, 3)) state = "paused";
    return { ...step, state };
  });
}

function collectScreenshotUrls(...values: unknown[]) {
  const urls = new Set<string>();
  function visit(value: unknown, key = "", depth = 0) {
    if (depth > 7 || value == null) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) && (/screenshot|image|capture/i.test(key) || /\.(png|jpe?g|webp)(\?|$)/i.test(value))) urls.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key, depth + 1));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey, depth + 1));
    }
  }
  values.forEach((value) => visit(value));
  return Array.from(urls);
}

function safeLogJson(value: unknown) {
  if (value == null) return "No structured DuoPlus log has been collected for this run.";
  const serialized = JSON.stringify(
    value,
    (key, child) => (/api.?key|authorization|password|secret|token/i.test(key) ? "[redacted]" : child),
    2,
  );
  if (!serialized) return "No structured DuoPlus log has been collected for this run.";
  return serialized.length > 16_000 ? `${serialized.slice(0, 16_000)}\n… log truncated in browser` : serialized;
}

type ObservedActionEvidence = {
  total: number;
  successful: number;
  failed: number;
  unknown: number;
  byAction: Array<{
    action: string;
    total: number;
    successful: number;
    failed: number;
  }>;
};

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function observedActionEvidence(value: unknown): ObservedActionEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 2 || record.actionTelemetryPoints !== 0) return null;
  const rawActions = record.actions;
  if (!rawActions || typeof rawActions !== "object" || Array.isArray(rawActions)) {
    return null;
  }
  const actions = rawActions as Record<string, unknown>;
  const rawRows = Array.isArray(actions.byAction) ? actions.byAction : [];
  const byAction = rawRows
    .flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (!isDuoPlusEvidenceAction(row.action)) {
        return [];
      }
      return [{
        action: row.action,
        total: nonNegativeInteger(row.total),
        successful: nonNegativeInteger(row.successful),
        failed: nonNegativeInteger(row.failed),
      }];
    })
    .toSorted((left, right) => right.total - left.total || left.action.localeCompare(right.action))
    .slice(0, 8);

  return {
    total: nonNegativeInteger(actions.total),
    successful: nonNegativeInteger(actions.successful),
    failed: nonNegativeInteger(actions.failed),
    unknown: nonNegativeInteger(actions.unknown),
    byAction,
  };
}

function AttemptTimeline({ schedule }: { schedule: Schedule }) {
  const run = schedule.latestRun;
  const [logOpen, setLogOpen] = useState(false);
  const steps: TimelineStep[] = !DEMO_MODE && run
    ? liveTimelineSteps(run, schedule)
    : !DEMO_MODE
      ? [
          { name: schedule.status === "Paused" ? "Schedule paused" : "Scheduled", time: schedule.nextRun, note: schedule.status === "Paused" ? "Future dispatch is suspended" : "Waiting for dispatch window", state: schedule.status === "Paused" ? "paused" : "active" },
          { name: "Device lock", time: "—", note: "Assigned at run time", state: "pending" },
          { name: "DuoPlus dispatch", time: "—", note: "Not yet sent", state: "pending" },
          { name: "Run on device", time: "—", note: "Not yet started", state: "pending" },
        ]
      : [
          { name: "Claimed", time: "10:14:03 AM", note: "Schedule assigned to runner", state: "complete" },
          { name: "Device locked", time: "10:14:07 AM", note: `${schedule.device} locked for task`, state: "complete" },
          { name: "DuoPlus accepted", time: "10:14:12 AM", note: "Task accepted by DuoPlus", state: "complete" },
          { name: "Running on device", time: "10:14:18 AM", note: "Searches in progress", state: "active" },
        ];

  return (
    <div className="attempt-panel">
      <div className="attempt-heading">
        <div>
          <strong>Run attempt — {schedule.title}</strong>
          <StatusBadge status={schedule.status} />
        </div>
        <button type="button" disabled={!DEMO_MODE && !run} onClick={() => setLogOpen(true)}>
          {!DEMO_MODE && !run ? "No task log yet" : "View task log"} <ExternalLink size={13} />
        </button>
      </div>
      <div className="timeline">
        {steps.map((step, index) => (
          <div className={`timeline-step timeline-${step.state}`} key={step.name}>
            <span className="timeline-marker">
              {step.state === "complete" ? <Check size={13} /> : step.state === "error" ? <X size={13} /> : null}
            </span>
            {index < steps.length - 1 ? <span className="timeline-line" /> : null}
            <strong>{step.name}</strong>
            <time>{step.time}</time>
            <p>{step.note}</p>
          </div>
        ))}
      </div>
      {logOpen ? <RunLogDialog run={run} schedule={schedule} onClose={() => setLogOpen(false)} /> : null}
    </div>
  );
}

function RunLogDialog({
  run,
  schedule,
  onClose,
}: {
  run?: CommandRun;
  schedule: Pick<Schedule, "title">;
  onClose: () => void;
}) {
  const demoLog = {
    schemaVersion: 2,
    actionTelemetryPoints: 0,
    totalLogEntries: 18,
    storedLogEntries: 18,
    truncated: false,
    actions: {
      total: 18,
      successful: 17,
      failed: 1,
      unknown: 0,
      byAction: [
        { action: "CLICK_ELEMENT", total: 9, successful: 8, failed: 1, unknown: 0 },
        { action: "OPEN_APP", total: 3, successful: 3, failed: 0, unknown: 0 },
        { action: "SLIDE_PAGE", total: 6, successful: 6, failed: 0, unknown: 0 },
      ],
    },
    entries: [],
  };
  const displayedLog = run?.log ?? (DEMO_MODE ? demoLog : null);
  const observedActions = observedActionEvidence(displayedLog);
  const screenshots = collectScreenshotUrls(run?.screenshots, displayedLog);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="run-log-dialog" role="dialog" aria-modal="true" aria-labelledby="run-log-title">
        <div className="modal-header">
          <span className="modal-icon"><FileCode2 size={20} /></span>
          <div><p>Proof of execution</p><h2 id="run-log-title">Task log</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close task log"><X size={19} /></button>
        </div>
        <div className="run-log-body">
          <dl className="run-log-meta">
            <div><dt>Schedule</dt><dd>{schedule.title}</dd></div>
            <div><dt>Run ID</dt><dd>{run?.id ?? "demo-run"}</dd></div>
            <div><dt>Status</dt><dd>{run?.status ?? "running"}</dd></div>
            <div><dt>Stage</dt><dd>{run?.stage?.replaceAll("_", " ") ?? "monitor task"}</dd></div>
            <div><dt>Attempt</dt><dd>{run ? `${run.attemptCount ?? 1} / ${run.maxAttempts ?? 3}` : "1 / 3"}</dd></div>
          </dl>
          {run?.lastError ? <div className="form-error" role="alert"><CircleAlert size={16} />{run.lastError}</div> : null}
          {observedActions ? (
            <section className="action-evidence" aria-labelledby="action-evidence-title">
              <div className="action-evidence-heading">
                <h3 id="action-evidence-title">Observed actions</h3>
                <span>Proof only · 0 extra score points</span>
              </div>
              <dl className="action-evidence-totals">
                <div><dt>Observed</dt><dd>{observedActions.total}</dd></div>
                <div><dt>Successful</dt><dd>{observedActions.successful}</dd></div>
                <div><dt>Failed</dt><dd>{observedActions.failed}</dd></div>
                <div><dt>Unknown</dt><dd>{observedActions.unknown}</dd></div>
              </dl>
              {observedActions.byAction.length ? (
                <ul className="action-evidence-types" aria-label="Observed action types">
                  {observedActions.byAction.map((action) => (
                    <li key={action.action}>
                      <span>{action.action.replaceAll("_", " ")}</span>
                      <strong>{action.successful}/{action.total}</strong>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
          <section className="screenshot-list" aria-labelledby="screenshots-title">
            <div><h3 id="screenshots-title">Screenshots</h3><span>{screenshots.length}</span></div>
            {screenshots.length ? screenshots.map((url, index) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">Screenshot {index + 1}<ExternalLink size={13} /></a>
            )) : <p>{DEMO_MODE ? "Screenshots appear here after a connected run." : "No screenshots were returned for this run."}</p>}
          </section>
          <section className="structured-log" aria-labelledby="structured-log-title">
            <div><h3 id="structured-log-title">Structured evidence</h3><span>Aggregate only</span></div>
            <pre>{safeLogJson(observedActions ? {
              schemaVersion: 2,
              actionTelemetryPoints: 0,
              actions: observedActions,
            } : null)}</pre>
          </section>
        </div>
      </section>
    </div>
  );
}

function DeviceCapacity({
  devices,
  onlineCount,
  totalCount,
  syncedCount,
  onSetup,
}: {
  devices: Array<{ name: string; status: string; detail: string }>;
  onlineCount: number;
  totalCount: number;
  syncedCount: number;
  onSetup: () => void;
}) {
  return (
    <section className="capacity-section" aria-labelledby="device-capacity-title">
      <div className="capacity-heading">
        <div><h2 id="device-capacity-title">Subscription device capacity</h2><span>{totalCount ? `${onlineCount} / ${totalCount} startup slots in use` : "Sync Subscription Startup count"}</span></div>
        <button type="button" onClick={onSetup}>Manage devices <span aria-hidden="true">→</span></button>
      </div>
      {devices.length ? <div className="device-grid">
        {devices.map((device) => (
          <article className="device-card" key={device.name}>
            <Smartphone size={19} />
            <div>
              <strong>{device.name}</strong>
              <span className={device.status === "Online" ? "online" : "offline"}><i />{device.status}</span>
              <small>{device.detail}</small>
            </div>
          </article>
        ))}
      </div> : <button className="capacity-empty" type="button" onClick={onSetup}><Smartphone size={18} /><span><strong>{syncedCount ? "No eligible phones" : "No phones synced"}</strong><small>{syncedCount ? "Expired and renewal-overdue devices are hidden from scheduling." : "Connect DuoPlus and sync your device inventory."}</small></span><span>Set up →</span></button>}
    </section>
  );
}

function ScheduleDrawer({
  draft,
  editing,
  clients,
  phones,
  templates,
  integrationConnected,
  subscriptionCapacity,
  eligiblePhoneCount,
  previewAnchor,
  onChange,
  onAddClient,
  onOpenIntegration,
  onClose,
  onSubmit,
}: {
  draft: DraftSchedule;
  editing: boolean;
  clients: string[];
  phones: string[];
  templates: TemplateRecord[];
  integrationConnected: boolean;
  subscriptionCapacity: number | null | undefined;
  eligiblePhoneCount: number;
  previewAnchor: string;
  onChange: (draft: DraftSchedule) => void;
  onAddClient: (name: string) => Promise<ClientRecord>;
  onOpenIntegration: () => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [addingClient, setAddingClient] = useState(false);
  const [newClient, setNewClient] = useState("");
  const [clientSaving, setClientSaving] = useState(false);
  const [clientError, setClientError] = useState("");
  const [templateQuery, setTemplateQuery] = useState("");
  const nextRuns = upcomingRuns(draft, previewAnchor);
  const taskConfigValidation = useMemo(
    () => parseTaskConfigJson(draft.configJson),
    [draft.configJson],
  );
  const matchingTemplates = useMemo(() => {
    const normalized = templateQuery.trim().toLowerCase();
    const sorted = templates.toSorted((left, right) => left.name.localeCompare(right.name));
    if (!normalized) return sorted;
    return sorted.filter((template) => {
      const source = template.templateType === 1 ? "official" : "custom";
      return [template.name, template.id, template.duoplusTemplateId ?? "", source]
        .some((value) => value.toLowerCase().includes(normalized));
    });
  }, [templateQuery, templates]);
  const officialTemplates = matchingTemplates.filter((template) => template.templateType === 1);
  const customTemplates = matchingTemplates.filter((template) => template.templateType === 2);
  const selectedTemplate = templates.find((template) => template.id === draft.templateId);
  const selectedTemplateIsVisible = matchingTemplates.some((template) => template.id === draft.templateId);
  const selectedTemplateSchema = selectedTemplate
    ? resolvedTemplateConfigSchema(selectedTemplate.name, selectedTemplate.configSchema)
    : null;
  const missingTemplateInputs = missingRequiredTemplateInputs(
    selectedTemplateSchema,
    taskConfigValidation.config,
  );
  const operatorInputs = selectedTemplateSchema?.inputs.filter((input) => input.role === "operator") ?? [];
  const constantInputs = selectedTemplateSchema?.inputs.filter((input) => input.role === "constant") ?? [];

  return (
    <aside className="schedule-drawer" aria-labelledby="schedule-drawer-title">
      <div className="drawer-header">
        <div><span className="drawer-kicker">Schedule builder</span><h2 id="schedule-drawer-title">{editing ? "Edit schedule" : "Add schedule"}</h2></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close schedule panel"><X size={18} /></button>
      </div>
      <form onSubmit={onSubmit}>
        <div className="drawer-body">
          <div className="client-field">
            <div className="field-heading"><span>Client</span><button type="button" onClick={() => setAddingClient((current) => !current)}><Plus size={13} /> Add client</button></div>
            <label className="field-label field-label-no-title">
              <span className="sr-only">Client</span>
              <span className="select-field"><select value={draft.client} onChange={(event) => onChange({ ...draft, client: event.target.value })}>{clients.map((client) => <option key={client}>{client}</option>)}</select><ChevronDown size={15} /></span>
            </label>
            {addingClient ? (
              <div className="inline-client-create">
                <input value={newClient} onChange={(event) => setNewClient(event.target.value)} placeholder="Client or business name" autoFocus />
                <button
                  type="button"
                  disabled={!newClient.trim() || clientSaving}
                  onClick={() => {
                    const name = newClient.trim();
                    if (!name) return;
                    setClientSaving(true);
                    setClientError("");
                    void onAddClient(name)
                      .then((client) => {
                        onChange({ ...draft, client: client.name });
                        setNewClient("");
                        setAddingClient(false);
                      })
                      .catch((error: unknown) => setClientError(error instanceof Error ? error.message : "Client could not be added."))
                      .finally(() => setClientSaving(false));
                  }}
                >{clientSaving ? "Adding…" : "Add"}</button>
              </div>
            ) : null}
            {clientError ? <small className="inline-field-error">{clientError}</small> : null}
          </div>
          <div className="field-label template-picker-field">
            <span>Template</span>
            <div className="template-search-field">
              <Search size={15} aria-hidden="true" />
              <label className="sr-only" htmlFor="schedule-template-search">Search templates</label>
              <input
                id="schedule-template-search"
                type="search"
                value={templateQuery}
                onChange={(event) => setTemplateQuery(event.target.value)}
                placeholder="Search name, source, or ID…"
              />
              {templateQuery ? <button type="button" onClick={() => setTemplateQuery("")} aria-label="Clear template search"><X size={14} /></button> : null}
            </div>
            <span className="select-field">
              <select value={draft.templateId} onChange={(event) => {
                const template = templates.find((candidate) => candidate.id === event.target.value);
                onChange({
                  ...draft,
                  templateId: event.target.value,
                  keyword: "",
                  configJson: configJsonForTemplate(template),
                });
              }} aria-label="Template">
                {!templates.length ? <option value="">No templates synced</option> : null}
                {selectedTemplate && !selectedTemplateIsVisible ? <option value={selectedTemplate.id} hidden>{selectedTemplate.name}</option> : null}
                {officialTemplates.length ? (
                  <optgroup label={`Official (${officialTemplates.length})`}>
                    {officialTemplates.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}
                  </optgroup>
                ) : null}
                {customTemplates.length ? (
                  <optgroup label={`Custom (${customTemplates.length})`}>
                    {customTemplates.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}
                  </optgroup>
                ) : null}
              </select>
              <ChevronDown size={15} aria-hidden="true" />
            </span>
            <small className="template-search-status" aria-live="polite">
              {templates.length
                ? `${matchingTemplates.length} of ${templates.length} templates shown`
                : "Sync DuoPlus templates to continue"}
            </small>
          </div>
          {selectedTemplateSchema ? (
            <section className="template-input-card" aria-labelledby="template-input-title">
              <div className="template-input-heading">
                <span><FileCode2 size={15} /></span>
                <div>
                  <strong id="template-input-title">RPA inputs</strong>
                  <small>{selectedTemplateSchema.inputs.length
                    ? `${selectedTemplateSchema.inputs.length} exact variable${selectedTemplateSchema.inputs.length === 1 ? "" : "s"} found in the DuoPlus template`
                    : "This template has no run-time variables"}</small>
                </div>
                <i>{selectedTemplateSchema.source === "bundled-export" ? "Verified" : "Imported"}</i>
              </div>
              {operatorInputs.length ? (
                <div className="template-input-fields">
                  {operatorInputs.map((input) => (
                    <TemplateInputField
                      key={input.key}
                      input={input}
                      value={taskConfigEntryValue(draft.configJson, input)}
                      onChange={(value) => onChange({
                        ...draft,
                        configJson: updateTaskConfigEntry(draft.configJson, input, value),
                      })}
                    />
                  ))}
                </div>
              ) : (
                <div className="template-no-inputs"><CheckCircle2 size={15} /><span>Nothing to fill in. Select the client, cadence, and run time.</span></div>
              )}
              {constantInputs.length ? (
                <details className="template-defaults">
                  <summary>{constantInputs.length} safe selector default{constantInputs.length === 1 ? "" : "s"}<ChevronDown size={14} /></summary>
                  <div className="template-input-fields">
                    {constantInputs.map((input) => (
                      <TemplateInputField
                        key={input.key}
                        input={input}
                        value={taskConfigEntryValue(draft.configJson, input)}
                        onChange={(value) => onChange({
                          ...draft,
                          configJson: updateTaskConfigEntry(draft.configJson, input, value),
                        })}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
              {selectedTemplateSchema.unresolvedVariables.length ? (
                <div className="template-schema-warning" role="status"><CircleAlert size={14} /><span>{selectedTemplateSchema.unresolvedVariables.length} unresolved script variable{selectedTemplateSchema.unresolvedVariables.length === 1 ? "" : "s"}; review this export before dispatch.</span></div>
              ) : null}
            </section>
          ) : (
            <label className="field-label">
              <span>Keyword</span>
              <input
                required
                value={draft.keyword}
                onChange={(event) => onChange({ ...draft, keyword: event.target.value })}
                placeholder="e.g. emergency plumber"
              />
              <small>No input definition has been imported for this template yet. This value is sent as the legacy keyword variable.</small>
            </label>
          )}
          {selectedTemplateSchema ? (
            <label className="field-label">
              <span>Schedule label <small>(optional)</small></span>
              <input
                value={draft.keyword}
                onChange={(event) => onChange({ ...draft, keyword: event.target.value })}
                placeholder={`Auto: ${selectedTemplate?.name ?? "RPA task"}`}
              />
              <small>For your dashboard only. The exact fields above are what DuoPlus receives.</small>
            </label>
          ) : null}
          <FormSelect required label="Required phone" value={draft.device} onChange={(value) => onChange({ ...draft, device: value })} help="This job stays in the selected phone's daily, weekly, or custom queue.">
            <option value="" disabled>Choose an eligible phone</option>
            {phones.map((phone) => <option key={phone}>{phone}</option>)}
          </FormSelect>
          <div className="capacity-aware-note">
            <ShieldCheck size={16} />
            <span><strong>Capacity-aware dispatch is automatic</strong><small>{subscriptionCapacity
              ? `${subscriptionCapacity} startup slot${subscriptionCapacity === 1 ? "" : "s"} across ${eligiblePhoneCount} eligible phone${eligiblePhoneCount === 1 ? "" : "s"}. Overlapping work waits and resumes as a slot opens.`
              : `Eligible phones are serialized automatically. Sync DuoPlus to load the hard startup-slot limit.`}</small></span>
          </div>

          {!integrationConnected || !templates.length ? (
            <button className="inventory-helper" type="button" onClick={onOpenIntegration}>
              <Cloud size={16} />
              <span><strong>{integrationConnected ? "Sync templates to continue" : "Connect your DuoPlus account"}</strong><small>Phones and RPA templates stay in your own workspace.</small></span>
              <span aria-hidden="true">→</span>
            </button>
          ) : null}

          <fieldset className="cadence-fieldset">
            <legend>Cadence</legend>
            <div>
              {(["Daily", "Weekly", "Monthly", "Custom"] as Cadence[]).map((cadence) => (
                <label key={cadence}>
                  <input
                    type="radio"
                    name="cadence"
                    checked={draft.cadence === cadence}
                    onChange={() => onChange({ ...draft, cadence })}
                  />
                  <span>{cadence}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {draft.cadence === "Weekly" ? (
            <FormSelect label="Run day" value={draft.weeklyDay} onChange={(value) => onChange({ ...draft, weeklyDay: value })}>
              <option value="0">Sunday</option>
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
            </FormSelect>
          ) : null}

          {draft.cadence === "Monthly" ? (
            <FormSelect label="Day of month" value={draft.monthlyDay} onChange={(value) => onChange({ ...draft, monthlyDay: value })}>
              {Array.from({ length: 28 }, (_, index) => (
                <option key={index + 1} value={String(index + 1)}>{index + 1}</option>
              ))}
            </FormSelect>
          ) : null}

          {draft.cadence === "Custom" ? (
            <label className="field-label">
              <span>Custom cron expression</span>
              <input
                value={draft.customCron}
                onChange={(event) => onChange({ ...draft, customCron: event.target.value })}
                placeholder="0 9 * * 1-5"
                pattern="\S+\s+\S+\s+\S+\s+\S+\s+\S+"
                required
              />
              <small>Minute, hour, day, month, weekday. Example: weekdays at 9 AM.</small>
            </label>
          ) : null}

          <label className="field-label">
            <span>Run time</span>
            <span className="input-with-icon"><Clock3 size={15} /><input type="time" value={normalizeInputTime(draft.runTime)} onChange={(event) => onChange({ ...draft, runTime: event.target.value })} /></span>
          </label>
          <label className="field-label">
            <span>Schedule timezone</span>
            <input list="schedule-timezones" value={draft.timezone} onChange={(event) => onChange({ ...draft, timezone: event.target.value })} placeholder="America/New_York" required />
            <datalist id="schedule-timezones">
              <option value="America/New_York" />
              <option value="America/Chicago" />
              <option value="America/Denver" />
              <option value="America/Los_Angeles" />
              <option value="America/Phoenix" />
              <option value="Pacific/Honolulu" />
            </datalist>
          </label>
          <FormSelect label="Estimated duration" value={draft.duration} onChange={(value) => onChange({ ...draft, duration: value })} help="Based on template history.">
            <option>15 minutes</option>
            <option>20 minutes</option>
            <option>25 minutes</option>
            <option>35 minutes</option>
          </FormSelect>
          <FormSelect label="Retry policy" value={draft.retryPolicy} onChange={(value) => onChange({ ...draft, retryPolicy: value })} help="Retry on device or network errors.">
            <option>Do not retry</option>
            <option>Retry up to 2 times</option>
            <option>Retry up to 3 times</option>
          </FormSelect>

          <details className="advanced-settings">
            <summary>
              <span><Globe2 size={15} /><span><strong>RPA parameters, location & locale</strong><small>Optional task and device overrides</small></span></span>
              <ChevronDown size={15} />
            </summary>
            <div className="advanced-settings-body">
              <label className="field-label">
                <span>Task configuration (JSON)</span>
                <textarea
                  value={draft.configJson}
                  onChange={(event) => onChange({ ...draft, configJson: event.target.value })}
                  aria-invalid={Boolean(taskConfigValidation.error)}
                  aria-describedby={taskConfigValidation.error ? "task-config-help task-config-error" : "task-config-help"}
                  placeholder={'{\n  "city": "Lakeland",\n  "radius": 10,\n  "use_maps": true\n}'}
                  spellCheck={false}
                  autoCapitalize="off"
                  style={{
                    width: "100%",
                    minHeight: 142,
                    resize: "vertical",
                    padding: "9px 10px",
                    border: `1px solid ${taskConfigValidation.error ? "var(--red)" : "var(--line-strong)"}`,
                    borderRadius: 6,
                    color: "#263655",
                    background: "#fff",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontSize: 11,
                    lineHeight: 1.45,
                  }}
                />
                <small id="task-config-help">JSON object only. Templates with a verified/imported definition receive only their exact variables; legacy templates receive the keyword field above. Typed entries support string, textarea, number, boolean, file, and excel. Never enter passwords, tokens, API keys, or proxy credentials.</small>
                {taskConfigValidation.error ? <span className="inline-field-error" id="task-config-error" role="alert">{taskConfigValidation.error}</span> : null}
              </label>
              <FormSelect
                label="Phone location"
                value={draft.gpsMode}
                onChange={(value) => onChange({ ...draft, gpsMode: value as DraftSchedule["gpsMode"] })}
                help="Keep current settings makes no GPS change before the run."
              >
                <option value="unchanged">Keep current phone settings</option>
                <option value="proxy">Use location from proxy IP</option>
                <option value="coordinates">Set exact coordinates</option>
              </FormSelect>
              {draft.gpsMode === "coordinates" ? (
                <div className="coordinate-grid">
                  <label className="field-label">
                    <span>Latitude</span>
                    <input required type="number" min="-90" max="90" step="any" value={draft.gpsLatitude} onChange={(event) => onChange({ ...draft, gpsLatitude: event.target.value })} placeholder="28.0395" />
                  </label>
                  <label className="field-label">
                    <span>Longitude</span>
                    <input required type="number" min="-180" max="180" step="any" value={draft.gpsLongitude} onChange={(event) => onChange({ ...draft, gpsLongitude: event.target.value })} placeholder="-81.9498" />
                  </label>
                </div>
              ) : null}
              <FormSelect
                label="Phone timezone override"
                value={draft.localeTimezone}
                onChange={(value) => onChange({ ...draft, localeTimezone: value })}
                help="Separate from the cadence timezone. Blank leaves the phone unchanged."
              >
                <option value="">Keep current phone timezone</option>
                <option>America/New_York</option>
                <option>America/Chicago</option>
                <option>America/Denver</option>
                <option>America/Los_Angeles</option>
              </FormSelect>
              <FormSelect label="Phone language override" value={draft.localeLanguage} onChange={(value) => onChange({ ...draft, localeLanguage: value })}>
                <option value="">Keep current phone language</option>
                <option value="en-US">English (United States)</option>
                <option value="es-US">Spanish (United States)</option>
              </FormSelect>
              {draft.gpsMode !== "unchanged" || draft.localeTimezone || draft.localeLanguage ? (
                <div className="dispatcher-warning"><CircleAlert size={15} /><span><strong>Requires minute dispatcher;</strong> daily Hobby cron leaves this run pending.</span></div>
              ) : null}
            </div>
          </details>

          <section className="next-runs-card" aria-label="Next three runs">
            <strong>Next 3 runs</strong>
            {nextRuns.length ? nextRuns.map((run, index) => (
              <div key={run.iso}><span>{index + 1}.</span><time>{run.date}</time><time>{run.time}</time></div>
            )) : <p>Enter a valid cadence and IANA timezone to preview upcoming runs.</p>}
          </section>
        </div>
        <div className="drawer-footer">
          <button className="primary-button drawer-submit" type="submit" disabled={!draft.client || !draft.templateId || Boolean(taskConfigValidation.error) || missingTemplateInputs.length > 0 || (!selectedTemplateSchema && !draft.keyword.trim())}>{editing ? "Save changes" : "Create schedule"}</button>
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </aside>
  );
}

function FormSelect({
  label,
  value,
  onChange,
  help,
  required = false,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="field-label">
      <span>{label}</span>
      <span className="select-field"><select required={required} value={value} onChange={(event) => onChange(event.target.value)}>{children}</select><ChevronDown size={15} /></span>
      {help ? <small>{help}</small> : null}
    </label>
  );
}

function TemplateInputField({
  input,
  value,
  onChange,
}: {
  input: DuoPlusTemplateInput;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}) {
  const defaultText = Array.isArray(input.defaultValue)
    ? input.defaultValue.join("\n")
    : String(input.defaultValue ?? "");
  const help = input.description || (input.usedByTemplate
    ? `Sent to DuoPlus as ${input.key}.`
    : `Declared by DuoPlus as ${input.key}; the current graph does not reference it directly.`);
  if (input.type === "boolean") {
    return (
      <FormSelect
        label={`${input.label}${input.required ? " *" : ""}`}
        value={value === true ? "true" : "false"}
        onChange={(next) => onChange(next === "true")}
        help={help}
      >
        <option value="true">Yes</option>
        <option value="false">No</option>
      </FormSelect>
    );
  }
  const multiline = input.type === "textarea" || input.type === "excel" || input.type === "file";
  return (
    <label className="field-label template-input-field">
      <span>{input.label}{input.required ? " *" : ""}<code>{input.key}</code></span>
      {multiline ? (
        <textarea
          required={input.required}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          placeholder={defaultText || (input.type === "file" ? "One file ID or URL per line" : "One value per line")}
          rows={3}
        />
      ) : (
        <input
          required={input.required}
          type={input.type === "number" ? "number" : "text"}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          placeholder={defaultText}
        />
      )}
      <small>{help}</small>
    </label>
  );
}

export function IntegrationDialog({
  demoMode,
  integration,
  loading,
  error,
  apiKey,
  showKey,
  syncSummary,
  phones,
  clients,
  phoneAssignmentSavingIds,
  onApiKeyChange,
  onToggleKey,
  onConnect,
  onSync,
  onSaveCapacity = async () => undefined,
  onImportTemplateSchemas = async () => ({ updated: [], unmatched: [] }),
  onAssignPhone,
  onSavePhoneLocation = async () => undefined,
  onDisconnect,
  onClose,
}: {
  demoMode: boolean;
  integration: Integration;
  loading: boolean;
  error: string;
  apiKey: string;
  showKey: boolean;
  syncSummary: InventorySyncSummary | null;
  phones: PhoneRecord[];
  clients: ClientRecord[];
  phoneAssignmentSavingIds: Set<string>;
  onApiKeyChange: (value: string) => void;
  onToggleKey: () => void;
  onConnect: (event: FormEvent<HTMLFormElement>) => void;
  onSync: () => void;
  onSaveCapacity?: (workerCapacityLimit: number) => Promise<void>;
  onImportTemplateSchemas?: (files: File[]) => Promise<TemplateSchemaImportSummary>;
  onAssignPhone: (phoneId: string, clientId: string | null) => void;
  onSavePhoneLocation?: (
    phoneId: string,
    gpsLatitude: number | null,
    gpsLongitude: number | null,
  ) => Promise<void>;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  const templateImportRef = useRef<HTMLInputElement>(null);
  const [templateImporting, setTemplateImporting] = useState(false);
  const [templateImportMessage, setTemplateImportMessage] = useState("");
  const [capacityDraft, setCapacityDraft] = useState(
    String(integration.subscriptionCapacity ?? 3),
  );
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="integration-dialog" role="dialog" aria-modal="true" aria-labelledby="integration-title">
        <div className="modal-header">
          <span className="modal-icon"><Cloud size={20} /></span>
          <div><p>DuoPlus integration</p><h2 id="integration-title">{demoMode ? "Read-only sample" : integration.connected ? "Workspace connected" : "Connect your workspace"}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close DuoPlus setup"><X size={19} /></button>
        </div>

        {demoMode ? (
          <div className="connected-content">
            <div className="demo-mode-notice" role="status">
              <CircleAlert size={20} />
              <div>
                <strong>Sample data only</strong>
                <p>This Preview is not connected to Supabase or DuoPlus. API keys cannot be entered or verified until live Preview environment variables are configured.</p>
              </div>
            </div>
            <button className="secondary-button full-button" type="button" onClick={onClose}>Close sample</button>
          </div>
        ) : integration.connected ? (
          <div className="connected-content">
            <div className="connected-status">
              <span><ShieldCheck size={20} /></span>
              <div><strong>Connection verified</strong><p>Your key is encrypted at rest and is never returned to this browser.</p></div>
            </div>
            <dl className="integration-details">
              <div><dt>API key</dt><dd>{integration.keyHint ?? "••••••••"}</dd></div>
              <div><dt>Last verified</dt><dd>{integration.verifiedAt ? new Date(integration.verifiedAt).toLocaleString() : "Just now"}</dd></div>
            </dl>
            {syncSummary ? (
              <div className="sync-summary">
                <div><Smartphone size={17} /><strong>{syncSummary.phoneCount}</strong><span>phones</span></div>
                <div><FileCode2 size={17} /><strong>{syncSummary.templateCount}</strong><span>templates</span></div>
                <div><ShieldCheck size={17} /><strong>{syncSummary.officialTemplateCount}</strong><span>Official</span></div>
                <div><Cloud size={17} /><strong>{syncSummary.customTemplateCount}</strong><span>Custom</span></div>
                <div><ShieldCheck size={17} /><strong>{syncSummary.subscriptionCapacity ?? "—"}</strong><span>startup slots</span></div>
                <div><Activity size={17} /><strong>{syncSummary.subscriptionAvailable ?? "—"}</strong><span>slots free</span></div>
              </div>
            ) : null}
            <form
              className="worker-capacity-setting"
              aria-busy={loading}
              onSubmit={(event) => {
                event.preventDefault();
                const nextLimit = Number(capacityDraft);
                if (!Number.isInteger(nextLimit) || nextLimit < 1 || nextLimit > 100) return;
                void onSaveCapacity(nextLimit).catch(() => undefined);
              }}
            >
              <label className="field-label">
                <span>Concurrent worker slots</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  inputMode="numeric"
                  required
                  value={capacityDraft}
                  disabled={loading}
                  onChange={(event) => setCapacityDraft(event.target.value)}
                  aria-describedby="worker-capacity-help"
                />
              </label>
              <button
                className="secondary-button"
                type="submit"
                disabled={loading || Number(capacityDraft) === integration.subscriptionCapacity}
              >
                Save slots
              </button>
              <p id="worker-capacity-help" aria-live="polite">
                {integration.subscriptionInUse ?? 0} of {integration.subscriptionCapacity ?? 3} slots are on or starting. The rest of the phone inventory waits in its own queue.
              </p>
            </form>
            <section className="phone-assignments" aria-labelledby="phone-assignments-title">
              <div className="phone-assignments-heading">
                <div>
                  <h3 id="phone-assignments-title">Device ownership</h3>
                  <p>Give each synced phone to one client before launching its cycle.</p>
                </div>
                <span>{phones.length} synced</span>
              </div>
              {phones.length ? (
                <div className="phone-assignment-list">
                  {phones.map((phone) => {
                    const saving = phoneAssignmentSavingIds.has(phone.id);
                    const currentClientIsActive = clients.some((client) => client.id === phone.clientId);
                    return (
                      <div className="phone-assignment-row" key={phone.id}>
                        <span className="phone-assignment-device">
                          <Smartphone size={16} />
                          <span>
                            <strong>{phone.name}</strong>
                            <small>{duoPhoneStatusLabel(phone)}</small>
                          </span>
                        </span>
                        <span className="phone-assignment-select">
                          <select
                            aria-label={`Client assignment for ${phone.name}`}
                            value={phone.clientId ?? ""}
                            disabled={saving || loading}
                            onChange={(event) => onAssignPhone(
                              phone.id,
                              event.target.value || null,
                            )}
                          >
                            <option value="">Unassigned</option>
                            {phone.clientId && !currentClientIsActive ? (
                              <option value={phone.clientId} disabled>Assigned client unavailable</option>
                            ) : null}
                            {clients.map((client) => (
                              <option key={client.id} value={client.id}>{client.name}</option>
                            ))}
                          </select>
                          {saving ? <RefreshCw size={14} className="spin" aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                        </span>
                        <details className="phone-location-editor">
                          <summary>
                            <MapPin size={13} aria-hidden="true" />
                            {phone.gpsLatitude == null ? "Set location" : "Edit location"}
                            <span className="sr-only"> for {phone.name}</span>
                          </summary>
                          <form
                            key={`${phone.id}:${phone.gpsLatitude ?? ""}:${phone.gpsLongitude ?? ""}`}
                            aria-busy={saving || loading}
                            onSubmit={(event) => {
                              event.preventDefault();
                              const values = new FormData(event.currentTarget);
                              const latitude = Number(values.get("latitude"));
                              const longitude = Number(values.get("longitude"));
                              if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return;
                              if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return;
                              void onSavePhoneLocation(phone.id, latitude, longitude).catch(() => undefined);
                            }}
                          >
                            <label>
                              <span>Latitude</span>
                              <input name="latitude" type="number" inputMode="decimal" min="-90" max="90" step="any" required defaultValue={phone.gpsLatitude ?? ""} placeholder="28.0395" disabled={saving || loading} />
                            </label>
                            <label>
                              <span>Longitude</span>
                              <input name="longitude" type="number" inputMode="decimal" min="-180" max="180" step="any" required defaultValue={phone.gpsLongitude ?? ""} placeholder="-81.9498" disabled={saving || loading} />
                            </label>
                            <button className="secondary-button" type="submit" disabled={saving || loading}>Save location</button>
                            {phone.gpsLatitude != null && phone.gpsLongitude != null ? (
                              <button className="text-danger-button" type="button" disabled={saving || loading} onClick={() => void onSavePhoneLocation(phone.id, null, null).catch(() => undefined)}>Clear</button>
                            ) : null}
                          </form>
                        </details>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="phone-assignments-empty">Sync inventory to load the phones in this DuoPlus workspace.</p>
              )}
              {!clients.length && phones.length ? (
                <p className="phone-assignments-note">Create a client before assigning a phone.</p>
              ) : null}
            </section>
            {error ? <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div> : null}
            <button className="primary-button full-button" type="button" disabled={loading} onClick={onSync}>
              <RefreshCw size={17} className={loading ? "spin" : ""} /> {loading ? "Syncing…" : "Sync phones, templates & slots"}
            </button>
            <input
              ref={templateImportRef}
              className="sr-only"
              type="file"
              accept="application/json,.json"
              multiple
              disabled={loading || templateImporting}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (!files.length) return;
                setTemplateImporting(true);
                setTemplateImportMessage("");
                void onImportTemplateSchemas(files)
                  .then((summary) => {
                    const imported = summary.updated.length;
                    setTemplateImportMessage(summary.unmatched.length
                      ? `${imported} imported · ${summary.unmatched.length} filename${summary.unmatched.length === 1 ? "" : "s"} did not match a synced template.`
                      : `${imported} template input definition${imported === 1 ? "" : "s"} imported.`);
                  })
                  .catch((importError: unknown) => setTemplateImportMessage(
                    importError instanceof Error ? importError.message : "Template definitions could not be imported.",
                  ))
                  .finally(() => setTemplateImporting(false));
              }}
            />
            <button
              className="secondary-button full-button"
              type="button"
              disabled={loading || templateImporting}
              onClick={() => templateImportRef.current?.click()}
            >
              <FileCode2 size={17} /> {templateImporting ? "Reading template definitions…" : "Import RPA template JSONs"}
            </button>
            <p className="template-import-help">Select exported DuoPlus RPA JSON files together. Filenames are matched to your synced templates; only declared run-time inputs are stored.</p>
            {templateImportMessage ? <p className="template-import-result" role="status">{templateImportMessage}</p> : null}
            <button className="text-danger-button" type="button" disabled={loading} onClick={onDisconnect}>Disconnect DuoPlus</button>
          </div>
        ) : (
          <form onSubmit={onConnect}>
            <p className="integration-intro">Each operator connects their own DuoPlus account. We use the key only from secure server routes to dispatch work and sync inventory.</p>
            <ol className="setup-steps">
              <li><span>1</span><p>Open DuoPlus Console</p></li>
              <li><span>2</span><p>Go to <strong>Automation → API</strong></p></li>
              <li><span>3</span><p>Copy your API key</p></li>
            </ol>
            <label className="field-label api-key-field">
              <span>DuoPlus API key</span>
              <span className="secret-input">
                <KeyRound size={16} />
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => onApiKeyChange(event.target.value)}
                  placeholder="Paste your key"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" onClick={onToggleKey} aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button>
              </span>
            </label>
            {error ? <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div> : null}
            <div className="security-note"><ShieldCheck size={17} /><span><strong>Your key stays private.</strong> It is encrypted server-side and never included in page data or logs.</span></div>
            <button className="primary-button full-button" type="submit" disabled={loading}>
              {loading ? <RefreshCw size={17} className="spin" /> : <Cloud size={17} />}
              {loading ? "Connecting & syncing…" : "Connect & sync"}
            </button>
            <button className="secondary-button full-button" type="button" onClick={onClose}>Cancel</button>
          </form>
        )}
      </section>
    </div>
  );
}

function ConfirmDialog({ schedule, onCancel, onConfirm }: { schedule: Schedule; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop">
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-title" aria-describedby="remove-description">
        <span className="danger-icon"><Trash2 size={20} /></span>
        <h2 id="remove-title">Remove this schedule?</h2>
        <p id="remove-description"><strong>{schedule.title}</strong> will stop creating future runs. Any pending DuoPlus task will be cancelled; run history is preserved.</p>
        <div><button className="secondary-button" type="button" onClick={onCancel}>Keep schedule</button><button className="danger-button" type="button" onClick={onConfirm}>Remove schedule</button></div>
      </section>
    </div>
  );
}

