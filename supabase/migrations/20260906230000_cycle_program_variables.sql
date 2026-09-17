-- Keep reusable program definitions client-neutral. A cycle stores its
-- non-secret bindings and cycle-backed schedules receive a resolved snapshot.

alter table public.device_cycles
  add column if not exists variables jsonb not null default '{}'::jsonb;

alter table public.device_cycles
  drop constraint if exists device_cycles_variables_object_check;
alter table public.device_cycles
  add constraint device_cycles_variables_object_check check (
    jsonb_typeof(variables) = 'object'
    and octet_length(variables::text) <= 200000
  );

create or replace function public.resolve_cycle_program_config(
  p_config jsonb,
  p_variables jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_field record;
  v_entry jsonb;
  v_binding jsonb;
  v_variable_name text;
  v_normalized_name text;
  v_result jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_config) <> 'object' or jsonb_typeof(p_variables) <> 'object' then
    raise exception using errcode = '22023', message = 'Program config and cycle variables must be JSON objects';
  end if;

  for v_field in select key, value from jsonb_each(p_config)
  loop
    v_entry := v_field.value;
    if jsonb_typeof(v_entry) <> 'object' then
      raise exception using errcode = '22023', message = 'Program config entries must be typed objects';
    end if;

    v_variable_name := null;
    if jsonb_typeof(v_entry -> 'value') = 'string'
       and (v_entry ->> 'value') ~ '^\{\{[a-z][a-z0-9_]{0,63}\}\}$' then
      v_variable_name := substring(v_entry ->> 'value' from 3 for length(v_entry ->> 'value') - 4);
    end if;

    if v_variable_name is not null then
      v_normalized_name := lower(regexp_replace(v_variable_name, '[^a-z0-9]', '', 'g'));
      if v_normalized_name ~ '(password|passwd|token|authorization|apikey|accesskey|cookie|privatekey|session|secret|credential)'
         or v_normalized_name = 'pwd'
         or v_normalized_name like '%pwd'
         or (
           v_normalized_name like '%proxy%'
           and v_normalized_name ~ '(user|username|login|pass|pwd|host|port|auth)'
         ) then
        raise exception using errcode = '22023', message = 'Program variables cannot request credentials or other sensitive values';
      end if;

      v_binding := p_variables -> v_variable_name;
      if v_binding is null then
        if coalesce((v_entry ->> 'required')::boolean, false) then
          raise exception using errcode = '22023', message = format('Required program variable %s is missing', v_variable_name);
        end if;
        continue;
      end if;
      if jsonb_typeof(v_binding) <> 'object'
         or not (v_binding ? 'value')
         or v_binding ->> 'type' is distinct from v_entry ->> 'type' then
        raise exception using errcode = '22023', message = format('Program variable %s has the wrong input type', v_variable_name);
      end if;
      if jsonb_typeof(v_binding -> 'value') = 'string'
         and (v_binding ->> 'value') ~ '^\{\{[a-z][a-z0-9_]{0,63}\}\}$' then
        raise exception using errcode = '22023', message = format('Program variable %s must contain a concrete value', v_variable_name);
      end if;
      v_entry := jsonb_set(v_entry, '{value}', v_binding -> 'value', false);
    end if;

    v_result := jsonb_set(v_result, array[v_field.key], v_entry, true);
  end loop;

  return v_result;
end;
$function$;

revoke all on function public.resolve_cycle_program_config(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.resolve_cycle_program_config(jsonb, jsonb)
  to service_role;

create or replace function public.stakeout_bind_cycle_schedule_variables()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_variables jsonb;
begin
  if new.source_kind <> 'device_cycle' or new.device_cycle_id is null then
    return new;
  end if;

  select cycle.variables into v_variables
  from public.device_cycles as cycle
  where cycle.id = new.device_cycle_id
    and cycle.organization_id = new.organization_id
    and cycle.connection_id = new.connection_id;
  if not found then
    raise exception using errcode = '23503', message = 'Cycle variable source not found';
  end if;

  new.config := public.resolve_cycle_program_config(new.config, v_variables);
  return new;
end;
$function$;

revoke all on function public.stakeout_bind_cycle_schedule_variables() from public;

drop trigger if exists stakeout_bind_cycle_schedule_variables on public.scheduler_schedules;
create trigger stakeout_bind_cycle_schedule_variables
before insert or update of config, source_kind, device_cycle_id
on public.scheduler_schedules
for each row execute function public.stakeout_bind_cycle_schedule_variables();

-- Materialized cycle runs are planned while they are inserted, inside the
-- activation transaction. This turns subscription capacity into a scheduling
-- constraint and retains the per-phone exclusion constraint as a final fence.
create index if not exists scheduler_runs_connection_window_open_idx
  on public.scheduler_runs using gist (connection_id, planned_window)
  where status in ('pending', 'preparing', 'queued', 'running', 'paused', 'retry_wait');

create or replace function public.stakeout_plan_cycle_run_workload()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_capacity integer;
  v_in_use integer;
  v_available integer;
  v_synced_at timestamptz;
  v_candidate timestamptz;
  v_candidate_end timestamptz;
  v_spacing interval := interval '15 minutes';
  v_overlap_count integer;
  v_overlap_end timestamptz;
  v_phone_overlap_end timestamptz;
begin
  if new.device_cycle_id is null then
    return new;
  end if;

  -- Different phones can be activated concurrently, so serialize planning by
  -- connection before reading the shared capacity timeline.
  perform pg_advisory_xact_lock(
    hashtextextended(new.connection_id::text, 1768841693)
  );

  select
    connection.subscription_capacity,
    connection.subscription_in_use,
    connection.subscription_available,
    connection.subscription_synced_at
  into v_capacity, v_in_use, v_available, v_synced_at
  from public.duo_connections as connection
  where connection.id = new.connection_id
    and connection.organization_id = new.organization_id
    and connection.status = 'active'
  for share;
  if not found then
    raise exception using errcode = '23514', message = 'An active DuoPlus connection is required for cycle workload planning';
  end if;
  if num_nulls(v_capacity, v_in_use, v_available, v_synced_at) not in (0, 4) then
    raise exception using errcode = '23514', message = 'Subscription capacity snapshot is incomplete';
  end if;
  if v_capacity is null then
    raise exception using errcode = '23514', message = 'Subscription capacity must be synced before cycle workload planning';
  end if;
  if v_capacity < 1
     or v_in_use < 0
     or v_available < 0
     or v_in_use + v_available <> v_capacity then
    raise exception using errcode = '23514', message = 'Subscription capacity snapshot is inconsistent';
  end if;
  if v_synced_at < clock_timestamp() - interval '60 minutes'
     or v_synced_at > clock_timestamp() + interval '5 minutes' then
    raise exception using errcode = '23514', message = 'Subscription capacity snapshot is stale or future-dated';
  end if;

  v_candidate := greatest(new.issue_at, new.window_start_at);
  loop
    v_candidate_end := v_candidate + (interval '1 second' * new.expected_duration_seconds);
    if v_candidate_end > new.window_end_at then
      raise exception using errcode = '23514', message = 'Cycle workload cannot fit before its canonical deadline';
    end if;

    select count(*), max(upper(run.planned_window))
    into v_overlap_count, v_overlap_end
    from public.scheduler_runs as run
    where run.organization_id = new.organization_id
      and run.connection_id = new.connection_id
      and run.id <> new.id
      and run.status in ('pending', 'preparing', 'queued', 'running', 'paused', 'retry_wait')
      and run.planned_window && tstzrange(
        v_candidate - v_spacing,
        v_candidate_end + v_spacing,
        '[)'
      );

    select max(upper(run.planned_window)) into v_phone_overlap_end
    from public.scheduler_runs as run
    where new.phone_id is not null
      and run.organization_id = new.organization_id
      and run.phone_id = new.phone_id
      and run.id <> new.id
      -- Mirror scheduler_runs_no_phone_overlap exactly so planning cannot
      -- choose a window that the authoritative exclusion constraint rejects.
      and run.status <> 'cancelled'
      and run.planned_window && tstzrange(
        v_candidate - v_spacing,
        v_candidate_end + v_spacing,
        '[)'
      );

    if v_overlap_count < v_capacity and v_phone_overlap_end is null then
      new.issue_at := v_candidate;
      return new;
    end if;

    v_candidate := greatest(
      v_candidate + interval '1 minute',
      case when v_overlap_count >= v_capacity then v_overlap_end + v_spacing else v_candidate end,
      coalesce(v_phone_overlap_end + v_spacing, v_candidate)
    );
  end loop;
end;
$function$;

revoke all on function public.stakeout_plan_cycle_run_workload() from public;

drop trigger if exists stakeout_plan_cycle_run_workload on public.scheduler_runs;
create trigger stakeout_plan_cycle_run_workload
before insert on public.scheduler_runs
for each row execute function public.stakeout_plan_cycle_run_workload();

comment on column public.device_cycles.variables is
  'Sanitized, non-secret client bindings resolved into cycle schedule config snapshots.';
comment on function public.resolve_cycle_program_config(jsonb, jsonb) is
  'Resolves exact {{variable_name}} values in reusable cycle program task config.';
comment on function public.stakeout_plan_cycle_run_workload() is
  'Spaces cycle runs across synced subscription capacity and dedicated phones before insertion.';
