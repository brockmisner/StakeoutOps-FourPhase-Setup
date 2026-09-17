-- Persist the authoritative DuoPlus Subscription Startup snapshot on the
-- shared pool. Admission and snapshot publication then version and lock the
-- same row, closing the final read/write race at every isolation level.

-- Supabase applies a migration as one transaction. Take cutover locks in the
-- runtime connection -> pool order so no refresh can land between backfill,
-- helper replacement, and trigger installation.
lock table public.duo_connections in access exclusive mode;
lock table public.duo_capacity_pools in access exclusive mode;

alter table public.duo_connections
  add column if not exists credential_generation integer not null default 0
    check (credential_generation >= 0);

-- Every credential replacement or removal advances the fence, including the
-- existing disconnect RPC. This prevents provider responses issued with an
-- older key from mutating the state of a newer key after they finish.
create or replace function public.stakeout_advance_duoplus_credential_generation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if old.credential_generation = 2147483647 then
    raise exception using
      errcode = '22003',
      message = 'DuoPlus credential generation is exhausted';
  end if;
  new.credential_generation := old.credential_generation + 1;
  return new;
end;
$function$;

revoke all on function public.stakeout_advance_duoplus_credential_generation()
  from public, anon, authenticated;

drop trigger if exists stakeout_advance_duoplus_credential_generation
  on public.duo_connections;
create trigger stakeout_advance_duoplus_credential_generation
before update of api_key_ciphertext, api_key_iv, api_key_auth_tag
on public.duo_connections
for each row
execute function public.stakeout_advance_duoplus_credential_generation();

alter table public.duo_capacity_pools
  add column if not exists provider_subscription_capacity integer,
  add column if not exists provider_subscription_in_use integer,
  add column if not exists provider_subscription_available integer,
  add column if not exists provider_subscription_synced_at timestamptz,
  add column if not exists provider_snapshot_source_connection_id uuid;

alter table public.duo_capacity_pools
  drop constraint if exists duo_capacity_pools_provider_snapshot_complete,
  add constraint duo_capacity_pools_provider_snapshot_complete check (
    (
      provider_subscription_capacity is null
      and provider_subscription_in_use is null
      and provider_subscription_available is null
      and provider_subscription_synced_at is null
      and provider_snapshot_source_connection_id is null
    )
    or
    (
      provider_subscription_capacity is not null
      and provider_subscription_capacity >= 0
      and provider_subscription_in_use is not null
      and provider_subscription_in_use >= 0
      and provider_subscription_available is not null
      and provider_subscription_available >= 0
      and provider_subscription_synced_at is not null
      and provider_snapshot_source_connection_id is not null
      and provider_subscription_in_use + provider_subscription_available =
        provider_subscription_capacity
    )
  );

-- Backfill the exact winner used at cutover: newest timestamp, then lower
-- capacity, higher reported use, and lower source UUID for deterministic,
-- conservative ties. Zero is an authoritative provider downgrade.
with evaluation_clock as materialized (
  select clock_timestamp() as now_at
), authoritative as (
  select distinct on (connection.capacity_pool_id)
    connection.capacity_pool_id as pool_id,
    connection.subscription_capacity,
    connection.subscription_in_use,
    connection.subscription_available,
    connection.subscription_synced_at,
    connection.id as source_connection_id
  from public.duo_connections as connection
  cross join evaluation_clock
  where connection.capacity_pool_id is not null
    and connection.subscription_capacity is not null
    and connection.subscription_capacity >= 0
    and connection.subscription_in_use is not null
    and connection.subscription_in_use >= 0
    and connection.subscription_available is not null
    and connection.subscription_available >= 0
    and connection.subscription_in_use + connection.subscription_available =
      connection.subscription_capacity
    and connection.subscription_synced_at >=
      evaluation_clock.now_at - interval '60 minutes'
    and connection.subscription_synced_at <=
      evaluation_clock.now_at + interval '5 minutes'
  order by connection.capacity_pool_id,
           connection.subscription_synced_at desc,
           connection.subscription_capacity asc,
           connection.subscription_in_use desc,
           connection.id
)
update public.duo_capacity_pools as pool
set provider_subscription_capacity = authoritative.subscription_capacity,
    provider_subscription_in_use = authoritative.subscription_in_use,
    provider_subscription_available = authoritative.subscription_available,
    provider_subscription_synced_at = authoritative.subscription_synced_at,
    provider_snapshot_source_connection_id =
      authoritative.source_connection_id
from authoritative
where pool.id = authoritative.pool_id;

-- Admission/configuration callers already lock the pool before invoking this
-- helper. Reading the persisted row makes that lock the serialization boundary
-- instead of reconstructing authority from mutable connection rows.
create or replace function public.stakeout_current_provider_capacity(
  p_pool_id uuid,
  p_as_of timestamptz default clock_timestamp()
)
returns integer
language sql
stable
security invoker
set search_path = pg_catalog, public
as $function$
  select pool.provider_subscription_capacity
  from public.duo_capacity_pools as pool
  where pool.id = p_pool_id
    and pool.provider_subscription_capacity is not null
    and pool.provider_subscription_capacity >= 0
    and pool.provider_subscription_in_use is not null
    and pool.provider_subscription_available is not null
    and pool.provider_subscription_in_use +
      pool.provider_subscription_available =
      pool.provider_subscription_capacity
    and pool.provider_subscription_synced_at >=
      p_as_of - interval '60 minutes'
    and pool.provider_subscription_synced_at <=
      p_as_of + interval '5 minutes';
$function$;

revoke all on function public.stakeout_current_provider_capacity(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.stakeout_current_provider_capacity(uuid, timestamptz)
  to service_role;

create or replace function public.stakeout_publish_duoplus_provider_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz;
begin
  -- UPDATE has already locked this duo_connections row. Lock distinct old/new
  -- pool identities in UUID order so a combined move + refresh cannot invert
  -- connection -> pool ordering or cross-lock two pools in reverse.
  perform pool.id
  from public.duo_capacity_pools as pool
  where pool.id = old.capacity_pool_id
     or pool.id = new.capacity_pool_id
  order by pool.id
  for update;

  v_now := clock_timestamp();

  -- A null snapshot never erases the last authoritative observation; it ages
  -- out normally and admission fails closed. Equal timestamps resolve
  -- conservatively regardless of commit order, including writes to one source.
  if new.capacity_pool_id is not null
     and new.subscription_capacity is not null
     and new.subscription_capacity >= 0
     and new.subscription_in_use is not null
     and new.subscription_in_use >= 0
     and new.subscription_available is not null
     and new.subscription_available >= 0
     and new.subscription_in_use + new.subscription_available =
       new.subscription_capacity
     and new.subscription_synced_at >= v_now - interval '60 minutes'
     and new.subscription_synced_at <= v_now + interval '5 minutes' then
    update public.duo_capacity_pools as pool
    set provider_subscription_capacity = new.subscription_capacity,
        provider_subscription_in_use = new.subscription_in_use,
        provider_subscription_available = new.subscription_available,
        provider_subscription_synced_at = new.subscription_synced_at,
        provider_snapshot_source_connection_id = new.id
    where pool.id = new.capacity_pool_id
      and (
        pool.provider_subscription_synced_at is null
        or new.subscription_synced_at >
          pool.provider_subscription_synced_at
        or (
          new.subscription_synced_at =
            pool.provider_subscription_synced_at
          and (
            new.subscription_capacity <
              pool.provider_subscription_capacity
            or (
              new.subscription_capacity =
                pool.provider_subscription_capacity
              and new.subscription_in_use >
                pool.provider_subscription_in_use
            )
            or (
              new.subscription_capacity =
                pool.provider_subscription_capacity
              and new.subscription_in_use =
                pool.provider_subscription_in_use
              and new.id < pool.provider_snapshot_source_connection_id
            )
          )
        )
      );
  end if;

  return new;
end;
$function$;

revoke all on function public.stakeout_publish_duoplus_provider_snapshot()
  from public, anon, authenticated;

drop trigger if exists stakeout_publish_duoplus_provider_snapshot
  on public.duo_connections;
create trigger stakeout_publish_duoplus_provider_snapshot
before update of
  capacity_pool_id,
  subscription_capacity,
  subscription_in_use,
  subscription_available,
  subscription_synced_at
on public.duo_connections
for each row
execute function public.stakeout_publish_duoplus_provider_snapshot();

comment on function public.stakeout_current_provider_capacity(uuid, timestamptz) is
  'Returns the fresh authoritative provider Startup capacity persisted on the pool row used for worker admission.';
comment on function public.stakeout_publish_duoplus_provider_snapshot() is
  'Publishes coherent connection snapshots onto their shared pool in deterministic connection-to-pool lock order.';
comment on column public.duo_capacity_pools.provider_snapshot_source_connection_id is
  'Source UUID for deterministic tie-breaking only; intentionally not an FK so connection deletion cannot erase pool authority.';

-- Saving a verified credential and assigning its provider pool must be one
-- transaction. In particular, a key-fingerprint collision must not leave the
-- new encrypted credential attached to the connection's previous pool.
create or replace function public.save_verified_duoplus_connection(
  p_connection_id uuid,
  p_organization_id uuid,
  p_expected_credential_generation integer,
  p_key_fingerprint text,
  p_api_key_ciphertext text,
  p_api_key_iv text,
  p_api_key_auth_tag text,
  p_key_hint text,
  p_min_gap_ms integer,
  p_verified_at timestamptz,
  p_subscription_capacity integer,
  p_subscription_in_use integer,
  p_subscription_available integer,
  p_subscription_synced_at timestamptz,
  p_default_limit integer default 3
)
returns table (
  pool_id uuid,
  worker_capacity_limit integer,
  active_worker_count integer,
  available_worker_slots integer
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_updated_count integer;
  v_now timestamptz;
begin
  if p_expected_credential_generation is null
     or p_expected_credential_generation < 0 then
    raise exception using
      errcode = '22023',
      message = 'Expected DuoPlus credential generation is invalid';
  end if;
  if p_key_fingerprint is null
     or p_key_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Capacity pool fingerprint is invalid';
  end if;
  if p_api_key_ciphertext is null
     or char_length(p_api_key_ciphertext) < 1
     or p_api_key_iv is null
     or char_length(p_api_key_iv) < 1
     or p_api_key_auth_tag is null
     or char_length(p_api_key_auth_tag) < 1 then
    raise exception using
      errcode = '22023',
      message = 'Encrypted DuoPlus credential is incomplete';
  end if;
  if p_key_hint is null
     or char_length(btrim(p_key_hint)) < 1
     or char_length(p_key_hint) > 24 then
    raise exception using
      errcode = '22023',
      message = 'DuoPlus key hint is invalid';
  end if;
  if p_min_gap_ms is null or p_min_gap_ms not between 1200 and 60000 then
    raise exception using
      errcode = '22023',
      message = 'min_gap_ms must be between 1200 and 60000';
  end if;
  if p_default_limit is null or p_default_limit not between 1 and 100 then
    raise exception using
      errcode = '22023',
      message = 'Default worker capacity must be between 1 and 100';
  end if;
  if p_verified_at is null or p_subscription_synced_at is null then
    raise exception using
      errcode = '22023',
      message = 'DuoPlus verification timestamps are required';
  end if;
  if p_subscription_capacity is null
     or p_subscription_capacity < 0
     or p_subscription_in_use is null
     or p_subscription_in_use < 0
     or p_subscription_available is null
     or p_subscription_available < 0
     or p_subscription_in_use + p_subscription_available <>
       p_subscription_capacity then
    raise exception using
      errcode = '22023',
      message = 'DuoPlus provider capacity snapshot is invalid';
  end if;

  -- Match link_duoplus_capacity_pool's first lock. Taking the fingerprint lock
  -- before UPDATE prevents an existing linker from holding this advisory lock
  -- while waiting on the connection row we are about to lock.
  perform pg_advisory_xact_lock(
    hashtextextended(p_key_fingerprint, 1949661977)
  );

  v_now := clock_timestamp();
  if p_verified_at < v_now - interval '60 minutes'
     or p_verified_at > v_now + interval '5 minutes'
     or p_subscription_synced_at < v_now - interval '60 minutes'
     or p_subscription_synced_at > v_now + interval '5 minutes' then
    raise exception using
      errcode = '22023',
      message = 'DuoPlus verification snapshot is stale or future-dated';
  end if;

  update public.duo_connections as connection
  set api_key_ciphertext = p_api_key_ciphertext,
      api_key_iv = p_api_key_iv,
      api_key_auth_tag = p_api_key_auth_tag,
      key_hint = p_key_hint,
      status = 'active',
      min_gap_ms = p_min_gap_ms,
      verified_at = p_verified_at,
      subscription_capacity = p_subscription_capacity,
      subscription_in_use = p_subscription_in_use,
      subscription_available = p_subscription_available,
      subscription_synced_at = p_subscription_synced_at,
      last_error = null,
      updated_at = v_now
  where connection.id = p_connection_id
    and connection.organization_id = p_organization_id
    and connection.credential_generation =
      p_expected_credential_generation;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    if exists (
      select 1
      from public.duo_connections as connection
      where connection.id = p_connection_id
        and connection.organization_id = p_organization_id
    ) then
      raise exception using
        errcode = 'P4113',
        message = 'DuoPlus credential changed while verification was in progress';
    end if;
    raise exception using errcode = '23503', message = 'DuoPlus connection not found';
  end if;

  -- A failure raised here rolls the credential and the trigger-published pool
  -- snapshot back with the RPC transaction. The advisory lock is re-entrant
  -- for this transaction when the linked function acquires the same key.
  return query
  select snapshot.pool_id,
         snapshot.worker_capacity_limit,
         snapshot.active_worker_count,
         snapshot.available_worker_slots
  from public.link_duoplus_capacity_pool(
    p_connection_id,
    p_organization_id,
    p_key_fingerprint,
    p_default_limit
  ) as snapshot;
end;
$function$;

revoke all on function public.save_verified_duoplus_connection(
  uuid, uuid, integer, text, text, text, text, text, integer, timestamptz,
  integer, integer, integer, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.save_verified_duoplus_connection(
  uuid, uuid, integer, text, text, text, text, text, integer, timestamptz,
  integer, integer, integer, timestamptz, integer
) to service_role;

comment on function public.save_verified_duoplus_connection(
  uuid, uuid, integer, text, text, text, text, text, integer, timestamptz,
  integer, integer, integer, timestamptz, integer
) is
  'Atomically saves a verified encrypted DuoPlus credential, publishes its complete provider snapshot, and links its durable Startup capacity pool.';


-- Final account-occupancy overrides. These intentionally follow the atomic
-- connection-save function so every caller observes the same conservative
-- provider-in-use boundary.
-- Provider-reported Startup use is authoritative for account occupancy even
-- when a manually started phone has not reached a workspace inventory cache.
-- Local ON images already visible to that snapshot remain the stronger bound
-- when higher. OFF reservations plus ON state from scheduler transitions or
-- complete inventory reads newer than the provider snapshot are additive;
-- they cannot safely be assumed included in the provider aggregate yet.
create or replace function public.get_duoplus_capacity_snapshot(
  p_connection_id uuid,
  p_organization_id uuid
)
returns table (
  pool_id uuid,
  worker_capacity_limit integer,
  active_worker_count integer,
  available_worker_slots integer
)
language sql
volatile
security invoker
set search_path = pg_catalog, public
as $function$
  with evaluation_clock as materialized (
    select clock_timestamp() as now_at
  ), target_pool as (
    select
      pool.id,
      pool.worker_capacity_limit,
      pool.provider_subscription_in_use,
      pool.provider_subscription_synced_at,
      public.stakeout_current_provider_capacity(
        pool.id,
        evaluation_clock.now_at
      ) as provider_capacity
    from public.duo_connections as connection
    join public.duo_capacity_pools as pool
      on pool.id = connection.capacity_pool_id
    cross join evaluation_clock
    where connection.id = p_connection_id
      and connection.organization_id = p_organization_id
      and connection.status = 'active'
  ), physical_occupancy as (
    select
      phone.duoplus_image_id,
      bool_or(
        phone.status in (1, 10, 11)
        or phone.scheduler_powered_on_at is not null
      ) as local_on,
      bool_or(
        (
          phone.lease_run_id is not null
          and phone.lease_expires_at > evaluation_clock.now_at
        )
        or (
          phone.scheduler_power_requested_at is not null
          and phone.scheduler_powered_on_at is null
          and coalesce(
            phone.startup_slot_reserved_until,
            phone.scheduler_power_requested_at + interval '15 minutes'
          ) > evaluation_clock.now_at
        )
        or (
          phone.startup_slot_run_id is not null
          and phone.startup_slot_reserved_until > evaluation_clock.now_at
        )
      ) as local_pending_off,
      coalesce(bool_or(
        (
          phone.status in (1, 10, 11)
          or phone.scheduler_powered_on_at is not null
        )
        and (
          phone.scheduler_power_requested_at >
            target_pool.provider_subscription_synced_at
          or phone.scheduler_powered_on_at >
            target_pool.provider_subscription_synced_at
          or phone.startup_power_attempted_at >
            target_pool.provider_subscription_synced_at
          or phone.last_seen_at >
            target_pool.provider_subscription_synced_at
          or (
            connection.inventory_synced_at >
              target_pool.provider_subscription_synced_at
            and phone.last_seen_at >= connection.inventory_synced_at
          )
        )
      ), false) as local_on_after_provider_snapshot
    from target_pool
    join public.duo_connections as connection
      on connection.capacity_pool_id = target_pool.id
    join public.duo_phones as phone
      on phone.connection_id = connection.id
     and phone.organization_id = connection.organization_id
    cross join evaluation_clock
    group by phone.duoplus_image_id
  ), occupied as (
    select
      count(*) filter (
        where local_on
          and not local_on_after_provider_snapshot
      )::integer as local_provider_visible_on_count,
      count(*) filter (
        where (local_on and local_on_after_provider_snapshot)
           or (not local_on and local_pending_off)
      )::integer as local_additive_count
    from physical_occupancy
  ), effective as (
    select
      target_pool.id,
      target_pool.worker_capacity_limit,
      target_pool.provider_capacity,
      case
        when target_pool.provider_capacity is null
          then occupied.local_provider_visible_on_count +
            occupied.local_additive_count
        else greatest(
          target_pool.provider_subscription_in_use,
          occupied.local_provider_visible_on_count
        ) + occupied.local_additive_count
      end as active_count
    from target_pool
    cross join occupied
  )
  select
    effective.id,
    effective.worker_capacity_limit,
    effective.active_count,
    greatest(
      least(
        effective.worker_capacity_limit,
        coalesce(effective.provider_capacity, 0)
      ) - effective.active_count,
      0
    )
  from effective;
$function$;

revoke all on function public.get_duoplus_capacity_snapshot(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_duoplus_capacity_snapshot(uuid, uuid)
  to service_role;

create or replace function public.acquire_phone_lease(
  p_phone_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_run_lease_token uuid,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_run public.scheduler_runs%rowtype;
  v_phone public.duo_phones%rowtype;
  v_phone_token uuid := gen_random_uuid();
  v_attempt_number smallint;
  v_starts_attempt boolean;
  v_pool_id uuid;
  v_worker_capacity integer;
  v_provider_capacity integer;
  v_provider_in_use integer;
  v_provider_synced_at timestamptz;
  v_effective_capacity integer;
  v_local_provider_visible_on_workers integer;
  v_local_additive_workers integer;
  v_active_workers integer;
  v_target_occupies_slot boolean;
  v_preserve_startup_reservation boolean;
  v_existing_task boolean;
  v_submission_reconciliation boolean;
  v_now timestamptz;
  v_phone_lease_until timestamptz;
  v_startup_reserved_until timestamptz;
begin
  if p_lease_seconds is null
     or p_lease_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'lease_seconds must be between 30 and 3600';
  end if;

  select * into v_run
  from public.scheduler_runs
  where id = p_run_id
  for update;
  if not found then
    return false;
  end if;

  v_submission_reconciliation := v_run.submission_state in (
    'attempting', 'accepted', 'unknown'
  );
  v_existing_task := v_submission_reconciliation
    or v_run.duoplus_task_id is not null
    or v_run.status in ('queued', 'running', 'paused')
    or v_run.stage in ('resolve_task', 'monitor_task', 'fetch_logs', 'cancel_task');

  if v_run.lease_owner is distinct from nullif(btrim(p_worker_id), '')
     or v_run.lease_token is distinct from p_run_lease_token
     or v_run.lease_expires_at is null
     or v_run.cancellation_requested
     or v_run.status not in ('pending', 'retry_wait', 'preparing', 'queued', 'running', 'paused')
     or (
       not v_existing_task
       and v_run.status in ('pending', 'retry_wait')
       and v_run.attempt_count >= v_run.max_attempts
     ) then
    return false;
  end if;

  if v_existing_task and (
    v_run.phone_id is null
    or v_run.phone_id <> p_phone_id
  ) then
    return false;
  end if;

  if v_submission_reconciliation and v_run.stage not in (
    'resolve_task', 'monitor_task', 'fetch_logs', 'cancel_task'
  ) then
    return false;
  end if;

  if v_run.device_cycle_id is not null and not v_existing_task and not exists (
    select 1
    from public.device_cycles as cycle
    where cycle.id = v_run.device_cycle_id
      and cycle.organization_id = v_run.organization_id
      and cycle.connection_id = v_run.connection_id
      and cycle.client_id = v_run.client_id
      and cycle.phone_id = p_phone_id
      and cycle.status = 'active'
      and (
        cycle.proxy_mode = 'preconfigured'
        or (
          cycle.proxy_mode = 'managed'
          and exists (
            select 1
            from public.phone_proxy_bindings as binding
            where binding.organization_id = cycle.organization_id
              and binding.connection_id = cycle.connection_id
              and binding.client_id = cycle.client_id
              and binding.phone_id = cycle.phone_id
              and binding.device_cycle_id = cycle.id
              and binding.released_at is null
              and binding.duoplus_proxy_id is not null
              and binding.health in ('unverified', 'aligned', 'nearby')
              and lower(binding.configured_isp) = lower(cycle.selected_proxy_isp)
          )
        )
      )
  ) then
    return false;
  end if;

  select * into v_phone
  from public.duo_phones
  where id = p_phone_id
  for update;
  if not found
     or v_phone.organization_id <> v_run.organization_id
     or v_phone.connection_id <> v_run.connection_id
     or (
       v_run.device_cycle_id is not null
       and v_phone.client_id is distinct from v_run.client_id
     )
     or (
       v_run.device_cycle_id is null
       and v_phone.client_id is not null
       and v_phone.client_id <> v_run.client_id
     ) then
    return false;
  end if;

  select connection.capacity_pool_id into v_pool_id
  from public.duo_connections as connection
  where connection.id = v_run.connection_id
    and connection.organization_id = v_run.organization_id
    and connection.status = 'active'
  for update;
  if not found then
    return false;
  end if;

  if v_pool_id is null then
    if not v_existing_task then
      return false;
    end if;
  else
    select
      pool.worker_capacity_limit,
      pool.provider_subscription_in_use,
      pool.provider_subscription_synced_at
    into v_worker_capacity, v_provider_in_use, v_provider_synced_at
    from public.duo_capacity_pools as pool
    where pool.id = v_pool_id
    for update;
    if not found then
      return false;
    end if;
  end if;

  -- All blocking row locks are now held. Re-sample time and revalidate every
  -- lease/phone predicate whose truth can change merely by time passing.
  v_now := clock_timestamp();
  if v_run.lease_expires_at <= v_now
     or v_run.cancellation_requested then
    return false;
  end if;

  if (
       not v_existing_task
       and (
         not v_phone.enabled
         or not v_phone.provider_present
         or v_phone.status in (3, 4)
         or (
           v_phone.expired_at is not null
           and v_phone.expired_at <= v_now
         )
       )
     )
     or (v_phone.lease_expires_at is not null and v_phone.lease_expires_at > v_now)
     or (v_phone.busy_until is not null and v_phone.busy_until > v_now)
     or (
       v_phone.scheduler_poweroff_lease_expires_at is not null
       and v_phone.scheduler_poweroff_lease_expires_at > v_now
     )
     or (
       v_phone.startup_slot_run_id is distinct from p_run_id
       and v_phone.startup_slot_reserved_until > v_now
     ) then
    return false;
  end if;

  if v_pool_id is not null and exists (
    select 1
    from public.duo_phones as other_phone
    join public.duo_connections as other_connection
      on other_connection.id = other_phone.connection_id
     and other_connection.organization_id = other_phone.organization_id
    where other_connection.capacity_pool_id = v_pool_id
      and other_phone.duoplus_image_id = v_phone.duoplus_image_id
      and (
        (
          other_phone.lease_run_id is distinct from p_run_id
          and other_phone.lease_expires_at > v_now
        )
        or (
          other_phone.busy_until is not null
          and other_phone.busy_until > v_now
        )
        or (
          other_phone.startup_slot_run_id is distinct from p_run_id
          and other_phone.startup_slot_reserved_until > v_now
        )
        or (
          other_phone.scheduler_power_requested_at is not null
          and other_phone.scheduler_powered_on_at is null
          and other_phone.scheduler_powered_on_run_id is distinct from p_run_id
          and coalesce(
            other_phone.startup_slot_reserved_until,
            other_phone.scheduler_power_requested_at + interval '15 minutes'
          ) > v_now
        )
        or (
          other_phone.scheduler_poweroff_lease_expires_at is not null
          and other_phone.scheduler_poweroff_lease_expires_at > v_now
        )
        or exists (
          select 1
          from public.scheduler_runs as other_run
          where other_run.phone_id = other_phone.id
            and other_run.id <> p_run_id
            and (
              other_run.status in ('preparing', 'queued', 'running', 'paused')
              or coalesce(other_run.submission_state, 'never') in ('attempting', 'unknown')
              or (
                other_run.submission_state = 'accepted'
                and (
                  other_run.duoplus_status is null
                  or other_run.duoplus_status not in (3, 4, 5)
                )
              )
            )
        )
      )
  ) then
    return false;
  end if;

  if not v_existing_task then
    v_provider_capacity :=
      public.stakeout_current_provider_capacity(v_pool_id, v_now);
    if v_provider_capacity is null then
      return false;
    end if;
    v_effective_capacity := least(v_worker_capacity, v_provider_capacity);

    with physical_occupancy as (
      select
        phone.duoplus_image_id,
        bool_or(
          phone.status in (1, 10, 11)
          or phone.scheduler_powered_on_at is not null
        ) as local_on,
        bool_or(
          (
            phone.lease_run_id is not null
            and phone.lease_expires_at > v_now
          )
          or (
            phone.scheduler_power_requested_at is not null
            and phone.scheduler_powered_on_at is null
            and coalesce(
              phone.startup_slot_reserved_until,
              phone.scheduler_power_requested_at + interval '15 minutes'
            ) > v_now
          )
          or (
            phone.startup_slot_run_id is not null
            and phone.startup_slot_reserved_until > v_now
          )
        ) as local_pending_off,
        coalesce(bool_or(
          (
            phone.status in (1, 10, 11)
            or phone.scheduler_powered_on_at is not null
          )
          and (
            phone.scheduler_power_requested_at > v_provider_synced_at
            or phone.scheduler_powered_on_at > v_provider_synced_at
            or phone.startup_power_attempted_at > v_provider_synced_at
            or phone.last_seen_at > v_provider_synced_at
            or (
              connection.inventory_synced_at > v_provider_synced_at
              and phone.last_seen_at >= connection.inventory_synced_at
            )
          )
        ), false) as local_on_after_provider_snapshot
      from public.duo_phones as phone
      join public.duo_connections as connection
        on connection.id = phone.connection_id
       and connection.organization_id = phone.organization_id
      where connection.capacity_pool_id = v_pool_id
      group by phone.duoplus_image_id
    )
    select
      count(*) filter (
        where local_on
          and not local_on_after_provider_snapshot
      )::integer,
      count(*) filter (
        where (local_on and local_on_after_provider_snapshot)
           or (not local_on and local_pending_off)
      )::integer,
      coalesce(bool_or(
        duoplus_image_id = v_phone.duoplus_image_id
        and (local_on or local_pending_off)
      ), false)
    into
      v_local_provider_visible_on_workers,
      v_local_additive_workers,
      v_target_occupies_slot
    from physical_occupancy;

    -- Provider use is a baseline for ON phones observed by that snapshot.
    -- OFF reservations and ON state from scheduler transitions or complete
    -- inventory reads newer than the provider snapshot are additive and
    -- de-duplicated by physical image first.
    v_active_workers := greatest(
      v_provider_in_use,
      v_local_provider_visible_on_workers
    ) + v_local_additive_workers;

    if v_active_workers > v_effective_capacity
       or (
         not v_target_occupies_slot
         and v_active_workers >= v_effective_capacity
       ) then
      return false;
    end if;
  end if;

  -- The pool scans above do not take additional blocking row locks, but a
  -- near-expiry dispatcher lease or startup reservation can still age out
  -- while they run. Re-sample immediately before mutation, and recheck both
  -- authority and the provider bound before deriving new deadlines.
  v_now := clock_timestamp();
  if v_run.lease_expires_at <= v_now
     or v_run.cancellation_requested
     or (
       not v_existing_task
       and v_phone.expired_at is not null
       and v_phone.expired_at <= v_now
     ) then
    return false;
  end if;

  v_preserve_startup_reservation :=
    v_phone.startup_slot_run_id = p_run_id
    and v_phone.startup_slot_reserved_until > v_now;

  if not v_existing_task then
    v_provider_capacity :=
      public.stakeout_current_provider_capacity(v_pool_id, v_now);
    if v_provider_capacity is null then
      return false;
    end if;
    v_effective_capacity := least(v_worker_capacity, v_provider_capacity);
    if v_active_workers > v_effective_capacity
       or (
         not v_target_occupies_slot
         and v_active_workers >= v_effective_capacity
       ) then
      return false;
    end if;
  end if;

  v_starts_attempt := not v_existing_task and (
    v_run.status in ('pending', 'retry_wait')
    or (v_run.status = 'preparing' and v_run.attempt_count = 0)
  );
  v_attempt_number := v_run.attempt_count + case when v_starts_attempt then 1 else 0 end;
  v_phone_lease_until :=
    v_now + make_interval(secs => p_lease_seconds);
  v_startup_reserved_until :=
    v_now + make_interval(secs => greatest(p_lease_seconds, 900));

  begin
    update public.scheduler_runs
    set phone_id = p_phone_id,
        status = case
          when v_existing_task then v_run.status
          when v_run.status in ('queued', 'running', 'paused') then v_run.status
          else 'preparing'
        end,
        stage = case when v_starts_attempt then 'prepare_phone' else v_run.stage end,
        attempt_count = v_attempt_number,
        phone_lease_token = v_phone_token,
        started_at = coalesce(started_at, v_now)
    where id = p_run_id;

    update public.duo_phones
    set busy_until = v_phone_lease_until,
        lease_run_id = p_run_id,
        lease_token = v_phone_token,
        lease_expires_at = v_phone_lease_until,
        startup_slot_run_id = case
          when not v_existing_task
            and status not in (1, 10, 11)
            then p_run_id
          when not v_existing_task then null
          else startup_slot_run_id
        end,
        startup_slot_reserved_until = case
          when not v_existing_task
            and status not in (1, 10, 11)
            and v_preserve_startup_reservation
            then startup_slot_reserved_until
          when not v_existing_task
            and status not in (1, 10, 11)
            then v_startup_reserved_until
          when not v_existing_task then null
          else startup_slot_reserved_until
        end,
        startup_power_attempted_at = case
          when not v_existing_task
            and status not in (1, 10, 11)
            and v_preserve_startup_reservation
            then startup_power_attempted_at
          when not v_existing_task then null
          else startup_power_attempted_at
        end
    where id = p_phone_id;

    if v_starts_attempt then
      insert into public.scheduler_run_attempts (
        organization_id, run_id, phone_id, attempt_number, worker_id, stage, status
      ) values (
        v_run.organization_id, p_run_id, p_phone_id, v_attempt_number,
        v_run.lease_owner, 'prepare_phone', 'started'
      );
    end if;
  exception
    when exclusion_violation or unique_violation or check_violation then
      return false;
  end;

  return true;
end;
$function$;

revoke all on function public.acquire_phone_lease(uuid, uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.acquire_phone_lease(uuid, uuid, text, uuid, integer)
  to service_role;


comment on function public.get_duoplus_capacity_snapshot(uuid, uuid) is
  'Returns shared Startup occupancy from the provider/local ON baseline plus distinct local reservations and post-snapshot ON transitions; stale provider state exposes zero availability.';
comment on function public.acquire_phone_lease(uuid, uuid, text, uuid, integer) is
  'Acquires under the shared pool only when the provider/local ON baseline plus distinct local reservations and post-snapshot ON transitions leave capacity.';

-- Every workspace linked to one DuoPlus account can contain its own row for
-- the same physical image. Power-off safety therefore has to inspect work and
-- mutex state by (capacity_pool_id, duoplus_image_id), not by one local row.
create or replace function public.stakeout_physical_phone_has_protected_work(
  p_pool_id uuid,
  p_duoplus_image_id text,
  p_ignored_poweroff_phone_id uuid default null,
  p_as_of timestamptz default clock_timestamp(),
  p_idle_seconds integer default 900
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
    from public.duo_phones as phone
    join public.duo_connections as connection
      on connection.id = phone.connection_id
     and connection.organization_id = phone.organization_id
    where connection.capacity_pool_id = p_pool_id
      and phone.duoplus_image_id = p_duoplus_image_id
      and (
        (
          phone.lease_run_id is not null
          and phone.lease_expires_at > p_as_of
        )
        or (phone.busy_until is not null and phone.busy_until > p_as_of)
        or (
          phone.startup_slot_run_id is not null
          and phone.startup_slot_reserved_until > p_as_of
        )
        or (
          phone.scheduler_power_requested_at is not null
          and phone.scheduler_powered_on_at is null
          and coalesce(
            phone.startup_slot_reserved_until,
            phone.scheduler_power_requested_at + interval '15 minutes'
          ) > p_as_of
        )
        or (
          phone.id is distinct from p_ignored_poweroff_phone_id
          and phone.scheduler_poweroff_lease_expires_at > p_as_of
        )
        or exists (
          select 1
          from public.scheduler_runs as run
          where run.organization_id = phone.organization_id
            and run.connection_id = phone.connection_id
            and run.phone_id = phone.id
            and (
              coalesce(run.submission_state, 'never') in (
                'attempting', 'unknown'
              )
              or (
                run.submission_state = 'accepted'
                and (
                  run.duoplus_task_id is null
                  or run.duoplus_status is null
                  or run.duoplus_status not in (3, 4, 5)
                )
              )
              or (
                run.duoplus_task_id is not null
                and (
                  run.duoplus_status is null
                  or run.duoplus_status not in (3, 4, 5)
                )
              )
              or run.status in ('preparing', 'queued', 'running', 'paused')
              or (
                run.status in ('pending', 'retry_wait')
                and not run.cancellation_requested
                and run.attempt_count < run.max_attempts
                and (
                  run.window_end_at is null
                  or run.window_end_at > p_as_of
                )
                and (
                  coalesce(run.submission_state, 'never') <> 'never'
                  or run.next_action_at <=
                    p_as_of + make_interval(secs => p_idle_seconds)
                  or run.issue_at <=
                    p_as_of + make_interval(secs => p_idle_seconds)
                )
              )
            )
        )
      )
  );
$function$;

revoke all on function public.stakeout_physical_phone_has_protected_work(
  uuid, text, uuid, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.stakeout_physical_phone_has_protected_work(
  uuid, text, uuid, timestamptz, integer
) to service_role;

-- Claim one row at a time in phone -> connection -> pool order. The exclusive
-- pool lock serializes the physical-image recheck with acquire_phone_lease,
-- including an acquire through a duplicate workspace row.
create or replace function public.claim_idle_scheduler_powered_phones(
  p_worker_id text,
  p_idle_seconds integer default 900,
  p_limit integer default 20,
  p_claim_seconds integer default 120
)
returns table (
  id uuid,
  organization_id uuid,
  connection_id uuid,
  duoplus_image_id text,
  status integer,
  claim_token uuid
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_attempted uuid[] := array[]::uuid[];
  v_phone_id uuid;
  v_organization_id uuid;
  v_connection_id uuid;
  v_duoplus_image_id text;
  v_pool_id uuid;
  v_claim_pool_id uuid;
  v_now timestamptz;
  v_claim_token uuid;
  v_claimed integer := 0;
begin
  if p_worker_id is null
     or char_length(btrim(p_worker_id)) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'worker_id is required';
  end if;
  if p_idle_seconds is null
     or p_idle_seconds not between 60 and 86400 then
    raise exception using errcode = '22023', message = 'idle_seconds must be between 60 and 86400';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 100';
  end if;
  if p_claim_seconds is null
     or p_claim_seconds not between 30 and 600 then
    raise exception using errcode = '22023', message = 'claim_seconds must be between 30 and 600';
  end if;

  while v_claimed < p_limit loop
    v_now := clock_timestamp();
    select phone.id, phone.organization_id, phone.connection_id,
           phone.duoplus_image_id
    into v_phone_id, v_organization_id, v_connection_id,
         v_duoplus_image_id
    from public.duo_phones as phone
    join public.duo_connections as connection
      on connection.id = phone.connection_id
     and connection.organization_id = phone.organization_id
     and connection.status = 'active'
    where not (phone.id = any(v_attempted))
      and connection.capacity_pool_id is not null
      and (
        v_claim_pool_id is null
        or connection.capacity_pool_id = v_claim_pool_id
      )
      and phone.status = 1
      and phone.provider_present
      and phone.scheduler_power_requested_at is not null
      and phone.scheduler_powered_on_at is not null
      and phone.scheduler_powered_on_run_id is not null
      and phone.scheduler_last_activity_at is not null
      and phone.scheduler_last_activity_at <=
        v_now - make_interval(secs => p_idle_seconds)
      and (phone.lease_expires_at is null or phone.lease_expires_at <= v_now)
      and (phone.busy_until is null or phone.busy_until <= v_now)
      and (
        phone.scheduler_poweroff_lease_expires_at is null
        or phone.scheduler_poweroff_lease_expires_at <= v_now
      )
    order by phone.scheduler_last_activity_at, phone.id
    for update of phone skip locked
    limit 1;

    if not found then
      exit;
    end if;
    v_attempted := array_append(v_attempted, v_phone_id);

    -- The phone row is already locked. Match acquire_phone_lease's remaining
    -- lock order before making the pool-wide physical-image decision.
    select connection.capacity_pool_id
    into v_pool_id
    from public.duo_connections as connection
    where connection.id = v_connection_id
      and connection.organization_id = v_organization_id
      and connection.status = 'active'
    for update;
    if not found or v_pool_id is null then
      continue;
    end if;
    if v_claim_pool_id is null then
      v_claim_pool_id := v_pool_id;
    elsif v_pool_id <> v_claim_pool_id then
      continue;
    end if;

    perform pool.id
    from public.duo_capacity_pools as pool
    where pool.id = v_pool_id
    for update;
    if not found then
      continue;
    end if;

    v_now := clock_timestamp();
    if not exists (
      select 1
      from public.duo_phones as phone
      where phone.id = v_phone_id
        and phone.status = 1
        and phone.provider_present
        and phone.scheduler_power_requested_at is not null
        and phone.scheduler_powered_on_at is not null
        and phone.scheduler_powered_on_run_id is not null
        and phone.scheduler_last_activity_at <=
          v_now - make_interval(secs => p_idle_seconds)
        and (
          phone.lease_expires_at is null
          or phone.lease_expires_at <= v_now
        )
        and (phone.busy_until is null or phone.busy_until <= v_now)
        and (
          phone.scheduler_poweroff_lease_expires_at is null
          or phone.scheduler_poweroff_lease_expires_at <= v_now
        )
    ) or public.stakeout_physical_phone_has_protected_work(
      v_pool_id,
      v_duoplus_image_id,
      null,
      v_now,
      p_idle_seconds
    ) then
      continue;
    end if;

    v_claim_token := gen_random_uuid();
    update public.duo_phones as phone
    set scheduler_poweroff_lease_owner = btrim(p_worker_id),
        scheduler_poweroff_lease_token = v_claim_token,
        scheduler_poweroff_lease_expires_at =
          v_now + make_interval(secs => p_claim_seconds),
        scheduler_poweroff_last_error = null
    where phone.id = v_phone_id
      and phone.status = 1
      and phone.scheduler_power_requested_at is not null
      and phone.scheduler_powered_on_at is not null
      and phone.scheduler_powered_on_run_id is not null
      and (
        phone.scheduler_poweroff_lease_expires_at is null
        or phone.scheduler_poweroff_lease_expires_at <= v_now
      )
    returning phone.id, phone.organization_id, phone.connection_id,
              phone.duoplus_image_id, phone.status
    into id, organization_id, connection_id, duoplus_image_id, status;

    if found then
      claim_token := v_claim_token;
      v_claimed := v_claimed + 1;
      return next;
    end if;
  end loop;
end;
$function$;

revoke all on function public.claim_idle_scheduler_powered_phones(
  text, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.claim_idle_scheduler_powered_phones(
  text, integer, integer, integer
) to service_role;

-- Repeat the pool-wide check immediately before powerOff. Consuming the exact
-- ownership token leaves a live target-row shutdown lease, which every shared
-- pool acquire sees while the provider request is in flight.
create or replace function public.consume_scheduler_phone_poweroff_ownership(
  p_phone_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_extension_seconds integer default 600
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_phone public.duo_phones%rowtype;
  v_pool_id uuid;
  v_now timestamptz;
  v_updated integer;
begin
  if p_extension_seconds not between 30 and 600 then
    raise exception using errcode = '22023', message = 'extension_seconds must be between 30 and 600';
  end if;

  select * into v_phone
  from public.duo_phones as phone
  where phone.id = p_phone_id
  for update;
  if not found then
    return false;
  end if;

  select connection.capacity_pool_id
  into v_pool_id
  from public.duo_connections as connection
  where connection.id = v_phone.connection_id
    and connection.organization_id = v_phone.organization_id
    and connection.status = 'active'
  for update;
  if not found or v_pool_id is null then
    return false;
  end if;

  perform pool.id
  from public.duo_capacity_pools as pool
  where pool.id = v_pool_id
  for update;
  if not found then
    return false;
  end if;

  v_now := clock_timestamp();
  if v_phone.status <> 1
     or v_phone.scheduler_poweroff_lease_owner is distinct from
       btrim(p_worker_id)
     or v_phone.scheduler_poweroff_lease_token is distinct from p_claim_token
     or v_phone.scheduler_poweroff_lease_expires_at <= v_now
     or v_phone.scheduler_power_requested_at is null
     or v_phone.scheduler_powered_on_at is null
     or v_phone.scheduler_powered_on_run_id is null
     or (
       v_phone.lease_expires_at is not null
       and v_phone.lease_expires_at > v_now
     )
     or (v_phone.busy_until is not null and v_phone.busy_until > v_now)
     or public.stakeout_physical_phone_has_protected_work(
       v_pool_id,
       v_phone.duoplus_image_id,
       p_phone_id,
       v_now,
       900
     ) then
    return false;
  end if;

  update public.duo_phones as phone
  set scheduler_power_requested_at = null,
      scheduler_powered_on_at = null,
      scheduler_powered_on_run_id = null,
      scheduler_poweroff_lease_expires_at =
        v_now + make_interval(secs => p_extension_seconds)
  where phone.id = p_phone_id
    and phone.scheduler_poweroff_lease_owner = btrim(p_worker_id)
    and phone.scheduler_poweroff_lease_token = p_claim_token
    and phone.scheduler_poweroff_lease_expires_at > v_now;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

revoke all on function public.consume_scheduler_phone_poweroff_ownership(
  uuid, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.consume_scheduler_phone_poweroff_ownership(
  uuid, text, uuid, integer
) to service_role;

-- Once the provider has reported a settled non-on state, update every mirrored
-- row for that physical image. Lock duplicate phone rows in UUID order before
-- the pool row so a concurrent acquire holding one duplicate cannot deadlock
-- completion while waiting for the same pool fence.
create or replace function public.complete_scheduler_phone_power_off(
  p_phone_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_observed_status integer
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_phone public.duo_phones%rowtype;
  v_pool_id uuid;
  v_now timestamptz;
  v_updated integer;
begin
  if p_observed_status not in (0, 2, 3, 4, 12) then
    return false;
  end if;

  -- Pool links are durable and never move implicitly. Read identity first,
  -- then acquire every physical duplicate in one deterministic phone order.
  select phone.* into v_phone
  from public.duo_phones as phone
  where phone.id = p_phone_id;
  if not found then
    return false;
  end if;

  select connection.capacity_pool_id
  into v_pool_id
  from public.duo_connections as connection
  where connection.id = v_phone.connection_id
    and connection.organization_id = v_phone.organization_id;
  if not found or v_pool_id is null then
    return false;
  end if;

  perform phone.id
  from public.duo_phones as phone
  join public.duo_connections as connection
    on connection.id = phone.connection_id
   and connection.organization_id = phone.organization_id
  where connection.capacity_pool_id = v_pool_id
    and phone.duoplus_image_id = v_phone.duoplus_image_id
  order by phone.id
  for update of phone;

  select phone.* into v_phone
  from public.duo_phones as phone
  where phone.id = p_phone_id;

  perform connection.id
  from public.duo_connections as connection
  where connection.id = v_phone.connection_id
    and connection.organization_id = v_phone.organization_id
  for update;
  if not found then
    return false;
  end if;

  perform pool.id
  from public.duo_capacity_pools as pool
  where pool.id = v_pool_id
  for update;
  if not found then
    return false;
  end if;

  v_now := clock_timestamp();
  if v_phone.scheduler_poweroff_lease_owner is distinct from
       btrim(p_worker_id)
     or v_phone.scheduler_poweroff_lease_token is distinct from p_claim_token
     or v_phone.scheduler_poweroff_lease_expires_at <= v_now then
    return false;
  end if;

  update public.duo_phones as phone
  set status = p_observed_status,
      busy_until = null,
      lease_run_id = null,
      lease_token = null,
      lease_expires_at = null,
      scheduler_power_requested_at = null,
      scheduler_powered_on_at = null,
      scheduler_powered_on_run_id = null,
      scheduler_last_activity_at = v_now,
      scheduler_poweroff_lease_owner = null,
      scheduler_poweroff_lease_token = null,
      scheduler_poweroff_lease_expires_at = null,
      scheduler_poweroff_last_error = null,
      startup_slot_run_id = null,
      startup_slot_reserved_until = null,
      startup_power_attempted_at = null,
      last_seen_at = v_now,
      updated_at = v_now
  from public.duo_connections as connection
  where connection.id = phone.connection_id
    and connection.organization_id = phone.organization_id
    and connection.capacity_pool_id = v_pool_id
    and phone.duoplus_image_id = v_phone.duoplus_image_id;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$function$;

revoke all on function public.complete_scheduler_phone_power_off(
  uuid, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.complete_scheduler_phone_power_off(
  uuid, text, uuid, integer
) to service_role;

comment on function public.stakeout_physical_phone_has_protected_work(
  uuid, text, uuid, timestamptz, integer
) is
  'Detects active or near-term work and mutex state across every workspace row for one physical DuoPlus phone.';
comment on function public.claim_idle_scheduler_powered_phones(
  text, integer, integer, integer
) is
  'Claims scheduler-owned idle phones only after a shared-pool physical-image safety check serialized with admission.';
comment on function public.consume_scheduler_phone_poweroff_ownership(
  uuid, text, uuid, integer
) is
  'Revalidates shared-pool physical-image safety immediately before the remote powerOff side effect.';
comment on function public.complete_scheduler_phone_power_off(
  uuid, text, uuid, integer
) is
  'Propagates a settled physical phone shutdown across every mirrored workspace row in its shared pool.';
