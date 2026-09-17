-- Cache DuoPlus Subscription Startup inventory and make it the hard ceiling
-- for new phone power-ons. This intentionally prevents the scheduler from
-- falling through to billable Temporary Startup capacity.

alter table public.duo_connections
  add column if not exists subscription_capacity integer
    check (subscription_capacity is null or subscription_capacity >= 0),
  add column if not exists subscription_in_use integer
    check (subscription_in_use is null or subscription_in_use >= 0),
  add column if not exists subscription_available integer
    check (subscription_available is null or subscription_available >= 0),
  add column if not exists subscription_synced_at timestamptz;

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

  select * into v_phone
  from public.duo_phones
  where id = p_phone_id
  for update;

  if not found
     or not v_phone.enabled
     or v_phone.organization_id <> v_run.organization_id
     or v_phone.connection_id <> v_run.connection_id
     or (v_phone.client_id is not null and v_phone.client_id <> v_run.client_id)
     or (v_phone.expired_at is not null and v_phone.expired_at <= clock_timestamp())
     or (v_phone.lease_expires_at is not null and v_phone.lease_expires_at > clock_timestamp())
     or (v_phone.busy_until is not null and v_phone.busy_until > clock_timestamp()) then
    return false;
  end if;

  -- Lock the connection row so concurrent acquisitions cannot both consume
  -- the same final Subscription Startup slot.
  select subscription_capacity
  into v_subscription_capacity
  from public.duo_connections
  where id = v_run.connection_id
    and organization_id = v_run.organization_id
    and status = 'active'
  for update;

  if not found then
    return false;
  end if;

  v_existing_task := v_run.duoplus_task_id is not null
    or v_run.status in ('queued', 'running', 'paused')
    or v_run.stage in ('resolve_task', 'monitor_task', 'fetch_logs', 'cancel_task');

  -- Existing DuoPlus tasks must remain monitorable/cancellable. New dispatches
  -- are fail-closed until inventory has supplied an exact subscription count.
  if not v_existing_task then
    if v_subscription_capacity is null or v_subscription_capacity <= 0 then
      return false;
    end if;

    -- An already-on phone does not consume another slot. An off phone needs a
    -- free slot, and active leases count as reservations while power-on runs.
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

      if v_active_or_reserved >= v_subscription_capacity then
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
    when exclusion_violation or unique_violation then
      return false;
  end;

  return true;
end;
$function$;

comment on column public.duo_connections.subscription_capacity is
  'Current non-expired DuoPlus Subscription Startup count; hard power-on ceiling.';
comment on function public.acquire_phone_lease(uuid, uuid, integer) is
  'Atomically leases a phone and blocks new power-ons beyond cached Subscription Startup capacity.';
