import { CronExpressionParser } from "cron-parser";

export interface ScheduleOccurrenceOptions {
  cronExpression: string;
  timeZone: string;
  nextRunAt: Date;
  horizonEnd: Date;
  maxOccurrences?: number;
}

/**
 * Expands a schedule into absolute instants. `cron-parser` evaluates wall-clock
 * time in `timeZone`, including DST transitions; the returned Dates are UTC
 * instants suitable for timestamptz and DuoPlus issue_at formatting.
 */
export function computeScheduleOccurrences(
  options: ScheduleOccurrenceOptions,
): Date[] {
  const maxOccurrences = options.maxOccurrences ?? 500;
  if (!Number.isInteger(maxOccurrences) || maxOccurrences < 1) {
    throw new Error("maxOccurrences must be a positive integer");
  }
  if (!options.cronExpression.trim()) throw new Error("cronExpression is required");
  if (!options.timeZone.trim()) throw new Error("timeZone is required");
  if (Number.isNaN(options.nextRunAt.getTime())) throw new Error("nextRunAt is invalid");
  if (Number.isNaN(options.horizonEnd.getTime())) throw new Error("horizonEnd is invalid");
  if (options.nextRunAt > options.horizonEnd) return [];

  const occurrences = [new Date(options.nextRunAt)];
  if (occurrences.length >= maxOccurrences) return occurrences;

  const expression = CronExpressionParser.parse(options.cronExpression, {
    currentDate: options.nextRunAt,
    endDate: options.horizonEnd,
    tz: options.timeZone,
  });

  while (occurrences.length < maxOccurrences && expression.hasNext()) {
    const next = expression.next().toDate();
    if (next > options.horizonEnd) break;
    const previous = occurrences.at(-1);
    if (!previous || previous.getTime() !== next.getTime()) occurrences.push(next);
  }

  return occurrences;
}

export function nextScheduleOccurrence(options: {
  cronExpression: string;
  timeZone: string;
  after: Date;
}): Date {
  return CronExpressionParser.parse(options.cronExpression, {
    currentDate: options.after,
    tz: options.timeZone,
  })
    .next()
    .toDate();
}
