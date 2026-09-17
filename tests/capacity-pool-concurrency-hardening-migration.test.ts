import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260907003400_capacity_pool_concurrency_hardening.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(name: string, nextMarker: string): string {
  const start = migration.indexOf(`create or replace function public.${name}`);
  const end = migration.indexOf(nextMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe("DuoPlus capacity-pool concurrency hardening migration", () => {
  it("takes migration locks in the runtime connection-to-pool order", () => {
    const connectionLock = migration.indexOf(
      "lock table public.duo_connections in access exclusive mode",
    );
    const poolLock = migration.indexOf(
      "lock table public.duo_capacity_pools in access exclusive mode",
    );
    expect(connectionLock).toBeGreaterThanOrEqual(0);
    expect(poolLock).toBeGreaterThan(connectionLock);
  });

  it("uses the newest valid provider snapshot and honors a zero-capacity downgrade", () => {
    const helper = functionBody(
      "stakeout_current_provider_capacity",
      "revoke all on function public.stakeout_current_provider_capacity",
    );
    expect(helper).toContain(
      "p_as_of timestamptz default clock_timestamp()",
    );
    expect(helper).toContain("connection.subscription_capacity >= 0");
    expect(helper).not.toContain("connection.status = 'active'");
    expect(helper).toContain("p_as_of - interval '60 minutes'");
    expect(helper).toContain("p_as_of + interval '5 minutes'");
    expect(helper).toMatch(
      /order by connection\.subscription_synced_at desc,\s*connection\.subscription_capacity asc,\s*connection\.id\s*limit 1/,
    );
    expect(helper).not.toContain("max(connection.subscription_capacity)");
    expect(migration).not.toContain("max(connection.subscription_capacity)");
  });

  it("reports availability from the effective provider-bounded pool capacity", () => {
    const snapshot = functionBody(
      "get_duoplus_capacity_snapshot",
      "revoke all on function public.get_duoplus_capacity_snapshot",
    );
    expect(snapshot).toContain("count(distinct phone.duoplus_image_id)");
    expect(snapshot).toMatch(
      /least\(\s*target_pool\.worker_capacity_limit,\s*coalesce\(\s*public\.stakeout_current_provider_capacity\(\s*target_pool\.id,\s*clock_timestamp\(\)/,
    );
  });

  it("keeps pool identity service-only and durable across key rotation", () => {
    expect(migration).toContain(
      "create table if not exists public.duo_capacity_pool_fingerprints",
    );
    expect(migration).toContain(
      "alter table public.duo_capacity_pool_fingerprints enable row level security",
    );
    expect(migration).toContain(
      "revoke all on table public.duo_capacity_pool_fingerprints",
    );
    expect(migration).toMatch(
      /constraint duo_capacity_pool_fingerprints_pool_fk[\s\S]*on delete restrict/,
    );
    expect(migration).toMatch(
      /constraint duo_connections_capacity_pool_fk[\s\S]*on delete restrict/,
    );
    expect(migration).toContain(
      "revoke delete, truncate on table public.duo_capacity_pools from service_role",
    );
  });

  it("never implicitly moves an already-linked connection to another pool", () => {
    const link = functionBody(
      "link_duoplus_capacity_pool",
      "revoke all on function public.link_duoplus_capacity_pool",
    );
    expect(link).toContain("if v_existing_pool_id is not null then");
    expect(link).toContain("v_pool_id := v_existing_pool_id");
    expect(link).toContain("errcode = 'P4112'");
    expect(link).toMatch(
      /set capacity_pool_id = v_pool_id,[\s\S]*connection\.capacity_pool_id is null/,
    );
    expect(link.match(/set capacity_pool_id =/g)).toHaveLength(1);
  });

  it("merges a connection's pre-link rate history into its durable pool", () => {
    const link = functionBody(
      "link_duoplus_capacity_pool",
      "revoke all on function public.link_duoplus_capacity_pool",
    );
    expect(link).toMatch(
      /from public\.duo_rate_slots as slot[\s\S]*where slot\.connection_id = p_connection_id[\s\S]*for update/,
    );
    expect(link).toContain(
      "pool.rate_reservation_count + v_legacy_reservation_count",
    );
    expect(link.indexOf("for update;")).toBeLessThan(
      link.indexOf("from public.duo_rate_slots as slot"),
    );
  });

  it("serializes linked requests on pool state with the strictest active gap", () => {
    const reserve = functionBody(
      "reserve_duoplus_rate_slot",
      "revoke all on function public.reserve_duoplus_rate_slot",
    );
    expect(reserve).toContain("from public.duo_capacity_pools as pool");
    expect(reserve).toContain("for update");
    expect(reserve).toContain("max(connection.min_gap_ms)");
    expect(reserve).toContain("connection.status = 'active'");
    expect(reserve).toContain("update public.duo_capacity_pools as pool");
    expect(reserve).toContain(
      "rate_reservation_count = pool.rate_reservation_count + 1",
    );
    expect(reserve).not.toContain("v_canonical_connection_id");
  });

  it("resamples time and revalidates state after acquire's blocking pool lock", () => {
    const acquire = functionBody(
      "acquire_phone_lease",
      "revoke all on function public.acquire_phone_lease",
    );
    expect(acquire).toContain("v_now timestamptz;");
    expect(acquire).not.toContain(
      "v_now timestamptz := clock_timestamp()",
    );
    expect(acquire).toMatch(
      /select pool\.worker_capacity_limit[\s\S]*for update;[\s\S]*v_now := clock_timestamp\(\);[\s\S]*v_run\.lease_expires_at <= v_now/,
    );
    expect(acquire).toContain(
      "stakeout_current_provider_capacity(v_pool_id, v_now)",
    );
    expect(acquire).toContain(
      "v_now + make_interval(secs => p_lease_seconds)",
    );
    expect(acquire.match(/v_now := clock_timestamp\(\);/g)).toHaveLength(2);
    expect(acquire).toMatch(
      /The pool scans above[\s\S]*v_now := clock_timestamp\(\);[\s\S]*v_run\.lease_expires_at <= v_now[\s\S]*v_preserve_startup_reservation :=[\s\S]*stakeout_current_provider_capacity\(v_pool_id, v_now\)[\s\S]*v_phone_lease_until :=\s*v_now/,
    );
  });

  it("uses post-lock provider time for configuration and rejects zero in planning", () => {
    const setCapacity = functionBody(
      "set_duoplus_worker_capacity",
      "revoke all on function public.set_duoplus_worker_capacity",
    );
    expect(setCapacity).toMatch(
      /from public\.duo_capacity_pools as pool[\s\S]*for update;[\s\S]*v_now := clock_timestamp\(\);[\s\S]*stakeout_current_provider_capacity\(v_pool_id, v_now\)/,
    );

    const planner = functionBody(
      "stakeout_plan_cycle_run_workload",
      "revoke all on function public.stakeout_plan_cycle_run_workload",
    );
    expect(planner).toContain("stakeout_current_provider_capacity(");
    expect(planner).toContain(
      "v_provider_capacity is null or v_provider_capacity <= 0",
    );
    expect(planner).toContain("connection.capacity_pool_id = v_pool_id");
  });
});
