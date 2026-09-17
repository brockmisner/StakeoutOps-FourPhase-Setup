export function addMilliseconds(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

function formatDuoPlusDateParts(
  date: Date,
  timeZone: string,
  includeSeconds: boolean,
): string {
  if (Number.isNaN(date.getTime())) throw new Error("Cannot format an invalid date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const minutePrecision = `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
  return includeSeconds ? `${minutePrecision}:${part("second")}` : minutePrecision;
}

/** DuoPlus addTask image issue_at uses minute precision. */
export function formatDuoPlusDate(date: Date, timeZone = "UTC"): string {
  return formatDuoPlusDateParts(date, timeZone, false);
}

/** DuoPlus taskList range filters require second precision. */
export function formatDuoPlusTaskListDate(
  date: Date,
  timeZone = "UTC",
): string {
  return formatDuoPlusDateParts(date, timeZone, true);
}

export function duoPlusTaskLookupWindow(issueAt: Date, timeZone = "UTC"): {
  start: string;
  end: string;
} {
  return {
    start: formatDuoPlusTaskListDate(
      addMilliseconds(issueAt, -10 * 60_000),
      timeZone,
    ),
    end: formatDuoPlusTaskListDate(
      addMilliseconds(issueAt, 10 * 60_000),
      timeZone,
    ),
  };
}
