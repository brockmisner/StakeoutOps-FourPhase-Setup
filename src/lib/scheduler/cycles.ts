export type CycleRuleWindow = {
  ruleKind: "daily_range" | "day_range" | "window_once";
  startDay: number;
  endDay: number;
};

export type CycleOccurrence = {
  cycleDay: number;
  occurrenceKey: string;
  windowStartDay: number;
  windowEndDay: number;
};

/**
 * Pure mirror of the database cycle compiler. The SQL function remains the
 * authoritative writer; this helper powers previews and boundary tests.
 */
export function expandCycleRule(
  rule: CycleRuleWindow,
  durationDays: number,
): CycleOccurrence[] {
  if (!Number.isInteger(durationDays) || durationDays < 15 || durationDays > 36) {
    throw new Error("Cycle duration must be between 15 and 36 days");
  }
  if (
    !Number.isInteger(rule.startDay) ||
    !Number.isInteger(rule.endDay) ||
    rule.startDay < 1 ||
    rule.endDay < rule.startDay ||
    rule.endDay > durationDays
  ) {
    throw new Error("Cycle rule must fit inside the cycle duration");
  }
  if (rule.ruleKind === "window_once") {
    if (rule.startDay === rule.endDay) {
      throw new Error("A one-time window must span at least two days");
    }
    return [
      {
        cycleDay: rule.startDay,
        occurrenceKey: `window:${rule.startDay}-${rule.endDay}`,
        windowStartDay: rule.startDay,
        windowEndDay: rule.endDay,
      },
    ];
  }
  return Array.from(
    { length: rule.endDay - rule.startDay + 1 },
    (_, index) => {
      const day = rule.startDay + index;
      return {
        cycleDay: day,
        occurrenceKey: `day:${day}`,
        windowStartDay: day,
        windowEndDay: day,
      };
    },
  );
}

export function plannedCycleRunCount(
  rules: CycleRuleWindow[],
  durationDays: number,
): number {
  return rules.reduce(
    (total, rule) => total + expandCycleRule(rule, durationDays).length,
    0,
  );
}

export function standardPresenceRules(durationDays: number): CycleRuleWindow[] {
  return [
    ...Array.from({ length: 5 }, () => ({
      ruleKind: "daily_range" as const,
      startDay: 1,
      endDay: durationDays,
    })),
    ...Array.from({ length: 3 }, () => ({
      ruleKind: "window_once" as const,
      startDay: 10,
      endDay: 11,
    })),
    ...Array.from({ length: 2 }, () => ({
      ruleKind: "day_range" as const,
      startDay: 11,
      endDay: 13,
    })),
  ];
}
