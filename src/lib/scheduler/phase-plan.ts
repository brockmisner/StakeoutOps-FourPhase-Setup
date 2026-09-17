import { z } from "zod";

export type CyclePhaseKind = "warmup" | "money" | "final_squeeze" | "after_action";
export type RulePhaseKind = "baseline" | CyclePhaseKind;

const appRequirementSchema = z.object({
  appKind: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{0,31}$/),
  minSuccessfulRuns: z.number().int().min(0).max(1_800),
  minActiveDays: z.number().int().min(0).max(36),
}).strict().refine(
  (requirement) => requirement.minSuccessfulRuns > 0 || requirement.minActiveDays > 0,
  { message: "An app requirement must specify successful runs or active days" },
);

/** Operator-defined completion requirements, not a claim about profile trust. */
export const phasePlanSchema = z.object({
  version: z.literal(1),
  warmupDays: z.number().int().min(10).max(14),
  moneyDays: z.number().int().min(2).max(5),
  finalSqueezeDays: z.number().int().min(1).max(3),
  afterActionDays: z.number().int().min(10).max(14),
  continueDailyTasks: z.boolean(),
  appRequirements: z.array(appRequirementSchema).max(32),
}).strict().superRefine((plan, context) => {
  const duration = plan.warmupDays + plan.moneyDays + plan.finalSqueezeDays + plan.afterActionDays;
  if (duration < 23 || duration > 36) {
    context.addIssue({ code: "custom", message: "A four-phase cycle must last 23–36 days" });
  }
  const apps = new Set<string>();
  plan.appRequirements.forEach((requirement, index) => {
    if (apps.has(requirement.appKind)) {
      context.addIssue({
        code: "custom",
        path: ["appRequirements", index, "appKind"],
        message: "Each app may have only one completion requirement",
      });
    }
    apps.add(requirement.appKind);
    if (requirement.minActiveDays > plan.warmupDays) {
      context.addIssue({
        code: "custom",
        path: ["appRequirements", index, "minActiveDays"],
        message: "Required active days must fit within warmup",
      });
    }
  });
});

export type PhasePlan = z.infer<typeof phasePlanSchema>;
export type AppRequirement = PhasePlan["appRequirements"][number];

export const defaultPhasePlan: PhasePlan = {
  version: 1,
  warmupDays: 10,
  moneyDays: 3,
  finalSqueezeDays: 3,
  afterActionDays: 14,
  continueDailyTasks: true,
  appRequirements: [],
};

export type PhaseWindow = {
  kind: CyclePhaseKind;
  label: string;
  startDay: number;
  endDay: number;
  days: number;
};

const phaseDefinitions: Array<{
  kind: CyclePhaseKind;
  label: string;
  durationKey: "warmupDays" | "moneyDays" | "finalSqueezeDays" | "afterActionDays";
}> = [
  { kind: "warmup", label: "Warmup", durationKey: "warmupDays" },
  { kind: "money", label: "Money", durationKey: "moneyDays" },
  { kind: "final_squeeze", label: "Final squeeze", durationKey: "finalSqueezeDays" },
  { kind: "after_action", label: "After action", durationKey: "afterActionDays" },
];

export function phasePlanDuration(plan: PhasePlan): number {
  return plan.warmupDays + plan.moneyDays + plan.finalSqueezeDays + plan.afterActionDays;
}

/** Inclusive relative days, with no gaps or overlap between phases. */
export function phaseWindows(plan: PhasePlan): PhaseWindow[] {
  let startDay = 1;
  return phaseDefinitions.map(({ kind, label, durationKey }) => {
    const days = plan[durationKey];
    const window = { kind, label, startDay, endDay: startDay + days - 1, days };
    startDay += days;
    return window;
  });
}

export function phaseWindowForRule(
  plan: PhasePlan,
  kind: RulePhaseKind,
): { startDay: number; endDay: number } {
  if (kind === "baseline") {
    return { startDay: 1, endDay: plan.continueDailyTasks ? phasePlanDuration(plan) : plan.warmupDays };
  }
  const window = phaseWindows(plan).find((phase) => phase.kind === kind);
  if (!window) throw new Error("Unknown cycle phase");
  return { startDay: window.startDay, endDay: window.endDay };
}

/** Calendar position only. Completion gates can keep a profile in an earlier phase. */
export function phaseForDay(plan: PhasePlan, day: number): CyclePhaseKind | null {
  if (!Number.isInteger(day)) return null;
  return phaseWindows(plan).find((window) => day >= window.startDay && day <= window.endDay)?.kind ?? null;
}

export type PhaseTaskCounts = {
  baseline: number;
  money: number;
  final_squeeze: number;
  after_action: number;
  warmup?: number;
};

export type PhaseTaskSlot = {
  id: string;
  name: string;
  phaseKind: RulePhaseKind;
  startDay: number;
  endDay: number;
  ruleKind: "daily_range";
  appKind: string;
  localTime: string;
  points: 1;
  expectedDurationSeconds: 600;
};

const taskCountsSchema = z.object({
  baseline: z.number().int().min(5).max(50),
  money: z.number().int().min(3).max(4),
  final_squeeze: z.number().int().min(4).max(7),
  after_action: z.number().int().min(3).max(5),
  warmup: z.number().int().min(0).max(50),
}).strict().refine(
  (counts) => counts.baseline + counts.warmup + counts.money + counts.final_squeeze + counts.after_action <= 50,
  { message: "A cycle program supports at most 50 task rules" },
);

const defaultTaskCounts: Required<PhaseTaskCounts> = {
  baseline: 5,
  warmup: 0,
  money: 4,
  final_squeeze: 6,
  after_action: 4,
};

const defaultApps = ["chrome", "maps", "google", "waze", "gmail"];

/**
 * Slots require an operator-selected RPA template before they can run. Times are
 * editable draft preferences; this helper does not reserve startup capacity.
 * IDs stay stable across changes to counts and phase durations so chosen
 * templates and task variables can be retained by the caller.
 */
export function buildPhaseTaskSlots(
  plan: PhasePlan,
  counts: Partial<PhaseTaskCounts> = {},
): PhaseTaskSlot[] {
  const parsedPlan = phasePlanSchema.parse(plan);
  const parsedCounts = taskCountsSchema.parse({ ...defaultTaskCounts, ...counts });
  const maxDailyTasks = parsedCounts.baseline + Math.max(
    parsedCounts.warmup, parsedCounts.money, parsedCounts.final_squeeze, parsedCounts.after_action,
  );
  const kinds: RulePhaseKind[] = ["baseline", "warmup", "money", "final_squeeze", "after_action"];
  return kinds.flatMap((phaseKind) => {
    const window = phaseWindowForRule(parsedPlan, phaseKind);
    const label = phaseKind === "baseline" ? "Daily routine"
      : phaseKind === "warmup" ? "Warmup-only"
        : phaseDefinitions.find((phase) => phase.kind === phaseKind)!.label;
    return Array.from({ length: parsedCounts[phaseKind] }, (_, index) => {
      const position = index + (phaseKind === "baseline" ? 0 : parsedCounts.baseline);
      // Spread preferences over 08:00–20:00. Actual fit is checked by the planner.
      const localMinutes = 8 * 60 + Math.floor(position * 12 * 60 / maxDailyTasks);
      const localTime = `${String(Math.floor(localMinutes / 60)).padStart(2, "0")}:${String(localMinutes % 60).padStart(2, "0")}`;
      return {
        id: `${phaseKind}-${index + 1}`,
        name: `${label} task ${index + 1}`,
        phaseKind,
        ...window,
        ruleKind: "daily_range" as const,
        appKind: defaultApps[index % defaultApps.length],
        localTime,
        points: 1 as const,
        expectedDurationSeconds: 600 as const,
      };
    });
  });
}

export type SuccessfulAppOccurrence = {
  appKind: string;
  /** Unique logical run identity within this profile, including its rule. */
  occurrenceKey: string;
  completedAt: string | Date;
};

export type AppRequirementProgress = AppRequirement & {
  successfulRuns: number;
  activeDays: number;
  complete: boolean;
  reasons: Array<"missing_successful_runs" | "missing_active_days">;
};

/**
 * Evaluate one profile's confirmed successes. Duplicate deliveries/retries count
 * once. When duplicate evidence disagrees about time, use the earliest confirmed
 * success, independent of input order. Active days use actual completion dates
 * in the provided IANA timezone, never planned dates or elapsed cycle days.
 */
export function computeAppRequirements(
  requirements: readonly AppRequirement[],
  successfulOccurrences: readonly SuccessfulAppOccurrence[],
  timezone = "UTC",
): AppRequirementProgress[] {
  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const mergedRequirements = new Map<string, AppRequirement>();
  for (const input of requirements) {
    const requirement = appRequirementSchema.parse(input);
    const previous = mergedRequirements.get(requirement.appKind);
    mergedRequirements.set(requirement.appKind, {
      ...requirement,
      minSuccessfulRuns: Math.max(previous?.minSuccessfulRuns ?? 0, requirement.minSuccessfulRuns),
      minActiveDays: Math.max(previous?.minActiveDays ?? 0, requirement.minActiveDays),
    });
  }
  const occurrencesByApp = new Map<string, Map<string, number>>();
  for (const occurrence of successfulOccurrences) {
    const appKind = occurrence.appKind.trim().toLowerCase();
    if (!mergedRequirements.has(appKind) || !occurrence.occurrenceKey.trim()) continue;
    const completedAt = new Date(occurrence.completedAt).getTime();
    if (!Number.isFinite(completedAt)) continue;
    const occurrences = occurrencesByApp.get(appKind) ?? new Map<string, number>();
    occurrences.set(occurrence.occurrenceKey, Math.min(
      occurrences.get(occurrence.occurrenceKey) ?? completedAt,
      completedAt,
    ));
    occurrencesByApp.set(appKind, occurrences);
  }
  return [...mergedRequirements.values()].map((requirement) => {
    const occurrences = occurrencesByApp.get(requirement.appKind) ?? new Map<string, number>();
    const activeDays = new Set([...occurrences.values()].map((timestamp) => dayFormatter.format(timestamp))).size;
    const successfulRuns = occurrences.size;
    const reasons: AppRequirementProgress["reasons"] = [];
    if (successfulRuns < requirement.minSuccessfulRuns) reasons.push("missing_successful_runs");
    if (activeDays < requirement.minActiveDays) reasons.push("missing_active_days");
    return { ...requirement, successfulRuns, activeDays, complete: reasons.length === 0, reasons };
  });
}
