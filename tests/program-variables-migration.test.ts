import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260906230000_cycle_program_variables.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("cycle program variable database boundary", () => {
  it("stores bindings on the cycle and resolves a schedule snapshot on insert", () => {
    expect(migration).toContain("add column if not exists variables jsonb not null");
    expect(migration).toContain("create or replace function public.resolve_cycle_program_config");
    expect(migration).toContain("new.config := public.resolve_cycle_program_config(new.config, v_variables)");
    expect(migration).toMatch(/before insert or update of config, source_kind, device_cycle_id/);
    expect(migration).toMatch(
      /grant execute on function public\.resolve_cycle_program_config\(jsonb, jsonb\)[\s\S]*to service_role;/,
    );
  });

  it("supports exact placeholders only and rejects credential-shaped names", () => {
    expect(migration).toContain("^\\{\\{[a-z][a-z0-9_]{0,63}\\}\\}$");
    expect(migration).toContain(
      "password|passwd|token|authorization|apikey|accesskey|cookie|privatekey|session|secret|credential",
    );
    expect(migration).toContain("must contain a concrete value");
    expect(migration).toContain("has the wrong input type");
  });

  it("plans cycle work atomically against subscription and phone capacity", () => {
    expect(migration).toContain("create or replace function public.stakeout_plan_cycle_run_workload");
    expect(migration).toContain("connection.subscription_capacity");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toMatch(
      /connection\.status = 'active'[\s\S]*for share;/,
    );
    expect(migration).toContain("interval '15 minutes'");
    expect(migration).toContain("v_overlap_count < v_capacity");
    expect(migration).toContain("run.phone_id = new.phone_id");
    expect(migration).toContain("run.status <> 'cancelled'");
    expect(migration).toContain("Cycle workload cannot fit before its canonical deadline");
    expect(migration).toMatch(/before insert on public\.scheduler_runs/);
  });

  it("rejects incomplete, inconsistent, stale, and future-dated capacity snapshots", () => {
    expect(migration).toContain(
      "num_nulls(v_capacity, v_in_use, v_available, v_synced_at) not in (0, 4)",
    );
    expect(migration).toContain("v_in_use + v_available <> v_capacity");
    expect(migration).toContain("clock_timestamp() - interval '60 minutes'");
    expect(migration).toContain("clock_timestamp() + interval '5 minutes'");
    expect(migration).toContain("Subscription capacity snapshot is incomplete");
    expect(migration).toContain("Subscription capacity snapshot is inconsistent");
    expect(migration).toContain(
      "Subscription capacity snapshot is stale or future-dated",
    );
  });
});
