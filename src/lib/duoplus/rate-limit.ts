export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(milliseconds: number): Promise<void>;
}

export interface RateSlotAllocator {
  reserve(connectionId: string, minGapMs: number): Promise<Date>;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const systemSleeper: Sleeper = {
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/**
 * Useful for tests and single-process scripts. Production should use the
 * Supabase RPC allocator so separate Vercel instances share one reservation.
 */
export class InMemoryRateSlotAllocator implements RateSlotAllocator {
  private readonly nextByConnection = new Map<string, number>();

  constructor(private readonly clock: Clock = systemClock) {}

  async reserve(connectionId: string, minGapMs: number): Promise<Date> {
    const now = this.clock.now().getTime();
    const slot = Math.max(now, this.nextByConnection.get(connectionId) ?? now);
    this.nextByConnection.set(connectionId, slot + Math.max(0, minGapMs));
    return new Date(slot);
  }
}

interface SupabaseRpcResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface SupabaseRpcClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<SupabaseRpcResult<unknown>>;
}

function reservationFromRpc(value: unknown): Date {
  let candidate = value;
  if (Array.isArray(value)) candidate = value[0];
  if (candidate && typeof candidate === "object") {
    const record = candidate as Record<string, unknown>;
    candidate =
      record.reserved_at ?? record.slot_at ?? record.reserve_duoplus_rate_slot;
  }
  if (typeof candidate !== "string" && typeof candidate !== "number") {
    throw new Error("reserve_duoplus_rate_slot returned no timestamp");
  }
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    throw new Error("reserve_duoplus_rate_slot returned an invalid timestamp");
  }
  return date;
}

export class SupabaseRateSlotAllocator implements RateSlotAllocator {
  constructor(private readonly supabase: SupabaseRpcClient) {}

  async reserve(connectionId: string, minGapMs: number): Promise<Date> {
    const { data, error } = await this.supabase.rpc(
      "reserve_duoplus_rate_slot",
      {
        p_connection_id: connectionId,
        p_min_gap_ms: minGapMs,
      },
    );
    if (error) throw new Error(`Unable to reserve DuoPlus rate slot: ${error.message}`);
    return reservationFromRpc(data);
  }
}

export async function waitForReservedSlot(
  allocator: RateSlotAllocator,
  connectionId: string,
  minGapMs: number,
  options: { clock?: Clock; sleeper?: Sleeper } = {},
): Promise<Date> {
  const clock = options.clock ?? systemClock;
  const sleeper = options.sleeper ?? systemSleeper;
  const slot = await allocator.reserve(connectionId, minGapMs);
  const waitMs = slot.getTime() - clock.now().getTime();
  if (waitMs > 0) await sleeper.sleep(waitMs);
  return slot;
}
