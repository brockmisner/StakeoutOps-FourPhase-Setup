-- Defense-in-depth for scheduler audit payloads and remote-side-effect leases.
-- This migration is intentionally limited to Stakeout scheduler tables.
-- Rollout order: apply this migration, then promote the matching application.
-- Legacy RPC overloads remain callable but fail closed, so an older minute
-- worker pauses dispatch safely during the promotion window instead of
-- crashing or performing an unfenced remote side effect.

create or replace function public.stakeout_redact_sensitive_jsonb(p_value jsonb)
returns jsonb
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_key text;
  v_item jsonb;
  v_normalized_key text;
  v_result jsonb;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      v_result := '{}'::jsonb;
      for v_key, v_item in
        select entry.key, entry.value
        from jsonb_each(p_value) as entry
      loop
        v_normalized_key := regexp_replace(
          lower(v_key),
          '[-_[:space:]]',
          '',
          'g'
        );
        v_result := v_result || jsonb_build_object(
          v_key,
          case
            when v_normalized_key = 'iv'
              or v_normalized_key ~ '(apikey|accesskey|authorization|cookie|credential|password|privatekey|proxy(user(name)?|login)|secret|session|token|ciphertext|authtag)'
              then to_jsonb('[REDACTED]'::text)
            else public.stakeout_redact_sensitive_jsonb(v_item)
          end
        );
      end loop;
      return v_result;
    when 'array' then
      select coalesce(
        jsonb_agg(
          public.stakeout_redact_sensitive_jsonb(item.value)
          order by item.ordinality
        ),
        '[]'::jsonb
      )
      into v_result
      from jsonb_array_elements(p_value) with ordinality as item(value, ordinality);
      return v_result;
    else
      return p_value;
  end case;
end;
$function$;

revoke all on function public.stakeout_redact_sensitive_jsonb(jsonb)
  from public, anon, authenticated;
grant execute on function public.stakeout_redact_sensitive_jsonb(jsonb)
  to service_role;

create or replace function public.stakeout_redact_duo_outbound_log()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if new.request_body is not null then
    new.request_body := public.stakeout_redact_sensitive_jsonb(new.request_body);
  end if;
  if new.response_body is not null then
    new.response_body := public.stakeout_redact_sensitive_jsonb(new.response_body);
  end if;
  return new;
end;
$function$;

revoke all on function public.stakeout_redact_duo_outbound_log()
  from public, anon, authenticated;
grant execute on function public.stakeout_redact_duo_outbound_log()
  to service_role;

drop trigger if exists stakeout_redact_duo_outbound_log
  on public.duo_outbound_logs;
create trigger stakeout_redact_duo_outbound_log
before insert or update of request_body, response_body
on public.duo_outbound_logs
for each row execute function public.stakeout_redact_duo_outbound_log();

create or replace function public.stakeout_redact_duo_phone_metadata()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if new.metadata is not null then
    new.metadata := public.stakeout_redact_sensitive_jsonb(new.metadata);
  end if;
  return new;
end;
$function$;

revoke all on function public.stakeout_redact_duo_phone_metadata()
  from public, anon, authenticated;
grant execute on function public.stakeout_redact_duo_phone_metadata()
  to service_role;

drop trigger if exists stakeout_redact_duo_phone_metadata
  on public.duo_phones;
create trigger stakeout_redact_duo_phone_metadata
before insert or update of metadata
on public.duo_phones
for each row execute function public.stakeout_redact_duo_phone_metadata();

-- Remove sensitive keys already persisted by older deployments. Redaction is
-- idempotent, so replaying the migration cannot reveal or further transform a
-- payload that is already clean.
update public.duo_outbound_logs
set request_body = case
      when request_body is null then null
      else public.stakeout_redact_sensitive_jsonb(request_body)
    end,
    response_body = case
      when response_body is null then null
      else public.stakeout_redact_sensitive_jsonb(response_body)
    end
where (
    request_body is not null
    and request_body is distinct from public.stakeout_redact_sensitive_jsonb(request_body)
  )
  or (
    response_body is not null
    and response_body is distinct from public.stakeout_redact_sensitive_jsonb(response_body)
  );

update public.duo_phones
set metadata = public.stakeout_redact_sensitive_jsonb(metadata)
where metadata is not null
  and metadata is distinct from public.stakeout_redact_sensitive_jsonb(metadata);

alter table public.duo_outbound_logs
  drop constraint if exists duo_outbound_logs_sensitive_payloads_redacted,
  add constraint duo_outbound_logs_sensitive_payloads_redacted check (
    (request_body is null or request_body = public.stakeout_redact_sensitive_jsonb(request_body))
    and
    (response_body is null or response_body = public.stakeout_redact_sensitive_jsonb(response_body))
  ) not valid;
alter table public.duo_outbound_logs
  validate constraint duo_outbound_logs_sensitive_payloads_redacted;

alter table public.duo_phones
  drop constraint if exists duo_phones_metadata_sensitive_fields_redacted,
  add constraint duo_phones_metadata_sensitive_fields_redacted check (
    metadata is null or metadata = public.stakeout_redact_sensitive_jsonb(metadata)
  ) not valid;
alter table public.duo_phones
  validate constraint duo_phones_metadata_sensitive_fields_redacted;

-- Raw request/response bodies are server diagnostics, not a member-facing
-- Data API surface. Server routes continue to use service_role under RLS.
drop policy if exists stakeout_outbound_logs_read_member
  on public.duo_outbound_logs;
revoke all on table public.duo_outbound_logs from anon, authenticated;
grant all on table public.duo_outbound_logs to service_role;
alter table public.duo_outbound_logs enable row level security;

-- Repair terminal rows produced by the older lease reaper after addTask may
-- have reached DuoPlus. Reopening them never resets submission_state or the
-- attempt counter; the worker must reconcile by deterministic task name.
do $repair_ambiguous_submissions$
declare
  v_run public.scheduler_runs%rowtype;
begin
  for v_run in
    select run.*
    from public.scheduler_runs as run
    where run.status = 'failed'
      and run.duoplus_task_id is null
      and run.submission_state in ('attempting', 'accepted', 'unknown')
    order by run.created_at, run.id
    for update
  loop
    if v_run.phone_id is not null and v_run.phone_lease_token is not null then
      update public.duo_phones
      set busy_until = null,
          lease_run_id = null,
          lease_token = null,
          lease_expires_at = null,
          scheduler_last_activity_at = clock_timestamp()
      where id = v_run.phone_id
        and organization_id = v_run.organization_id
        and connection_id = v_run.connection_id
        and lease_run_id = v_run.id
        and lease_token = v_run.phone_lease_token;
    end if;

    -- Undo only the exact false pre-accept classification emitted by the old
    -- reaper. Other historical attempt outcomes remain immutable.
    update public.scheduler_run_attempts
    set status = 'started',
        error_message = null,
        finished_at = null
    where run_id = v_run.id
      and attempt_number = v_run.attempt_count
      and status = 'abandoned'
      and error_message = 'Worker lease expired before DuoPlus accepted the task';

    update public.scheduler_runs
    set status = 'retry_wait',
        stage = 'resolve_task',
        next_action_at = clock_timestamp(),
        finished_at = null,
        last_error = 'Recovered an earlier ambiguous DuoPlus submission for reconciliation; resubmission remains blocked',
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        phone_lease_token = null
    where id = v_run.id
      and status = 'failed'
      and submission_state = v_run.submission_state
      and duoplus_task_id is null;

    if found then
      insert into public.scheduler_run_events (
        organization_id, run_id, event_type, stage, status, message, metadata
      ) values (
        v_run.organization_id,
        v_run.id,
        'ambiguous_submission_recovered',
        'resolve_task',
        'retry_wait',
        'Failed run reopened for DuoPlus reconciliation without resubmission',
        jsonb_build_object('submission_state', v_run.submission_state)
      );
    end if;
  end loop;
end;
$repair_ambiguous_submissions$;

-- Lease expiry distinguishes definite pre-submit work from any request that
-- may have crossed the network boundary. Ambiguous/accepted submissions keep
-- their attempt and submission state and become immediately claimable only in
-- resolve_task. The next worker may query/cancel/sync, but never call addTask.
create or replace function public.reap_expired_run_leases(p_limit integer default 100)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_run public.scheduler_runs%rowtype;
  v_reaped integer := 0;
  v_retry_delay_seconds integer;
  v_reconciliation_only boolean;
begin
  if p_limit not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 1000';
  end if;

  for v_run in
    select run.*
    from public.scheduler_runs as run
    where run.status in ('pending', 'retry_wait', 'preparing')
      and run.lease_owner is not null
      and run.lease_token is not null
      and run.lease_expires_at <= clock_timestamp()
    order by run.lease_expires_at
    for update skip locked
    limit p_limit
  loop
    v_reconciliation_only := v_run.submission_state in (
      'attempting', 'accepted', 'unknown'
    ) or v_run.duoplus_task_id is not null;

    -- The locked run row and its exact phone token are the expired generation.
    -- Clear the phone mutex even if its longer TTL has not elapsed, otherwise
    -- the replacement worker cannot reacquire the same phone to reconcile.
    if v_run.phone_id is not null and v_run.phone_lease_token is not null then
      update public.duo_phones
      set busy_until = null,
          lease_run_id = null,
          lease_token = null,
          lease_expires_at = null,
          scheduler_last_activity_at = clock_timestamp()
      where id = v_run.phone_id
        and organization_id = v_run.organization_id
        and connection_id = v_run.connection_id
        and lease_run_id = v_run.id
        and lease_token = v_run.phone_lease_token;
    end if;

    if v_reconciliation_only then
      update public.scheduler_runs
      set status = 'retry_wait',
          stage = 'resolve_task',
          next_action_at = clock_timestamp(),
          finished_at = null,
          last_error = 'Worker lease expired after DuoPlus submission may have started; reconciling without resubmission',
          lease_owner = null,
          lease_token = null,
          lease_expires_at = null,
          phone_lease_token = null
      where id = v_run.id
        and lease_token = v_run.lease_token
        and lease_expires_at <= clock_timestamp();
    elsif v_run.status = 'preparing' then
      -- Only submission_state=never reaches this branch, so it is safe to
      -- abandon the definitely pre-submit attempt and apply retry limits.
      update public.scheduler_run_attempts
      set status = 'abandoned',
          error_message = coalesce(
            error_message,
            'Worker lease expired before DuoPlus submission started'
          ),
          finished_at = clock_timestamp()
      where run_id = v_run.id
        and attempt_number = v_run.attempt_count
        and status = 'started';

      v_retry_delay_seconds := least(
        900,
        (30 * power(2, greatest(v_run.attempt_count - 1, 0)))::integer
      );

      update public.scheduler_runs
      set status = case when attempt_count < max_attempts then 'retry_wait' else 'failed' end,
          stage = case when attempt_count < max_attempts then 'pending' else 'error' end,
          next_action_at = case
            when attempt_count < max_attempts
              then clock_timestamp() + make_interval(secs => v_retry_delay_seconds)
            else next_action_at
          end,
          finished_at = case when attempt_count >= max_attempts then clock_timestamp() else null end,
          last_error = 'Worker lease expired before DuoPlus submission started',
          lease_owner = null,
          lease_token = null,
          lease_expires_at = null,
          phone_lease_token = null
      where id = v_run.id
        and lease_token = v_run.lease_token
        and lease_expires_at <= clock_timestamp();
    else
      -- A definite pre-submit worker died before acquiring/preparing a phone.
      update public.scheduler_runs
      set next_action_at = clock_timestamp(),
          lease_owner = null,
          lease_token = null,
          lease_expires_at = null,
          phone_lease_token = null
      where id = v_run.id
        and lease_token = v_run.lease_token
        and lease_expires_at <= clock_timestamp();
    end if;

    insert into public.scheduler_run_events (
      organization_id, run_id, event_type, stage, status, message, metadata
    ) values (
      v_run.organization_id,
      v_run.id,
      case when v_reconciliation_only
        then 'submission_lease_expired'
        else 'lease_expired'
      end,
      case when v_reconciliation_only then 'resolve_task' else v_run.stage end,
      case when v_reconciliation_only then 'retry_wait' else v_run.status end,
      case when v_reconciliation_only
        then 'Expired lease released; DuoPlus submission remains reconciliation-only'
        else 'Expired worker/device lease was safely released'
      end,
      jsonb_build_object(
        'previous_worker', v_run.lease_owner,
        'submission_state', v_run.submission_state,
        'reconciliation_only', v_reconciliation_only
      )
    );

    v_reaped := v_reaped + 1;
  end loop;

  return v_reaped;
end;
$function$;

revoke all on function public.reap_expired_run_leases(integer)
  from public, anon, authenticated;
grant execute on function public.reap_expired_run_leases(integer)
  to service_role;

-- Reconciliation work stays claimable even when its schedule was disabled or
-- its attempt budget was exhausted after the original side effect. The stage
-- and submission state keep that claim on the lookup-only path.
create or replace function public.claim_due_runs(
  p_worker_id text,
  p_limit integer default 100,
  p_lease_seconds integer default 120,
  p_horizon_end timestamptz default now()
)
returns setof public.scheduler_runs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if nullif(btrim(p_worker_id), '') is null then
    raise exception using errcode = '22023', message = 'worker_id is required';
  end if;
  if p_limit not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 1000';
  end if;
  if p_lease_seconds not between 15 and 3600 then
    raise exception using errcode = '22023', message = 'lease_seconds must be between 15 and 3600';
  end if;
  if p_horizon_end > clock_timestamp() + interval '31 days' then
    raise exception using errcode = '22023', message = 'horizon may not exceed 31 days';
  end if;

  perform public.reap_expired_run_leases(p_limit);

  return query
  with candidates as materialized (
    select run.id
    from public.scheduler_runs as run
    join public.scheduler_schedules as schedule on schedule.id = run.schedule_id
    where (
        schedule.enabled
        or run.cancellation_requested
        or run.submission_state <> 'never'
        or run.duoplus_task_id is not null
        or run.stage in ('cancel_task', 'resolve_task', 'monitor_task', 'fetch_logs')
        or run.status in ('preparing', 'queued', 'running', 'paused')
      )
      and run.status in ('pending', 'retry_wait', 'preparing', 'queued', 'running', 'paused')
      and (
        run.status in ('preparing', 'queued', 'running', 'paused')
        or run.cancellation_requested
        or run.submission_state <> 'never'
        or run.duoplus_task_id is not null
        or run.stage in ('cancel_task', 'resolve_task', 'monitor_task', 'fetch_logs')
        or run.attempt_count < run.max_attempts
      )
      and (run.cancellation_requested or run.issue_at <= p_horizon_end)
      and (run.cancellation_requested or run.next_action_at <= clock_timestamp())
      and (run.lease_expires_at is null or run.lease_expires_at <= clock_timestamp())
    order by run.cancellation_requested desc, run.next_action_at, run.issue_at, run.created_at
    for update of run skip locked
    limit p_limit
  )
  update public.scheduler_runs as run
  set lease_owner = btrim(p_worker_id),
      lease_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      claimed_at = clock_timestamp(),
      stage = case
        when run.cancellation_requested then 'cancel_task'
        when run.status = 'pending'
          and run.attempt_count = 0
          and run.submission_state = 'never'
          and run.stage = 'pending'
          then 'prepare_phone'
        else run.stage
      end
  from candidates
  where run.id = candidates.id
  returning run.*;
end;
$function$;

revoke all on function public.claim_due_runs(text, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_due_runs(text, integer, integer, timestamptz)
  to service_role;

-- An accepted or ambiguous submission may reacquire only its already assigned
-- phone, and only in a reconciliation stage. It cannot start another attempt,
-- change phone, or return to the preparation path.
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
  v_subscription_capacity integer;
  v_subscription_in_use integer;
  v_subscription_available integer;
  v_subscription_synced_at timestamptz;
  v_active_or_reserved integer;
  v_existing_task boolean;
  v_submission_reconciliation boolean;
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
     or v_run.lease_expires_at <= clock_timestamp()
     or v_run.cancellation_requested
     or v_run.status not in ('pending', 'retry_wait', 'preparing', 'queued', 'running', 'paused')
     or (
       not v_existing_task
       and
       v_run.status in ('pending', 'retry_wait')
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

  v_starts_attempt := not v_existing_task and (
    v_run.status in ('pending', 'retry_wait')
    or (v_run.status = 'preparing' and v_run.attempt_count = 0)
  );
  v_attempt_number := v_run.attempt_count + case when v_starts_attempt then 1 else 0 end;

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

create or replace function public.acquire_phone_lease(
  p_phone_id uuid,
  p_run_id uuid,
  p_lease_seconds integer default 900
)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, public
as $function$
  select false;
$function$;

revoke all on function public.acquire_phone_lease(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.acquire_phone_lease(uuid, uuid, integer)
  to service_role;
revoke all on function public.acquire_phone_lease(uuid, uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.acquire_phone_lease(uuid, uuid, text, uuid, integer)
  to service_role;

-- The only pre-side-effect RPC performs the final invariant check and the
-- never -> attempting transition in one row-locking statement. There is no
-- check-then-update gap in which schedule/template/phone state can change.
create or replace function public.authorize_run_submission(
  p_run_id uuid,
  p_worker_id text,
  p_run_lease_token uuid,
  p_submission_started_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_updated integer;
begin
  update public.scheduler_runs as run
  set stage = 'submit_task',
      submission_state = 'attempting',
      submission_started_at = p_submission_started_at,
      submission_acknowledged_at = null
  from public.scheduler_schedules as schedule,
       public.duo_phones as phone,
       public.duo_templates as template,
       public.duo_connections as connection
  where run.id = p_run_id
    and p_submission_started_at is not null
    and schedule.id = run.schedule_id
    and phone.id = run.phone_id
    and template.id = run.template_id
    and connection.id = run.connection_id
    and schedule.organization_id = run.organization_id
    and schedule.connection_id = run.connection_id
    and phone.organization_id = run.organization_id
    and phone.connection_id = run.connection_id
    and template.organization_id = run.organization_id
    and template.connection_id = run.connection_id
    and connection.organization_id = run.organization_id
    and schedule.enabled
    -- Complete provider inventory syncs enable present templates and disable
    -- source-scoped rows that have disappeared from DuoPlus.
    and template.enabled
    and connection.status = 'active'
    and connection.api_key_ciphertext is not null
    and connection.api_key_iv is not null
    and connection.api_key_auth_tag is not null
    and not run.cancellation_requested
    and run.status = 'preparing'
    and run.duoplus_task_id is null
    and run.submission_state = 'never'
    and run.submission_started_at is null
    and run.submission_acknowledged_at is null
    and run.lease_owner = btrim(p_worker_id)
    and run.lease_token = p_run_lease_token
    and run.lease_expires_at > clock_timestamp()
    and phone.enabled
    and phone.provider_present
    and phone.status not in (3, 4)
    and (phone.expired_at is null or phone.expired_at > clock_timestamp())
    and (
      phone.scheduler_poweroff_lease_expires_at is null
      or phone.scheduler_poweroff_lease_expires_at <= clock_timestamp()
    )
    and phone.lease_run_id = run.id
    and phone.lease_token = run.phone_lease_token
    and phone.lease_expires_at > clock_timestamp()
    and (
      run.device_cycle_id is null
      or exists (
        select 1
        from public.device_cycles as cycle
        where cycle.id = run.device_cycle_id
          and cycle.organization_id = run.organization_id
          and cycle.connection_id = run.connection_id
          and cycle.client_id = run.client_id
          and cycle.phone_id = run.phone_id
          and cycle.status = 'active'
          and phone.client_id = cycle.client_id
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
      )
    );

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

create or replace function public.authorize_run_submission(
  p_run_id uuid,
  p_worker_id text
)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, public
as $function$
  select false;
$function$;

create or replace function public.authorize_run_submission(
  p_run_id uuid,
  p_worker_id text,
  p_run_lease_token uuid
)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, public
as $function$
  select false;
$function$;

revoke all on function public.authorize_run_submission(uuid, text)
  from public, anon, authenticated;
grant execute on function public.authorize_run_submission(uuid, text)
  to service_role;
revoke all on function public.authorize_run_submission(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.authorize_run_submission(uuid, text, uuid)
  to service_role;
revoke all on function public.authorize_run_submission(uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.authorize_run_submission(uuid, text, uuid, timestamptz)
  to service_role;

-- Post-addTask validation intentionally has a different name and accepts only
-- the acknowledged state. It cannot authorize or mutate submission state.
create or replace function public.validate_run_after_submission(
  p_run_id uuid,
  p_worker_id text,
  p_run_lease_token uuid
)
returns boolean
language sql
volatile
security invoker
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
    from public.scheduler_runs as run
    join public.scheduler_schedules as schedule
      on schedule.id = run.schedule_id
    join public.duo_phones as phone
      on phone.id = run.phone_id
    join public.duo_templates as template
      on template.id = run.template_id
     and template.organization_id = run.organization_id
     and template.connection_id = run.connection_id
    join public.duo_connections as connection
      on connection.id = run.connection_id
     and connection.organization_id = run.organization_id
    where run.id = p_run_id
      and schedule.enabled
      and template.enabled
      and connection.status = 'active'
      and connection.api_key_ciphertext is not null
      and connection.api_key_iv is not null
      and connection.api_key_auth_tag is not null
      and not run.cancellation_requested
      and run.status = 'preparing'
      and run.stage = 'resolve_task'
      and run.submission_state = 'accepted'
      and run.submission_started_at is not null
      and run.submission_acknowledged_at is not null
      and run.lease_owner = btrim(p_worker_id)
      and run.lease_token = p_run_lease_token
      and run.lease_expires_at > clock_timestamp()
      and phone.lease_run_id = run.id
      and phone.lease_token = run.phone_lease_token
      and phone.lease_expires_at > clock_timestamp()
      and (
        run.device_cycle_id is null
        or exists (
          select 1
          from public.device_cycles as cycle
          where cycle.id = run.device_cycle_id
            and cycle.organization_id = run.organization_id
            and cycle.connection_id = run.connection_id
            and cycle.client_id = run.client_id
            and cycle.phone_id = run.phone_id
            and cycle.status = 'active'
            and phone.client_id = cycle.client_id
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
        )
      )
  );
$function$;

revoke all on function public.validate_run_after_submission(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.validate_run_after_submission(uuid, text, uuid)
  to service_role;

-- Cleanup is fenced too: a stale invocation must not clear a newer worker or
-- phone lease simply because the deployment reused the same worker id.
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
      scheduler_last_activity_at = clock_timestamp()
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

create or replace function public.release_run_lease(
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
begin
  select * into v_run
  from public.scheduler_runs
  where id = p_run_id
  for update;

  if not found
     or v_run.lease_owner is distinct from nullif(btrim(p_worker_id), '')
     or v_run.lease_token is distinct from p_run_lease_token then
    return false;
  end if;

  if v_run.phone_id is not null and v_run.phone_lease_token is not null then
    update public.duo_phones
    set busy_until = null,
        lease_run_id = null,
        lease_token = null,
        lease_expires_at = null,
        scheduler_last_activity_at = clock_timestamp()
    where id = v_run.phone_id
      and organization_id = v_run.organization_id
      and connection_id = v_run.connection_id
      and lease_run_id = v_run.id
      and lease_token = v_run.phone_lease_token;
  end if;

  update public.scheduler_runs
  set lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      phone_lease_token = null
  where id = v_run.id
    and lease_owner = nullif(btrim(p_worker_id), '')
    and lease_token = p_run_lease_token;

  return found;
end;
$function$;

create or replace function public.release_run_lease(
  p_run_id uuid,
  p_worker_id text
)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, public
as $function$
  select false;
$function$;

revoke all on function public.release_run_lease(uuid, text)
  from public, anon, authenticated;
grant execute on function public.release_run_lease(uuid, text)
  to service_role;
revoke all on function public.release_run_lease(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.release_run_lease(uuid, text, uuid)
  to service_role;

-- Keep worker and phone ownership alive together. If a phone token exists but
-- no matching, unexpired phone lease remains, neither lease is renewed.
create or replace function public.renew_run_lease(
  p_run_id uuid,
  p_worker_id text,
  p_run_lease_token uuid,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_run public.scheduler_runs%rowtype;
  v_phone_id uuid;
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz;
begin
  if p_lease_seconds not between 15 and 3600 then
    raise exception using errcode = '22023', message = 'lease_seconds must be between 15 and 3600';
  end if;

  select * into v_run
  from public.scheduler_runs
  where id = p_run_id
  for update;

  if not found
     or v_run.lease_owner is distinct from btrim(p_worker_id)
     or v_run.lease_token is distinct from p_run_lease_token
     or v_run.lease_expires_at <= v_now then
    return false;
  end if;

  if v_run.phone_lease_token is not null then
    if v_run.phone_id is null then
      return false;
    end if;

    select phone.id into v_phone_id
    from public.duo_phones as phone
    where phone.id = v_run.phone_id
      and phone.organization_id = v_run.organization_id
      and phone.connection_id = v_run.connection_id
      and phone.lease_run_id = v_run.id
      and phone.lease_token = v_run.phone_lease_token
      and phone.lease_expires_at > v_now
    for update;

    if not found then
      return false;
    end if;
  end if;

  v_expires_at := v_now + make_interval(secs => p_lease_seconds);

  update public.scheduler_runs
  set lease_expires_at = v_expires_at
  where id = v_run.id;

  if v_phone_id is not null then
    update public.duo_phones
    set busy_until = greatest(coalesce(busy_until, v_expires_at), v_expires_at),
        lease_expires_at = greatest(lease_expires_at, v_expires_at)
    where id = v_phone_id
      and lease_run_id = v_run.id
      and lease_token = v_run.phone_lease_token;
  end if;

  return true;
end;
$function$;

create or replace function public.renew_run_lease(
  p_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, public
as $function$
  select false;
$function$;

revoke all on function public.renew_run_lease(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.renew_run_lease(uuid, text, integer)
  to service_role;
revoke all on function public.renew_run_lease(uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.renew_run_lease(uuid, text, uuid, integer)
  to service_role;

comment on function public.stakeout_redact_sensitive_jsonb(jsonb) is
  'Recursively replaces credential-shaped JSON fields before scheduler diagnostics are persisted.';
comment on function public.acquire_phone_lease(uuid, uuid, text, uuid, integer) is
  'Acquires the assigned phone only for the exact run-lease generation; submitted runs are reconciliation-only.';
comment on function public.acquire_phone_lease(uuid, uuid, integer) is
  'Fail-closed compatibility overload for workers deployed before run lease-token fencing.';
comment on function public.authorize_run_submission(uuid, text, uuid, timestamptz) is
  'Atomic pre-addTask gate and never-to-attempting transition for an enabled provider template, active credential, eligible phone/cycle, and exact run/phone lease generation.';
comment on function public.authorize_run_submission(uuid, text, uuid) is
  'Fail-closed compatibility overload for the interim token-aware worker; submission must transition through the atomic four-argument gate.';
comment on function public.validate_run_after_submission(uuid, text, uuid) is
  'Post-addTask validity check for an acknowledged, exactly fenced submission; never authorizes a new side effect.';
comment on function public.release_phone_lease(uuid, uuid, text, uuid) is
  'Releases a phone only while the caller still owns the exact run-lease generation.';
comment on function public.release_run_lease(uuid, text, uuid) is
  'Releases worker and phone coordination state only for the exact run-lease generation.';
comment on function public.release_run_lease(uuid, text) is
  'Fail-closed compatibility overload for workers deployed before run lease-token fencing.';
comment on function public.renew_run_lease(uuid, text, uuid, integer) is
  'Atomically renews an exact worker lease generation and its matching phone lease/busy horizon when present.';
comment on function public.renew_run_lease(uuid, text, integer) is
  'Fail-closed compatibility overload for workers deployed before run lease-token fencing.';
comment on function public.authorize_run_submission(uuid, text) is
  'Fail-closed compatibility overload; an unfenced worker can never authorize addTask.';
