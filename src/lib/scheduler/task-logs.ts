import { isDuoPlusEvidenceAction } from "@/lib/duoplus/action-types";
import type { DuoPlusTaskLog, JsonValue } from "@/lib/duoplus/types";

export interface StoredTaskLogSummary {
  id: string | null;
  /** DuoPlus action identifier only (for example OPEN_APP or CLICK_ELEMENT). */
  action: string | null;
  successful: boolean | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  screenshots: string[];
}

export interface StoredTaskActionCount {
  action: string;
  total: number;
  successful: number;
  failed: number;
  unknown: number;
}

export interface StoredTaskActionSummary {
  total: number;
  successful: number;
  failed: number;
  unknown: number;
  byAction: StoredTaskActionCount[];
}

export interface StoredTaskLogEvidence {
  schemaVersion: 2;
  /** Action telemetry is proof only. Readiness points come from the run outcome. */
  actionTelemetryPoints: 0;
  totalLogEntries: number;
  storedLogEntries: number;
  truncated: boolean;
  actions: StoredTaskActionSummary;
  entries: StoredTaskLogSummary[];
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function screenshotCandidates(log: DuoPlusTaskLog): unknown[] {
  const screenshot = log.result_info?.extra_data?.screenshot;
  return Array.isArray(screenshot) ? screenshot : [screenshot];
}

function safeOpaqueId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    return null;
  }
  // Numeric strings in phone-number lengths are not useful enough to retain
  // when evidence belongs to privacy-sensitive account profiles.
  return /^\d{8,15}$/.test(value) ? null : value;
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[ .]\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/.test(
    value,
  )
    ? value
    : null;
}

function safeAction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const action = value.trim().toUpperCase();
  return isDuoPlusEvidenceAction(action) ? action : null;
}

function actionResult(log: DuoPlusTaskLog): boolean | null {
  if (typeof log.result_info?.result === "boolean") return log.result_info.result;
  return typeof log.result === "boolean" ? log.result : null;
}

function actionError(log: DuoPlusTaskLog): string | null {
  const value =
    typeof log.result_info?.error_message === "string"
      ? log.result_info.error_message
      : log.error_message;
  return typeof value === "string" && value.trim()
    ? "DuoPlus action error (details withheld)"
    : null;
}

function summarizeActions(logs: DuoPlusTaskLog[]): StoredTaskActionSummary {
  const counts = new Map<string, StoredTaskActionCount>();
  for (const log of logs) {
    const action = safeAction(log.result_info?.action);
    if (!action) continue;
    const successful = actionResult(log);
    const count = counts.get(action) ?? {
      action,
      total: 0,
      successful: 0,
      failed: 0,
      unknown: 0,
    };
    count.total += 1;
    if (successful === true) count.successful += 1;
    else if (successful === false) count.failed += 1;
    else count.unknown += 1;
    counts.set(action, count);
  }

  const byAction = [...counts.values()].sort((left, right) =>
    left.action.localeCompare(right.action),
  );
  return byAction.reduce<StoredTaskActionSummary>(
    (summary, count) => ({
      total: summary.total + count.total,
      successful: summary.successful + count.successful,
      failed: summary.failed + count.failed,
      unknown: summary.unknown + count.unknown,
      byAction: summary.byAction.concat(count),
    }),
    { total: 0, successful: 0, failed: 0, unknown: 0, byAction: [] },
  );
}

export function summarizeTaskLogs(logs: DuoPlusTaskLog[]): {
  summaries: StoredTaskLogSummary[];
  screenshots: string[];
  evidence: StoredTaskLogEvidence;
} {
  const summaries = logs.slice(0, 250).map((log) => {
    const screenshots = screenshotCandidates(log)
      .map(safeUrl)
      .filter((url): url is string => Boolean(url));
    const action = safeAction(log.result_info?.action);
    return {
      id: safeOpaqueId(log.id),
      action,
      successful: action ? actionResult(log) : null,
      errorMessage: actionError(log),
      startedAt: safeTimestamp(log.start_at),
      finishedAt: safeTimestamp(log.finish_at),
      createdAt: safeTimestamp(log.created_at),
      screenshots,
    };
  });
  const screenshots = [...new Set(summaries.flatMap((entry) => entry.screenshots))].slice(
    0,
    100,
  );
  const evidence: StoredTaskLogEvidence = {
    schemaVersion: 2,
    actionTelemetryPoints: 0,
    totalLogEntries: logs.length,
    storedLogEntries: summaries.length,
    truncated: logs.length > summaries.length,
    actions: summarizeActions(logs),
    entries: summaries,
  };
  return { summaries, screenshots, evidence };
}

export function taskLogEvidenceAsJson(evidence: StoredTaskLogEvidence): JsonValue {
  return evidence as unknown as JsonValue;
}
