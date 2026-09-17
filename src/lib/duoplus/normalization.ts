import { isIP } from "node:net";

/**
 * Converts DuoPlus's optional phone IP into a value PostgreSQL `inet` accepts.
 * The provider uses an empty string when no address is available.
 */
export function normalizeDuoPlusIpAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : null;
}

/**
 * Converts DuoPlus provider timestamps to the ISO representation expected by
 * PostgreSQL `timestamptz`. DuoPlus phone inventory can return Unix seconds as
 * a string, while other responses use ordinary date strings.
 */
export function normalizeDuoPlusProviderTimestamp(
  value: unknown,
): string | null {
  const candidate =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? value.trim()
        : null;
  if (candidate === null || candidate === "") return null;

  const numeric =
    typeof candidate === "number"
      ? candidate
      : /^\d+(?:\.\d+)?$/.test(candidate)
        ? Number(candidate)
        : Number.NaN;
  const milliseconds = Number.isFinite(numeric)
    ? numeric >= 100_000_000_000
      ? numeric
      : numeric * 1_000
    : typeof candidate === "string"
      ? Date.parse(candidate)
      : Number.NaN;
  if (!Number.isFinite(milliseconds)) return null;

  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
