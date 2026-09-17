import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260907004500_serialize_duoplus_provider_snapshots.sql",
    import.meta.url,
  ),
  "utf8",
);

const hardeningMigration = readFileSync(
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

describe("DuoPlus authoritative provider snapshot migration", () => {
  it("adds a credential-generation fence advanced once by every key mutation", () => {
    expect(migration).toMatch(
      /add column if not exists credential_generation integer not null default 0\s*check \(credential_generation >= 0\)/,
    );
    const advance = functionBody(
      "stakeout_advance_duoplus_credential_generation",
      "revoke all on function public.stakeout_advance_duoplus_credential_generation",
    );
    expect(advance).toContain(
      "new.credential_generation := old.credential_generation + 1",
    );
    expect(migration).toMatch(
      /create trigger stakeout_advance_duoplus_credential_generation\s*before update of api_key_ciphertext, api_key_iv, api_key_auth_tag\s*on public\.duo_connections/,
    );
  });

  it("takes an atomic connection-to-pool cutover lock", () => {
    const connectionLock = migration.indexOf(
      "lock table public.duo_connections in access exclusive mode",
    );
    const poolLock = migration.indexOf(
      "lock table public.duo_capacity_pools in access exclusive mode",
    );
    expect(connectionLock).toBeGreaterThanOrEqual(0);
    expect(poolLock).toBeGreaterThan(connectionLock);
  });

  it("persists a complete authoritative snapshot without a source FK", () => {
    expect(migration).toContain(
      "add column if not exists provider_subscription_capacity integer",
    );
    expect(migration).toContain(
      "add column if not exists provider_subscription_synced_at timestamptz",
    );
    expect(migration).toContain(
      "add column if not exists provider_snapshot_source_connection_id uuid",
    );
    expect(migration).toMatch(
      /constraint duo_capacity_pools_provider_snapshot_complete check \([\s\S]*provider_subscription_in_use \+ provider_subscription_available =\s*provider_subscription_capacity/,
    );
    expect(migration).not.toMatch(
      /foreign key \(provider_snapshot_source_connection_id\)/,
    );
  });

  it("backfills the newest snapshot with conservative deterministic ties", () => {
    expect(migration).toContain(
      "select distinct on (connection.capacity_pool_id)",
    );
    expect(migration).toMatch(
      /order by connection\.capacity_pool_id,\s*connection\.subscription_synced_at desc,\s*connection\.subscription_capacity asc,\s*connection\.subscription_in_use desc,\s*connection\.id/,
    );
    expect(migration).toContain("connection.subscription_capacity >= 0");
    expect(migration).toContain(
      "evaluation_clock.now_at - interval '60 minutes'",
    );
  });

  it("reads provider capacity only from the pool's versioned snapshot", () => {
    const helper = functionBody(
      "stakeout_current_provider_capacity",
      "revoke all on function public.stakeout_current_provider_capacity",
    );
    expect(helper).toContain("from public.duo_capacity_pools as pool");
    expect(helper).toContain("pool.provider_subscription_capacity");
    expect(helper).toContain("p_as_of - interval '60 minutes'");
    expect(helper).not.toContain("public.duo_connections");
  });

  it("locks old and new pool rows in deterministic order before publishing", () => {
    const publish = functionBody(
      "stakeout_publish_duoplus_provider_snapshot",
      "revoke all on function public.stakeout_publish_duoplus_provider_snapshot",
    );
    expect(publish).toContain("security invoker");
    expect(publish).toContain("set search_path = pg_catalog, public");
    expect(publish).toMatch(
      /where pool\.id = old\.capacity_pool_id\s*or pool\.id = new\.capacity_pool_id\s*order by pool\.id\s*for update;/,
    );
    expect(publish).toContain("update public.duo_capacity_pools as pool");
    expect(publish).toContain("return new;");
  });

  it("makes equal-timestamp publication conservative regardless of commit order", () => {
    const publish = functionBody(
      "stakeout_publish_duoplus_provider_snapshot",
      "revoke all on function public.stakeout_publish_duoplus_provider_snapshot",
    );
    expect(publish).toMatch(
      /new\.subscription_synced_at =\s*pool\.provider_subscription_synced_at[\s\S]*new\.subscription_capacity <\s*pool\.provider_subscription_capacity/,
    );
    expect(publish).toMatch(
      /new\.subscription_capacity =\s*pool\.provider_subscription_capacity[\s\S]*new\.subscription_in_use >\s*pool\.provider_subscription_in_use/,
    );
    expect(publish).toContain(
      "new.id < pool.provider_snapshot_source_connection_id",
    );
  });

  it("publishes snapshot changes and pool moves but ignores status-only updates", () => {
    expect(migration).toMatch(
      /create trigger stakeout_publish_duoplus_provider_snapshot\s*before update of\s*capacity_pool_id,\s*subscription_capacity,\s*subscription_in_use,\s*subscription_available,\s*subscription_synced_at\s*on public\.duo_connections\s*for each row/,
    );
    const triggerStart = migration.indexOf(
      "create trigger stakeout_publish_duoplus_provider_snapshot",
    );
    const triggerEnd = migration.indexOf(
      "comment on function public.stakeout_current_provider_capacity",
      triggerStart,
    );
    expect(migration.slice(triggerStart, triggerEnd)).not.toMatch(
      /update of[\s\S]*\bstatus\b/i,
    );
  });

  it("versions the same pool row that acquire locks exclusively", () => {
    const acquireStart = hardeningMigration.indexOf(
      "create or replace function public.acquire_phone_lease",
    );
    const acquireEnd = hardeningMigration.indexOf(
      "revoke all on function public.acquire_phone_lease",
      acquireStart,
    );
    const acquire = hardeningMigration.slice(acquireStart, acquireEnd);
    expect(acquire).toMatch(
      /select pool\.worker_capacity_limit[\s\S]*from public\.duo_capacity_pools as pool[\s\S]*for update;/,
    );
    expect(migration).toContain("update public.duo_capacity_pools as pool");
  });

  it("keeps trigger code service-only and the helper explicitly granted", () => {
    expect(migration).toContain(
      "revoke all on function public.stakeout_publish_duoplus_provider_snapshot()",
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.stakeout_publish_duoplus_provider_snapshot/,
    );
    expect(migration).toContain(
      "grant execute on function public.stakeout_current_provider_capacity(uuid, timestamptz)",
    );
  });

  it("atomically saves verified credentials before linking their capacity pool", () => {
    const save = functionBody(
      "save_verified_duoplus_connection",
      "revoke all on function public.save_verified_duoplus_connection",
    );
    const fingerprintLock = save.indexOf("pg_advisory_xact_lock");
    const connectionUpdate = save.indexOf(
      "update public.duo_connections as connection",
    );
    const poolLink = save.indexOf(
      "from public.link_duoplus_capacity_pool",
    );

    expect(save).toContain("security invoker");
    expect(save).toContain("set search_path = pg_catalog, public");
    expect(fingerprintLock).toBeGreaterThanOrEqual(0);
    expect(connectionUpdate).toBeGreaterThan(fingerprintLock);
    expect(poolLink).toBeGreaterThan(connectionUpdate);
    expect(save).toContain("api_key_ciphertext = p_api_key_ciphertext");
    expect(save).toContain("api_key_iv = p_api_key_iv");
    expect(save).toContain("api_key_auth_tag = p_api_key_auth_tag");
    expect(save).toContain("subscription_capacity = p_subscription_capacity");
    expect(save).toContain("subscription_in_use = p_subscription_in_use");
    expect(save).toContain(
      "subscription_available = p_subscription_available",
    );
    expect(save).toContain("last_error = null");
    expect(save).toContain("p_expected_credential_generation integer");
    expect(save).toMatch(
      /connection\.credential_generation =\s*p_expected_credential_generation/,
    );
    expect(save).toContain("errcode = 'P4113'");
    expect(save).not.toContain(
      "credential_generation = connection.credential_generation + 1",
    );
    expect(save).toContain("get diagnostics v_updated_count = row_count");
  });

  it("validates the complete atomic save payload and exposes it only to service role", () => {
    const save = functionBody(
      "save_verified_duoplus_connection",
      "revoke all on function public.save_verified_duoplus_connection",
    );
    expect(save).toContain("p_key_fingerprint !~ '^[0-9a-f]{64}$'");
    expect(save).toContain("Encrypted DuoPlus credential is incomplete");
    expect(save).toContain("p_min_gap_ms not between 1200 and 60000");
    expect(save).toContain("p_default_limit not between 1 and 100");
    expect(save).toContain("DuoPlus verification timestamps are required");
    expect(save).toMatch(
      /p_subscription_in_use \+ p_subscription_available <>\s*p_subscription_capacity/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.save_verified_duoplus_connection\([\s\S]*?\) from public, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.save_verified_duoplus_connection\([\s\S]*?\) to service_role;/,
    );
  });
});
