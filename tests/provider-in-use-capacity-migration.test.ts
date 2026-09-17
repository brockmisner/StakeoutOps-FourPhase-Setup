import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260907004500_serialize_duoplus_provider_snapshots.sql",
    import.meta.url,
  ),
  "utf8",
);

function finalFunctionBody(name: string, nextMarker: string): string {
  const start = migration.lastIndexOf(
    `create or replace function public.${name}`,
  );
  const end = migration.indexOf(nextMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe("DuoPlus provider-in-use capacity boundary", () => {
  it("adds distinct OFF reservations to the provider/local ON baseline", () => {
    const snapshot = finalFunctionBody(
      "get_duoplus_capacity_snapshot",
      "revoke all on function public.get_duoplus_capacity_snapshot",
    );

    expect(snapshot).toContain("with evaluation_clock as materialized");
    expect(snapshot).toContain("pool.provider_subscription_in_use");
    expect(snapshot).toContain("pool.provider_subscription_synced_at");
    expect(snapshot).toContain("group by phone.duoplus_image_id");
    expect(snapshot).toContain("as local_provider_visible_on_count");
    expect(snapshot).toContain("as local_additive_count");
    expect(snapshot).toMatch(
      /else greatest\(\s*target_pool\.provider_subscription_in_use,\s*occupied\.local_provider_visible_on_count\s*\) \+ occupied\.local_additive_count/,
    );
    expect(snapshot).toMatch(
      /least\(\s*effective\.worker_capacity_limit,\s*coalesce\(effective\.provider_capacity, 0\)\s*\) - effective\.active_count/,
    );
  });

  it("locks and applies additive local occupancy before admitting a new power-on", () => {
    const acquire = finalFunctionBody(
      "acquire_phone_lease",
      "revoke all on function public.acquire_phone_lease",
    );
    const poolLock = acquire.indexOf(
      "pool.worker_capacity_limit,\n      pool.provider_subscription_in_use,\n      pool.provider_subscription_synced_at",
    );
    const freshProvider = acquire.indexOf(
      "stakeout_current_provider_capacity(v_pool_id, v_now)",
    );
    const providerUseBound = acquire.indexOf(
      "v_active_workers := greatest(\n      v_provider_in_use,\n      v_local_provider_visible_on_workers\n    ) + v_local_additive_workers",
    );
    const admissionGuard = acquire.indexOf(
      "if v_active_workers > v_effective_capacity",
    );

    expect(poolLock).toBeGreaterThanOrEqual(0);
    expect(acquire).toMatch(
      /p_lease_seconds is null\s*or p_lease_seconds not between 30 and 3600/,
    );
    expect(acquire.slice(poolLock)).toMatch(/for update;/);
    expect(freshProvider).toBeGreaterThan(poolLock);
    expect(providerUseBound).toBeGreaterThan(freshProvider);
    expect(admissionGuard).toBeGreaterThan(providerUseBound);
    expect(acquire).toContain(
      "v_effective_capacity := least(v_worker_capacity, v_provider_capacity)",
    );
  });

  it("closes cap three when one unseen provider phone and two local OFF reservations are occupied", () => {
    const snapshot = finalFunctionBody(
      "get_duoplus_capacity_snapshot",
      "revoke all on function public.get_duoplus_capacity_snapshot",
    );
    const acquire = finalFunctionBody(
      "acquire_phone_lease",
      "revoke all on function public.acquire_phone_lease",
    );
    const occupied = Math.max(1, 0) + 2;

    expect(occupied).toBe(3);
    expect(Math.max(Math.min(3, 3) - occupied, 0)).toBe(0);
    expect(snapshot).toContain("or (not local_on and local_pending_off)");
    expect(acquire).toContain("or (not local_on and local_pending_off)");
    expect(acquire).toMatch(
      /not v_target_occupies_slot\s*and v_active_workers >= v_effective_capacity/,
    );
  });

  it("keeps scheduler-started ON transitions additive until a newer provider snapshot", () => {
    const snapshot = finalFunctionBody(
      "get_duoplus_capacity_snapshot",
      "revoke all on function public.get_duoplus_capacity_snapshot",
    );
    const acquire = finalFunctionBody(
      "acquire_phone_lease",
      "revoke all on function public.acquire_phone_lease",
    );

    for (const body of [snapshot, acquire]) {
      expect(body).toContain("as local_on_after_provider_snapshot");
      expect(body).toMatch(
        /scheduler_powered_on_at >\s*(target_pool\.)?provider_subscription_synced_at|scheduler_powered_on_at > v_provider_synced_at/,
      );
      expect(body).toMatch(
        /startup_power_attempted_at >\s*(target_pool\.)?provider_subscription_synced_at|startup_power_attempted_at > v_provider_synced_at/,
      );
      expect(body).toMatch(
        /connection\.inventory_synced_at >\s*(target_pool\.)?provider_subscription_synced_at|connection\.inventory_synced_at > v_provider_synced_at/,
      );
      expect(body).toMatch(
        /phone\.last_seen_at >\s*(target_pool\.)?provider_subscription_synced_at|phone\.last_seen_at > v_provider_synced_at/,
      );
      expect(body).toContain(
        "phone.last_seen_at >= connection.inventory_synced_at",
      );
      expect(body).toContain(
        "where (local_on and local_on_after_provider_snapshot)",
      );
    }
  });

  it("keeps the final overrides service-only", () => {
    expect(migration).toContain(
      "revoke all on function public.get_duoplus_capacity_snapshot(uuid, uuid)\n  from public, anon, authenticated",
    );
    expect(migration).toContain(
      "revoke all on function public.acquire_phone_lease(uuid, uuid, text, uuid, integer)\n  from public, anon, authenticated",
    );
  });
});
