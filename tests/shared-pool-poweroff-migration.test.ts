import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260907004500_serialize_duoplus_provider_snapshots.sql",
    import.meta.url,
  ),
  "utf8",
);

function lastFunctionBody(name: string): string {
  const marker = `create or replace function public.${name}`;
  const start = migration.lastIndexOf(marker);
  const end = migration.indexOf(`revoke all on function public.${name}`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe("shared-pool physical phone power-off hardening", () => {
  it("detects protected work through every mirrored physical phone row", () => {
    const helper = lastFunctionBody(
      "stakeout_physical_phone_has_protected_work",
    );

    expect(helper).toContain("connection.capacity_pool_id = p_pool_id");
    expect(helper).toContain(
      "phone.duoplus_image_id = p_duoplus_image_id",
    );
    expect(helper).toContain("run.phone_id = phone.id");
    expect(helper).toContain(
      "phone.scheduler_poweroff_lease_expires_at > p_as_of",
    );
    expect(helper).toContain("run.status in ('preparing', 'queued', 'running', 'paused')");
    expect(helper).toContain("run.issue_at <=");
    expect(helper).toMatch(
      /run\.status in \('pending', 'retry_wait'\)\s*and not run\.cancellation_requested\s*and run\.attempt_count < run\.max_attempts\s*and \(\s*run\.window_end_at is null\s*or run\.window_end_at > p_as_of/,
    );
  });

  it("serializes both claim and consume with the shared pool admission lock", () => {
    const claim = lastFunctionBody("claim_idle_scheduler_powered_phones");
    const consume = lastFunctionBody(
      "consume_scheduler_phone_poweroff_ownership",
    );

    for (const body of [claim, consume]) {
      const phoneLock = body.indexOf("for update");
      const connectionLock = body.indexOf("from public.duo_connections as connection", phoneLock);
      const poolLock = body.indexOf("from public.duo_capacity_pools as pool", connectionLock);
      expect(phoneLock).toBeGreaterThanOrEqual(0);
      expect(connectionLock).toBeGreaterThan(phoneLock);
      expect(poolLock).toBeGreaterThan(connectionLock);
      expect(body.slice(poolLock)).toContain("for update;");
      expect(body).toContain(
        "public.stakeout_physical_phone_has_protected_work(",
      );
    }
  });

  it("pins a batched claim to its first pool and rejects null limits", () => {
    const claim = lastFunctionBody("claim_idle_scheduler_powered_phones");

    expect(claim).toContain("v_claim_pool_id uuid");
    expect(claim).toMatch(
      /v_claim_pool_id is null\s*or connection\.capacity_pool_id = v_claim_pool_id/,
    );
    expect(claim).toContain("v_claim_pool_id := v_pool_id");
    expect(claim).toContain("v_pool_id <> v_claim_pool_id");
    expect(claim).toMatch(
      /p_idle_seconds is null[\s\S]*p_limit is null[\s\S]*p_claim_seconds is null/,
    );
  });

  it("keeps the exact shutdown claim live across the provider call", () => {
    const consume = lastFunctionBody(
      "consume_scheduler_phone_poweroff_ownership",
    );

    expect(consume).toContain(
      "scheduler_poweroff_lease_token is distinct from p_claim_token",
    );
    expect(consume).toContain(
      "v_now + make_interval(secs => p_extension_seconds)",
    );
    expect(consume).toMatch(
      /stakeout_physical_phone_has_protected_work\([\s\S]*p_phone_id,[\s\S]*v_now/,
    );
  });

  it("propagates a settled shutdown to every duplicate image in the pool", () => {
    const complete = lastFunctionBody("complete_scheduler_phone_power_off");

    expect(complete).toMatch(
      /phone\.duoplus_image_id = v_phone\.duoplus_image_id[\s\S]*order by phone\.id[\s\S]*for update of phone;/,
    );
    expect(complete).toContain("connection.capacity_pool_id = v_pool_id");
    expect(complete).toContain("set status = p_observed_status");
    expect(complete).toContain("startup_slot_run_id = null");
    expect(complete).toContain("scheduler_poweroff_lease_token = null");
    expect(complete).not.toContain("update public.duo_connections");
  });

  it("keeps every new function service-only", () => {
    for (const signature of [
      "stakeout_physical_phone_has_protected_work(\n  uuid, text, uuid, timestamptz, integer\n)",
      "claim_idle_scheduler_powered_phones(\n  text, integer, integer, integer\n)",
      "consume_scheduler_phone_poweroff_ownership(\n  uuid, text, uuid, integer\n)",
      "complete_scheduler_phone_power_off(\n  uuid, text, uuid, integer\n)",
    ]) {
      expect(migration).toContain(
        `revoke all on function public.${signature} from public, anon, authenticated;`,
      );
      expect(migration).toContain(
        `grant execute on function public.${signature} to service_role;`,
      );
    }
  });
});
