-- First-class profile readiness for device-cycle RPA work.
--
-- A score is an internal Stakeout readiness signal, not a Google trust or
-- ranking metric. Published program rules define fixed, bounded points. Every
-- cycle-backed run snapshots that definition, and a successful run can produce
-- at most one immutable score event.

alter table public.cycle_programs
  add column ready_day smallint not null default 10,
  add column ready_threshold_percent smallint not null default 80,
  add column completion_threshold_percent smallint not null default 90,
  add constraint cycle_programs_readiness_thresholds_check check (
    ready_day between 1 and duration_days
    and ready_threshold_percent between 1 and 100
    and completion_threshold_percent between 1 and 100
    and completion_threshold_percent >= ready_threshold_percent
  );

alter table public.cycle_program_rules
  add column app_kind text not null default 'other',
  add column points smallint not null default 1,
  add constraint cycle_program_rules_app_kind_check check (
    app_kind ~ '^[a-z][a-z0-9_]{0,31}$'
  ),
  add constraint cycle_program_rules_points_check check (points between 1 and 100);

create or replace function public.stakeout_validate_readiness_program()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if new.ready_day > new.duration_days then
    raise exception using errcode = '23514',
      message = 'Readiness day must fit inside the cycle duration';
  end if;

  if tg_op = 'UPDATE'
     and old.status in ('published', 'retired')
     and (
       new.ready_day is distinct from old.ready_day
       or new.ready_threshold_percent is distinct from old.ready_threshold_percent
       or new.completion_threshold_percent is distinct from old.completion_threshold_percent
     ) then
    raise exception using errcode = '23514',
      message = 'Published cycle program readiness gates are immutable';
  end if;

  return new;
end;
$function$;

revoke all on function public.stakeout_validate_readiness_program()
  from public, anon, authenticated;

create trigger stakeout_validate_readiness_program
before insert or update on public.cycle_programs
for each row execute function public.stakeout_validate_readiness_program();

create or replace function public.stakeout_keep_published_scoring_rules_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_program_status text;
begin
  select program.status into v_program_status
  from public.cycle_programs as program
  where program.id = case when tg_op = 'DELETE' then old.program_id else new.program_id end
    and program.organization_id = case
      when tg_op = 'DELETE' then old.organization_id else new.organization_id
    end;

  if v_program_status in ('published', 'retired') then
    raise exception using errcode = '23514',
      message = 'Published cycle program rules are immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function public.stakeout_keep_published_scoring_rules_immutable()
  from public, anon, authenticated;

create trigger stakeout_keep_published_scoring_rules_immutable
before update or delete on public.cycle_program_rules
for each row execute function public.stakeout_keep_published_scoring_rules_immutable();

create table public.device_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete restrict,
  connection_id uuid not null,
  phone_id uuid not null,
  device_cycle_id uuid not null,
  label text not null check (char_length(btrim(label)) between 1 and 160),
  state text not null default 'new'
    check (state in ('new', 'warming', 'ready', 'completed', 'needs_attention', 'retired')),
  started_on date not null,
  duration_days smallint not null check (duration_days between 15 and 30),
  timezone text not null check (char_length(btrim(timezone)) between 1 and 80),
  ready_day smallint not null check (ready_day between 1 and 30),
  earned_points integer not null default 0 check (earned_points >= 0),
  possible_points integer not null check (possible_points > 0),
  ready_score_threshold integer not null check (ready_score_threshold >= 0),
  completion_score_threshold integer not null check (completion_score_threshold > 0),
  successful_days smallint not null default 0 check (successful_days between 0 and 30),
  last_success_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  retired_at timestamptz,
  status_reason text not null default 'No successful RPA runs yet.'
    check (char_length(status_reason) between 1 and 500),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_profiles_connection_fk
    foreign key (organization_id, connection_id)
    references public.duo_connections (organization_id, id) on delete restrict,
  constraint device_profiles_phone_fk
    foreign key (organization_id, connection_id, phone_id)
    references public.duo_phones (organization_id, connection_id, id) on delete restrict,
  constraint device_profiles_cycle_fk
    foreign key (organization_id, connection_id, device_cycle_id)
    references public.device_cycles (organization_id, connection_id, id) on delete restrict,
  constraint device_profiles_org_connection_id_unique
    unique (organization_id, connection_id, id),
  constraint device_profiles_org_id_unique unique (organization_id, id),
  constraint device_profiles_cycle_unique unique (device_cycle_id),
  constraint device_profiles_score_bounds_check check (
    earned_points <= possible_points
    and ready_score_threshold <= possible_points
    and completion_score_threshold <= possible_points
  ),
  constraint device_profiles_readiness_day_check check (ready_day <= duration_days),
  constraint device_profiles_lifecycle_check check (
    (state <> 'ready' or (ready_at is not null and completed_at is null and retired_at is null))
    and (state <> 'completed' or (ready_at is not null and completed_at is not null and retired_at is null))
    and (state <> 'retired' or retired_at is not null)
  )
);

create index device_profiles_org_state_idx
  on public.device_profiles (organization_id, state, updated_at desc);
create index device_profiles_org_created_idx
  on public.device_profiles (organization_id, created_at desc);
create index device_profiles_client_idx
  on public.device_profiles (organization_id, client_id, state);
create index device_profiles_client_fk_idx
  on public.device_profiles (client_id);
create index device_profiles_phone_fk_idx
  on public.device_profiles (organization_id, connection_id, phone_id);
create index device_profiles_cycle_fk_idx
  on public.device_profiles (organization_id, connection_id, device_cycle_id);
create index device_profiles_created_by_idx
  on public.device_profiles (created_by)
  where created_by is not null;
alter table public.device_cycles
  add column profile_id uuid;

-- Upgrade every existing cycle rather than hiding historical/current work from
-- the new readiness view. Legacy rules begin at one point and app=other.
insert into public.device_profiles (
  organization_id, client_id, connection_id, phone_id, device_cycle_id, label,
  state, started_on, duration_days, timezone, ready_day, possible_points,
  ready_score_threshold, completion_score_threshold, created_by, created_at,
  updated_at
)
select
  cycle.organization_id,
  cycle.client_id,
  cycle.connection_id,
  cycle.phone_id,
  cycle.id,
  left(coalesce(nullif(btrim(cycle.profile_label), ''), cycle.name), 160),
  'new',
  cycle.starts_on,
  cycle.duration_days,
  cycle.timezone,
  program.ready_day,
  score.full_points,
  greatest(1, ceil(score.ready_points * program.ready_threshold_percent / 100.0)::integer),
  ceil(score.full_points * program.completion_threshold_percent / 100.0)::integer,
  cycle.created_by,
  cycle.created_at,
  cycle.updated_at
from public.device_cycles as cycle
join public.cycle_programs as program
  on program.id = cycle.program_id
 and program.organization_id = cycle.organization_id
 and program.connection_id = cycle.connection_id
cross join lateral (
  select
    sum(rule.points * case
      when rule.rule_kind = 'window_once' then 1
      else rule.end_day - rule.start_day + 1
    end)::integer as full_points,
    coalesce(sum(rule.points * case
      when rule.start_day > program.ready_day then 0
      when rule.rule_kind = 'window_once' then 1
      else least(rule.end_day, program.ready_day) - rule.start_day + 1
    end), 0)::integer as ready_points
  from public.cycle_program_rules as rule
  where rule.program_id = program.id
    and rule.organization_id = program.organization_id
    and rule.connection_id = program.connection_id
) as score;

update public.device_cycles as cycle
set profile_id = profile.id
from public.device_profiles as profile
where profile.device_cycle_id = cycle.id
  and profile.organization_id = cycle.organization_id
  and profile.connection_id = cycle.connection_id;

alter table public.device_cycles
  add constraint device_cycles_profile_fk
    foreign key (organization_id, connection_id, profile_id)
    references public.device_profiles (organization_id, connection_id, id) on delete restrict;

create unique index device_cycles_profile_fk_idx
  on public.device_cycles (organization_id, connection_id, profile_id)
  where profile_id is not null;

alter table public.scheduler_runs
  add column profile_id uuid,
  add column app_kind text,
  add column planned_points smallint,
  add column scoring_version smallint,
  add constraint scheduler_runs_profile_fk
    foreign key (organization_id, connection_id, profile_id)
    references public.device_profiles (organization_id, connection_id, id) on delete restrict;

update public.scheduler_runs as run
set profile_id = cycle.profile_id,
    app_kind = rule.app_kind,
    planned_points = rule.points,
    scoring_version = 1
from public.device_cycles as cycle,
     public.cycle_program_rules as rule
where run.device_cycle_id = cycle.id
  and run.program_rule_id = rule.id
  and cycle.organization_id = run.organization_id
  and cycle.connection_id = run.connection_id
  and rule.organization_id = run.organization_id
  and rule.connection_id = run.connection_id;

alter table public.scheduler_runs
  add constraint scheduler_runs_profile_scoring_check check (
    (
      device_cycle_id is null
      and profile_id is null
      and app_kind is null
      and planned_points is null
      and scoring_version is null
    )
    or (
      device_cycle_id is not null
      and profile_id is not null
      and app_kind ~ '^[a-z][a-z0-9_]{0,31}$'
      and planned_points between 1 and 100
      and scoring_version > 0
    )
  );

create index scheduler_runs_profile_fk_idx
  on public.scheduler_runs (organization_id, connection_id, profile_id)
  where profile_id is not null;
create index scheduler_runs_profile_status_idx
  on public.scheduler_runs (profile_id, status, cycle_day)
  where profile_id is not null;
create index scheduler_runs_uncredited_profile_success_idx
  on public.scheduler_runs (finished_at, created_at, id)
  where status = 'succeeded'
    and profile_id is not null
    and planned_points is not null;

create table public.profile_score_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  profile_id uuid not null,
  run_id uuid not null,
  device_cycle_id uuid not null,
  app_kind text not null check (app_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  points smallint not null check (points between 1 and 100),
  cycle_day smallint not null check (cycle_day between 1 and 30),
  source text not null default 'rpa_success' check (source = 'rpa_success'),
  awarded_at timestamptz not null default now(),
  constraint profile_score_events_profile_fk
    foreign key (organization_id, connection_id, profile_id)
    references public.device_profiles (organization_id, connection_id, id) on delete restrict,
  constraint profile_score_events_run_fk
    foreign key (organization_id, run_id)
    references public.scheduler_runs (organization_id, id) on delete restrict,
  constraint profile_score_events_cycle_fk
    foreign key (organization_id, connection_id, device_cycle_id)
    references public.device_cycles (organization_id, connection_id, id) on delete restrict,
  constraint profile_score_events_run_unique unique (run_id)
);

create index profile_score_events_profile_idx
  on public.profile_score_events (profile_id, awarded_at desc);
create index profile_score_events_org_app_idx
  on public.profile_score_events (organization_id, app_kind, awarded_at desc);
create index profile_score_events_org_profile_app_idx
  on public.profile_score_events (organization_id, profile_id, app_kind);
create index profile_score_events_cycle_fk_idx
  on public.profile_score_events (organization_id, connection_id, device_cycle_id);

-- Successful legacy runs receive exactly the points captured above. Their
-- original completion timestamp is retained as the award timestamp.
insert into public.profile_score_events (
  organization_id, connection_id, profile_id, run_id, device_cycle_id,
  app_kind, points, cycle_day, source, awarded_at
)
select
  run.organization_id,
  run.connection_id,
  run.profile_id,
  run.id,
  run.device_cycle_id,
  run.app_kind,
  run.planned_points,
  run.cycle_day,
  'rpa_success',
  coalesce(run.finished_at, run.updated_at, run.created_at)
from public.scheduler_runs as run
where run.status = 'succeeded'
  and run.profile_id is not null
on conflict (run_id) do nothing;

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

  select cycle.status into v_cycle_status
  from public.device_cycles as cycle
  where cycle.id = v_profile.device_cycle_id
    and cycle.organization_id = v_profile.organization_id
    and cycle.connection_id = v_profile.connection_id;

  if not found then
    return;
  end if;

  select
    coalesce(sum(event.points), 0)::integer,
    count(distinct event.cycle_day)::integer,
    max(event.awarded_at)
  into v_earned, v_successful_days, v_last_success
  from public.profile_score_events as event
  where event.profile_id = v_profile.id
    and event.organization_id = v_profile.organization_id;

  select count(*)::integer into v_failed_runs
  from public.scheduler_runs as run
  join public.cycle_program_rules as rule on rule.id = run.program_rule_id
  where run.profile_id = v_profile.id
    and run.organization_id = v_profile.organization_id
    and run.status = 'failed'
    and rule.required;

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

  if v_profile.retired_at is not null or v_cycle_status = 'cancelled' then
    v_next_state := 'retired';
    v_reason := 'The device cycle is retired.';
  elsif v_profile.state = 'completed' or v_completion_met then
    v_next_state := 'completed';
    v_reason := 'Completion score, cycle duration, app coverage, and required special tasks are complete.';
  elsif v_cycle_status in ('blocked', 'paused') then
    v_next_state := 'needs_attention';
    v_reason := 'The device cycle is ' || v_cycle_status || '.';
  elsif v_failed_runs >= 3 then
    v_next_state := 'needs_attention';
    v_reason := v_failed_runs || ' required runs have reached failed status.';
  elsif v_current_day > v_profile.ready_day
        and (v_last_success is null or v_last_success < clock_timestamp() - interval '48 hours') then
    v_next_state := 'needs_attention';
    v_reason := 'No successful scored activity was recorded in the last 48 hours.';
  elsif v_current_day > v_profile.ready_day and not v_ready_met then
    v_next_state := 'needs_attention';
    v_reason := 'The readiness day passed before every score, day, app, and special-task gate was met.';
  elsif v_profile.state = 'ready' or v_ready_met then
    v_next_state := 'ready';
    v_reason := 'Readiness score, successful-day, app-coverage, and special-task gates are met.';
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

create or replace function public.credit_profile_run(
  p_run_id uuid,
  p_worker_id text default null
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_run public.scheduler_runs%rowtype;
  v_inserted integer := 0;
begin
  select * into v_run
  from public.scheduler_runs as run
  where run.id = p_run_id
  for update;

  if not found
     or v_run.status <> 'succeeded'
     or v_run.profile_id is null
     or v_run.device_cycle_id is null
     or v_run.cycle_day is null
     or v_run.app_kind is null
     or v_run.planned_points is null then
    return false;
  end if;

  if p_worker_id is not null
     and v_run.lease_owner is distinct from nullif(btrim(p_worker_id), '') then
    return false;
  end if;

  insert into public.profile_score_events (
    organization_id, connection_id, profile_id, run_id, device_cycle_id,
    app_kind, points, cycle_day, source, awarded_at
  ) values (
    v_run.organization_id, v_run.connection_id, v_run.profile_id, v_run.id,
    v_run.device_cycle_id, v_run.app_kind, v_run.planned_points,
    v_run.cycle_day, 'rpa_success', coalesce(v_run.finished_at, clock_timestamp())
  )
  on conflict (run_id) do nothing;

  get diagnostics v_inserted = row_count;
  perform public.refresh_profile_readiness(v_run.profile_id);
  return v_inserted = 1;
end;
$function$;

create or replace function public.stakeout_snapshot_profile_run()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_profile_id uuid;
  v_app_kind text;
  v_points smallint;
begin
  if new.device_cycle_id is null then
    if new.profile_id is not null
       or new.app_kind is not null
       or new.planned_points is not null
       or new.scoring_version is not null then
      raise exception using errcode = '23514',
        message = 'Calendar runs cannot carry device-profile scoring fields';
    end if;
    return new;
  end if;

  select cycle.profile_id, rule.app_kind, rule.points
  into v_profile_id, v_app_kind, v_points
  from public.device_cycles as cycle
  join public.cycle_program_rules as rule
    on rule.id = new.program_rule_id
   and rule.organization_id = cycle.organization_id
   and rule.connection_id = cycle.connection_id
   and rule.program_id = cycle.program_id
  where cycle.id = new.device_cycle_id
    and cycle.organization_id = new.organization_id
    and cycle.connection_id = new.connection_id;

  if v_profile_id is null then
    raise exception using errcode = '23514',
      message = 'Cycle-backed run requires an initialized device profile';
  end if;

  if tg_op = 'UPDATE' and (
    new.device_cycle_id is distinct from old.device_cycle_id
    or new.program_rule_id is distinct from old.program_rule_id
    or new.profile_id is distinct from old.profile_id
    or new.app_kind is distinct from old.app_kind
    or new.planned_points is distinct from old.planned_points
    or new.scoring_version is distinct from old.scoring_version
  ) then
    raise exception using errcode = '23514',
      message = 'Materialized run scoring snapshots are immutable';
  end if;

  if tg_op = 'INSERT' then
    new.profile_id := v_profile_id;
    new.app_kind := v_app_kind;
    new.planned_points := v_points;
    new.scoring_version := 1;
  elsif new.profile_id <> v_profile_id
        or new.app_kind <> v_app_kind
        or new.planned_points <> v_points then
    raise exception using errcode = '23514',
      message = 'Run scoring snapshot does not match its cycle profile and published rule';
  end if;

  return new;
end;
$function$;

create or replace function public.reconcile_profile_score_credits(
  p_limit integer default 100
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_run_id uuid;
  v_credited integer := 0;
begin
  if p_limit not between 1 and 1000 then
    raise exception using errcode = '22023',
      message = 'limit must be between 1 and 1000';
  end if;

  for v_run_id in
    select run.id
    from public.scheduler_runs as run
    where run.status = 'succeeded'
      and run.profile_id is not null
      and run.planned_points is not null
      and not exists (
        select 1 from public.profile_score_events as event
        where event.run_id = run.id
      )
    order by run.finished_at nulls last, run.created_at
    for update of run skip locked
    limit p_limit
  loop
    if public.credit_profile_run(v_run_id, null) then
      v_credited := v_credited + 1;
    end if;
  end loop;

  return v_credited;
end;
$function$;

create or replace function public.stakeout_create_device_profile()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_program public.cycle_programs%rowtype;
  v_profile_id uuid := gen_random_uuid();
  v_full_points integer;
  v_ready_points integer;
begin
  select * into v_program
  from public.cycle_programs as program
  where program.id = new.program_id
    and program.organization_id = new.organization_id
    and program.connection_id = new.connection_id;

  if not found then
    return new;
  end if;

  select
    sum(rule.points * case
      when rule.rule_kind = 'window_once' then 1
      else rule.end_day - rule.start_day + 1
    end)::integer,
    coalesce(sum(rule.points * case
      when rule.start_day > v_program.ready_day then 0
      when rule.rule_kind = 'window_once' then 1
      else least(rule.end_day, v_program.ready_day) - rule.start_day + 1
    end), 0)::integer
  into v_full_points, v_ready_points
  from public.cycle_program_rules as rule
  where rule.program_id = new.program_id
    and rule.organization_id = new.organization_id
    and rule.connection_id = new.connection_id;

  if coalesce(v_full_points, 0) <= 0 then
    raise exception using errcode = '23514',
      message = 'Device profile requires a scored cycle program';
  end if;

  insert into public.device_profiles (
    id, organization_id, client_id, connection_id, phone_id, device_cycle_id,
    label, state, started_on, duration_days, timezone, ready_day,
    possible_points, ready_score_threshold, completion_score_threshold,
    created_by
  ) values (
    v_profile_id, new.organization_id, new.client_id, new.connection_id,
    new.phone_id, new.id,
    left(coalesce(nullif(btrim(new.profile_label), ''), new.name), 160),
    'new', new.starts_on, new.duration_days, new.timezone, v_program.ready_day,
    v_full_points,
    greatest(1, ceil(v_ready_points * v_program.ready_threshold_percent / 100.0)::integer),
    ceil(v_full_points * v_program.completion_threshold_percent / 100.0)::integer,
    new.created_by
  );

  update public.device_cycles
  set profile_id = v_profile_id
  where id = new.id and organization_id = new.organization_id;

  return new;
end;
$function$;

create or replace function public.stakeout_credit_profile_run_trigger()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if new.profile_id is null then
    return new;
  end if;

  if tg_op = 'INSERT'
     and new.status in ('succeeded', 'failed', 'cancelled') then
    begin
      if new.status = 'succeeded' then
        perform public.credit_profile_run(new.id, null);
      elsif new.status in ('failed', 'cancelled') then
        perform public.refresh_profile_readiness(new.profile_id);
      end if;
    exception when others then
      raise warning 'Profile readiness refresh deferred for run %: %', new.id, sqlerrm;
    end;
  elsif tg_op = 'UPDATE'
        and old.status is distinct from new.status
        and new.status in ('succeeded', 'failed', 'cancelled') then
    begin
      if new.status = 'succeeded' then
        perform public.credit_profile_run(new.id, null);
      elsif new.status in ('failed', 'cancelled') then
        perform public.refresh_profile_readiness(new.profile_id);
      end if;
    exception when others then
      raise warning 'Profile readiness refresh deferred for run %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$function$;

create or replace function public.stakeout_reject_profile_score_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  raise exception using errcode = '55000',
    message = 'Profile score events are immutable';
end;
$function$;

create or replace function public.stakeout_validate_profile_score_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if not exists (
    select 1
    from public.scheduler_runs as run
    where run.id = new.run_id
      and run.organization_id = new.organization_id
      and run.connection_id = new.connection_id
      and run.profile_id = new.profile_id
      and run.device_cycle_id = new.device_cycle_id
      and run.status = 'succeeded'
      and run.app_kind = new.app_kind
      and run.planned_points = new.points
      and run.cycle_day = new.cycle_day
  ) then
    raise exception using errcode = '23514',
      message = 'Profile score event must exactly match a successful scored run';
  end if;
  return new;
end;
$function$;

create or replace function public.stakeout_sync_profile_cycle_state()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if old.status is not distinct from new.status or new.profile_id is null then
    return new;
  end if;

  if new.status = 'cancelled' then
    update public.device_profiles
    set state = 'retired',
        retired_at = coalesce(retired_at, clock_timestamp()),
        status_reason = 'The device cycle is retired.'
    where id = new.profile_id and organization_id = new.organization_id;
  elsif new.status in ('completed', 'paused', 'blocked', 'active') then
    perform public.refresh_profile_readiness(new.profile_id);
  end if;

  return new;
end;
$function$;

create or replace function public.stakeout_validate_device_profile_identity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if not exists (
    select 1
    from public.device_cycles as cycle
    join public.cycle_programs as program
      on program.id = cycle.program_id
     and program.organization_id = cycle.organization_id
     and program.connection_id = cycle.connection_id
    where cycle.id = new.device_cycle_id
      and cycle.organization_id = new.organization_id
      and cycle.connection_id = new.connection_id
      and cycle.client_id = new.client_id
      and cycle.phone_id = new.phone_id
      and cycle.starts_on = new.started_on
      and cycle.duration_days = new.duration_days
      and cycle.timezone = new.timezone
      and program.ready_day = new.ready_day
  ) then
    raise exception using errcode = '23514',
      message = 'Device profile identity must match its cycle and program';
  end if;
  return new;
end;
$function$;

create or replace function public.stakeout_validate_cycle_profile_link()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if old.profile_id is not null and new.profile_id is distinct from old.profile_id then
    raise exception using errcode = '23514',
      message = 'A device cycle profile link is immutable once initialized';
  end if;

  if new.profile_id is not null and not exists (
    select 1 from public.device_profiles as profile
    where profile.id = new.profile_id
      and profile.device_cycle_id = new.id
      and profile.organization_id = new.organization_id
      and profile.connection_id = new.connection_id
      and profile.client_id = new.client_id
      and profile.phone_id = new.phone_id
  ) then
    raise exception using errcode = '23514',
      message = 'Device cycle profile link does not match its tenant, client, phone, and cycle';
  end if;
  return new;
end;
$function$;

create or replace function public.get_profile_app_scores(p_organization_id uuid)
returns table (
  profile_id uuid,
  app_kind text,
  earned_points bigint,
  possible_points bigint
)
language sql
security invoker
set search_path = pg_catalog, public
stable
as $function$
  with selected_profiles as materialized (
    select profile.id
    from public.device_profiles as profile
    where profile.organization_id = p_organization_id
    order by profile.created_at desc
    limit 300
  )
  select
    run.profile_id,
    run.app_kind,
    coalesce(sum(event.points), 0)::bigint as earned_points,
    sum(run.planned_points)::bigint as possible_points
  from public.scheduler_runs as run
  join selected_profiles as profile on profile.id = run.profile_id
  left join public.profile_score_events as event
    on event.run_id = run.id
   and event.organization_id = run.organization_id
  where run.organization_id = p_organization_id
    and run.profile_id is not null
  group by run.profile_id, run.app_kind
  order by run.profile_id, run.app_kind;
$function$;

-- Bring every upgraded profile to the same derived state as new profiles.
do $block$
declare
  v_profile_id uuid;
begin
  for v_profile_id in select id from public.device_profiles
  loop
    perform public.refresh_profile_readiness(v_profile_id);
  end loop;
end;
$block$;

create trigger stakeout_snapshot_profile_run
before insert or update of device_cycle_id, program_rule_id, profile_id,
  app_kind, planned_points, scoring_version
on public.scheduler_runs
for each row execute function public.stakeout_snapshot_profile_run();

create trigger stakeout_create_device_profile
after insert on public.device_cycles
for each row execute function public.stakeout_create_device_profile();

create trigger stakeout_credit_profile_run
after insert or update on public.scheduler_runs
for each row execute function public.stakeout_credit_profile_run_trigger();

create trigger stakeout_reject_profile_score_event_mutation
before update or delete on public.profile_score_events
for each row execute function public.stakeout_reject_profile_score_event_mutation();

create trigger stakeout_validate_profile_score_event
before insert on public.profile_score_events
for each row execute function public.stakeout_validate_profile_score_event();

create trigger stakeout_sync_profile_cycle_state
after update of status on public.device_cycles
for each row execute function public.stakeout_sync_profile_cycle_state();

create trigger stakeout_validate_device_profile_identity
before insert or update of organization_id, client_id, connection_id, phone_id,
  device_cycle_id, started_on, duration_days, timezone, ready_day
on public.device_profiles
for each row execute function public.stakeout_validate_device_profile_identity();

create trigger stakeout_validate_cycle_profile_link
before update of profile_id on public.device_cycles
for each row execute function public.stakeout_validate_cycle_profile_link();

create trigger stakeout_touch_device_profiles
before update on public.device_profiles
for each row execute function public.stakeout_set_updated_at();

alter table public.device_profiles enable row level security;
alter table public.profile_score_events enable row level security;

create policy stakeout_device_profiles_read_member
on public.device_profiles for select to authenticated
using (public.is_organization_member(organization_id));

create policy stakeout_profile_score_events_read_member
on public.profile_score_events for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.device_profiles, public.profile_score_events
  from anon, authenticated;
grant select on table public.device_profiles, public.profile_score_events
  to authenticated;
grant all on table public.device_profiles, public.profile_score_events
  to service_role;

revoke all on function public.refresh_profile_readiness(uuid)
  from public, anon, authenticated;
revoke all on function public.credit_profile_run(uuid, text)
  from public, anon, authenticated;
revoke all on function public.stakeout_snapshot_profile_run()
  from public, anon, authenticated;
revoke all on function public.reconcile_profile_score_credits(integer)
  from public, anon, authenticated;
revoke all on function public.stakeout_create_device_profile()
  from public, anon, authenticated;
revoke all on function public.stakeout_credit_profile_run_trigger()
  from public, anon, authenticated;
revoke all on function public.stakeout_reject_profile_score_event_mutation()
  from public, anon, authenticated;
revoke all on function public.stakeout_validate_profile_score_event()
  from public, anon, authenticated;
revoke all on function public.stakeout_sync_profile_cycle_state()
  from public, anon, authenticated;
revoke all on function public.stakeout_validate_device_profile_identity()
  from public, anon, authenticated;
revoke all on function public.stakeout_validate_cycle_profile_link()
  from public, anon, authenticated;
revoke all on function public.get_profile_app_scores(uuid)
  from public, anon, authenticated;

grant execute on function public.refresh_profile_readiness(uuid) to service_role;
grant execute on function public.credit_profile_run(uuid, text) to service_role;
grant execute on function public.reconcile_profile_score_credits(integer) to service_role;
grant execute on function public.get_profile_app_scores(uuid) to service_role;

-- Replace the program factory with the scored-program signature. Its final
-- arguments have defaults so an in-flight older server deployment can still
-- call the first seven arguments during a zero-downtime rollout.
drop function public.create_cycle_program(uuid, uuid, text, integer, text, jsonb, uuid);

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
  p_completion_threshold_percent integer default 90
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
  if p_duration_days not between 15 and 30 then
    raise exception using errcode = '22023',
      message = 'Cycle duration must be between 15 and 30 days';
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
    status, published_at, created_by
  ) values (
    v_program_id, p_organization_id, p_connection_id, btrim(p_name),
    p_duration_days, btrim(p_timezone), p_ready_day,
    p_ready_threshold_percent, p_completion_threshold_percent,
    'draft', null, p_created_by
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
      config, expected_duration_seconds, max_attempts, required
    ) values (
      p_organization_id, p_connection_id, v_program_id, v_template_id,
      left(coalesce(nullif(btrim(v_rule->>'name'), ''), 'Cycle task ' || v_sequence), 160),
      v_rule_kind, v_app_kind, v_points, v_start_day, v_end_day,
      (v_rule->>'localTime')::time, v_sequence,
      coalesce(v_rule->'config', '{}'::jsonb),
      coalesce((v_rule->>'expectedDurationSeconds')::integer, 600),
      coalesce((v_rule->>'maxAttempts')::integer, 3),
      coalesce((v_rule->>'required')::boolean, true)
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
  uuid, uuid, text, integer, text, jsonb, uuid, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.create_cycle_program(
  uuid, uuid, text, integer, text, jsonb, uuid, integer, integer, integer
) to service_role;

comment on table public.device_profiles is
  'One non-secret profile label per device cycle with bounded Stakeout readiness scoring; this is not a ranking or Google trust metric.';
comment on table public.profile_score_events is
  'Immutable, idempotent ledger: one fixed point award per successfully completed scored run.';
comment on column public.scheduler_runs.planned_points is
  'Immutable point value snapshotted from the published cycle rule when the run is materialized.';
comment on function public.credit_profile_run(uuid, text) is
  'Idempotently credits one successful cycle-backed run and refreshes its profile readiness state.';
comment on function public.reconcile_profile_score_credits(integer) is
  'Bounded repair pass for successful scored runs that lack their immutable ledger event.';
comment on function public.get_profile_app_scores(uuid) is
  'Service-only per-profile/app earned and possible score aggregate from immutable run snapshots and score events.';
