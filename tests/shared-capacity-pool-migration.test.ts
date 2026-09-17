import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260907001030_shared_adjustable_startup_worker_pool.sql",
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

describe("shared adjustable DuoPlus Startup worker pool migration", () => {
  it("keeps the credential fingerprint and pool state service-only", () => {
    expect(migration).toMatch(
      /create table if not exists public\.duo_capacity_pools[\s\S]*key_fingerprint text not null unique[\s\S]*worker_capacity_limit integer not null default 3[\s\S]*between 1 and 100/,
    );
    expect(migration).toContain(
      "alter table public.duo_capacity_pools enable row level security",
    );
    expect(migration).toContain(
      "revoke all on table public.duo_capacity_pools from public, anon, authenticated",
    );
    expect(migration).toContain(
      "grant all on table public.duo_capacity_pools to service_role",
    );
    expect(migration).toContain("add column if not exists capacity_pool_id uuid");
  });

  it("counts each occupied physical image once across linked connections", () => {
    const body = functionBody(
      "get_duoplus_capacity_snapshot",
      "revoke all on function public.get_duoplus_capacity_snapshot",
    );
    expect(body).toContain("count(distinct phone.duoplus_image_id)");
    expect(body).toContain("connection.capacity_pool_id = target_pool.id");
    expect(body).toContain("phone.status in (1, 10, 11)");
    expect(body).toContain("phone.lease_expires_at > clock_timestamp()");
    expect(body).toContain("phone.scheduler_power_requested_at is not null");
    expect(body).toContain("phone.scheduler_powered_on_at is not null");
    expect(body).toContain(
      "phone.scheduler_power_requested_at + interval '15 minutes'",
    );
    expect(body).toContain("coalesce(provider.provider_capacity, 0)");
    expect(body).toContain(
      "phone.startup_slot_reserved_until > clock_timestamp()",
    );
  });

  it("preserves an adjusted limit and bounds changes by a fresh provider snapshot", () => {
    const link = functionBody(
      "link_duoplus_capacity_pool",
      "revoke all on function public.link_duoplus_capacity_pool",
    );
    expect(link).toContain("p_default_limit integer default 3");
    expect(link).toContain("on conflict (key_fingerprint) do update");
    expect(link).not.toMatch(/do update[\s\S]*worker_capacity_limit\s*=/);

    const setCapacity = functionBody(
      "set_duoplus_worker_capacity",
      "revoke all on function public.set_duoplus_worker_capacity",
    );
    expect(setCapacity).toContain("p_worker_capacity_limit not between 1 and 100");
    expect(setCapacity).toContain("interval '60 minutes'");
    expect(setCapacity).toContain("interval '5 minutes'");
    expect(setCapacity).toContain(
      "p_worker_capacity_limit > v_provider_capacity",
    );
  });

  it("atomically fences the shared pool and reserves before an off-phone powerOn", () => {
    const acquire = functionBody(
      "acquire_phone_lease",
      "revoke all on function public.acquire_phone_lease",
    );
    expect(acquire).toMatch(
      /select pool\.worker_capacity_limit[\s\S]*from public\.duo_capacity_pools[\s\S]*for update;/,
    );
    expect(acquire).toContain(
      "other_phone.duoplus_image_id = v_phone.duoplus_image_id",
    );
    expect(acquire).toContain("count(distinct phone.duoplus_image_id)");
    expect(acquire).toContain("v_active_workers >= v_effective_capacity");
    expect(acquire).toContain("startup_slot_run_id = case");
    expect(acquire).toContain("then p_run_id");
    expect(acquire).toContain("startup_slot_reserved_until = case");
    expect(acquire).toContain("v_preserve_startup_reservation");
    expect(acquire).toContain("startup_power_attempted_at = case");
    expect(acquire).toMatch(
      /startup_power_attempted_at = case[\s\S]*v_preserve_startup_reservation[\s\S]*then startup_power_attempted_at[\s\S]*when not v_existing_task then null/,
    );
  });

  it("serializes provider requests across a canonical pool rate slot", () => {
    const reserve = functionBody(
      "reserve_duoplus_rate_slot",
      "revoke all on function public.reserve_duoplus_rate_slot",
    );
    expect(reserve).toContain("connection.capacity_pool_id = v_pool_id");
    expect(reserve).toContain("order by connection.id");
    expect(reserve).toContain("v_canonical_connection_id");
    expect(reserve).toContain("for update");
  });

  it("releases only startup reservations that never reached powerOn", () => {
    const release = functionBody(
      "release_phone_lease",
      "revoke all on function public.release_phone_lease",
    );
    expect(release).toContain("startup_slot_run_id = v_run.id");
    expect(release).toContain("startup_power_attempted_at is null");
    expect(release).toMatch(
      /startup_slot_run_id = case[\s\S]*startup_power_attempted_at is null[\s\S]*then null/,
    );
    expect(release).toMatch(
      /startup_slot_reserved_until = case[\s\S]*startup_power_attempted_at is null[\s\S]*then null/,
    );
  });

  it("keeps provider and worker snapshots after a confirmed power-off", () => {
    const complete = functionBody(
      "complete_scheduler_phone_power_off",
      "revoke all on function public.complete_scheduler_phone_power_off",
    );
    expect(complete).toContain("startup_slot_run_id = null");
    expect(complete).not.toContain("update public.duo_connections");
    expect(complete).not.toContain("subscription_capacity = null");
    expect(complete).not.toContain("worker_capacity_limit");
  });

  it("plans all linked work against the earliest available shared lane", () => {
    const planner = functionBody(
      "stakeout_plan_cycle_run_workload",
      "revoke all on function public.stakeout_plan_cycle_run_workload",
    );
    expect(planner).toContain("connection.capacity_pool_id = v_pool_id");
    expect(planner).toContain("min(upper(slot.occupied_window))");
    expect(planner).toContain("v_pool_lane_end");
    expect(planner).toContain("phone.duoplus_image_id = v_phone_image_id");
    expect(planner).toContain("interval '15 minutes'");
  });
});
