-- Four-phase profile programs. Existing programs remain on the legacy path.
-- Phase dates and task windows remain canonical; missed prerequisites are
-- surfaced for recovery, never silently moved or treated as completed.

alter table public.cycle_programs
  add column phase_plan jsonb,
  drop constraint cycle_programs_duration_days_check,
  add constraint cycle_programs_duration_days_check check (duration_days between 15 and 36);
alter table public.cycle_program_rules
  add column phase_kind text check (phase_kind in ('baseline', 'warmup', 'money', 'final_squeeze', 'after_action')),
  drop constraint cycle_program_rules_start_day_check,
  drop constraint cycle_program_rules_end_day_check,
  add constraint cycle_program_rules_start_day_check check (start_day between 1 and 36),
  add constraint cycle_program_rules_end_day_check check (end_day between 1 and 36);
alter table public.device_cycles
  drop constraint device_cycles_duration_days_check,
  add constraint device_cycles_duration_days_check check (duration_days between 15 and 36);
alter table public.device_profiles
  drop constraint device_profiles_duration_days_check,
  drop constraint device_profiles_ready_day_check,
  drop constraint device_profiles_successful_days_check,
  add constraint device_profiles_duration_days_check check (duration_days between 15 and 36),
  add constraint device_profiles_ready_day_check check (ready_day between 1 and 36),
  add constraint device_profiles_successful_days_check check (successful_days between 0 and 36);
alter table public.scheduler_runs
  drop constraint scheduler_runs_cycle_day_check,
  add constraint scheduler_runs_cycle_day_check check (cycle_day is null or cycle_day between 1 and 36);
alter table public.profile_score_events
  drop constraint profile_score_events_cycle_day_check,
  add constraint profile_score_events_cycle_day_check check (cycle_day between 1 and 36);

create function public.stakeout_validate_phase_plan(p_plan jsonb, p_duration_days integer)
returns boolean
language plpgsql immutable security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_key text;
  v_req jsonb;
  v_apps text[] := array[]::text[];
begin
  if p_plan is null then return true; end if;
  if jsonb_typeof(p_plan) <> 'object'
     or p_plan->'version' is distinct from '1'::jsonb
     or jsonb_typeof(p_plan->'continueDailyTasks') is distinct from 'boolean'
     or jsonb_typeof(p_plan->'appRequirements') is distinct from 'array'
     or exists (select 1 from jsonb_object_keys(p_plan) as key(name)
       where key.name not in ('version', 'warmupDays', 'moneyDays', 'finalSqueezeDays',
         'afterActionDays', 'continueDailyTasks', 'appRequirements')) then
    raise exception using errcode = '22023', message = 'Invalid four-phase plan structure';
  end if;
  foreach v_key in array array['warmupDays', 'moneyDays', 'finalSqueezeDays', 'afterActionDays'] loop
    if jsonb_typeof(p_plan->v_key) is distinct from 'number'
       or coalesce(p_plan->>v_key, '') !~ '^[0-9]{1,2}$' then
      raise exception using errcode = '22023', message = 'Phase durations must be whole numbers';
    end if;
  end loop;
  if (p_plan->>'warmupDays')::integer not between 10 and 14
     or (p_plan->>'moneyDays')::integer not between 2 and 5
     or (p_plan->>'finalSqueezeDays')::integer not between 1 and 3
     or (p_plan->>'afterActionDays')::integer not between 10 and 14
     or p_duration_days is distinct from (
       (p_plan->>'warmupDays')::integer + (p_plan->>'moneyDays')::integer
       + (p_plan->>'finalSqueezeDays')::integer + (p_plan->>'afterActionDays')::integer
     ) then
    raise exception using errcode = '22023', message = 'Four-phase duration must equal its 23–36 day phase total';
  end if;
  for v_req in select value from jsonb_array_elements(p_plan->'appRequirements') loop
    if jsonb_typeof(v_req) <> 'object'
       or coalesce(v_req->>'appKind', '') !~ '^[a-z][a-z0-9_]{0,31}$'
       or jsonb_typeof(v_req->'minSuccessfulRuns') is distinct from 'number'
       or jsonb_typeof(v_req->'minActiveDays') is distinct from 'number'
       or coalesce(v_req->>'minSuccessfulRuns', '') !~ '^[0-9]{1,6}$'
       or coalesce(v_req->>'minActiveDays', '') !~ '^[0-9]{1,2}$'
       or exists (select 1 from jsonb_object_keys(v_req) as key(name)
         where key.name not in ('appKind', 'minSuccessfulRuns', 'minActiveDays')) then
      raise exception using errcode = '22023', message = 'App requirements need an app and nonnegative integer run/day targets';
    end if;
    if (v_req->>'minSuccessfulRuns')::integer = 0 and (v_req->>'minActiveDays')::integer = 0 then
      raise exception using errcode = '22023', message = 'An app requirement must have a positive run or day target';
    end if;
    if v_req->>'appKind' = any(v_apps) then
      raise exception using errcode = '22023', message = 'Each app may have only one requirement';
    end if;
    if (v_req->>'minActiveDays')::integer > (p_plan->>'warmupDays')::integer then
      raise exception using errcode = '22023', message = 'App active-day targets must fit within warmup';
    end if;
    v_apps := array_append(v_apps, v_req->>'appKind');
  end loop;
  return true;
end;
$function$;

alter table public.cycle_programs
  add constraint cycle_programs_phase_plan_check
  check (public.stakeout_validate_phase_plan(phase_plan, duration_days));

create function public.stakeout_validate_phase_program()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_counts record;
  v_req jsonb;
  v_available integer;
begin
  if tg_op = 'UPDATE' and old.status in ('published', 'retired')
     and new.phase_plan is distinct from old.phase_plan then
    raise exception using errcode = '23514', message = 'Published phase plans are immutable';
  end if;
  perform public.stakeout_validate_phase_plan(new.phase_plan, new.duration_days);
  if new.phase_plan is null then return new; end if;
  if new.ready_day <> (new.phase_plan->>'warmupDays')::integer then
    raise exception using errcode = '23514', message = 'Four-phase readiness day must match warmup duration';
  end if;
  if new.status <> 'published' then return new; end if;
  select count(*) filter (where phase_kind = 'baseline' and required) as baseline,
         count(*) filter (where phase_kind = 'money') as money,
         count(*) filter (where phase_kind = 'money' and required) as required_money,
         count(*) filter (where phase_kind = 'final_squeeze') as final_squeeze,
         count(*) filter (where phase_kind = 'final_squeeze' and required) as required_final_squeeze,
         count(*) filter (where phase_kind = 'after_action') as after_action,
         count(*) filter (where phase_kind = 'after_action' and required) as required_after_action,
         count(*) filter (where phase_kind is null) as legacy
  into v_counts from public.cycle_program_rules where program_id = new.id;
  if v_counts.baseline < 5 or v_counts.required_money < 3 or v_counts.money > 4
     or v_counts.required_final_squeeze < 4 or v_counts.final_squeeze > 7
     or v_counts.required_after_action < 3 or v_counts.after_action > 5 or v_counts.legacy > 0 then
    raise exception using errcode = '23514',
      message = 'Four-phase programs require 5+ daily, 3–4 Money, 4–7 Final squeeze, and 3–5 After action rules';
  end if;
  -- Revalidate windows here as a draft plan can change after its rules were inserted.
  if exists (
    select 1 from public.cycle_program_rules as rule
    cross join lateral public.get_cycle_phase_window(new.phase_plan, rule.phase_kind) as win
    where rule.program_id = new.id
      and (rule.rule_kind <> 'daily_range' or rule.start_day <> win.start_day or rule.end_day <> win.end_day)
  ) then
    raise exception using errcode = '23514', message = 'Phase rules must span their exact daily phase window';
  end if;
  for v_req in select value from jsonb_array_elements(new.phase_plan->'appRequirements') loop
    select coalesce(sum(least(rule.end_day, (new.phase_plan->>'warmupDays')::integer) - rule.start_day + 1), 0)::integer
    into v_available from public.cycle_program_rules as rule
    where rule.program_id = new.id and rule.phase_kind in ('baseline', 'warmup')
      and rule.app_kind = v_req->>'appKind';
    if v_available < greatest((v_req->>'minSuccessfulRuns')::integer, (v_req->>'minActiveDays')::integer) then
      raise exception using errcode = '23514', message = 'App requirement exceeds the available warmup tasks';
    end if;
  end loop;
  return new;
end;
$function$;

create function public.get_cycle_phase_window(p_plan jsonb, p_phase_kind text)
returns table(start_day integer, end_day integer)
language sql immutable security invoker
set search_path = pg_catalog, public
as $function$
  select
    case p_phase_kind
      when 'baseline' then 1 when 'warmup' then 1
      when 'money' then (p_plan->>'warmupDays')::integer + 1
      when 'final_squeeze' then (p_plan->>'warmupDays')::integer + (p_plan->>'moneyDays')::integer + 1
      when 'after_action' then (p_plan->>'warmupDays')::integer + (p_plan->>'moneyDays')::integer + (p_plan->>'finalSqueezeDays')::integer + 1
    end,
    case p_phase_kind
      when 'baseline' then case when (p_plan->>'continueDailyTasks')::boolean
        then (p_plan->>'warmupDays')::integer + (p_plan->>'moneyDays')::integer + (p_plan->>'finalSqueezeDays')::integer + (p_plan->>'afterActionDays')::integer
        else (p_plan->>'warmupDays')::integer end
      when 'warmup' then (p_plan->>'warmupDays')::integer
      when 'money' then (p_plan->>'warmupDays')::integer + (p_plan->>'moneyDays')::integer
      when 'final_squeeze' then (p_plan->>'warmupDays')::integer + (p_plan->>'moneyDays')::integer + (p_plan->>'finalSqueezeDays')::integer
      when 'after_action' then (p_plan->>'warmupDays')::integer + (p_plan->>'moneyDays')::integer + (p_plan->>'finalSqueezeDays')::integer + (p_plan->>'afterActionDays')::integer
    end;
$function$;

create function public.stakeout_validate_phase_rule()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_plan jsonb;
  v_window record;
begin
  -- Check OLD as well as NEW: moving a published rule into a draft program
  -- must not remove an immutable prerequisite from an existing cycle.
  if tg_op = 'UPDATE' and exists (
    select 1 from public.cycle_programs as original
    where original.id = old.program_id and original.organization_id = old.organization_id
      and original.phase_plan is not null and original.status in ('published', 'retired')
  ) then
    raise exception using errcode = '23514', message = 'Published phase rules are immutable';
  end if;
  select phase_plan into v_plan from public.cycle_programs
  where id = new.program_id and organization_id = new.organization_id;
  if v_plan is null then
    if new.phase_kind is not null then
      raise exception using errcode = '23514', message = 'Phase rules require a four-phase program';
    end if;
    return new;
  end if;
  if new.phase_kind is null then
    raise exception using errcode = '23514', message = 'Each four-phase rule requires its phase';
  end if;
  select * into v_window from public.get_cycle_phase_window(v_plan, new.phase_kind);
  if new.rule_kind <> 'daily_range' or new.start_day is distinct from v_window.start_day
     or new.end_day is distinct from v_window.end_day then
    raise exception using errcode = '23514', message = 'Phase rules must span their exact daily phase window';
  end if;
  return new;
end;
$function$;

create trigger stakeout_validate_phase_program before insert or update on public.cycle_programs
for each row execute function public.stakeout_validate_phase_program();
create trigger stakeout_validate_phase_rule before insert or update on public.cycle_program_rules
for each row execute function public.stakeout_validate_phase_rule();

-- A phase-managed phone keeps the original client/city across profile cycles.
-- These are operator-configured locations, not a GPS verification result.
alter table public.duo_phones
  add column dedicated_client_id uuid references public.clients(id) on delete restrict,
  add column dedicated_country text,
  add column dedicated_region text,
  add column dedicated_city text,
  add constraint duo_phones_dedicated_city_complete check (
    (dedicated_client_id is null and dedicated_country is null and dedicated_region is null and dedicated_city is null)
    or (dedicated_client_id is not null and client_id is not null and client_id = dedicated_client_id
      and dedicated_country is not null and dedicated_country ~ '^[A-Z]{2}$'
      and dedicated_region is not null and char_length(btrim(dedicated_region)) between 1 and 120
      and dedicated_city is not null and char_length(btrim(dedicated_city)) between 1 and 120)
  );
create index duo_phones_dedicated_client_idx on public.duo_phones(dedicated_client_id)
where dedicated_client_id is not null;

create function public.stakeout_keep_phone_city_assignment()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $function$
begin
  if old.dedicated_client_id is not null and (
    new.client_id is distinct from old.client_id
    or new.organization_id is distinct from old.organization_id
    or new.connection_id is distinct from old.connection_id
    or new.dedicated_client_id is distinct from old.dedicated_client_id
    or new.dedicated_country is distinct from old.dedicated_country
    or new.dedicated_region is distinct from old.dedicated_region
    or new.dedicated_city is distinct from old.dedicated_city
  ) then
    raise exception using errcode = '23514', message = 'This phone is dedicated to its original client and city';
  end if;
  return new;
end;
$function$;
create trigger stakeout_keep_phone_city_assignment before update on public.duo_phones
for each row execute function public.stakeout_keep_phone_city_assignment();

create function public.stakeout_bind_phase_cycle_city()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_phone public.duo_phones%rowtype;
  v_plan jsonb;
begin
  select phase_plan into v_plan from public.cycle_programs
  where id = new.program_id and organization_id = new.organization_id;
  select * into v_phone from public.duo_phones
  where id = new.phone_id and organization_id = new.organization_id and connection_id = new.connection_id
  for update;
  if not found then return new; end if; -- The existing tenant FK/trigger rejects it.
  if v_phone.dedicated_client_id is not null and (
    v_phone.dedicated_client_id <> new.client_id
    or v_phone.dedicated_country <> new.target_country
    or lower(btrim(v_phone.dedicated_region)) <> lower(btrim(new.target_region))
    or lower(btrim(v_phone.dedicated_city)) <> lower(btrim(new.target_city))
  ) then
    raise exception using errcode = '23514', message = 'Device cycle must use the phone’s dedicated client and city';
  end if;
  if v_plan is not null then
    if new.target_latitude is null or new.target_longitude is null then
      raise exception using errcode = '23514', message = 'Four-phase cycles require configured device coordinates';
    end if;
    if v_phone.dedicated_client_id is null then
      update public.duo_phones set dedicated_client_id = new.client_id,
        dedicated_country = new.target_country, dedicated_region = btrim(new.target_region), dedicated_city = btrim(new.target_city)
      where id = v_phone.id;
    end if;
  end if;
  return new;
end;
$function$;
create trigger stakeout_bind_phase_cycle_city before insert or update of
  organization_id, connection_id, client_id, phone_id, program_id,
  target_country, target_region, target_city, target_latitude, target_longitude
on public.device_cycles
for each row execute function public.stakeout_bind_phase_cycle_city();

create function public.get_device_cycle_phase_gate(
  p_organization_id uuid, p_cycle_id uuid, p_phase_kind text default null
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_cycle public.device_cycles%rowtype;
  v_plan jsonb;
  v_now timestamptz := statement_timestamp();
  v_today date;
  v_day integer;
  v_warmup integer;
  v_money integer;
  v_final integer;
  v_calendar_rank integer;
  v_target_rank integer;
  v_missing_rank integer;
  v_current_phase text;
  v_target_phase text;
  v_earliest timestamptz;
  v_phase_start integer;
  v_missing integer := 0;
  v_irrecoverable boolean := false;
  v_requirements jsonb;
  v_apps_met boolean;
  v_allowed boolean;
  v_status text;
  v_phase_names text[] := array['warmup', 'money', 'final_squeeze', 'after_action'];
begin
  select * into v_cycle from public.device_cycles
  where id = p_cycle_id and organization_id = p_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Device cycle phase gate not found in this organization';
  end if;
  select phase_plan into v_plan from public.cycle_programs
  where id = v_cycle.program_id and organization_id = p_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Device cycle program not found in this organization';
  end if;
  if v_plan is null then return null; end if;
  if p_phase_kind is not null and p_phase_kind not in ('baseline', 'warmup', 'money', 'final_squeeze', 'after_action') then
    raise exception using errcode = '22023', message = 'Invalid requested cycle phase';
  end if;
  v_today := (v_now at time zone v_cycle.timezone)::date;
  v_day := v_today - v_cycle.starts_on + 1;
  v_warmup := (v_plan->>'warmupDays')::integer;
  v_money := (v_plan->>'moneyDays')::integer;
  v_final := (v_plan->>'finalSqueezeDays')::integer;
  v_calendar_rank := case when v_day <= v_warmup then 1
    when v_day <= v_warmup + v_money then 2
    when v_day <= v_warmup + v_money + v_final then 3 else 4 end;
  v_target_rank := case p_phase_kind when 'baseline' then 1 when 'warmup' then 1
    when 'money' then 2 when 'final_squeeze' then 3 when 'after_action' then 4 else v_calendar_rank end;
  v_target_phase := coalesce(p_phase_kind, v_phase_names[v_target_rank]);
  v_phase_start := case v_target_rank when 1 then 1 when 2 then v_warmup + 1
    when 3 then v_warmup + v_money + 1 else v_warmup + v_money + v_final + 1 end;
  v_earliest := (v_cycle.starts_on + v_phase_start - 1)::timestamp at time zone v_cycle.timezone;

  -- Generate expected logical occurrences from the immutable program. A missing
  -- materialized row must block just as a pending/failed row does.
  with required_occurrences as (
    select rule.id as rule_id, day.cycle_day,
      case rule.phase_kind when 'baseline' then case when day.cycle_day <= v_warmup then 1
        when day.cycle_day <= v_warmup + v_money then 2
        when day.cycle_day <= v_warmup + v_money + v_final then 3 else 4 end
        when 'warmup' then 1
        when 'money' then 2 when 'final_squeeze' then 3 else 4 end as phase_rank
    from public.cycle_program_rules as rule
    cross join lateral generate_series(rule.start_day::integer, rule.end_day::integer) as day(cycle_day)
    where rule.program_id = v_cycle.program_id and rule.organization_id = p_organization_id and rule.required
      and ((rule.phase_kind = 'baseline' and day.cycle_day < v_phase_start)
        or (rule.phase_kind = 'warmup' and v_target_rank > 1)
        or (rule.phase_kind = 'money' and v_target_rank > 2)
        or (rule.phase_kind = 'final_squeeze' and v_target_rank > 3))
  )
  select count(*) filter (where run.status is distinct from 'succeeded')::integer,
    coalesce(bool_or(run.status in ('failed', 'cancelled')
      or coalesce(run.window_end_at,
        (v_cycle.starts_on + expected.cycle_day)::timestamp at time zone v_cycle.timezone) <= v_now)
      filter (where run.status is distinct from 'succeeded'), false),
    min(expected.phase_rank) filter (where run.status is distinct from 'succeeded')
  into v_missing, v_irrecoverable, v_missing_rank
  from required_occurrences as expected
  left join public.scheduler_runs as run on run.device_cycle_id = v_cycle.id
    and run.organization_id = p_organization_id and run.program_rule_id = expected.rule_id
    and run.cycle_day = expected.cycle_day;

  -- One immutable event per successful logical run. Active days are actual local
  -- completion dates, not planned cycle_day values or retry attempts.
  with progress as (
    select req.value->>'appKind' as app_kind,
      (req.value->>'minSuccessfulRuns')::integer as min_runs,
      (req.value->>'minActiveDays')::integer as min_days,
      count(distinct event.run_id)::integer as runs,
      count(distinct (coalesce(success.finished_at, event.awarded_at) at time zone v_cycle.timezone)::date)::integer as days
    from jsonb_array_elements(v_plan->'appRequirements') as req(value)
    left join public.profile_score_events as event on event.organization_id = p_organization_id
      and event.device_cycle_id = v_cycle.id and event.app_kind = req.value->>'appKind'
      and exists (select 1 from public.scheduler_runs as run
        join public.cycle_program_rules as rule on rule.id = run.program_rule_id
        where run.id = event.run_id and run.status = 'succeeded'
          and run.cycle_day <= v_warmup and rule.phase_kind in ('baseline', 'warmup'))
    left join public.scheduler_runs as success on success.id = event.run_id
    group by req.value
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'appKind', app_kind, 'minSuccessfulRuns', min_runs, 'minActiveDays', min_days,
      'successfulRuns', runs, 'activeDays', days, 'met', runs >= min_runs and days >= min_days
    ) order by app_kind), '[]'::jsonb),
    coalesce(bool_and(runs >= min_runs and days >= min_days), true)
  into v_requirements, v_apps_met from progress;

  if v_target_rank > 1 and not v_apps_met then
    v_missing_rank := 1;
    v_irrecoverable := v_irrecoverable or v_today >= v_cycle.starts_on + v_warmup;
  end if;
  v_current_phase := v_phase_names[least(v_calendar_rank, coalesce(v_missing_rank, v_calendar_rank))];
  v_allowed := v_now >= v_earliest and v_missing = 0 and (v_target_rank = 1 or v_apps_met);
  v_status := case when v_allowed then 'ready' when v_irrecoverable then 'recovery_required' else 'waiting' end;
  return jsonb_build_object('currentPhase', v_current_phase, 'phaseGate', jsonb_build_object(
    'allowed', v_allowed, 'status', v_status,
    'blockedPhase', case when v_allowed then null else v_target_phase end,
    'missingRequiredRuns', v_missing, 'requirements', v_requirements,
    'earliestStartAt', v_earliest,
    'reason', case when v_allowed then null
      when v_irrecoverable then 'Required earlier work or app coverage missed its window; recovery is required.'
      when v_now < v_earliest then 'The minimum days in the earlier phases have not elapsed.'
      else 'Required earlier work or app completion targets are not complete.' end
  ));
end;
$function$;

create function public.get_scheduler_run_phase_gate(p_organization_id uuid, p_run_id uuid)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog, public
as $function$
declare v_run public.scheduler_runs%rowtype; v_phase text; v_plan jsonb;
begin
  select * into v_run from public.scheduler_runs
  where id = p_run_id and organization_id = p_organization_id;
  if not found then
    return jsonb_build_object('allowed', false, 'status', 'recovery_required',
      'blockedPhase', null, 'missingRequiredRuns', 0, 'requirements', '[]'::jsonb,
      'reason', 'Run not found in this organization.');
  end if;
  -- Never strand remote-task reconciliation behind a newly unmet prerequisite.
  if v_run.device_cycle_id is null or v_run.submission_state <> 'never'
    or v_run.duoplus_task_id is not null or v_run.status in ('queued', 'running', 'paused')
    or v_run.stage in ('resolve_task', 'monitor_task', 'fetch_logs', 'cancel_task') then return null; end if;
  select program.phase_plan into v_plan from public.device_cycles as cycle
  join public.cycle_programs as program on program.id = cycle.program_id
    and program.organization_id = cycle.organization_id and program.connection_id = cycle.connection_id
  where cycle.id = v_run.device_cycle_id and cycle.organization_id = p_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Run phase program identity is missing';
  end if;
  if v_plan is null then return null; end if;
  select phase_kind into v_phase from public.cycle_program_rules
  where id = v_run.program_rule_id and organization_id = p_organization_id;
  if not found or v_phase is null then
    raise exception using errcode = 'P0002', message = 'Run phase rule identity is missing';
  end if;
  return public.get_device_cycle_phase_gate(p_organization_id, v_run.device_cycle_id, v_phase)->'phaseGate';
end;
$function$;

create function public.get_device_cycle_phase_gates(p_organization_id uuid)
returns table(device_cycle_id uuid, current_phase text, phase_gate jsonb)
language sql volatile security invoker
set search_path = pg_catalog, public
as $function$
  with selected as materialized (
    select cycle.id from public.device_cycles as cycle
    where cycle.organization_id = p_organization_id
    order by cycle.created_at desc, cycle.id limit 300
  ), gates as materialized (
    select selected.id, public.get_device_cycle_phase_gate(p_organization_id, selected.id) as result
    from selected
  )
  select gates.id, gates.result->>'currentPhase', gates.result->'phaseGate'
  from gates where gates.result is not null;
$function$;

create function public.stakeout_enforce_run_phase_submission()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $function$
declare v_gate jsonb;
begin
  -- BEFORE UPDATE reads the old row. Only actual new submission is gated;
  -- adoption/reconciliation of accepted or unknown remote work remains possible.
  if old.submission_state = 'never' and new.submission_state = 'attempting'
     and old.duoplus_task_id is null and old.device_cycle_id is not null then
    v_gate := public.get_scheduler_run_phase_gate(old.organization_id, old.id);
    if v_gate is not null and not coalesce((v_gate->>'allowed')::boolean, false) then
      raise exception using errcode = '23514', message = 'Cycle phase prerequisites are not complete', detail = v_gate::text;
    end if;
  end if;
  return new;
end;
$function$;
create trigger stakeout_enforce_run_phase_submission before update of submission_state on public.scheduler_runs
for each row execute function public.stakeout_enforce_run_phase_submission();

-- Keep the first ten argument names/defaults compatible with older servers.
-- Drop the old signature to avoid ambiguous PostgREST overload resolution.
drop function public.create_cycle_program(uuid, uuid, text, integer, text, jsonb, uuid, integer, integer, integer);

create function public.create_cycle_program(
  p_organization_id uuid,
  p_connection_id uuid,
  p_name text,
  p_duration_days integer,
  p_timezone text,
  p_rules jsonb,
  p_created_by uuid default null,
  p_ready_day integer default 10,
  p_ready_threshold_percent integer default 80,
  p_completion_threshold_percent integer default 90,
  p_phase_plan jsonb default null
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_program_id uuid := gen_random_uuid();
  v_rule jsonb;
  v_template_id uuid;
  v_rule_kind text;
  v_app_kind text;
  v_points integer;
  v_start_day integer;
  v_end_day integer;
  v_sequence integer;
begin
  if nullif(btrim(p_name), '') is null then
    raise exception using errcode = '22023', message = 'Program name is required';
  end if;
  if p_duration_days not between 15 and 36 then
    raise exception using errcode = '22023',
      message = 'Cycle duration must be between 15 and 36 days';
  end if;
  if p_ready_day not between 1 and p_duration_days
     or p_ready_threshold_percent not between 1 and 100
     or p_completion_threshold_percent not between 1 and 100
     or p_completion_threshold_percent < p_ready_threshold_percent then
    raise exception using errcode = '22023',
      message = 'Profile readiness gates are invalid';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_timezone_names as zone
    where zone.name = btrim(p_timezone)
  ) then
    raise exception using errcode = '22023', message = 'Program timezone is invalid';
  end if;
  if p_rules is null
     or jsonb_typeof(p_rules) <> 'array'
     or jsonb_array_length(p_rules) not between 1 and 50 then
    raise exception using errcode = '22023',
      message = 'Program requires between 1 and 50 rules';
  end if;
  if not exists (
    select 1 from public.duo_connections
    where id = p_connection_id
      and organization_id = p_organization_id
      and status = 'active'
  ) then
    raise exception using errcode = '23514',
      message = 'An active DuoPlus connection is required';
  end if;

  insert into public.cycle_programs (
    id, organization_id, connection_id, name, duration_days, timezone,
    ready_day, ready_threshold_percent, completion_threshold_percent,
    status, published_at, created_by, phase_plan
  ) values (
    v_program_id, p_organization_id, p_connection_id, btrim(p_name),
    p_duration_days, btrim(p_timezone), p_ready_day,
    p_ready_threshold_percent, p_completion_threshold_percent,
    'draft', null, p_created_by, p_phase_plan
  );

  for v_rule in select value from jsonb_array_elements(p_rules)
  loop
    if jsonb_typeof(v_rule) <> 'object' then
      raise exception using errcode = '22023',
        message = 'Every program rule must be an object';
    end if;

    v_template_id := (v_rule->>'templateId')::uuid;
    v_rule_kind := v_rule->>'ruleKind';
    v_app_kind := lower(btrim(coalesce(nullif(v_rule->>'appKind', ''), 'other')));
    v_points := coalesce((v_rule->>'points')::integer, 1);
    v_start_day := (v_rule->>'startDay')::integer;
    v_end_day := (v_rule->>'endDay')::integer;
    v_sequence := (v_rule->>'sequence')::integer;

    if v_rule_kind not in ('daily_range', 'day_range', 'window_once')
       or v_start_day not between 1 and p_duration_days
       or v_end_day not between v_start_day and p_duration_days then
      raise exception using errcode = '22023',
        message = 'Program rule has an invalid day range or kind';
    end if;
    if v_rule_kind = 'window_once' and v_end_day = v_start_day then
      raise exception using errcode = '22023',
        message = 'A window-once rule requires at least two eligible days';
    end if;
    if v_app_kind !~ '^[a-z][a-z0-9_]{0,31}$' or v_points not between 1 and 100 then
      raise exception using errcode = '22023',
        message = 'Program rule app or points are invalid';
    end if;
    if not exists (
      select 1 from public.duo_templates
      where id = v_template_id
        and organization_id = p_organization_id
        and connection_id = p_connection_id
        and enabled
    ) then
      raise exception using errcode = '23514',
        message = 'Program rule references an unavailable DuoPlus template';
    end if;

    insert into public.cycle_program_rules (
      organization_id, connection_id, program_id, template_id, name,
      rule_kind, app_kind, points, start_day, end_day, local_time, sequence,
      config, expected_duration_seconds, max_attempts, required, phase_kind
    ) values (
      p_organization_id, p_connection_id, v_program_id, v_template_id,
      left(coalesce(nullif(btrim(v_rule->>'name'), ''), 'Cycle task ' || v_sequence), 160),
      v_rule_kind, v_app_kind, v_points, v_start_day, v_end_day,
      (v_rule->>'localTime')::time, v_sequence,
      coalesce(v_rule->'config', '{}'::jsonb),
      coalesce((v_rule->>'expectedDurationSeconds')::integer, 600),
      coalesce((v_rule->>'maxAttempts')::integer, 3),
      coalesce((v_rule->>'required')::boolean, true),
      nullif(v_rule->>'phaseKind', '')
    );
  end loop;

  if not exists (
    select 1 from public.cycle_program_rules as rule
    where rule.program_id = v_program_id and rule.start_day <= p_ready_day
  ) then
    raise exception using errcode = '23514',
      message = 'At least one scored rule must begin by the readiness day';
  end if;

  update public.cycle_programs
  set status = 'published', published_at = clock_timestamp()
  where id = v_program_id;

  return v_program_id;
end;
$function$;

revoke all on function public.create_cycle_program(
  uuid, uuid, text, integer, text, jsonb, uuid, integer, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.create_cycle_program(
  uuid, uuid, text, integer, text, jsonb, uuid, integer, integer, integer, jsonb
) to service_role;


create or replace function public.refresh_profile_readiness(p_profile_id uuid)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_profile public.device_profiles%rowtype;
  v_profile_organization_id uuid;
  v_profile_connection_id uuid;
  v_profile_cycle_id uuid;
  v_cycle_status text;
  v_phase_plan jsonb;
  v_phase_gate jsonb;
  v_current_day integer;
  v_earned integer;
  v_successful_days integer;
  v_last_success timestamptz;
  v_failed_runs integer;
  v_apps_covered boolean;
  v_all_apps_covered boolean;
  v_ready_specials_done boolean;
  v_all_specials_done boolean;
  v_ready_met boolean;
  v_completion_met boolean;
  v_next_state text;
  v_reason text;
begin
  -- Always lock cycle -> profile. Cycle lifecycle changes already own the
  -- cycle row before calling this function; using the same order here avoids a
  -- final-run versus pause/block deadlock.
  select profile.organization_id, profile.connection_id, profile.device_cycle_id
  into v_profile_organization_id, v_profile_connection_id, v_profile_cycle_id
  from public.device_profiles as profile
  where profile.id = p_profile_id;

  if not found then
    return;
  end if;

  perform 1
  from public.device_cycles as cycle
  where cycle.id = v_profile_cycle_id
    and cycle.organization_id = v_profile_organization_id
    and cycle.connection_id = v_profile_connection_id
  for update;

  if not found then
    return;
  end if;

  select * into v_profile
  from public.device_profiles as profile
  where profile.id = p_profile_id
  for update;

  if not found then
    return;
  end if;

  select cycle.status, program.phase_plan into v_cycle_status, v_phase_plan
  from public.device_cycles as cycle
  join public.cycle_programs as program on program.id = cycle.program_id
  where cycle.id = v_profile.device_cycle_id
    and cycle.organization_id = v_profile.organization_id
    and cycle.connection_id = v_profile.connection_id;

  if not found then
    return;
  end if;

  select
    coalesce(sum(event.points), 0)::integer,
    case when v_phase_plan is null then count(distinct event.cycle_day)
      else count(distinct (coalesce(scored_run.finished_at, event.awarded_at) at time zone v_profile.timezone)::date) end::integer,
    max(event.awarded_at)
  into v_earned, v_successful_days, v_last_success
  from public.profile_score_events as event
  left join public.scheduler_runs as scored_run on scored_run.id = event.run_id
  where event.profile_id = v_profile.id
    and event.organization_id = v_profile.organization_id;

  select count(*)::integer into v_failed_runs
  from public.scheduler_runs as run
  join public.cycle_program_rules as rule on rule.id = run.program_rule_id
  where run.profile_id = v_profile.id
    and run.organization_id = v_profile.organization_id
    and run.status = 'failed'
    and rule.required;

  if v_phase_plan is not null then
    select count(*)::integer into v_failed_runs
    from public.device_cycles as cycle
    join public.cycle_program_rules as rule on rule.program_id = cycle.program_id
    cross join lateral generate_series(rule.start_day::integer, rule.end_day::integer) as day(cycle_day)
    left join public.scheduler_runs as run on run.device_cycle_id = cycle.id
      and run.program_rule_id = rule.id and run.cycle_day = day.cycle_day
    where cycle.id = v_profile.device_cycle_id and cycle.organization_id = v_profile.organization_id
      and rule.required and run.status is distinct from 'succeeded'
      and (run.status in ('failed', 'cancelled') or coalesce(run.window_end_at,
        (cycle.starts_on + day.cycle_day)::timestamp at time zone cycle.timezone) <= clock_timestamp());
  end if;

  v_current_day := greatest(
    0,
    least(
      v_profile.duration_days,
      ((clock_timestamp() at time zone v_profile.timezone)::date - v_profile.started_on) + 1
    )
  );

  -- Readiness requires at least one successful run in every required app that
  -- the program introduces by the readiness day.
  select not exists (
    select 1
    from public.cycle_program_rules as rule
    join public.device_cycles as cycle on cycle.id = v_profile.device_cycle_id
    where rule.program_id = cycle.program_id
      and rule.organization_id = v_profile.organization_id
      and rule.connection_id = v_profile.connection_id
      and rule.required
      and rule.start_day <= v_profile.ready_day
      and not exists (
        select 1
        from public.profile_score_events as event
        where event.profile_id = v_profile.id
          and event.organization_id = v_profile.organization_id
          and event.app_kind = rule.app_kind
      )
  ) into v_apps_covered;

  select not exists (
    select 1
    from public.cycle_program_rules as rule
    join public.device_cycles as cycle on cycle.id = v_profile.device_cycle_id
    where rule.program_id = cycle.program_id
      and rule.organization_id = v_profile.organization_id
      and rule.connection_id = v_profile.connection_id
      and rule.required
      and not exists (
        select 1
        from public.profile_score_events as event
        where event.profile_id = v_profile.id
          and event.organization_id = v_profile.organization_id
          and event.app_kind = rule.app_kind
      )
  ) into v_all_apps_covered;

  -- A window task becomes a readiness gate as soon as its first eligible day
  -- arrives. This prevents a profile from becoming Ready before day-10/11
  -- special work has actually succeeded.
  select not exists (
    select 1
    from public.cycle_program_rules as rule
    join public.device_cycles as cycle on cycle.id = v_profile.device_cycle_id
    where rule.program_id = cycle.program_id
      and rule.organization_id = v_profile.organization_id
      and rule.connection_id = v_profile.connection_id
      and rule.required
      and rule.rule_kind = 'window_once'
      and rule.start_day <= least(v_current_day, v_profile.ready_day)
      and not exists (
        select 1
        from public.profile_score_events as event
        join public.scheduler_runs as run on run.id = event.run_id
        where event.profile_id = v_profile.id
          and run.program_rule_id = rule.id
      )
  ) into v_ready_specials_done;

  select not exists (
    select 1
    from public.scheduler_runs as run
    join public.cycle_program_rules as rule on rule.id = run.program_rule_id
    where run.profile_id = v_profile.id
      and run.organization_id = v_profile.organization_id
      and rule.required
      and rule.rule_kind in ('day_range', 'window_once')
      and run.status <> 'succeeded'
  ) into v_all_specials_done;

  v_ready_met :=
    v_current_day >= v_profile.ready_day
    and v_earned >= v_profile.ready_score_threshold
    and v_successful_days >= least(v_profile.ready_day, 8)
    and v_apps_covered
    and v_ready_specials_done;

  v_completion_met :=
    v_current_day >= v_profile.duration_days
    and v_earned >= v_profile.completion_score_threshold
    and v_all_apps_covered
    and v_all_specials_done
    and not exists (
      select 1 from public.scheduler_runs as open_run
      where open_run.device_cycle_id = v_profile.device_cycle_id
        and open_run.organization_id = v_profile.organization_id
        and open_run.status not in ('succeeded', 'failed', 'cancelled')
    );

  -- Four-phase readiness is based on successful prerequisites rather than
  -- point percentages. All required daily work must succeed before completion.
  if v_phase_plan is not null then
    v_phase_gate := public.get_device_cycle_phase_gate(
      v_profile.organization_id, v_profile.device_cycle_id, 'money'
    )->'phaseGate';
    v_ready_met := coalesce((v_phase_gate->>'allowed')::boolean, false);
    v_completion_met := v_current_day >= v_profile.duration_days and v_ready_met and not exists (
      select 1 from public.device_cycles as cycle
      join public.cycle_program_rules as rule on rule.program_id = cycle.program_id
      cross join lateral generate_series(rule.start_day::integer, rule.end_day::integer) as day(cycle_day)
      left join public.scheduler_runs as run on run.device_cycle_id = cycle.id
        and run.program_rule_id = rule.id and run.cycle_day = day.cycle_day
      where cycle.id = v_profile.device_cycle_id and cycle.organization_id = v_profile.organization_id
        and rule.required and run.status is distinct from 'succeeded'
    ) and not exists (
      select 1 from public.scheduler_runs as open_run
      where open_run.device_cycle_id = v_profile.device_cycle_id
        and open_run.organization_id = v_profile.organization_id
        and open_run.status not in ('succeeded', 'failed', 'cancelled')
    );
  end if;

  if v_profile.retired_at is not null or v_cycle_status = 'cancelled' then
    v_next_state := 'retired';
    v_reason := 'The device cycle is retired.';
  elsif v_profile.state = 'completed' or v_completion_met then
    v_next_state := 'completed';
    v_reason := case when v_phase_plan is null then 'Completion score, cycle duration, app coverage, and required special tasks are complete.'
      else 'All required phase work, app requirements, and cycle duration are complete.' end;
  elsif v_cycle_status in ('blocked', 'paused') then
    v_next_state := 'needs_attention';
    v_reason := 'The device cycle is ' || v_cycle_status || '.';
  elsif v_failed_runs >= (case when v_phase_plan is null then 3 else 1 end) then
    v_next_state := 'needs_attention';
    v_reason := v_failed_runs || case when v_phase_plan is null
      then ' required runs have reached failed status.'
      else ' required runs failed, were cancelled, or missed their window.' end;
  elsif v_current_day > v_profile.ready_day
        and (v_last_success is null or v_last_success < clock_timestamp() - interval '48 hours') then
    v_next_state := 'needs_attention';
    v_reason := 'No successful scored activity was recorded in the last 48 hours.';
  elsif v_current_day > v_profile.ready_day and not v_ready_met then
    v_next_state := 'needs_attention';
    v_reason := case when v_phase_plan is null then 'The readiness day passed before every score, day, app, and special-task gate was met.'
      else coalesce(v_phase_gate->>'reason', 'Required warmup work or app completion targets are not complete.') end;
  elsif v_profile.state = 'ready' or v_ready_met then
    v_next_state := 'ready';
    v_reason := case when v_phase_plan is null then 'Readiness score, successful-day, app-coverage, and special-task gates are met.'
      else 'Warmup duration, required tasks, and app completion requirements are met.' end;
  elsif v_earned = 0 and v_current_day <= 1 then
    v_next_state := 'new';
    v_reason := 'No successful RPA runs yet.';
  else
    v_next_state := 'warming';
    v_reason := v_earned || ' of ' || v_profile.ready_score_threshold
      || ' readiness points across ' || v_successful_days || ' successful days.';
  end if;

  update public.device_profiles
  set earned_points = least(v_earned, possible_points),
      successful_days = least(v_successful_days, duration_days),
      last_success_at = v_last_success,
      state = v_next_state,
      status_reason = left(v_reason, 500),
      ready_at = case
        when v_next_state in ('ready', 'completed') then coalesce(ready_at, clock_timestamp())
        else ready_at
      end,
      completed_at = case
        when v_next_state = 'completed' then coalesce(completed_at, clock_timestamp())
        else completed_at
      end,
      retired_at = case
        when v_next_state = 'retired' then coalesce(retired_at, clock_timestamp())
        else retired_at
      end
  where id = v_profile.id;

  -- Reaching all completion gates closes the cycle and disables its compiled
  -- schedules through the existing device-cycle lifecycle trigger.
  if v_completion_met
     and v_cycle_status not in ('completed', 'cancelled')
     and not exists (
       select 1 from public.scheduler_runs as open_run
       where open_run.device_cycle_id = v_profile.device_cycle_id
         and open_run.organization_id = v_profile.organization_id
         and open_run.status not in ('succeeded', 'failed', 'cancelled')
     ) then
    update public.device_cycles
    set status = 'completed',
        completed_at = coalesce(completed_at, clock_timestamp()),
        last_error = null
    where id = v_profile.device_cycle_id
      and organization_id = v_profile.organization_id;
  end if;
end;
$function$;


-- Internal functions are invoker-only; the API supplies tenant-scoped IDs.
-- Revoke PostgreSQL's default PUBLIC execute before exposing service RPCs.
revoke all on function public.stakeout_validate_phase_plan(jsonb, integer) from public, anon, authenticated;
grant execute on function public.stakeout_validate_phase_plan(jsonb, integer) to service_role;
revoke all on function public.stakeout_validate_phase_program() from public, anon, authenticated;
grant execute on function public.stakeout_validate_phase_program() to service_role;
revoke all on function public.get_cycle_phase_window(jsonb, text) from public, anon, authenticated;
grant execute on function public.get_cycle_phase_window(jsonb, text) to service_role;
revoke all on function public.stakeout_validate_phase_rule() from public, anon, authenticated;
grant execute on function public.stakeout_validate_phase_rule() to service_role;
revoke all on function public.stakeout_keep_phone_city_assignment() from public, anon, authenticated;
grant execute on function public.stakeout_keep_phone_city_assignment() to service_role;
revoke all on function public.stakeout_bind_phase_cycle_city() from public, anon, authenticated;
grant execute on function public.stakeout_bind_phase_cycle_city() to service_role;
revoke all on function public.get_device_cycle_phase_gate(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.get_device_cycle_phase_gate(uuid, uuid, text) to service_role;
revoke all on function public.get_scheduler_run_phase_gate(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_scheduler_run_phase_gate(uuid, uuid) to service_role;
revoke all on function public.get_device_cycle_phase_gates(uuid) from public, anon, authenticated;
grant execute on function public.get_device_cycle_phase_gates(uuid) to service_role;
revoke all on function public.stakeout_enforce_run_phase_submission() from public, anon, authenticated;
grant execute on function public.stakeout_enforce_run_phase_submission() to service_role;

comment on column public.cycle_programs.phase_plan is
  'Immutable four-phase duration and app-completion requirements; null preserves legacy behavior.';
comment on column public.cycle_program_rules.phase_kind is
  'Daily routine or named phase, compiled to exact immutable day windows.';
comment on column public.duo_phones.dedicated_city is
  'Persistent configured city for phase-managed phones; does not assert verified GPS location.';
comment on function public.get_scheduler_run_phase_gate(uuid, uuid) is
  'Service-only tenant-scoped prerequisite gate; existing remote tasks bypass it for reconciliation.';

-- Cancellation is unfinished coverage, never evidence of successful work.
create or replace function public.get_device_cycle_run_counts(p_organization_id uuid)
returns table(device_cycle_id uuid, total bigint, done bigint, running bigint, failed bigint, pending bigint)
language sql stable security invoker
set search_path = pg_catalog, public
as $function$
  select cycle.id, count(run.id),
    count(*) filter (where run.status = 'succeeded'),
    count(*) filter (where run.status in ('preparing', 'queued', 'running')),
    count(*) filter (where run.status = 'failed'),
    count(*) filter (where run.status in ('pending', 'retry_wait', 'paused'))
  from public.device_cycles as cycle
  left join public.scheduler_runs as run on run.organization_id = cycle.organization_id
    and run.device_cycle_id = cycle.id
  where cycle.organization_id = p_organization_id
  group by cycle.id;
$function$;
