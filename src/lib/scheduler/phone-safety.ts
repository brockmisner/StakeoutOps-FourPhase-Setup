import { DUOPLUS_PHONE_STATUS } from "@/lib/duoplus/types";

import type { DuoPhoneRow } from "./types";

/**
 * Fast application-layer guard for new work. The database lease repeats this
 * check under a row lock, which is the authoritative race-free boundary.
 */
export function isPhoneEligibleForNewWork(
  phone: Pick<
    DuoPhoneRow,
    "enabled" | "provider_present" | "status" | "expired_at"
  >,
  now = new Date(),
): boolean {
  if (!phone.enabled || phone.provider_present === false) return false;
  if (
    phone.status === DUOPLUS_PHONE_STATUS.EXPIRED ||
    phone.status === DUOPLUS_PHONE_STATUS.RENEWAL_OVERDUE
  ) {
    return false;
  }
  if (phone.expired_at === null) return true;
  const expiration = new Date(phone.expired_at).getTime();
  // Inventory should contain a valid timestamptz. Fail closed if a malformed
  // value reaches application code instead of treating it as unexpired.
  return Number.isFinite(expiration) && expiration > now.getTime();
}

function timezoneOffsetMilliseconds(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const representedAsUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return representedAsUtc - Math.floor(instant.getTime() / 1_000) * 1_000;
}

/** UTC instant immediately after the cycle's final client-local calendar day. */
export function cycleEndExclusiveInstant(
  endsOn: string,
  timezone: string,
): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endsOn);
  if (!match) throw new Error("Cycle end date is invalid");
  const nextDayWallClock = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + 1,
  ));
  if (Number.isNaN(nextDayWallClock.getTime())) {
    throw new Error("Cycle end date is invalid");
  }

  // Convert client-local midnight to UTC. Re-evaluate the offset to cover a
  // DST transition between the first UTC guess and the target local instant.
  const wallClockMilliseconds = nextDayWallClock.getTime();
  let result = new Date(wallClockMilliseconds);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = new Date(
      wallClockMilliseconds - timezoneOffsetMilliseconds(result, timezone),
    );
    if (next.getTime() === result.getTime()) break;
    result = next;
  }
  return result;
}

/** A dedicated cycle phone must remain paid through its complete local window. */
export function isPhoneEligibleThroughCycle(
  phone: Pick<
    DuoPhoneRow,
    "enabled" | "provider_present" | "status" | "expired_at"
  >,
  endsOn: string,
  timezone: string,
  now = new Date(),
): boolean {
  if (!isPhoneEligibleForNewWork(phone, now)) return false;
  if (phone.expired_at === null) return true;
  const expiration = new Date(phone.expired_at).getTime();
  const requiredThrough = cycleEndExclusiveInstant(endsOn, timezone).getTime();
  return Number.isFinite(expiration) && expiration > requiredThrough;
}
