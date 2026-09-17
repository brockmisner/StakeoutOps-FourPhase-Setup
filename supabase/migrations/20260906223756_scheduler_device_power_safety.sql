-- Scheduler-owned phone power lifecycle and final expired-device dispatch fences.
-- No phone is eligible for automatic shutdown unless this scheduler both
-- requested its off -> on transition and later observed the phone online.

alter table public.duo_phones
  add column if not exists provider_present boolean not null default true,
  add column if not exists scheduler_power_requested_at timestamptz,
  add column if not exists scheduler_powered_on_at timestamptz,
  add column if not exists scheduler_powered_on_run_id uuid,
  add column if not exists scheduler_last_activity_at timestamptz,
  add column if not exists scheduler_poweroff_lease_owner text,
  add column if not exists scheduler_poweroff_lease_token uuid,
  add column if not exists scheduler_poweroff_lease_expires_at timestamptz,
  add column if not exists scheduler_poweroff_last_error text;

-- Older inventory syncs used enabled=false to mean "not returned by the
-- provider", so migrate that provider state into its own column once. From
-- this point forward enabled is exclusively the operator's scheduler switch.
update public.duo_phones
set provider_present = case
      when metadata ->> 'provider_present' = 'false' then false
      else true
    end,
    enabled = case
      -- The newly added column defaults true, which distinguishes the one-time
      -- legacy conversion from a migration replay after an operator disables
      -- the already-converted row.
      when provider_present
        and metadata ->> 'provider_present' = 'false'
        then true
      else enabled
    end;

create index if not exists duo_phones_provider_eligibility_idx
  on public.duo_phones (organization_id, connection_id, enabled, status)
  where provider_present;

create or replace function public.replace_duoplus_phone_inventory(
  p_organization_id uuid,
  p_connection_id uuid,
  p_synced_at timestamptz,
  p_phones jsonb
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_count integer;
  v_connection_updated integer;
  v_previous_synced_at timestamptz;
begin
  if p_organization_id is null or p_connection_id is null then
    raise exception using errcode = '22004', message = 'Organization and connection are required';
  end if;
  if p_synced_at is null then
    raise exception using errcode = '22004', message = 'Inventory sync time is required';
  end if;
  if p_synced_at > clock_timestamp() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'Inventory sync time is too far in the future';
  end if;
  if jsonb_typeof(p_phones) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Phone inventory must be a JSON array';
  end if;

  -- Serialize complete snapshots for one provider connection. A slower,
  -- older request must never overwrite or mark absent phones from a newer one.
  perform pg_advisory_xact_lock(
    hashtextextended(p_connection_id::text, 1723549171)
  );

  select connection.inventory_synced_at
  into v_previous_synced_at
  from public.duo_connections as connection
  where connection.id = p_connection_id
    and connection.organization_id = p_organization_id;

  if not found then
    raise exception using errcode = '23503', message = 'DuoPlus connection not found';
  end if;
  if v_previous_synced_at is not null and v_previous_synced_at > p_synced_at then
    raise exception using errcode = 'P4107', message = 'Stale phone inventory snapshot';
  end if;

  with incoming as (
    select
      item.duoplus_image_id,
      item.name,
      item.status,
      item.adb_endpoint,
      item.ip_address,
      item.os_version,
      item.expired_at,
      item.last_seen_at,
      coalesce(item.metadata, '{}'::jsonb)
        || jsonb_build_object('provider_present', true) as metadata
    from jsonb_to_recordset(p_phones) as item(
      duoplus_image_id text,
      name text,
      status integer,
      adb_endpoint text,
      ip_address inet,
      os_version text,
      expired_at timestamptz,
      last_seen_at timestamptz,
      metadata jsonb
    )
  )
  insert into public.duo_phones (
    organization_id, connection_id, duoplus_image_id, name, status,
    adb_endpoint, ip_address, os_version, expired_at, last_seen_at,
    metadata, enabled, provider_present, updated_at
  )
  select
    p_organization_id, p_connection_id, incoming.duoplus_image_id,
    incoming.name, incoming.status, incoming.adb_endpoint,
    incoming.ip_address, incoming.os_version, incoming.expired_at,
    coalesce(incoming.last_seen_at, p_synced_at), incoming.metadata,
    true, true, p_synced_at
  from incoming
  where nullif(btrim(incoming.duoplus_image_id), '') is not null
  on conflict (connection_id, duoplus_image_id) do update
  set name = excluded.name,
      status = excluded.status,
      adb_endpoint = excluded.adb_endpoint,
      ip_address = excluded.ip_address,
      os_version = excluded.os_version,
      expired_at = excluded.expired_at,
      last_seen_at = excluded.last_seen_at,
      metadata = excluded.metadata,
      provider_present = true,
      -- Deliberately preserve duo_phones.enabled. Inventory discovery must
      -- never undo an operator's manual scheduler disable.
      updated_at = excluded.updated_at
  where duo_phones.organization_id = p_organization_id;

  update public.duo_phones as phone
  set provider_present = false,
      scheduler_power_requested_at = null,
      scheduler_powered_on_at = null,
      scheduler_powered_on_run_id = null,
      scheduler_poweroff_lease_owner = null,
      scheduler_poweroff_lease_token = null,
      scheduler_poweroff_lease_expires_at = null,
      metadata = coalesce(phone.metadata, '{}'::jsonb)
        || jsonb_build_object('provider_present', false),
      updated_at = p_synced_at
  where phone.organization_id = p_organization_id
    and phone.connection_id = p_connection_id
    and not exists (
      select 1
      from jsonb_array_elements(p_phones) as item(value)
      where item.value ->> 'duoplus_image_id' = phone.duoplus_image_id
    );

  update public.duo_connections as connection
  set inventory_synced_at = p_synced_at,
      updated_at = greatest(
        coalesce(connection.updated_at, p_synced_at),
        p_synced_at
      )
  where connection.id = p_connection_id
    and connection.organization_id = p_organization_id
    and (
      connection.inventory_synced_at is null
      or connection.inventory_synced_at <= p_synced_at
    );

  get diagnostics v_connection_updated = row_count;
  if v_connection_updated <> 1 then
    raise exception using errcode = 'P4107', message = 'Stale phone inventory snapshot';
  end if;

  v_count := jsonb_array_length(p_phones);
  return v_count;
end;
$function$;

revoke all on function public.replace_duoplus_phone_inventory(uuid, uuid, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_duoplus_phone_inventory(uuid, uuid, timestamptz, jsonb)
  to service_role;

alter table public.duo_phones
  drop constraint if exists duo_phones_scheduler_power_owner_complete,
  add constraint duo_phones_scheduler_power_owner_complete check (
    (
      scheduler_power_requested_at is null
      and scheduler_powered_on_at is null
      and scheduler_powered_on_run_id is null
    )
    or
    (
      scheduler_power_requested_at is not null
      and scheduler_powered_on_run_id is not null
    )
  ),
  drop constraint if exists duo_phones_scheduler_poweroff_lease_complete,
  add constraint duo_phones_scheduler_poweroff_lease_complete check (
    (
      scheduler_poweroff_lease_owner is null
      and scheduler_poweroff_lease_token is null
      and scheduler_poweroff_lease_expires_at is null
    )
    or
    (
      scheduler_poweroff_lease_owner is not null
      and scheduler_poweroff_lease_token is not null
      and scheduler_poweroff_lease_expires_at is not null
    )
  );

create index if not exists duo_phones_scheduler_idle_power_idx
  on public.duo_phones (
    scheduler_last_activity_at,
    scheduler_poweroff_lease_expires_at,
    connection_id
  )
  where scheduler_powered_on_at is not null and status = 1;

create or replace function public.clear_scheduler_power_ownership_on_shutdown()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  -- A confirmed transition away from an active/powering state ends the
  -- scheduler-owned power session. Repeated status=2 snapshots immediately
  -- after a powerOn request do not erase a still-pending confirmation.
  if new.status in (0, 3, 4, 12)
     or (new.status = 2 and old.status <> 2) then
    new.scheduler_power_requested_at := null;
    new.scheduler_powered_on_at := null;
    new.scheduler_powered_on_run_id := null;
    new.scheduler_poweroff_lease_owner := null;
    new.scheduler_poweroff_lease_token := null;
    new.scheduler_poweroff_lease_expires_at := null;
  end if;
  return new;
end;
$function$;

revoke all on function public.clear_scheduler_power_ownership_on_shutdown()
  from public, anon, authenticated;

drop trigger if exists clear_scheduler_power_ownership_on_shutdown
  on public.duo_phones;
create trigger clear_scheduler_power_ownership_on_shutdown
before update of status on public.duo_phones
for each row execute function public.clear_scheduler_power_ownership_on_shutdown();

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
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'worker_id is required';
  end if;
  if p_idle_seconds not between 60 and 86400 then
    raise exception using errcode = '22023', message = 'idle_seconds must be between 60 and 86400';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 100';
  end if;
  if p_claim_seconds not between 30 and 600 then
    raise exception using errcode = '22023', message = 'claim_seconds must be between 30 and 600';
  end if;

  return query
  with candidates as (
    select phone.id
    from public.duo_phones as phone
    join public.duo_connections as connection
      on connection.id = phone.connection_id
     and connection.organization_id = phone.organization_id
     and connection.status = 'active'
    where phone.status = 1
      and phone.provider_present
      and phone.scheduler_power_requested_at is not null
      and phone.scheduler_powered_on_at is not null
      and phone.scheduler_powered_on_run_id is not null
      and phone.scheduler_last_activity_at is not null
      and phone.scheduler_last_activity_at <=
        clock_timestamp() - make_interval(secs => p_idle_seconds)
      and (
        phone.lease_expires_at is null
        or phone.lease_expires_at <= clock_timestamp()
      )
      and (
        phone.busy_until is null
        or phone.busy_until <= clock_timestamp()
      )
      and (
        phone.scheduler_poweroff_lease_expires_at is null
        or phone.scheduler_poweroff_lease_expires_at <= clock_timestamp()
      )
      and not exists (
        select 1
        from public.scheduler_runs as run
        where run.organization_id = phone.organization_id
          and run.connection_id = phone.connection_id
          and run.phone_id = phone.id
          and (
            -- Local terminal state does not prove an ambiguous remote side
            -- effect is terminal. Keep the persisted phone on until taskList
            -- establishes a final DuoPlus state.
            coalesce(run.submission_state, 'never') in ('attempting', 'unknown')
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
              and (
                coalesce(run.submission_state, 'never') <> 'never'
                or run.next_action_at <=
                  clock_timestamp() + make_interval(secs => p_idle_seconds)
                or run.issue_at <=
                  clock_timestamp() + make_interval(secs => p_idle_seconds)
              )
            )
          )
      )
    order by phone.scheduler_last_activity_at, phone.id
    for update of phone skip locked
    limit p_limit
  ), claimed as (
    update public.duo_phones as phone
    set scheduler_poweroff_lease_owner = btrim(p_worker_id),
        scheduler_poweroff_lease_token = gen_random_uuid(),
        scheduler_poweroff_lease_expires_at =
          clock_timestamp() + make_interval(secs => p_claim_seconds),
        scheduler_poweroff_last_error = null
    from candidates
    where phone.id = candidates.id
    returning phone.id, phone.organization_id, phone.connection_id,
              phone.duoplus_image_id, phone.status,
              phone.scheduler_poweroff_lease_token
  )
  select claimed.id, claimed.organization_id, claimed.connection_id,
         claimed.duoplus_image_id, claimed.status,
         claimed.scheduler_poweroff_lease_token
  from claimed;
end;
$function$;

revoke all on function public.claim_idle_scheduler_powered_phones(text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_idle_scheduler_powered_phones(text, integer, integer, integer)
  to service_role;

comment on function public.claim_idle_scheduler_powered_phones(text, integer, integer, integer) is
  'Atomically claims idle phones whose current power session was started and confirmed by the scheduler.';

-- Revalidate immediately before the remote powerOff side effect. A batch
-- claim may have waited behind earlier phones, so its original short lease is
-- not sufficient authorization. Consuming ownership also extends the claim
-- across the bounded provider request, preventing a new run from starting in
-- the middle of shutdown.
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
  v_updated integer;
begin
  if p_extension_seconds not between 30 and 600 then
    raise exception using errcode = '22023', message = 'extension_seconds must be between 30 and 600';
  end if;

  update public.duo_phones as phone
  set scheduler_power_requested_at = null,
      scheduler_powered_on_at = null,
      scheduler_powered_on_run_id = null,
      scheduler_poweroff_lease_expires_at =
        clock_timestamp() + make_interval(secs => p_extension_seconds)
  where phone.id = p_phone_id
    and phone.status = 1
    and phone.scheduler_poweroff_lease_owner = btrim(p_worker_id)
    and phone.scheduler_poweroff_lease_token = p_claim_token
    and phone.scheduler_poweroff_lease_expires_at > clock_timestamp()
    and phone.scheduler_power_requested_at is not null
    and phone.scheduler_powered_on_at is not null
    and phone.scheduler_powered_on_run_id is not null
    and (phone.lease_expires_at is null or phone.lease_expires_at <= clock_timestamp())
    and (phone.busy_until is null or phone.busy_until <= clock_timestamp())
    and not exists (
      select 1
      from public.scheduler_runs as run
      where run.organization_id = phone.organization_id
        and run.connection_id = phone.connection_id
        and run.phone_id = phone.id
        and (
          coalesce(run.submission_state, 'never') in ('attempting', 'unknown')
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
            and (
              coalesce(run.submission_state, 'never') <> 'never'
              or run.next_action_at <=
                clock_timestamp() + interval '15 minutes'
              or run.issue_at <= clock_timestamp() + interval '15 minutes'
            )
          )
        )
    );

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

revoke all on function public.consume_scheduler_phone_poweroff_ownership(uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.consume_scheduler_phone_poweroff_ownership(uuid, text, uuid, integer)
  to service_role;

-- Releasing before powerOff clears the claim. An ambiguous provider result is
-- different: ownership is abandoned to prevent retries, but the claim stays
-- live for a bounded quarantine so new work cannot race an in-flight shutdown.
create or replace function public.release_scheduler_phone_poweroff_claim(
  p_phone_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_abandon_ownership boolean default false,
  p_error_message text default null,
  p_quarantine_seconds integer default 600
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_updated integer;
begin
  if p_quarantine_seconds not between 30 and 600 then
    raise exception using errcode = '22023', message = 'quarantine_seconds must be between 30 and 600';
  end if;

  update public.duo_phones as phone
  set scheduler_power_requested_at = case
        when p_abandon_ownership then null
        else phone.scheduler_power_requested_at
      end,
      scheduler_powered_on_at = case
        when p_abandon_ownership then null
        else phone.scheduler_powered_on_at
      end,
      scheduler_powered_on_run_id = case
        when p_abandon_ownership then null
        else phone.scheduler_powered_on_run_id
      end,
      scheduler_poweroff_lease_owner = case
        when p_abandon_ownership then phone.scheduler_poweroff_lease_owner
        else null
      end,
      scheduler_poweroff_lease_token = case
        when p_abandon_ownership then phone.scheduler_poweroff_lease_token
        else null
      end,
      scheduler_poweroff_lease_expires_at = case
        when p_abandon_ownership then greatest(
          phone.scheduler_poweroff_lease_expires_at,
          clock_timestamp() + make_interval(secs => p_quarantine_seconds)
        )
        else null
      end,
      scheduler_poweroff_last_error = left(p_error_message, 1000)
  where phone.id = p_phone_id
    and phone.scheduler_poweroff_lease_owner = btrim(p_worker_id)
    and phone.scheduler_poweroff_lease_token = p_claim_token
    and phone.scheduler_poweroff_lease_expires_at > clock_timestamp();

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

revoke all on function public.release_scheduler_phone_poweroff_claim(uuid, text, uuid, boolean, text, integer)
  from public, anon, authenticated;
grant execute on function public.release_scheduler_phone_poweroff_claim(uuid, text, uuid, boolean, text, integer)
  to service_role;

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
  v_organization_id uuid;
  v_connection_id uuid;
begin
  update public.duo_phones as phone
  set status = p_observed_status,
      scheduler_power_requested_at = null,
      scheduler_powered_on_at = null,
      scheduler_powered_on_run_id = null,
      scheduler_poweroff_lease_owner = null,
      scheduler_poweroff_lease_token = null,
      scheduler_poweroff_lease_expires_at = null,
      scheduler_poweroff_last_error = null
  where phone.id = p_phone_id
    and phone.scheduler_poweroff_lease_owner = btrim(p_worker_id)
    and phone.scheduler_poweroff_lease_token = p_claim_token
    and phone.scheduler_poweroff_lease_expires_at > clock_timestamp()
  returning phone.organization_id, phone.connection_id
  into v_organization_id, v_connection_id;

  if not found then
    return false;
  end if;

  -- Power changes can move a Subscription Startup between DuoPlus pools.
  -- Clear the all-or-none snapshot so the next minute tick must refresh it
  -- before any new phone is allowed to power on.
  update public.duo_connections as connection
  set subscription_capacity = null,
      subscription_in_use = null,
      subscription_available = null,
      subscription_synced_at = null,
      updated_at = clock_timestamp()
  where connection.id = v_connection_id
    and connection.organization_id = v_organization_id;

  return true;
end;
$function$;

revoke all on function public.complete_scheduler_phone_power_off(uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.complete_scheduler_phone_power_off(uuid, text, uuid, integer)
  to service_role;

-- A cycle reserves one dedicated phone for every client-local day. It is not
-- enough for the phone to be paid today: its provider subscription must cover
-- the exclusive instant after the final local cycle day.
create or replace function public.stakeout_validate_cycle_phone_eligibility()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_required_through timestamptz;
  v_phone public.duo_phones%rowtype;
begin
  if new.status not in ('provisioning', 'active', 'paused', 'blocked') then
    return new;
  end if;

  v_required_through := ((new.ends_on + 1)::timestamp at time zone new.timezone);
  select * into v_phone
  from public.duo_phones as phone
  where phone.id = new.phone_id
    and phone.organization_id = new.organization_id
    and phone.connection_id = new.connection_id
  for share;

  if not found
     or v_phone.client_id is distinct from new.client_id
     or not v_phone.enabled
     or not v_phone.provider_present
     or v_phone.status in (3, 4)
     or (
       v_phone.expired_at is not null
       and v_phone.expired_at <= v_required_through
     ) then
    raise exception using
      errcode = 'P4108',
      message = 'Phone must remain eligible through the full device cycle';
  end if;

  return new;
end;
$function$;

revoke all on function public.stakeout_validate_cycle_phone_eligibility()
  from public, anon, authenticated;

drop trigger if exists stakeout_validate_cycle_phone_eligibility
  on public.device_cycles;
create trigger stakeout_validate_cycle_phone_eligibility
before insert or update of phone_id, client_id, connection_id, starts_on,
  ends_on, timezone, status
on public.device_cycles
for each row execute function public.stakeout_validate_cycle_phone_eligibility();

-- Preserve the existing lease semantics while adding two final fences:
-- expired/renewal-overdue statuses can never receive a run, and a phone being
-- shut down cannot race a new assignment.
create or replace function public.acquire_phone_lease(
  p_phone_id uuid,
  p_run_id uuid,
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
  v_subscription_capacity integer;
  v_subscription_in_use integer;
  v_subscription_available integer;
  v_subscription_synced_at timestamptz;
  v_active_or_reserved integer;
  v_existing_task boolean;
begin
  if p_lease_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'lease_seconds must be between 30 and 3600';
  end if;

  select * into v_run
  from public.scheduler_runs
  where id = p_run_id
  for update;

  if not found
     or v_run.lease_owner is null
     or v_run.lease_expires_at <= clock_timestamp()
     or v_run.cancellation_requested
     or v_run.status not in ('pending', 'retry_wait', 'preparing', 'queued', 'running', 'paused')
     or (
       v_run.status in ('pending', 'retry_wait')
       and v_run.attempt_count >= v_run.max_attempts
     ) then
    return false;
  end if;

  v_existing_task := v_run.submission_state in ('attempting', 'accepted', 'unknown')
    or v_run.duoplus_task_id is not null
    or v_run.status in ('queued', 'running', 'paused')
    or v_run.stage in ('resolve_task', 'monitor_task', 'fetch_logs', 'cancel_task');

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
           and v_phone.expired_at <= clock_timestamp()
         )
       )
     )
     or (v_phone.lease_expires_at is not null and v_phone.lease_expires_at > clock_timestamp())
     or (v_phone.busy_until is not null and v_phone.busy_until > clock_timestamp())
     or (
       v_phone.scheduler_poweroff_lease_expires_at is not null
       and v_phone.scheduler_poweroff_lease_expires_at > clock_timestamp()
     ) then
    return false;
  end if;

  select subscription_capacity, subscription_in_use, subscription_available,
         subscription_synced_at
  into v_subscription_capacity, v_subscription_in_use,
       v_subscription_available, v_subscription_synced_at
  from public.duo_connections
  where id = v_run.connection_id
    and organization_id = v_run.organization_id
    and status = 'active'
  for update;

  if not found then
    return false;
  end if;

  if not v_existing_task then
    if v_subscription_capacity is null
       or v_subscription_capacity <= 0
       or v_subscription_in_use is null
       or v_subscription_available is null
       or v_subscription_in_use + v_subscription_available <> v_subscription_capacity
       or v_subscription_synced_at is null
       or v_subscription_synced_at < clock_timestamp() - interval '60 minutes'
       or v_subscription_synced_at > clock_timestamp() + interval '5 minutes' then
      return false;
    end if;

    if v_phone.status not in (1, 10, 11) then
      select count(*)::integer
      into v_active_or_reserved
      from public.duo_phones as phone
      where phone.connection_id = v_run.connection_id
        and phone.organization_id = v_run.organization_id
        and phone.id <> p_phone_id
        and (
          phone.status in (1, 10, 11)
          or (
            phone.lease_run_id is not null
            and phone.lease_expires_at > clock_timestamp()
          )
        );

      if greatest(v_active_or_reserved, v_subscription_in_use) >= v_subscription_capacity then
        return false;
      end if;
    end if;
  end if;

  v_starts_attempt := v_run.status in ('pending', 'retry_wait')
    or (v_run.status = 'preparing' and v_run.attempt_count = 0);
  v_attempt_number := v_run.attempt_count + case when v_starts_attempt then 1 else 0 end;

  begin
    update public.scheduler_runs
    set phone_id = p_phone_id,
        status = case
          when v_run.status in ('queued', 'running', 'paused') then v_run.status
          else 'preparing'
        end,
        stage = case when v_starts_attempt then 'prepare_phone' else v_run.stage end,
        attempt_count = v_attempt_number,
        phone_lease_token = v_phone_token,
        started_at = coalesce(started_at, clock_timestamp())
    where id = p_run_id;

    update public.duo_phones
    set busy_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        lease_run_id = p_run_id,
        lease_token = v_phone_token,
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
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

revoke all on function public.acquire_phone_lease(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.acquire_phone_lease(uuid, uuid, integer)
  to service_role;

-- Manual client ownership is also a server-side assignment. Allow removing an
-- assignment from any phone, but reject a new assignment for expired inventory.
create or replace function public.assign_duoplus_phone_client(
  p_organization_id uuid,
  p_phone_id uuid,
  p_client_id uuid
)
returns setof public.duo_phones
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_phone public.duo_phones%rowtype;
  v_client_status text;
begin
  select * into v_phone
  from public.duo_phones as phone
  where phone.id = p_phone_id
    and phone.organization_id = p_organization_id
  for update;

  if not found then
    raise exception using errcode = 'P4101', message = 'Phone not found';
  end if;

  if p_client_id is not null then
    select client.status into v_client_status
    from public.clients as client
    where client.id = p_client_id
      and client.organization_id = p_organization_id
    for share;

    if not found then
      raise exception using errcode = 'P4102', message = 'Client not found';
    end if;
    if v_client_status <> 'active' then
      raise exception using errcode = 'P4103', message = 'Client is not active';
    end if;
  end if;

  if v_phone.client_id is not distinct from p_client_id then
    return next v_phone;
    return;
  end if;

  if p_client_id is not null and (
    not v_phone.enabled
    or not v_phone.provider_present
    or v_phone.status in (3, 4)
    or (v_phone.expired_at is not null and v_phone.expired_at <= clock_timestamp())
  ) then
    raise exception using errcode = 'P4105', message = 'Phone is unavailable for assignment';
  end if;

  if exists (
    select 1
    from public.device_cycles as cycle
    where cycle.organization_id = p_organization_id
      and cycle.phone_id = p_phone_id
      and cycle.status in ('provisioning', 'active', 'paused', 'blocked')
  ) then
    raise exception using errcode = 'P4104', message = 'Phone has an open device cycle';
  end if;

  if exists (
    select 1
    from public.scheduler_schedules as schedule
    where schedule.organization_id = p_organization_id
      and schedule.phone_id = p_phone_id
      and schedule.enabled
  ) or exists (
    select 1
    from public.scheduler_runs as run
    where run.organization_id = p_organization_id
      and run.phone_id = p_phone_id
      and (
        run.status in (
          'pending', 'preparing', 'queued', 'running', 'paused', 'retry_wait'
        )
        or coalesce(run.submission_state, 'never') in ('attempting', 'unknown')
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
      )
  ) then
    raise exception using errcode = 'P4106', message = 'Phone has scheduled or unfinished work';
  end if;

  return query
  update public.duo_phones as phone
  set client_id = p_client_id,
      updated_at = clock_timestamp()
  where phone.id = p_phone_id
    and phone.organization_id = p_organization_id
  returning phone.*;
end;
$function$;

revoke all on function public.assign_duoplus_phone_client(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.assign_duoplus_phone_client(uuid, uuid, uuid)
  to service_role;

comment on column public.duo_phones.scheduler_power_requested_at is
  'When this scheduler successfully requested an off-to-on transition; not proof that the phone reached on.';
comment on column public.duo_phones.scheduler_powered_on_at is
  'When this scheduler later observed its requested power transition online; required for automatic power-off.';
comment on column public.duo_phones.scheduler_powered_on_run_id is
  'Audit id of the run that requested this scheduler-owned power session.';
