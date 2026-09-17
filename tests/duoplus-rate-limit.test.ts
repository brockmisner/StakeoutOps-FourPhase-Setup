import { describe, expect, it, vi } from "vitest";

import { DuoPlusClient } from "@/lib/duoplus/client";
import {
  InMemoryRateSlotAllocator,
  SupabaseRateSlotAllocator,
  waitForReservedSlot,
  type Clock,
  type Sleeper,
} from "@/lib/duoplus/rate-limit";

class ManualTime implements Clock, Sleeper {
  readonly sleeps: number[] = [];

  constructor(private milliseconds: number) {}

  now(): Date {
    return new Date(this.milliseconds);
  }

  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.milliseconds += milliseconds;
  }
}

describe("DuoPlus one-request-per-second reservation", () => {
  it("spaces reservations for one connection by the configured gap", async () => {
    const time = new ManualTime(Date.UTC(2026, 8, 5, 12));
    const allocator = new InMemoryRateSlotAllocator(time);

    const first = await waitForReservedSlot(allocator, "connection-a", 1_200, {
      clock: time,
      sleeper: time,
    });
    const second = await waitForReservedSlot(allocator, "connection-a", 1_200, {
      clock: time,
      sleeper: time,
    });
    const third = await waitForReservedSlot(allocator, "connection-a", 1_200, {
      clock: time,
      sleeper: time,
    });

    expect(second.getTime() - first.getTime()).toBe(1_200);
    expect(third.getTime() - second.getTime()).toBe(1_200);
    expect(time.sleeps).toEqual([1_200, 1_200]);
  });

  it("keeps independent BYO DuoPlus connections from blocking each other", async () => {
    const time = new ManualTime(Date.UTC(2026, 8, 5, 12));
    const allocator = new InMemoryRateSlotAllocator(time);

    const firstA = await allocator.reserve("friend-a", 1_200);
    const firstB = await allocator.reserve("friend-b", 1_200);
    const secondA = await allocator.reserve("friend-a", 1_200);

    expect(firstB).toEqual(firstA);
    expect(secondA.getTime() - firstA.getTime()).toBe(1_200);
  });

  it("uses the shared Supabase reservation RPC in production", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ reserved_at: "2026-09-05T12:00:01.200Z" }],
      error: null,
    });
    const allocator = new SupabaseRateSlotAllocator({ rpc });

    await expect(allocator.reserve("connection-a", 1_200)).resolves.toEqual(
      new Date("2026-09-05T12:00:01.200Z"),
    );
    expect(rpc).toHaveBeenCalledWith("reserve_duoplus_rate_slot", {
      p_connection_id: "connection-a",
      p_min_gap_ms: 1_200,
    });
  });
});

describe("DuoPlusClient transport", () => {
  it("waits for the reserved slot and sends only server-side POST headers", async () => {
    const time = new ManualTime(Date.UTC(2026, 8, 5, 12));
    const allocator = new InMemoryRateSlotAllocator(time);
    const callTimes: number[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callTimes.push(time.now().getTime());
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "DuoPlus-API-Key": "friend-secret",
          Lang: "en",
        },
      });
      return new Response(JSON.stringify({ code: 200, data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const fetchImpl = fetchMock as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-secret",
      connectionId: "connection-a",
      fetchImpl,
      rateSlotAllocator: allocator,
      clock: time,
      sleeper: time,
      minGapMs: 1_200,
    });

    await client.post("/api/v1/cloudPhone/list", {});
    await client.post("/api/v1/automation/userTemplateList", {});

    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(1_200);
    expect(time.sleeps).toEqual([1_200]);
  });

  it("never retries an invalid API key inside the transport", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: 401, message: "key expired" }), {
        status: 401,
      }),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "expired",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(client.listPhones()).rejects.toMatchObject({
      duoCode: 401,
      retryable: false,
      unauthorized: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("redacts an API key echoed inside an upstream error before logging", async () => {
    const apiKey = "literal-leak-key";
    const logger = { log: vi.fn().mockResolvedValue(undefined) };
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 500,
          message: `DuoPlus reflected ${apiKey} in a generic error`,
        }),
        { status: 500 },
      ),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey,
      connectionId: "connection-a",
      fetchImpl,
      logger,
      minGapMs: 0,
    });

    await expect(client.listPhones()).rejects.toMatchObject({ retryable: true });
    expect(logger.log).toHaveBeenCalledTimes(1);
    const logged = logger.log.mock.calls[0]?.[0];
    expect(JSON.stringify(logged)).not.toContain(apiKey);
    expect(logged).toMatchObject({
      errorMessage: expect.stringContaining("DuoPlus request failed"),
      responseBody: {
        code: 500,
        message: expect.stringContaining("[REDACTED]"),
      },
    });
  });

  it("counts only current Subscription Startup records across both availability pools", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { free_status: 0 | 1 };
      const list = body.free_status === 0
        ? [
            { id: "assigned-current", free_status: 0, expired_at: 1_800_000_000 },
            { id: "assigned-expired", free_status: 0, expired_at: 1_600_000_000 },
          ]
        : [
            { id: "free-current-a", free_status: 1, expired_at: 1_800_000_000 },
            { id: "free-current-b", free_status: 1, expired_at: "1800000000" },
          ];
      return new Response(JSON.stringify({ code: 200, data: { list } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const fetchImpl = fetchMock as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-secret",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(
      client.getSubscriptionStartupCapacity(new Date("2026-09-05T12:00:00.000Z")),
    ).resolves.toEqual({ total: 3, inUse: 1, available: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))))
      .toEqual([
        { free_status: 0, page: 1, pagesize: 100 },
        { free_status: 1, page: 1, pagesize: 100 },
      ]);
  });

  it("keeps renewal-warning startup records in effective capacity until expiration", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { free_status: 0 | 1 };
      const list = body.free_status === 0
        ? [
            { id: "usable", free_status: 0, expired_at: 1_800_000_000, need_renewal: false },
            { id: "overdue-boolean", free_status: 0, expired_at: 1_800_000_000, need_renewal: true },
            { id: "overdue-number", free_status: 0, expired_at: 1_800_000_000, need_renewal: 1 },
          ]
        : [];
      return new Response(JSON.stringify({ code: 200, data: { list } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-secret",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(
      client.getSubscriptionStartupCapacity(new Date("2026-09-05T12:00:00.000Z")),
    ).resolves.toEqual({ total: 3, inUse: 3, available: 0 });
  });

  it("counts a slot returned by both sequential Startup lists once as in use", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { free_status: 0 | 1 };
      const list = body.free_status === 0
        ? [{ id: "transitioning", free_status: 0, expired_at: 1_800_000_000 }]
        : [
            { id: "transitioning", free_status: 1, expired_at: 1_800_000_000 },
            { id: "free", free_status: 1, expired_at: 1_800_000_000 },
          ];
      return new Response(JSON.stringify({ code: 200, data: { list } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-secret",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(
      client.getSubscriptionStartupCapacity(new Date("2026-09-05T12:00:00.000Z")),
    ).resolves.toEqual({ total: 2, inUse: 1, available: 1 });
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["nonnumeric", "not-an-epoch"],
  ])("rejects %s Subscription Startup expiration data", async (_label, expiredAt) => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { free_status: 0 | 1 };
      const list =
        body.free_status === 0
          ? [{ id: "assigned", free_status: 0, expired_at: expiredAt }]
          : [];
      return new Response(JSON.stringify({ code: 200, data: { list } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-secret",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(client.getSubscriptionStartupCapacity()).rejects.toMatchObject({
      name: "DuoPlusApiError",
      retryable: true,
      message: expect.stringContaining("invalid expired_at"),
    });
  });

  it("accepts documented empty Subscription Startup pools as zero capacity", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: { list: [], page: 1, total: 0, total_page: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-secret",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(client.getSubscriptionStartupCapacity()).resolves.toEqual({
      total: 0,
      inUse: 0,
      available: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
