import { DuoPlusApiError } from "./errors";
import type { DuoPlusEnvelope } from "./types";

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return (
    normalized === "iv" ||
    normalized.includes("apikey") ||
    normalized.includes("accesskey") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("credential") ||
    normalized.includes("password") ||
    normalized.includes("privatekey") ||
    /^proxy(user(name)?|login)$/.test(normalized) ||
    normalized.includes("secret") ||
    normalized.includes("session") ||
    normalized.includes("token") ||
    normalized.includes("ciphertext") ||
    normalized.includes("authtag")
  );
}

export function redactDuoPlusValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactDuoPlusValue(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : redactDuoPlusValue(item, seen),
    ]),
  );
}

export function redactKnownSecrets(value: unknown, secrets: string[]): unknown {
  const literals = secrets.filter((secret) => secret.length >= 4);
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      return literals.reduce(
        (text, secret) => text.split(secret).join("[REDACTED]"),
        candidate,
      );
    }
    if (!candidate || typeof candidate !== "object") return candidate;
    if (seen.has(candidate)) return "[Circular]";
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.map(visit);
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : visit(item),
      ]),
    );
  };
  return visit(value);
}

export interface CompactAuditOptions {
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
}

/** Bounds audit payloads and drops binary-looking data before database writes. */
export function compactDuoPlusAuditValue(
  value: unknown,
  options: CompactAuditOptions = {},
): unknown {
  const maxDepth = options.maxDepth ?? 5;
  const maxArrayItems = options.maxArrayItems ?? 25;
  const maxObjectKeys = options.maxObjectKeys ?? 40;
  const maxStringLength = options.maxStringLength ?? 2_000;
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown, depth: number): unknown => {
    if (candidate === null || candidate === undefined) return candidate;
    if (typeof candidate === "string") {
      const looksBinary =
        candidate.startsWith("data:image/") ||
        (candidate.length > 4_096 && /^[A-Za-z0-9+/=\r\n]+$/.test(candidate));
      if (looksBinary) return `[OMITTED_BINARY:${candidate.length}]`;
      return candidate.length > maxStringLength
        ? `${candidate.slice(0, maxStringLength)}…[TRUNCATED:${candidate.length}]`
        : candidate;
    }
    if (typeof candidate !== "object") return candidate;
    if (depth >= maxDepth) return "[MAX_DEPTH]";
    if (seen.has(candidate)) return "[Circular]";
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      const values = candidate
        .slice(0, maxArrayItems)
        .map((item) => visit(item, depth + 1));
      if (candidate.length > maxArrayItems) {
        values.push(`[TRUNCATED_ITEMS:${candidate.length - maxArrayItems}]`);
      }
      return values;
    }

    const entries = Object.entries(candidate as Record<string, unknown>);
    const compacted = Object.fromEntries(
      entries.slice(0, maxObjectKeys).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : visit(item, depth + 1),
      ]),
    );
    if (entries.length > maxObjectKeys) {
      compacted._truncated_keys = entries.length - maxObjectKeys;
    }
    return compacted;
  };

  return visit(value, 0);
}

export function parseDuoPlusEnvelope<T>(
  value: unknown,
  endpoint: string,
  httpStatus = 200,
): T {
  if (!value || typeof value !== "object") {
    throw new DuoPlusApiError({
      endpoint,
      httpStatus,
      message: `${endpoint} returned a non-JSON response`,
      retryable: httpStatus >= 500 || httpStatus === 429,
    });
  }

  const envelope = value as Partial<DuoPlusEnvelope<T>>;
  if (typeof envelope.code !== "number") {
    throw new DuoPlusApiError({
      endpoint,
      httpStatus,
      message: `${endpoint} returned an invalid DuoPlus envelope`,
      retryable: httpStatus >= 500 || httpStatus === 429,
    });
  }

  if (envelope.code !== 200) {
    const message = envelope.message ?? envelope.msg ?? "DuoPlus request failed";
    throw new DuoPlusApiError({
      endpoint,
      httpStatus,
      duoCode: envelope.code,
      message: `${endpoint} ${envelope.code}: ${message}`,
      retryable:
        envelope.code !== 401 &&
        (envelope.code === 429 || envelope.code >= 500 || httpStatus >= 500),
    });
  }

  return envelope.data as T;
}

export function extractDuoPlusList<T>(
  value: unknown,
  endpoint = "DuoPlus list endpoint",
): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["list", "rows", "items", "data"]) {
      if (Array.isArray(record[key])) return record[key] as T[];
    }
  }

  // A legitimate empty inventory still has a documented list-shaped value
  // (`list: []`). Treating an unknown code-200 payload as an empty list would
  // let callers erase cached inventory and persist zero capacity as fresh.
  throw new DuoPlusApiError({
    endpoint,
    message: `${endpoint} returned an invalid list payload`,
    retryable: true,
  });
}

export function extractDuoPlusCursor(value: unknown): string | number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidate = record.next_cursor_id ?? record.cursor_id ?? record.next_cursor;
  return typeof candidate === "string" || typeof candidate === "number"
    ? candidate
    : null;
}

export function extractDuoPlusTotalPages(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).total_page;
  const totalPages =
    typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && candidate.trim()
        ? Number(candidate)
        : Number.NaN;
  return Number.isInteger(totalPages) && totalPages >= 0 ? totalPages : null;
}

export function extractDuoPlusTotal(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).total;
  const total =
    typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && candidate.trim()
        ? Number(candidate)
        : Number.NaN;
  return Number.isInteger(total) && total >= 0 ? total : null;
}
