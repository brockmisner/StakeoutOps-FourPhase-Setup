import { CronExpressionParser } from "cron-parser";

export type PlanningSchedule = {
  id: string; clientId: string; phoneId: string | null; templateId: string;
  name: string; keyword: string; cronExpression: string; timezone: string;
  enabled: boolean; nextRunAt: string | null; expectedDurationSeconds: number; maxAttempts: number;
};
export type PlanningRun = {
  id: string; scheduleId: string; clientId: string; phoneId: string | null; templateId: string;
  scheduledFor: string; issueAt: string; status: string; stage: string;
  expectedDurationSeconds: number; startedAt: string | null; finishedAt: string | null;
  windowEndAt: string | null; nextActionAt?: string | null; attemptCount: number; maxAttempts: number;
  lastError: string | null; deviceCycleId: string | null;
};
export type PlanningSnapshot = {
  runs: PlanningRun[]; schedules: PlanningSchedule[]; truncated: boolean; loadedAt: string;
};
export type PlanningPhone = { id: string; name: string; clientId?: string | null; status: number; enabled: boolean; imageId?: string; };
export type FleetEvent = {
  id: string; runId?: string; scheduleId: string; clientId: string; phoneId: string | null;
  templateId: string; title: string; due: number; start: number | null; end: number | null;
  durationMinutes: number; lane: number | null; status: string; projected: boolean;
  attention: boolean; reason?: string; attemptCount: number; maxAttempts: number;
};
type Interval = { start: number; end: number };
export type FleetPlan = {
  events: FleetEvent[]; lanes: Interval[][]; warnings: string[];
  capacity: number; reliable: boolean; now: number; horizonEnd: number;
};
const ACTIVE = new Set(["running", "preparing"]);
const MINUTE = 60_000;

export function dateInZone(value: number | string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (kind: string) => parts.find(p => p.type === kind)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function addDateDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}
export function weekStart(date: string): string {
  return addDateDays(date, -(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7);
}
export function dayStart(date: string, timezone: string): number {
  // Find the zone's first midnight on this local date, including DST transitions.
  const reference = Date.parse(`${date}T00:00:00Z`) - 36 * 3600_000;
  const cron = CronExpressionParser.parse("0 0 * * *", { tz: timezone, currentDate: new Date(reference) });
  for (let i = 0; i < 4; i++) {
    const instant = cron.next().toDate().getTime();
    if (dateInZone(instant, timezone) === date) return instant;
  }
  throw new Error("This date is not available in the selected timezone.");
}

export function buildFleetPlan(snapshot: PlanningSnapshot, options: {
  from: number; through: number; now: number; capacity: number | null;
  used: number | null; phones: PlanningPhone[]; startupMinutes: number; spacingMinutes: number;
}): FleetPlan {
  const { from, through, now, phones } = options;
  const warnings: string[] = [];
  const knownCapacity = options.capacity != null && Number.isInteger(options.capacity) && options.capacity > 0 && options.capacity <= 500;
  const capacity = knownCapacity ? options.capacity! : 0;
  if (!knownCapacity) warnings.push("Sync DuoPlus to confirm the Startup slot limit before relying on a forecast.");
  if (snapshot.truncated) warnings.push("The planning feed reached its safety limit. Completion and availability are partial.");
  const schedules = new Map(snapshot.schedules.map(s => [s.id, s]));
  const phoneById = new Map(phones.map(p => [p.id, p]));
  const physicalKey = (id: string) => phoneById.get(id)?.imageId || id;
  const represented = new Set(snapshot.runs.map(r => `${r.scheduleId}@${Date.parse(r.scheduledFor)}`));
  const runById = new Map(snapshot.runs.map(r => [r.id, r]));
  const events: FleetEvent[] = snapshot.runs.filter(r => r.status !== "cancelled").map(r => ({
    id: r.id, runId: r.id, scheduleId: r.scheduleId, clientId: r.clientId, phoneId: r.phoneId,
    templateId: r.templateId, title: schedules.get(r.scheduleId)?.name ?? (r.deviceCycleId ? "Cycle task" : "Scheduled task"),
    due: Date.parse(r.scheduledFor), start: r.startedAt ? Date.parse(r.startedAt) : null,
    end: r.finishedAt ? Date.parse(r.finishedAt) : null, durationMinutes: r.expectedDurationSeconds / 60,
    lane: null, status: r.status, projected: false,
    attention: ["failed", "paused", "retry_wait"].includes(r.status), reason: r.lastError ?? undefined,
    attemptCount: r.attemptCount, maxAttempts: r.maxAttempts,
  }));
  // Projection starts at next_run_at, so disabled, past and already materialized occurrences are never recreated.
  for (const s of snapshot.schedules.filter(s => s.enabled && s.nextRunAt)) {
    try {
      const begin = Math.max(from, Date.parse(s.nextRunAt!));
      const iterator = CronExpressionParser.parse(s.cronExpression, { tz: s.timezone, currentDate: new Date(begin - 1) });
      let count = 0;
      for (; count < 2000 && events.length < 12000; count++) {
        const due = iterator.next().toDate().getTime();
        if (due >= through) break;
        if (represented.has(`${s.id}@${due}`)) continue;
        events.push({ id: `forecast:${s.id}:${due}`, scheduleId: s.id, clientId: s.clientId, phoneId: s.phoneId,
          templateId: s.templateId, title: s.name, due, start: null, end: null, lane: null,
          durationMinutes: s.expectedDurationSeconds / 60, status: "projected", projected: true,
          attention: false, attemptCount: 0, maxAttempts: s.maxAttempts });
      }
      if (count >= 2000 || events.length >= 12000) warnings.push("Some recurring occurrences were omitted because the forecast reached its safety limit.");
    } catch { warnings.push(`Could not project the cadence for ${s.name}.`); }
  }
  const lanes: Interval[][] = Array.from({ length: capacity }, () => []);
  const deviceBusy = new Map<string, Interval[]>();
  const spacing = options.spacingMinutes * MINUTE;
  const active = events.filter(e => ACTIVE.has(e.status));
  const activeDevices = new Set(active.filter(e => e.phoneId).map(e => physicalKey(e.phoneId!)));
  if (activeDevices.size < active.filter(e => e.phoneId).length) warnings.push("Multiple active runs reference the same physical phone. Reconcile the device before relying on the forecast.");
  const onlineDevices = new Set(phones.filter(p => p.status === 1).map(p => physicalKey(p.id)));
  const unknownOccupied = Math.max(0, (options.used ?? onlineDevices.size) - activeDevices.size, [...onlineDevices].filter(id => !activeDevices.has(id)).length);
  if (unknownOccupied > 0) warnings.push(`${unknownOccupied} on-phone slot${unknownOccupied === 1 ? " has" : "s have"} no tracked active run. Reserved until the device is reconciled.`);
  const blockedCount = Math.min(capacity, unknownOccupied);
  for (let lane = 0; lane < blockedCount; lane++) lanes[lane].push({ start: Math.min(now, from), end: Math.max(through, now + 86400_000) });
  function reserve(e: FleetEvent, lane: number, start: number, end: number, buffer = spacing) {
    e.lane = lane; e.start = start; e.end = end;
    const interval = { start, end: end + buffer };
    lanes[lane].push(interval);
    if (e.phoneId) {
      const key = physicalKey(e.phoneId);
      const list = deviceBusy.get(key) ?? []; list.push(interval); deviceBusy.set(key, list);
    }
  }
  active.sort((a,b) => (a.start ?? a.due) - (b.start ?? b.due)).forEach((e, index) => {
    if (index + blockedCount >= capacity) { e.attention = true; e.reason = "Active runs exceed the known slot limit."; warnings.push(e.reason); return; }
    const start = e.start ?? now;
    let end = start + Math.max(1, e.durationMinutes) * MINUTE;
    if (end <= now) {
      end = Math.max(through, now + 86400_000); e.attention = true; e.reason = "Running beyond its estimate; this slot remains reserved until completion is confirmed.";
      warnings.push(e.reason);
    }
    reserve(e, index + blockedCount, start, end);
  });
  // Place finished observations for display only. They never create future capacity.
  for (const e of events.filter(e => ["succeeded", "failed"].includes(e.status) && e.start != null && e.end != null)) {
    if (!capacity) continue;
    const lane = lanes.findIndex(list => !list.some(i => e.start! < i.end && e.end! > i.start));
    if (lane >= 0) reserve(e, lane, e.start!, e.end!, 0);
  }
  const waiting = events.filter(e => e.projected || ["pending", "queued", "retry_wait"].includes(e.status))
    .sort((a,b) => a.due - b.due || a.clientId.localeCompare(b.clientId) || a.id.localeCompare(b.id));
  for (const e of waiting) {
    const run = e.runId ? runById.get(e.runId) : undefined;
    if (e.due < now && through <= now) { e.attention = true; e.reason = "No confirmed completion for this past occurrence."; continue; }
    const phone = e.phoneId ? phoneById.get(e.phoneId) : undefined;
    if (!phone || !phone.enabled || ![1, 2, 10, 11].includes(phone.status)) {
      e.attention = true; e.reason = "A synced, eligible dedicated phone is required."; continue;
    }
    if (!Number.isFinite(e.durationMinutes) || e.durationMinutes <= 0) { e.attention = true; e.reason = "An estimated duration is required."; continue; }
    if (!capacity) continue;
    const earliest = Math.max(now, e.due, run ? Date.parse(run.issueAt) : e.due, run?.nextActionAt ? Date.parse(run.nextActionAt) : 0);
    const duration = (e.durationMinutes + options.startupMinutes) * MINUTE;
    let best = { lane: -1, start: Infinity };
    lanes.forEach((list, lane) => {
      const intervals = [...list, ...(deviceBusy.get(physicalKey(phone.id)) ?? [])].sort((a,b) => a.start - b.start);
      let start = earliest;
      for (const i of intervals) { if (start < i.end && start + duration > i.start) start = i.end; }
      if (start < best.start) best = { lane, start };
    });
    if (best.lane < 0) continue;
    const end = best.start + duration;
    const deadline = run?.windowEndAt ? Date.parse(run.windowEndAt) : Infinity;
    if (end > deadline) { e.attention = true; e.reason = "Does not fit its execution window with the current queue and buffers."; continue; }
    if (best.start >= through) { e.attention = true; e.reason = "No capacity within the displayed planning window."; continue; }
    reserve(e, best.lane, best.start, end);
    if (e.due < now && !e.reason) { e.attention = true; e.reason = "Past its requested start; completion is still outstanding."; }
  }
  return { events, lanes, warnings: [...new Set(warnings)], capacity,
    reliable: knownCapacity && !snapshot.truncated && warnings.length === 0,
    now, horizonEnd: through };
}

export function findOpenSlot(plan: FleetPlan, durationMinutes: number, after = plan.now): { lane: number; start: number; end: number } | null {
  if (!plan.reliable || durationMinutes <= 0) return null;
  let best: { lane: number; start: number; end: number } | null = null;
  plan.lanes.forEach((list, lane) => {
    let start = after;
    for (const i of [...list].sort((a,b) => a.start - b.start)) {
      if (start < i.end && start + durationMinutes * MINUTE > i.start) start = i.end;
    }
    const end = start + durationMinutes * MINUTE;
    if (end <= plan.horizonEnd && (!best || start < best.start)) best = { lane, start, end };
  });
  return best;
}
