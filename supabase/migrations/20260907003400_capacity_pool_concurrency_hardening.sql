-- Forward-only concurrency fixes for shared DuoPlus Startup pools.
-- The prior migration is already deployed and intentionally remains immutable.

-- Take schema locks in the same connection -> pool order used by runtime
-- functions. This prevents the migration itself from deadlocking an older
-- in-flight rate reservation while both table definitions are replaced.
lock table public.duo_connections in access exclusive mode;
lock table public.duo_capacity_pools in access exclusive mode;

-- Store rate state on the durable provider pool itself. Unlike the former
-- canonical-connection row, this state survives connection rotation/deletion
-- and never requires a pool lock followed by a connection FK lock.
alter table public.duo_capacity_pools
  add column if not exists rate_next_available_at timestamptz not null default now(),
  add column if not exists rate_last_reserved_at timestamptz,
  add column if not exists rate_reservation_count bigint not null default 0
    check (rate_reservation_count >= 0);

update public.duo_capacity_pools as pool
set rate_next_available_at = greatest(
      pool.rate_next_available_at,
      legacy.next_available_at
    ),
    rate_last_reserved_at = case
      when pool.rate_last_reserved_at is null then legacy.last_reserved_at
      when legacy.last_reserved_at is null then pool.rate_last_reserved_at
      else greatest(pool.rate_last_reserved_at, legacy.last_reserved_at)
    end,
    rate_reservation_count = greatest(
      pool.rate_reservation_count,
      legacy.reservation_count
    )
from (
  select
    connection.capacity_pool_id as pool_id,
    max(slot.next_available_at) as next_available_at,
    max(slot.last_reserved_at) as last_reserved_at,
    sum(slot.reservation_count)::bigint as reservation_count
  from public.duo_connections as connection
  join public.duo_rate_slots as slot
    on slot.connection_id = connection.id
   and slot.organization_id = connection.organization_id
  where connection.capacity_pool_id is not null
  group by connection.capacity_pool_id
) as legacy
where pool.id = legacy.pool_id;

-- Pool identity is durable. API-key rotation adds a fingerprint alias instead
-- of moving a connection to a new pool. A true provider-account switch needs a
-- future explicit drain/detach operation and is never inferred from a new key.
create table if not exists public.duo_capacity_pool_fingerprints (
  key_fingerprint text primary key
    check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  pool_id uuid not null,
  created_at timestamptz not null default now(),
  constraint duo_capacity_pool_fingerprints_pool_fk
    foreign key (pool_id)
    references public.duo_capacity_pools(id)
    on delete restrict
);

insert into public.duo_capacity_pool_fingerprints (
  key_fingerprint, pool_id
)
select pool.key_fingerprint, pool.id
from public.duo_capacity_pools as pool
on conflict (key_fingerprint) do nothing;

alter table public.duo_capacity_pool_fingerprints enable row level security;
revoke all on table public.duo_capacity_pool_fingerprints
  from public, anon, authenticated;
grant all on table public.duo_capacity_pool_fingerprints to service_role;

-- Replace the SET NULL relationship with an explicit durable reference. Pool
-- deletion is not an application operation, and service_role cannot delete or
-- truncate either pool identity table.
alter table public.duo_connections
  drop constraint if exists duo_connections_capacity_pool_id_fkey,
  drop constraint if exists duo_connections_capacity_pool_fk;
alter table public.duo_connections
  add constraint duo_connections_capacity_pool_fk
  foreign key (capacity_pool_id)
  references public.duo_capacity_pools(id)
  on delete restrict;

revoke delete, truncate on table public.duo_capacity_pools from service_role;
revoke delete, truncate on table public.duo_capacity_pool_fingerprints
  from service_role;

-- One authoritative provider snapshot is the most recently synchronized valid
-- row. If timestamps tie, the lower capacity wins conservatively and the UUID
-- makes selection deterministic. An older high value can never mask a newer
-- provider downgrade. A recently disconnected row remains authoritative until
-- its normal freshness TTL expires, so disconnect cannot resurrect an older
-- higher snapshot.
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
  select connection.subscription_capacity
  from public.duo_connections as connection
  where connection.capacity_pool_id = p_pool_id
    and connection.subscription_capacity is not null
    and connection.subscription_capacity >= 0
    and connection.subscription_in_use is not null
    and connection.subscription_available is not null
    and connection.subscription_in_use + connection.subscription_available =
      connection.subscription_capacity
    and connection.subscription_synced_at >=
      p_as_of - interval '60 minutes'
    and connection.subscription_synced_at <=
      p_as_of + interval '5 minutes'
  order by connection.subscription_synced_at desc,
           connection.subscription_capacity asc,
           connection.id
  limit 1;
$function$;

revoke all on function public.stakeout_current_provider_capacity(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.stakeout_current_provider_capacity(uuid, timestamptz)
  to service_role;

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
  with target_pool as (
    select pool.id, pool.worker_capacity_limit
    from public.duo_connections as connection
    join public.duo_capacity_pools as pool
      on pool.id = connection.capacity_pool_id
    where connection.id = p_connection_id
      and connection.organization_id = p_organization_id
      and connection.status = 'active'
  ), occupied as (
    select count(distinct phone.duoplus_image_id)::integer as active_count
    from target_pool
    join public.duo_connections as connection
      on connection.capacity_pool_id = target_pool.id
    join public.duo_phones as phone
      on phone.connection_id = connection.id
     and phone.organization_id = connection.organization_id
    where phone.status in (1, 10, 11)
       or (
         phone.lease_run_id is not null
         and phone.lease_expires_at > statement_timestamp()
       )
       or phone.scheduler_powered_on_at is not null
       or (
         phone.scheduler_power_requested_at is not null
         and phone.scheduler_powered_on_at is null
         and coalesce(
           phone.startup_slot_reserved_until,
           phone.scheduler_power_requested_at + interval '15 minutes'
         ) > statement_timestamp()
       )
       or (
         phone.startup_slot_run_id is not null
         and phone.startup_slot_reserved_until > statement_timestamp()
       )
  )
  select
    target_pool.id,
    target_pool.worker_capacity_limit,
    occupied.active_count,
    greatest(
      least(
        target_pool.worker_capacity_limit,
        coalesce(
          public.stakeout_current_provider_capacity(
            target_pool.id,
            clock_timestamp()
          ),
          0
        )
      ) - occupied.active_count,
      0
    )
  from target_pool
  cross join occupied;
$function$;

revoke all on function public.get_duoplus_capacity_snapshot(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_duoplus_capacity_snapshot(uuid, uuid)
  to service_role;

create or replace function public.link_duoplus_capacity_pool(
  p_connection_id uuid,
  p_organization_id uuid,
  p_key_fingerprint text,
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
  v_existing_pool_id uuid;
  v_pool_id uuid;
  v_alias_pool_id uuid;
  v_legacy_next_available timestamptz;
  v_legacy_last_reserved timestamptz;
  v_legacy_reservation_count bigint;
begin
  if p_key_fingerprint is null
     or p_key_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Capacity pool fingerprint is invalid';
  end if;
  if p_default_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Default worker capacity must be between 1 and 100';
  end if;

  -- Serialize creation for one fingerprint without holding any pool row first.
  perform pg_advisory_xact_lock(
    hashtextextended(p_key_fingerprint, 1949661977)
  );

  select connection.capacity_pool_id into v_existing_pool_id
  from public.duo_connections as connection
  where connection.id = p_connection_id
    and connection.organization_id = p_organization_id
    and connection.status = 'active'
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'Active DuoPlus connection not found';
  end if;

  if v_existing_pool_id is not null then
    -- A linked connection never moves implicitly. Lock its durable pool after
    -- the connection, matching acquire/set/rate lock order.
    perform 1
    from public.duo_capacity_pools as pool
    where pool.id = v_existing_pool_id
    for update;
    if not found then
      raise exception using errcode = '23503', message = 'DuoPlus capacity pool not found';
    end if;

    select alias.pool_id into v_alias_pool_id
    from public.duo_capacity_pool_fingerprints as alias
    where alias.key_fingerprint = p_key_fingerprint;

    if found and v_alias_pool_id <> v_existing_pool_id then
      raise exception using
        errcode = 'P4112',
        message = 'Capacity fingerprint is already linked to another provider pool';
    end if;

    insert into public.duo_capacity_pool_fingerprints (
      key_fingerprint, pool_id
    ) values (
      p_key_fingerprint, v_existing_pool_id
    )
    on conflict (key_fingerprint) do nothing;

    v_pool_id := v_existing_pool_id;
  else
    select alias.pool_id into v_pool_id
    from public.duo_capacity_pool_fingerprints as alias
    where alias.key_fingerprint = p_key_fingerprint;

    if v_pool_id is null then
      insert into public.duo_capacity_pools (
        key_fingerprint, worker_capacity_limit
      ) values (
        p_key_fingerprint, p_default_limit
      )
      on conflict (key_fingerprint) do update
      set key_fingerprint = excluded.key_fingerprint
      returning id into v_pool_id;

      insert into public.duo_capacity_pool_fingerprints (
        key_fingerprint, pool_id
      ) values (
        p_key_fingerprint, v_pool_id
      )
      on conflict (key_fingerprint) do nothing;
    else
      perform 1
      from public.duo_capacity_pools as pool
      where pool.id = v_pool_id
      for update;
      if not found then
        raise exception using errcode = '23503', message = 'DuoPlus capacity pool not found';
      end if;
    end if;

    -- This connection may have reserved a compatibility slot immediately
    -- before its first pool link. The connection lock excludes another such
    -- reservation while that durable history is merged into the pool.
    select slot.next_available_at, slot.last_reserved_at,
           slot.reservation_count
    into v_legacy_next_available, v_legacy_last_reserved,
         v_legacy_reservation_count
    from public.duo_rate_slots as slot
    where slot.connection_id = p_connection_id
    for update;

    if found then
      update public.duo_capacity_pools as pool
      set rate_next_available_at = greatest(
            pool.rate_next_available_at,
            v_legacy_next_available
          ),
          rate_last_reserved_at = case
            when pool.rate_last_reserved_at is null
              then v_legacy_last_reserved
            when v_legacy_last_reserved is null
              then pool.rate_last_reserved_at
            else greatest(
              pool.rate_last_reserved_at,
              v_legacy_last_reserved
            )
          end,
          rate_reservation_count =
            pool.rate_reservation_count + v_legacy_reservation_count
      where pool.id = v_pool_id;
    end if;

    update public.duo_connections as connection
    set capacity_pool_id = v_pool_id,
        updated_at = clock_timestamp()
    where connection.id = p_connection_id
      and connection.organization_id = p_organization_id
      and connection.capacity_pool_id is null;
  end if;

  return query
  select snapshot.pool_id, snapshot.worker_capacity_limit,
         snapshot.active_worker_count, snapshot.available_worker_slots
  from public.get_duoplus_capacity_snapshot(
    p_connection_id, p_organization_id
  ) as snapshot;
end;
$function$;

revoke all on function public.link_duoplus_capacity_pool(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.link_duoplus_capacity_pool(uuid, uuid, text, integer)
  to service_role;

create or replace function public.set_duoplus_worker_capacity(
  p_connection_id uuid,
  p_organization_id uuid,
  p_worker_capacity_limit integer
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
  v_pool_id uuid;
  v_provider_capacity integer;
  v_now timestamptz;
begin
  if p_worker_capacity_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Worker capacity must be between 1 and 100';
  end if;

  select connection.capacity_pool_id into v_pool_id
  from public.duo_connections as connection
  where connection.id = p_connection_id
    and connection.organization_id = p_organization_id
    and connection.status = 'active'
  for update;
  if not found or v_pool_id is null then
    raise exception using errcode = '23503', message = 'DuoPlus capacity pool is not linked';
  end if;

  perform 1
  from public.duo_capacity_pools as pool
  where pool.id = v_pool_id
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'DuoPlus capacity pool not found';
  end if;

  v_now := clock_timestamp();
  v_provider_capacity :=
    public.stakeout_current_provider_capacity(v_pool_id, v_now);
  if v_provider_capacity is null then
    raise exception using
      errcode = 'P4110',
      message = 'Current provider Subscription Startup capacity is unavailable or stale';
  end if;
  if p_worker_capacity_limit > v_provider_capacity then
    raise exception using
      errcode = 'P4111',
      message = 'Worker capacity cannot exceed current provider Subscription Startup capacity';
  end if;

  update public.duo_capacity_pools as pool
  set worker_capacity_limit = p_worker_capacity_limit
  where pool.id = v_pool_id;

  return query
  select snapshot.pool_id, snapshot.worker_capacity_limit,
         snapshot.active_worker_count, snapshot.available_worker_slots
  from public.get_duoplus_capacity_snapshot(
    p_connection_id, p_organization_id
  ) as snapshot;
end;
$function$;

revoke all on function public.set_duoplus_worker_capacity(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.set_duoplus_worker_capacity(uuid, uuid, integer)
  to service_role;

create or replace function public.reserve_duoplus_rate_slot(
  p_connection_id uuid,
  p_min_gap_ms integer default 1200
)
returns timestamptz
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_organization_id uuid;
  v_pool_id uuid;
  v_configured_gap integer;
  v_effective_gap integer;
  v_next_available timestamptz;
  v_reserved_at timestamptz;
begin
  if p_min_gap_ms not between 1200 and 60000 then
    raise exception using errcode = '22023', message = 'min_gap_ms must be between 1200 and 60000';
  end if;

  select connection.organization_id, connection.capacity_pool_id,
         connection.min_gap_ms
  into v_organization_id, v_pool_id, v_configured_gap
  from public.duo_connections as connection
  where connection.id = p_connection_id
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'DuoPlus connection not found';
  end if;

  if v_pool_id is not null then
    select pool.rate_next_available_at
    into v_next_available
    from public.duo_capacity_pools as pool
    where pool.id = v_pool_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'DuoPlus capacity pool not found';
    end if;

    select greatest(
      v_configured_gap,
      coalesce(max(connection.min_gap_ms), v_configured_gap)
    )::integer
    into v_configured_gap
    from public.duo_connections as connection
    where connection.capacity_pool_id = v_pool_id
      and connection.status = 'active';

    v_effective_gap := greatest(1200, p_min_gap_ms, v_configured_gap);

    v_reserved_at := greatest(clock_timestamp(), v_next_available);
    update public.duo_capacity_pools as pool
    set rate_last_reserved_at = v_reserved_at,
        rate_next_available_at =
          v_reserved_at + (interval '1 millisecond' * v_effective_gap),
        rate_reservation_count = pool.rate_reservation_count + 1
    where pool.id = v_pool_id;
  else
    -- Database-first compatibility for an active connection that has not yet
    -- been fingerprint-linked by the matching application deployment.
    v_effective_gap := greatest(1200, p_min_gap_ms, v_configured_gap);

    insert into public.duo_rate_slots (connection_id, organization_id)
    values (p_connection_id, v_organization_id)
    on conflict (connection_id) do nothing;

    select slot.next_available_at
    into v_next_available
    from public.duo_rate_slots as slot
    where slot.connection_id = p_connection_id
    for update;

    v_reserved_at := greatest(clock_timestamp(), v_next_available);
    update public.duo_rate_slots as slot
    set last_reserved_at = v_reserved_at,
        next_available_at =
          v_reserved_at + (interval '1 millisecond' * v_effective_gap),
        reservation_count = slot.reservation_count + 1,
        updated_at = clock_timestamp()
    where slot.connection_id = p_connection_id;
  end if;

  return v_reserved_at;
end;
$function$;

revoke all on function public.reserve_duoplus_rate_slot(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_duoplus_rate_slot(uuid, integer)
  to service_role;

-- Refresh the decision clock only after every potentially blocking row lock.
-- This prevents an expired run lease from being accepted after waiting for a
-- busy provider pool and ensures all TTLs begin at the actual acquisition time.
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
  v_effective_capacity integer;
  v_active_workers integer;
  v_target_occupies_slot boolean;
  v_preserve_startup_reservation boolean;
  v_existing_task boolean;
  v_submission_reconciliation boolean;
  v_now timestamptz;
  v_phone_lease_until timestamptz;
  v_startup_reserved_until timestamptz;
begin
  if p_lease_seconds not between 30 and 3600 then
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
    select pool.worker_capacity_limit into v_worker_capacity
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

    select
      count(distinct phone.duoplus_image_id)::integer,
      coalesce(bool_or(phone.duoplus_image_id = v_phone.duoplus_image_id), false)
    into v_active_workers, v_target_occupies_slot
    from public.duo_phones as phone
    join public.duo_connections as connection
      on connection.id = phone.connection_id
     and connection.organization_id = phone.organization_id
    where connection.capacity_pool_id = v_pool_id
      and (
        phone.status in (1, 10, 11)
        or (
          phone.lease_run_id is not null
          and phone.lease_expires_at > v_now
        )
        or phone.scheduler_powered_on_at is not null
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
      );

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

create or replace function public.stakeout_plan_cycle_run_workload()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_pool_id uuid;
  v_worker_capacity integer;
  v_provider_capacity integer;
  v_capacity integer;
  v_candidate timestamptz;
  v_candidate_end timestamptz;
  v_spacing interval := interval '15 minutes';
  v_pool_lane_end timestamptz;
  v_phone_lane_end timestamptz;
  v_phone_image_id text;
begin
  if new.device_cycle_id is null then
    return new;
  end if;

  select connection.capacity_pool_id into v_pool_id
  from public.duo_connections as connection
  where connection.id = new.connection_id
    and connection.organization_id = new.organization_id
    and connection.status = 'active'
  for share;
  if not found or v_pool_id is null then
    raise exception using
      errcode = '23514',
      message = 'A linked DuoPlus capacity pool is required for cycle workload planning';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_pool_id::text, 1768841693)
  );

  select pool.worker_capacity_limit into v_worker_capacity
  from public.duo_capacity_pools as pool
  where pool.id = v_pool_id
  for share;
  if not found then
    raise exception using errcode = '23514', message = 'DuoPlus capacity pool is unavailable';
  end if;

  v_provider_capacity :=
    public.stakeout_current_provider_capacity(
      v_pool_id,
      clock_timestamp()
    );
  if v_provider_capacity is null or v_provider_capacity <= 0 then
    raise exception using
      errcode = '23514',
      message = 'Current provider Subscription Startup capacity is unavailable for cycle workload planning';
  end if;
  v_capacity := least(v_worker_capacity, v_provider_capacity);

  if new.phone_id is not null then
    select phone.duoplus_image_id into v_phone_image_id
    from public.duo_phones as phone
    where phone.id = new.phone_id
      and phone.organization_id = new.organization_id
      and phone.connection_id = new.connection_id;
    if not found then
      raise exception using errcode = '23514', message = 'Cycle phone is unavailable for workload planning';
    end if;
  end if;

  v_candidate := greatest(new.issue_at, new.window_start_at);
  loop
    v_candidate_end :=
      v_candidate + (interval '1 second' * new.expected_duration_seconds);
    if v_candidate_end > new.window_end_at then
      raise exception using
        errcode = '23514',
        message = 'Cycle workload cannot fit before its canonical deadline';
    end if;

    with pool_windows as (
      select tstzrange(
        lower(run.planned_window) - v_spacing,
        upper(run.planned_window) + v_spacing,
        '[)'
      ) as occupied_window
      from public.scheduler_runs as run
      join public.duo_connections as connection
        on connection.id = run.connection_id
       and connection.organization_id = run.organization_id
      where connection.capacity_pool_id = v_pool_id
        and run.id <> new.id
        and run.status in ('pending', 'preparing', 'queued', 'running', 'paused', 'retry_wait')
        and tstzrange(
          lower(run.planned_window) - v_spacing,
          upper(run.planned_window) + v_spacing,
          '[)'
        ) && tstzrange(v_candidate, v_candidate_end, '[)')
    ), candidate_points as (
      select v_candidate as point_at
      union
      select greatest(lower(slot.occupied_window), v_candidate)
      from pool_windows as slot
    ), first_saturation as (
      select point.point_at
      from candidate_points as point
      where point.point_at < v_candidate_end
        and (
          select count(*)
          from pool_windows as slot
          where slot.occupied_window @> point.point_at
        ) >= v_capacity
      order by point.point_at
      limit 1
    )
    select min(upper(slot.occupied_window))
    into v_pool_lane_end
    from first_saturation as saturation
    join pool_windows as slot
      on slot.occupied_window @> saturation.point_at;

    select min(upper(run.planned_window) + v_spacing)
    into v_phone_lane_end
    from public.scheduler_runs as run
    join public.duo_connections as connection
      on connection.id = run.connection_id
     and connection.organization_id = run.organization_id
    join public.duo_phones as phone
      on phone.id = run.phone_id
     and phone.connection_id = run.connection_id
     and phone.organization_id = run.organization_id
    where v_phone_image_id is not null
      and connection.capacity_pool_id = v_pool_id
      and phone.duoplus_image_id = v_phone_image_id
      and run.id <> new.id
      and run.status <> 'cancelled'
      and tstzrange(
        lower(run.planned_window) - v_spacing,
        upper(run.planned_window) + v_spacing,
        '[)'
      ) && tstzrange(v_candidate, v_candidate_end, '[)');

    if v_pool_lane_end is null and v_phone_lane_end is null then
      new.issue_at := v_candidate;
      return new;
    end if;

    v_candidate := greatest(
      v_candidate + interval '1 minute',
      coalesce(v_pool_lane_end, v_candidate),
      coalesce(v_phone_lane_end, v_candidate)
    );
  end loop;
end;
$function$;

revoke all on function public.stakeout_plan_cycle_run_workload()
  from public, anon, authenticated;

comment on table public.duo_capacity_pool_fingerprints is
  'Service-only API-key fingerprint aliases preserving one durable provider pool across credential rotation.';
comment on function public.stakeout_current_provider_capacity(uuid, timestamptz) is
  'Returns the newest valid provider Startup capacity; tied snapshots choose the lower capacity conservatively.';
comment on function public.link_duoplus_capacity_pool(uuid, uuid, text, integer) is
  'Links an unlinked connection by fingerprint alias and records rotated aliases without ever moving an existing linked connection.';
comment on function public.reserve_duoplus_rate_slot(uuid, integer) is
  'Reserves the account-wide DuoPlus request gap directly on the durable capacity pool; unlinked connections retain the compatibility path.';
comment on function public.acquire_phone_lease(uuid, uuid, text, uuid, integer) is
  'Acquires under the shared pool using the newest provider snapshot and a post-lock clock/lease revalidation.';
comment on function public.stakeout_plan_cycle_run_workload() is
  'Plans shared worker lanes using the newest authoritative provider capacity snapshot.';
