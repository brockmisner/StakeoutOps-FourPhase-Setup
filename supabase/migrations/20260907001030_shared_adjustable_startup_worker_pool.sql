-- Model DuoPlus Subscription Startups as one adjustable worker pool shared by
-- every workspace that connects the same provider account. The fingerprint is
-- an application-keyed HMAC; no API credential is stored in this table.

create table if not exists public.duo_capacity_pools (
  id uuid primary key default gen_random_uuid(),
  key_fingerprint text not null unique
    check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  worker_capacity_limit integer not null default 3
    check (worker_capacity_limit between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.duo_capacity_pools enable row level security;
revoke all on table public.duo_capacity_pools from public, anon, authenticated;
grant all on table public.duo_capacity_pools to service_role;

drop trigger if exists stakeout_touch_duo_capacity_pools
  on public.duo_capacity_pools;
create trigger stakeout_touch_duo_capacity_pools
before update on public.duo_capacity_pools
for each row execute function public.stakeout_set_updated_at();

alter table public.duo_connections
  add column if not exists capacity_pool_id uuid
    references public.duo_capacity_pools(id) on delete set null;

create index if not exists duo_connections_capacity_pool_idx
  on public.duo_connections (capacity_pool_id, status)
  where capacity_pool_id is not null;

alter table public.duo_phones
  add column if not exists startup_slot_run_id uuid,
  add column if not exists startup_slot_reserved_until timestamptz,
  add column if not exists startup_power_attempted_at timestamptz;

alter table public.duo_phones
  drop constraint if exists duo_phones_startup_slot_complete,
  add constraint duo_phones_startup_slot_complete check (
    (
      startup_slot_run_id is null
      and startup_slot_reserved_until is null
      and startup_power_attempted_at is null
    )
    or
    (
      startup_slot_run_id is not null
      and startup_slot_reserved_until is not null
      and (
        startup_power_attempted_at is null
        or startup_power_attempted_at <= startup_slot_reserved_until
      )
    )
  );

create index if not exists duo_phones_startup_slot_idx
  on public.duo_phones (startup_slot_reserved_until, startup_slot_run_id)
  where startup_slot_run_id is not null;

-- A confirmed provider status ends the temporary boot reservation. A real ON
-- row remains counted by status; a completed shutdown releases every startup
-- field. Repeated OFF snapshots while booting deliberately preserve the
-- reservation and attempted marker so a minute retry cannot power on twice.
create or replace function public.clear_scheduler_power_ownership_on_shutdown()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if new.status = 1 then
    new.startup_slot_run_id := null;
    new.startup_slot_reserved_until := null;
    new.startup_power_attempted_at := null;
  elsif new.status in (0, 3, 4, 12)
     or (new.status = 2 and old.status <> 2) then
    new.scheduler_power_requested_at := null;
    new.scheduler_powered_on_at := null;
    new.scheduler_powered_on_run_id := null;
    new.scheduler_poweroff_lease_owner := null;
    new.scheduler_poweroff_lease_token := null;
    new.scheduler_poweroff_lease_expires_at := null;
    new.startup_slot_run_id := null;
    new.startup_slot_reserved_until := null;
    new.startup_power_attempted_at := null;
  end if;
  return new;
end;
$function$;

revoke all on function public.clear_scheduler_power_ownership_on_shutdown()
  from public, anon, authenticated;

-- Return live occupancy, de-duplicated by the provider's physical image id.
-- This intentionally counts manually-on phones, provider boot states, active
-- phone leases, scheduler power requests, and durable startup reservations.
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
stable
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
  ), provider as (
    select max(connection.subscription_capacity)::integer as provider_capacity
    from target_pool
    join public.duo_connections as connection
      on connection.capacity_pool_id = target_pool.id
    where connection.status = 'active'
      and connection.subscription_capacity is not null
      and connection.subscription_capacity > 0
      and connection.subscription_in_use is not null
      and connection.subscription_available is not null
      and connection.subscription_in_use + connection.subscription_available =
        connection.subscription_capacity
      and connection.subscription_synced_at >=
        clock_timestamp() - interval '60 minutes'
      and connection.subscription_synced_at <=
        clock_timestamp() + interval '5 minutes'
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
         and phone.lease_expires_at > clock_timestamp()
       )
       or phone.scheduler_powered_on_at is not null
       or (
         phone.scheduler_power_requested_at is not null
         and phone.scheduler_powered_on_at is null
         and coalesce(
           phone.startup_slot_reserved_until,
           phone.scheduler_power_requested_at + interval '15 minutes'
         ) > clock_timestamp()
       )
       or (
         phone.startup_slot_run_id is not null
         and phone.startup_slot_reserved_until > clock_timestamp()
       )
  )
  select
    target_pool.id,
    target_pool.worker_capacity_limit,
    occupied.active_count,
    greatest(
      least(
        target_pool.worker_capacity_limit,
        coalesce(provider.provider_capacity, 0)
      ) - occupied.active_count,
      0
    )
  from target_pool
  cross join provider
  cross join occupied;
$function$;

revoke all on function public.get_duoplus_capacity_snapshot(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_duoplus_capacity_snapshot(uuid, uuid)
  to service_role;

-- Link identical provider credentials to the same shared ceiling. Re-linking
-- never overwrites an operator-adjusted limit on an existing pool.
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
  v_pool_id uuid;
begin
  if p_key_fingerprint is null
     or p_key_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Capacity pool fingerprint is invalid';
  end if;
  if p_default_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Default worker capacity must be between 1 and 100';
  end if;

  perform 1
  from public.duo_connections as connection
  where connection.id = p_connection_id
    and connection.organization_id = p_organization_id
    and connection.status = 'active'
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'Active DuoPlus connection not found';
  end if;

  insert into public.duo_capacity_pools (
    key_fingerprint, worker_capacity_limit
  ) values (
    p_key_fingerprint, p_default_limit
  )
  on conflict (key_fingerprint) do update
  set key_fingerprint = excluded.key_fingerprint
  returning id into v_pool_id;

  update public.duo_connections as connection
  set capacity_pool_id = v_pool_id,
      updated_at = clock_timestamp()
  where connection.id = p_connection_id
    and connection.organization_id = p_organization_id;

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

-- Operators can lower the local concurrency ceiling, or raise it after the
-- provider snapshot proves that enough non-expired Subscription Startups exist.
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

  select max(connection.subscription_capacity)::integer
  into v_provider_capacity
  from public.duo_connections as connection
  where connection.capacity_pool_id = v_pool_id
    and connection.status = 'active'
    and connection.subscription_capacity is not null
    and connection.subscription_capacity > 0
    and connection.subscription_in_use is not null
    and connection.subscription_available is not null
    and connection.subscription_in_use + connection.subscription_available =
      connection.subscription_capacity
    and connection.subscription_synced_at >=
      clock_timestamp() - interval '60 minutes'
    and connection.subscription_synced_at <=
      clock_timestamp() + interval '5 minutes';

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

-- DuoPlus rate limits apply to the provider account, not to each duplicate
-- workspace connection. Preserve the public signature while all linked
-- connections reserve against one canonical rate-slot row.
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
  v_pool_id uuid;
  v_canonical_connection_id uuid;
  v_canonical_organization_id uuid;
  v_configured_gap integer;
  v_effective_gap integer;
  v_next_available timestamptz;
  v_pool_next_available timestamptz;
  v_reserved_at timestamptz;
begin
  if p_min_gap_ms not between 1200 and 60000 then
    raise exception using errcode = '22023', message = 'min_gap_ms must be between 1200 and 60000';
  end if;

  select connection.capacity_pool_id
  into v_pool_id
  from public.duo_connections as connection
  where connection.id = p_connection_id
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'DuoPlus connection not found';
  end if;

  if v_pool_id is not null then
    perform 1
    from public.duo_capacity_pools as pool
    where pool.id = v_pool_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'DuoPlus capacity pool not found';
    end if;

    select connection.id, connection.organization_id
    into v_canonical_connection_id, v_canonical_organization_id
    from public.duo_connections as connection
    where connection.capacity_pool_id = v_pool_id
    order by connection.id
    limit 1;

    select max(connection.min_gap_ms)::integer
    into v_configured_gap
    from public.duo_connections as connection
    where connection.capacity_pool_id = v_pool_id;

    select max(slot.next_available_at)
    into v_pool_next_available
    from public.duo_rate_slots as slot
    join public.duo_connections as connection
      on connection.id = slot.connection_id
     and connection.organization_id = slot.organization_id
    where connection.capacity_pool_id = v_pool_id;
  else
    select connection.id, connection.organization_id, connection.min_gap_ms
    into v_canonical_connection_id, v_canonical_organization_id,
         v_configured_gap
    from public.duo_connections as connection
    where connection.id = p_connection_id;
  end if;

  v_effective_gap := greatest(1200, p_min_gap_ms, v_configured_gap);

  insert into public.duo_rate_slots (connection_id, organization_id)
  values (v_canonical_connection_id, v_canonical_organization_id)
  on conflict (connection_id) do nothing;

  select greatest(
    slot.next_available_at,
    coalesce(v_pool_next_available, slot.next_available_at)
  )
  into v_next_available
  from public.duo_rate_slots as slot
  where slot.connection_id = v_canonical_connection_id
  for update;

  v_reserved_at := greatest(clock_timestamp(), v_next_available);

  update public.duo_rate_slots as slot
  set last_reserved_at = v_reserved_at,
      next_available_at =
        v_reserved_at + (interval '1 millisecond' * v_effective_gap),
      reservation_count = slot.reservation_count + 1,
      updated_at = clock_timestamp()
  where slot.connection_id = v_canonical_connection_id;

  return v_reserved_at;
end;
$function$;

revoke all on function public.reserve_duoplus_rate_slot(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_duoplus_rate_slot(uuid, integer)
  to service_role;

-- The effective five-argument dispatcher lease now serializes on the shared
-- pool row. It also fences duplicate records for one physical image id across
-- workspaces, and reserves an off phone before any remote powerOn side effect.
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
  v_now timestamptz := clock_timestamp();
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
     or v_run.lease_expires_at <= v_now
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
     )
     or (
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

  v_preserve_startup_reservation :=
    v_phone.startup_slot_run_id = p_run_id
    and v_phone.startup_slot_reserved_until > v_now;

  select connection.capacity_pool_id into v_pool_id
  from public.duo_connections as connection
  where connection.id = v_run.connection_id
    and connection.organization_id = v_run.organization_id
    and connection.status = 'active'
  for update;
  if not found then
    return false;
  end if;

  -- Existing remote tasks remain reconcilable during a database-first rollout,
  -- but a new remote task cannot start until this connection has a pool.
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

    -- One physical cloud phone can never be leased or have active remote work
    -- from a duplicate connection at the same time.
    if exists (
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
  end if;

  if not v_existing_task then
    select max(connection.subscription_capacity)::integer
    into v_provider_capacity
    from public.duo_connections as connection
    where connection.capacity_pool_id = v_pool_id
      and connection.status = 'active'
      and connection.subscription_capacity is not null
      and connection.subscription_capacity > 0
      and connection.subscription_in_use is not null
      and connection.subscription_available is not null
      and connection.subscription_in_use + connection.subscription_available =
        connection.subscription_capacity
      and connection.subscription_synced_at >= v_now - interval '60 minutes'
      and connection.subscription_synced_at <= v_now + interval '5 minutes';
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

  v_starts_attempt := not v_existing_task and (
    v_run.status in ('pending', 'retry_wait')
    or (v_run.status = 'preparing' and v_run.attempt_count = 0)
  );
  v_attempt_number := v_run.attempt_count + case when v_starts_attempt then 1 else 0 end;
  v_phone_lease_until := v_now + make_interval(secs => p_lease_seconds);
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

-- Pre-power validation can fail after acquisition but before powerOn. Release
-- those unused reservations immediately. Once the attempt marker is set, the
-- durable reservation survives normal per-tick lease cleanup so retries poll
-- instead of issuing a duplicate powerOn request.
create or replace function public.release_phone_lease(
  p_phone_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_run_lease_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_run public.scheduler_runs%rowtype;
  v_updated integer;
begin
  select * into v_run
  from public.scheduler_runs
  where id = p_run_id
  for update;

  if not found
     or v_run.lease_owner is distinct from nullif(btrim(p_worker_id), '')
     or v_run.lease_token is distinct from p_run_lease_token
     or v_run.phone_id is distinct from p_phone_id
     or v_run.phone_lease_token is null then
    return false;
  end if;

  update public.duo_phones
  set busy_until = null,
      lease_run_id = null,
      lease_token = null,
      lease_expires_at = null,
      scheduler_last_activity_at = clock_timestamp(),
      startup_slot_run_id = case
        when startup_slot_run_id = v_run.id
          and startup_power_attempted_at is null
          then null
        else startup_slot_run_id
      end,
      startup_slot_reserved_until = case
        when startup_slot_run_id = v_run.id
          and startup_power_attempted_at is null
          then null
        else startup_slot_reserved_until
      end,
      startup_power_attempted_at = case
        when startup_slot_run_id = v_run.id
          and startup_power_attempted_at is null
          then null
        else startup_power_attempted_at
      end
  where id = p_phone_id
    and organization_id = v_run.organization_id
    and connection_id = v_run.connection_id
    and lease_run_id = v_run.id
    and lease_token = v_run.phone_lease_token;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

revoke all on function public.release_phone_lease(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.release_phone_lease(uuid, uuid, text, uuid)
  to service_role;

-- A successful power-off releases only phone ownership and startup state.
-- Provider inventory and the operator's adjustable pool setting are retained.
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
begin
  update public.duo_phones as phone
  set status = p_observed_status,
      scheduler_power_requested_at = null,
      scheduler_powered_on_at = null,
      scheduler_powered_on_run_id = null,
      scheduler_poweroff_lease_owner = null,
      scheduler_poweroff_lease_token = null,
      scheduler_poweroff_lease_expires_at = null,
      scheduler_poweroff_last_error = null,
      startup_slot_run_id = null,
      startup_slot_reserved_until = null,
      startup_power_attempted_at = null
  where phone.id = p_phone_id
    and phone.scheduler_poweroff_lease_owner = btrim(p_worker_id)
    and phone.scheduler_poweroff_lease_token = p_claim_token
    and phone.scheduler_poweroff_lease_expires_at > clock_timestamp();

  return found;
end;
$function$;

revoke all on function public.complete_scheduler_phone_power_off(uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.complete_scheduler_phone_power_off(uuid, text, uuid, integer)
  to service_role;

-- Plan cycle-generated work across the shared pool. Saturation advances to the
-- soonest worker-lane end, rather than the latest overlapping job, and the
-- physical image id fence also spans duplicate workspace connections.
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

  select max(connection.subscription_capacity)::integer
  into v_provider_capacity
  from public.duo_connections as connection
  where connection.capacity_pool_id = v_pool_id
    and connection.status = 'active'
    and connection.subscription_capacity is not null
    and connection.subscription_capacity > 0
    and connection.subscription_in_use is not null
    and connection.subscription_available is not null
    and connection.subscription_in_use + connection.subscription_available =
      connection.subscription_capacity
    and connection.subscription_synced_at >=
      clock_timestamp() - interval '60 minutes'
    and connection.subscription_synced_at <=
      clock_timestamp() + interval '5 minutes';
  if v_provider_capacity is null then
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

    -- Find the first instant in the candidate interval at which all lanes are
    -- occupied, then advance to the earliest of those lanes ending.
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

comment on table public.duo_capacity_pools is
  'Service-only shared Startup worker ceilings keyed by an application-HMAC provider credential fingerprint.';
comment on column public.duo_capacity_pools.worker_capacity_limit is
  'Operator-adjustable concurrent powered-phone ceiling; defaults to three and cannot be raised above current provider capacity.';
comment on column public.duo_connections.capacity_pool_id is
  'Shared physical Subscription Startup pool for connections using the same DuoPlus account.';
comment on column public.duo_phones.startup_slot_run_id is
  'Run holding a durable worker-slot reservation while this off phone boots.';
comment on column public.duo_phones.startup_slot_reserved_until is
  'Expiry for the pre-powerOn worker-slot reservation.';
comment on column public.duo_phones.startup_power_attempted_at is
  'Set atomically before remote powerOn; minute retries poll until the reservation expires instead of issuing duplicate powerOn requests.';
comment on function public.get_duoplus_capacity_snapshot(uuid, uuid) is
  'Returns the adjustable shared worker ceiling and distinct live physical-phone occupancy for a linked connection.';
comment on function public.link_duoplus_capacity_pool(uuid, uuid, text, integer) is
  'Links a connection to the shared HMAC-identified DuoPlus Startup pool without overwriting an existing operator limit.';
comment on function public.set_duoplus_worker_capacity(uuid, uuid, integer) is
  'Adjusts the shared worker ceiling from 1 to 100, bounded by a fresh provider capacity snapshot.';
comment on function public.reserve_duoplus_rate_slot(uuid, integer) is
  'Serializes DuoPlus requests across one canonical rate slot for every connection sharing a provider-account capacity pool.';
comment on function public.acquire_phone_lease(uuid, uuid, text, uuid, integer) is
  'Atomically fences physical phones and reserves a shared Startup worker slot before a new off-phone powerOn.';
comment on function public.release_phone_lease(uuid, uuid, text, uuid) is
  'Releases an unused startup reservation before powerOn, but preserves a marked attempt across minute-tick lease cleanup.';
comment on function public.complete_scheduler_phone_power_off(uuid, text, uuid, integer) is
  'Completes a scheduler-owned power-off without clearing provider capacity or the adjustable shared worker setting.';
comment on function public.stakeout_plan_cycle_run_workload() is
  'Places cycle runs across the shared Startup pool and advances saturation to the earliest ending worker lane.';
