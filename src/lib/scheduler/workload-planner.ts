export type WorkloadTask = {
  id: string;
  clientId: string;
  phoneId?: string | null;
  preferredStart: string;
  earliestStart?: string;
  deadline?: string;
  durationSeconds: number;
};

export type WorkloadPlannerOptions = {
  capacity: number;
  minimumSpacingMinutes?: number;
};

export type PlannedWorkloadTask = WorkloadTask & {
  lane: number;
  startAt: string;
  endAt: string;
  shiftedByMinutes: number;
};

export type UnplannedWorkloadTask = {
  task: WorkloadTask;
  reason: "invalid_time" | "invalid_duration" | "deadline_exceeded";
};

export type WorkloadPlan = {
  planned: PlannedWorkloadTask[];
  unplanned: UnplannedWorkloadTask[];
};

type Candidate = {
  task: WorkloadTask;
  preferred: number;
  earliest: number;
  deadline: number;
  durationMs: number;
};

type Placement = Candidate & { lane: number; start: number; end: number };

function parseTime(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  return new Date(value).getTime();
}

/**
 * Build a deterministic, non-overlapping plan. Tasks never move earlier than
 * requested; capacity lanes and each dedicated phone are both serialized.
 * Equal-time work is selected from the least-served client first.
 */
export function planWorkload(
  tasks: WorkloadTask[],
  options: WorkloadPlannerOptions,
): WorkloadPlan {
  if (!Number.isInteger(options.capacity) || options.capacity < 1) {
    throw new Error("Workload capacity must be a positive integer.");
  }
  const spacingMs = Math.max(0, options.minimumSpacingMinutes ?? 15) * 60_000;
  const unplanned: UnplannedWorkloadTask[] = [];
  const remaining: Candidate[] = [];

  for (const task of tasks) {
    const preferred = new Date(task.preferredStart).getTime();
    const earliest = Math.max(preferred, parseTime(task.earliestStart, preferred));
    const deadline = parseTime(task.deadline, Number.POSITIVE_INFINITY);
    const durationMs = task.durationSeconds * 1_000;
    if (![preferred, earliest, deadline].every((value) => !Number.isNaN(value))) {
      unplanned.push({ task, reason: "invalid_time" });
    } else if (!Number.isFinite(durationMs) || durationMs <= 0) {
      unplanned.push({ task, reason: "invalid_duration" });
    } else {
      remaining.push({ task, preferred, earliest, deadline, durationMs });
    }
  }

  const laneAvailable = Array.from({ length: options.capacity }, () => Number.NEGATIVE_INFINITY);
  const phoneAvailable = new Map<string, number>();
  const clientAssignments = new Map<string, number>();
  const planned: PlannedWorkloadTask[] = [];

  while (remaining.length > 0) {
    const placements: Placement[] = remaining.map((candidate) => {
      let bestLane = 0;
      let bestStart = Number.POSITIVE_INFINITY;
      const phoneStart = candidate.task.phoneId
        ? phoneAvailable.get(candidate.task.phoneId) ?? Number.NEGATIVE_INFINITY
        : Number.NEGATIVE_INFINITY;
      for (let lane = 0; lane < laneAvailable.length; lane += 1) {
        const start = Math.max(candidate.earliest, laneAvailable[lane], phoneStart);
        if (start < bestStart) {
          bestLane = lane;
          bestStart = start;
        }
      }
      return {
        ...candidate,
        lane: bestLane,
        start: bestStart,
        end: bestStart + candidate.durationMs,
      };
    });

    placements.sort((left, right) =>
      left.start - right.start
      || (clientAssignments.get(left.task.clientId) ?? 0) - (clientAssignments.get(right.task.clientId) ?? 0)
      || left.deadline - right.deadline
      || left.preferred - right.preferred
      || left.task.clientId.localeCompare(right.task.clientId)
      || left.task.id.localeCompare(right.task.id),
    );
    const chosen = placements[0];
    const remainingIndex = remaining.findIndex((candidate) => candidate.task.id === chosen.task.id);
    remaining.splice(remainingIndex, 1);

    if (chosen.end > chosen.deadline) {
      unplanned.push({ task: chosen.task, reason: "deadline_exceeded" });
      continue;
    }

    const availableAt = chosen.end + spacingMs;
    laneAvailable[chosen.lane] = availableAt;
    if (chosen.task.phoneId) phoneAvailable.set(chosen.task.phoneId, availableAt);
    clientAssignments.set(
      chosen.task.clientId,
      (clientAssignments.get(chosen.task.clientId) ?? 0) + 1,
    );
    planned.push({
      ...chosen.task,
      lane: chosen.lane,
      startAt: new Date(chosen.start).toISOString(),
      endAt: new Date(chosen.end).toISOString(),
      shiftedByMinutes: Math.round((chosen.start - chosen.preferred) / 60_000),
    });
  }

  return { planned, unplanned };
}

