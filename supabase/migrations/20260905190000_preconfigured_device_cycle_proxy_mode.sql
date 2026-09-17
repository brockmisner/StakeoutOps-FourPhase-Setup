-- Make device cycles safe for phones whose proxies are configured outside Stakeout.
--
-- Existing cycles were created by the managed Proxy-Seller flow and retain that
-- mode. New database-level defaults are preconfigured and do not require or
-- create a managed proxy binding. The public API also writes this mode
-- explicitly. Managed mode remains available only for a future gated release.

alter table public.device_cycles
  add column if not exists proxy_mode text;

update public.device_cycles
set proxy_mode = 'managed'
where proxy_mode is null;

alter table public.device_cycles
  alter column proxy_mode set not null,
  alter column proxy_mode set default 'preconfigured',
  alter column proxy_diversity_status set default 'unknown',
  drop constraint if exists device_cycles_proxy_mode_check,
  drop constraint if exists device_cycles_proxy_diversity_status_check,
  drop constraint if exists device_cycles_proxy_selection_consistent;

alter table public.device_cycles
  add constraint device_cycles_proxy_mode_check
    check (proxy_mode in ('managed', 'preconfigured')),
  add constraint device_cycles_proxy_diversity_status_check
    check (proxy_diversity_status in ('pending', 'unique', 'reused', 'unknown')),
  add constraint device_cycles_proxy_selection_consistent check (
    (
      proxy_mode = 'managed'
      and (
        (selected_proxy_isp is null and proxy_diversity_status = 'pending')
        or (selected_proxy_isp is not null and proxy_diversity_status in ('unique', 'reused'))
      )
    )
    or (
      proxy_mode = 'preconfigured'
      and selected_proxy_isp is null
      and proxy_diversity_status = 'unknown'
    )
  );

create or replace function public.stakeout_validate_device_cycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_program_duration smallint;
  v_program_status text;
  v_client_status text;
  v_phone_client_id uuid;
  v_phone_enabled boolean;
  v_phone_expired_at timestamptz;
  v_predecessor_organization_id uuid;
  v_predecessor_client_id uuid;
  v_predecessor_status text;
  v_predecessor_ends_on date;
  v_local_today date;
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names as zone
    where zone.name = new.timezone
  ) then
    raise exception using errcode = '22023', message = 'Device cycle timezone is invalid';
  end if;

  select program.duration_days, program.status
  into v_program_duration, v_program_status
  from public.cycle_programs as program
  where program.id = new.program_id
    and program.organization_id = new.organization_id
    and program.connection_id = new.connection_id
  for share;
  if not found then
    raise exception using errcode = '23503', message = 'Device cycle program not found';
  end if;
  if new.duration_days <> v_program_duration then
    raise exception using errcode = '23514', message = 'Device cycle duration must match its program';
  end if;

  select client.status
  into v_client_status
  from public.clients as client
  where client.id = new.client_id
    and client.organization_id = new.organization_id
  for share;
  if not found then
    raise exception using errcode = '23514', message = 'Device cycle client organization mismatch';
  end if;

  select phone.client_id, phone.enabled, phone.expired_at
  into v_phone_client_id, v_phone_enabled, v_phone_expired_at
  from public.duo_phones as phone
  where phone.id = new.phone_id
    and phone.organization_id = new.organization_id
    and phone.connection_id = new.connection_id
  for share;
  if not found then
    raise exception using errcode = '23503', message = 'Device cycle phone not found';
  end if;
  if v_phone_client_id is null or v_phone_client_id <> new.client_id then
    raise exception using errcode = '23514', message = 'Device cycle phone must be dedicated to the same client';
  end if;

  if new.predecessor_cycle_id is not null then
    if new.predecessor_cycle_id = new.id then
      raise exception using errcode = '23514', message = 'A device cycle cannot be its own predecessor';
    end if;
    select predecessor.organization_id, predecessor.client_id,
           predecessor.status, predecessor.ends_on
    into v_predecessor_organization_id, v_predecessor_client_id,
         v_predecessor_status, v_predecessor_ends_on
    from public.device_cycles as predecessor
    where predecessor.id = new.predecessor_cycle_id
    for share;
    if not found then
      raise exception using errcode = '23503', message = 'Predecessor device cycle not found';
    end if;
    if v_predecessor_organization_id <> new.organization_id
       or v_predecessor_client_id <> new.client_id then
      raise exception using errcode = '23514', message = 'Predecessor cycle tenant or client mismatch';
    end if;
    if v_predecessor_status not in ('completed', 'cancelled')
       or v_predecessor_ends_on >= new.starts_on then
      raise exception using errcode = '23514', message = 'Predecessor cycle must be closed before the new cycle starts';
    end if;
  end if;

  if tg_op = 'INSERT' and new.status not in ('provisioning', 'blocked') then
    raise exception using errcode = '23514', message = 'New device cycles must start in provisioning or blocked state';
  end if;
  if tg_op = 'UPDATE' then
    if (old.status = 'provisioning' and new.status not in ('provisioning', 'blocked', 'active', 'cancelled'))
       or (old.status = 'blocked' and new.status not in ('blocked', 'active', 'cancelled'))
       or (old.status = 'active' and new.status not in ('active', 'paused', 'blocked', 'completed', 'cancelled'))
       or (old.status = 'paused' and new.status not in ('paused', 'active', 'blocked', 'completed', 'cancelled'))
       or (old.status in ('completed', 'cancelled') and new.status <> old.status) then
      raise exception using errcode = '23514', message = 'Invalid device cycle status transition';
    end if;

    if old.activated_at is not null and (
      new.organization_id is distinct from old.organization_id
      or new.client_id is distinct from old.client_id
      or new.connection_id is distinct from old.connection_id
      or new.program_id is distinct from old.program_id
      or new.phone_id is distinct from old.phone_id
      or new.starts_on is distinct from old.starts_on
      or new.ends_on is distinct from old.ends_on
      or new.duration_days is distinct from old.duration_days
      or new.timezone is distinct from old.timezone
      or new.proxy_mode is distinct from old.proxy_mode
      or new.target_country is distinct from old.target_country
      or new.target_region is distinct from old.target_region
      or new.target_city is distinct from old.target_city
      or new.target_latitude is distinct from old.target_latitude
      or new.target_longitude is distinct from old.target_longitude
      or new.selected_proxy_isp is distinct from old.selected_proxy_isp
      or new.proxy_diversity_status is distinct from old.proxy_diversity_status
    ) then
      raise exception using errcode = '23514', message = 'Activated device cycle identity and location are immutable';
    end if;
  end if;

  if new.status = 'active' then
    v_local_today := (clock_timestamp() at time zone new.timezone)::date;
    if v_program_status <> 'published' then
      raise exception using errcode = '23514', message = 'Active device cycles require a published program';
    end if;
    if v_client_status <> 'active' then
      raise exception using errcode = '23514', message = 'Active device cycles require an active client';
    end if;
    if not v_phone_enabled
       or (v_phone_expired_at is not null and v_phone_expired_at <= clock_timestamp()) then
      raise exception using errcode = '23514', message = 'Active device cycles require an enabled, unexpired phone';
    end if;
    if new.starts_on < v_local_today
       and (tg_op = 'INSERT' or old.activated_at is null) then
      raise exception using errcode = '23514', message = 'A device cycle cannot be activated after its local start date';
    end if;
    if new.proxy_mode = 'managed' then
      if new.selected_proxy_isp is null then
        raise exception using errcode = '23514', message = 'Managed device cycles require an atomically reserved proxy ISP';
      end if;
      if not exists (
        select 1
        from public.phone_proxy_bindings as binding
        where binding.organization_id = new.organization_id
          and binding.connection_id = new.connection_id
          and binding.client_id = new.client_id
          and binding.phone_id = new.phone_id
          and binding.device_cycle_id = new.id
          and binding.released_at is null
          and binding.duoplus_proxy_id is not null
          and lower(binding.configured_isp) = lower(new.selected_proxy_isp)
          and binding.health in ('unverified', 'aligned', 'nearby')
      ) then
        raise exception using errcode = '23514', message = 'Managed device cycles require a matching provisioned proxy binding';
      end if;
    elsif exists (
      select 1
      from public.phone_proxy_bindings as binding
      where binding.device_cycle_id = new.id
        and binding.organization_id = new.organization_id
        and binding.released_at is null
    ) then
      raise exception using errcode = '23514', message = 'Preconfigured proxy cycles cannot claim a managed proxy binding';
    end if;
  end if;

  if new.status = 'completed' and exists (
    select 1 from public.scheduler_runs as run
    where run.device_cycle_id = new.id
      and run.status not in ('succeeded', 'failed', 'cancelled')
  ) then
    raise exception using errcode = '23514', message = 'A device cycle with open runs cannot be completed';
  end if;

  -- Keep the parent state and compiled scheduler state consistent. Existing
  -- remote tasks remain cancellable by the worker; new submissions are fenced
  -- by the inactive cycle and disabled schedules.
  if tg_op = 'UPDATE' and old.status = 'active' and new.status <> 'active' then
    update public.scheduler_schedules
    set enabled = false
    where device_cycle_id = new.id
      and source_kind = 'device_cycle'
      and enabled;
  end if;

  return new;
end;
$function$;

create or replace function public.stakeout_validate_phone_proxy_binding()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_cycle public.device_cycles%rowtype;
  v_list public.proxy_lists%rowtype;
begin
  select * into v_cycle
  from public.device_cycles as cycle
  where cycle.id = new.device_cycle_id
    and cycle.organization_id = new.organization_id
    and cycle.connection_id = new.connection_id
  for share;
  if not found then
    raise exception using errcode = '23503', message = 'Proxy binding device cycle not found';
  end if;
  if new.client_id <> v_cycle.client_id or new.phone_id <> v_cycle.phone_id then
    raise exception using errcode = '23514', message = 'Proxy binding client or phone does not match its device cycle';
  end if;
  if new.released_at is null and v_cycle.proxy_mode <> 'managed' then
    raise exception using errcode = '23514', message = 'Preconfigured proxy cycles cannot claim a managed proxy binding';
  end if;

  select * into v_list
  from public.proxy_lists as list
  where list.id = new.proxy_list_id
    and list.organization_id = new.organization_id
  for share;
  if not found then
    raise exception using errcode = '23503', message = 'Proxy binding list not found';
  end if;
  if new.released_at is null and not v_list.enabled then
    raise exception using errcode = '23514', message = 'An active proxy binding requires an enabled proxy list';
  end if;
  if lower(btrim(new.configured_country)) <> lower(btrim(v_list.country))
     or lower(btrim(new.configured_region)) <> lower(btrim(v_list.region))
     or lower(btrim(new.configured_city)) <> lower(btrim(v_list.city))
     or lower(btrim(new.configured_isp)) <> lower(btrim(v_list.isp)) then
    raise exception using errcode = '23514', message = 'Proxy binding GEO or ISP does not match its proxy list';
  end if;
  if lower(btrim(new.configured_country)) <> lower(btrim(v_cycle.target_country))
     or lower(btrim(new.configured_region)) <> lower(btrim(v_cycle.target_region))
     or lower(btrim(new.configured_city)) <> lower(btrim(v_cycle.target_city)) then
    raise exception using errcode = '23514', message = 'Proxy binding GEO must exactly match the device cycle target city';
  end if;
  if new.target_latitude is distinct from v_cycle.target_latitude
     or new.target_longitude is distinct from v_cycle.target_longitude then
    raise exception using errcode = '23514', message = 'Proxy binding target coordinates do not match its device cycle';
  end if;

  if new.released_at is not null and v_cycle.status in ('active', 'paused') then
    raise exception using errcode = '23514', message = 'An active or paused device cycle must be stopped before releasing its proxy binding';
  end if;
  if tg_op = 'UPDATE' then
    if v_cycle.status in ('active', 'paused')
       and old.released_at is null
       and (
         new.organization_id is distinct from old.organization_id
         or new.client_id is distinct from old.client_id
         or new.connection_id is distinct from old.connection_id
         or new.phone_id is distinct from old.phone_id
         or new.device_cycle_id is distinct from old.device_cycle_id
         or new.proxy_list_id is distinct from old.proxy_list_id
         or new.duoplus_proxy_id is distinct from old.duoplus_proxy_id
         or new.gateway_host is distinct from old.gateway_host
         or new.gateway_port is distinct from old.gateway_port
         or new.configured_country is distinct from old.configured_country
         or new.configured_region is distinct from old.configured_region
         or new.configured_city is distinct from old.configured_city
         or new.configured_isp is distinct from old.configured_isp
       ) then
      raise exception using errcode = '23514', message = 'Active cycle proxy assignments are immutable';
    end if;
  end if;

  if new.released_at is null then
    if v_cycle.status not in ('provisioning', 'active', 'paused', 'blocked') then
      raise exception using errcode = '23514', message = 'A closed device cycle cannot receive an active proxy binding';
    end if;
    if new.duoplus_proxy_id is null then
      raise exception using errcode = '23514', message = 'An active proxy binding requires a DuoPlus proxy id';
    end if;
    if v_cycle.selected_proxy_isp is null
       or lower(btrim(new.configured_isp)) <> lower(btrim(v_cycle.selected_proxy_isp))
       or new.diversity_status <> v_cycle.proxy_diversity_status then
      raise exception using errcode = '23514', message = 'Proxy binding does not match the cycle ISP reservation';
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.reserve_cycle_proxy_isp(
  p_organization_id uuid,
  p_cycle_id uuid,
  p_candidate_isps text[]
)
returns table (
  selected_isp text,
  diversity_status text
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_cycle public.device_cycles%rowtype;
  v_selected_isp text;
  v_usage_count bigint;
  v_diversity_status text;
begin
  if p_organization_id is null or p_cycle_id is null then
    raise exception using errcode = '22004', message = 'Organization and cycle are required';
  end if;
  if p_candidate_isps is null
     or cardinality(p_candidate_isps) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Between 1 and 500 candidate ISPs are required';
  end if;

  -- Read once to identify the shared client lock, then re-read the cycle under
  -- lock. Every reservation for this client's cycles serializes on this row.
  select * into v_cycle
  from public.device_cycles as cycle
  where cycle.id = p_cycle_id
    and cycle.organization_id = p_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Device cycle not found';
  end if;

  perform 1
  from public.clients as client
  where client.id = v_cycle.client_id
    and client.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'Device cycle client not found';
  end if;

  select * into v_cycle
  from public.device_cycles as cycle
  where cycle.id = p_cycle_id
    and cycle.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Device cycle not found';
  end if;

  if v_cycle.proxy_mode <> 'managed' then
    raise exception using errcode = '23514', message = 'ISP reservation is only valid for managed proxy cycles';
  end if;
  if v_cycle.selected_proxy_isp is not null then
    return query
    select v_cycle.selected_proxy_isp, v_cycle.proxy_diversity_status;
    return;
  end if;
  if v_cycle.status not in ('provisioning', 'blocked')
     or v_cycle.activated_at is not null then
    raise exception using errcode = '23514', message = 'Proxy ISP must be reserved before cycle activation';
  end if;

  with normalized_candidates as (
    select lower(btrim(candidate.value)) as normalized_isp,
           (array_agg(btrim(candidate.value) order by candidate.ordinality))[1] as display_isp,
           min(candidate.ordinality) as preference
    from unnest(p_candidate_isps) with ordinality as candidate(value, ordinality)
    where nullif(btrim(candidate.value), '') is not null
      and char_length(btrim(candidate.value)) <= 180
    group by lower(btrim(candidate.value))
  ), ranked_candidates as (
    select candidate.display_isp,
           candidate.preference,
           count(sibling.id) as usage_count
    from normalized_candidates as candidate
    left join public.device_cycles as sibling
      on sibling.organization_id = v_cycle.organization_id
     and sibling.client_id = v_cycle.client_id
     and sibling.id <> v_cycle.id
     and sibling.status in ('provisioning', 'active', 'paused', 'blocked')
     and lower(btrim(sibling.target_country)) = lower(btrim(v_cycle.target_country))
     and lower(btrim(sibling.target_region)) = lower(btrim(v_cycle.target_region))
     and lower(btrim(sibling.target_city)) = lower(btrim(v_cycle.target_city))
     and lower(btrim(sibling.selected_proxy_isp)) = candidate.normalized_isp
    group by candidate.display_isp, candidate.preference
    order by count(sibling.id), candidate.preference, lower(candidate.display_isp)
    limit 1
  )
  select candidate.display_isp, candidate.usage_count
  into v_selected_isp, v_usage_count
  from ranked_candidates as candidate;

  if v_selected_isp is null then
    raise exception using errcode = '22023', message = 'Candidate ISP list contains no usable values';
  end if;
  v_diversity_status := case when v_usage_count = 0 then 'unique' else 'reused' end;

  update public.device_cycles
  set selected_proxy_isp = v_selected_isp,
      proxy_diversity_status = v_diversity_status
  where id = v_cycle.id
    and organization_id = v_cycle.organization_id;

  return query select v_selected_isp, v_diversity_status;
end;
$function$;

create or replace function public.activate_device_cycle(
  p_organization_id uuid,
  p_cycle_id uuid
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_cycle public.device_cycles%rowtype;
  v_program public.cycle_programs%rowtype;
  v_rule public.cycle_program_rules%rowtype;
  v_schedule_id uuid;
  v_run_id uuid;
  v_day integer;
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_materialized integer := 0;
begin
  select * into v_cycle
  from public.device_cycles
  where id = p_cycle_id and organization_id = p_organization_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Device cycle not found';
  end if;
  if v_cycle.status not in ('provisioning', 'blocked') then
    raise exception using errcode = '22023', message = 'Only a provisioning or blocked cycle can be activated';
  end if;
  if v_cycle.proxy_mode = 'managed' and not exists (
    select 1 from public.phone_proxy_bindings as binding
    where binding.device_cycle_id = v_cycle.id
      and binding.organization_id = v_cycle.organization_id
      and binding.connection_id = v_cycle.connection_id
      and binding.client_id = v_cycle.client_id
      and binding.phone_id = v_cycle.phone_id
      and binding.released_at is null
      and binding.duoplus_proxy_id is not null
      and lower(binding.configured_isp) = lower(v_cycle.selected_proxy_isp)
      and binding.health in ('unverified', 'aligned', 'nearby')
  ) then
    raise exception using errcode = '23514', message = 'Managed cycle requires a provisioned phone proxy binding';
  end if;
  if v_cycle.proxy_mode = 'preconfigured' and exists (
    select 1 from public.phone_proxy_bindings as binding
    where binding.device_cycle_id = v_cycle.id
      and binding.organization_id = v_cycle.organization_id
      and binding.released_at is null
  ) then
    raise exception using errcode = '23514', message = 'Preconfigured proxy cycle cannot claim a managed proxy binding';
  end if;

  select * into v_program
  from public.cycle_programs
  where id = v_cycle.program_id
    and organization_id = v_cycle.organization_id
    and connection_id = v_cycle.connection_id
    and status = 'published'
  for share;
  if not found then
    raise exception using errcode = '23514', message = 'Cycle program is not published';
  end if;

  -- Mark active inside the same transaction before inserting cycle-backed
  -- schedules/runs. Any later failure rolls this transition back atomically.
  update public.device_cycles
  set status = 'active',
      activated_at = coalesce(activated_at, clock_timestamp()),
      completed_at = null,
      last_error = null
  where id = v_cycle.id;

  for v_rule in
    select * from public.cycle_program_rules
    where program_id = v_program.id
    order by sequence
  loop
    v_schedule_id := gen_random_uuid();
    v_start_at := ((v_cycle.starts_on + (v_rule.start_day - 1)) + v_rule.local_time)
      at time zone v_cycle.timezone;
    v_end_at := ((v_cycle.starts_on + (v_rule.end_day - 1)) + v_rule.local_time)
      at time zone v_cycle.timezone;

    insert into public.scheduler_schedules (
      id, organization_id, client_id, connection_id, phone_id, template_id,
      name, keyword, config, cron_expression, timezone, next_run_at, enabled,
      gps_latitude, gps_longitude, gps_mode, locale_timezone,
      max_attempts, expected_duration_seconds, created_by, source_kind,
      device_cycle_id, program_rule_id, active_from, active_through
    ) values (
      v_schedule_id, v_cycle.organization_id, v_cycle.client_id,
      v_cycle.connection_id, v_cycle.phone_id, v_rule.template_id,
      left(v_cycle.name || ' — ' || v_rule.name, 180), v_cycle.keyword,
      v_rule.config,
      extract(minute from v_rule.local_time)::integer || ' ' ||
        extract(hour from v_rule.local_time)::integer || ' * * *',
      v_cycle.timezone,
      '9999-12-31 00:00:00+00'::timestamptz,
      true,
      case when v_cycle.proxy_mode = 'managed' then v_cycle.target_latitude else null end,
      case when v_cycle.proxy_mode = 'managed' then v_cycle.target_longitude else null end,
      case
        when v_cycle.proxy_mode = 'preconfigured' then 0
        when v_cycle.target_latitude is null then 1
        else 2
      end,
      case when v_cycle.proxy_mode = 'managed' then v_cycle.timezone else null end,
      v_rule.max_attempts, v_rule.expected_duration_seconds,
      v_cycle.created_by, 'device_cycle', v_cycle.id, v_rule.id,
      v_start_at, v_end_at
    );

    if v_rule.rule_kind = 'window_once' then
      v_run_id := gen_random_uuid();
      insert into public.scheduler_runs (
        id, organization_id, client_id, connection_id, schedule_id, phone_id,
        template_id, scheduled_for, issue_at, expected_duration_seconds,
        status, stage, next_action_at, attempt_count, max_attempts, task_name,
        device_cycle_id, program_rule_id, cycle_day, occurrence_key,
        window_start_at, window_end_at
      ) values (
        v_run_id, v_cycle.organization_id, v_cycle.client_id,
        v_cycle.connection_id, v_schedule_id, v_cycle.phone_id,
        v_rule.template_id, v_start_at, v_start_at,
        v_rule.expected_duration_seconds, 'pending', 'pending', clock_timestamp(),
        0, v_rule.max_attempts, 'stk_' || v_run_id::text,
        v_cycle.id, v_rule.id, v_rule.start_day,
        'window:' || v_rule.start_day || '-' || v_rule.end_day,
        v_start_at,
        ((v_cycle.starts_on + v_rule.end_day)::timestamp at time zone v_cycle.timezone)
      );
      v_materialized := v_materialized + 1;
    else
      for v_day in v_rule.start_day..least(v_rule.end_day, v_cycle.duration_days)
      loop
        v_start_at := ((v_cycle.starts_on + (v_day - 1)) + v_rule.local_time)
          at time zone v_cycle.timezone;
        v_run_id := gen_random_uuid();
        insert into public.scheduler_runs (
          id, organization_id, client_id, connection_id, schedule_id, phone_id,
          template_id, scheduled_for, issue_at, expected_duration_seconds,
          status, stage, next_action_at, attempt_count, max_attempts, task_name,
          device_cycle_id, program_rule_id, cycle_day, occurrence_key,
          window_start_at, window_end_at
        ) values (
          v_run_id, v_cycle.organization_id, v_cycle.client_id,
          v_cycle.connection_id, v_schedule_id, v_cycle.phone_id,
          v_rule.template_id, v_start_at, v_start_at,
          v_rule.expected_duration_seconds, 'pending', 'pending', clock_timestamp(),
          0, v_rule.max_attempts, 'stk_' || v_run_id::text,
          v_cycle.id, v_rule.id, v_day, 'day:' || v_day,
          v_start_at,
          ((v_cycle.starts_on + v_day)::timestamp at time zone v_cycle.timezone)
        );
        v_materialized := v_materialized + 1;
      end loop;
    end if;
  end loop;

  update public.device_cycles
  set last_error = null
  where id = v_cycle.id;

  return v_materialized;
end;
$function$;

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

  v_existing_task := v_run.duoplus_task_id is not null
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
     or not v_phone.enabled
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
     or (v_phone.expired_at is not null and v_phone.expired_at <= clock_timestamp())
     or (v_phone.lease_expires_at is not null and v_phone.lease_expires_at > clock_timestamp())
     or (v_phone.busy_until is not null and v_phone.busy_until > clock_timestamp()) then
    return false;
  end if;

  -- Lock the connection row so concurrent acquisitions cannot both consume
  -- the same final Subscription Startup slot.
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
       or v_subscription_synced_at < clock_timestamp() - interval '24 hours'
       or v_subscription_synced_at > clock_timestamp() + interval '5 minutes' then
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

create or replace function public.authorize_run_submission(
  p_run_id uuid,
  p_worker_id text
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
  set stage = 'submit_task'
  from public.scheduler_schedules as schedule,
       public.duo_phones as phone
  where run.id = p_run_id
    and schedule.id = run.schedule_id
    and phone.id = run.phone_id
    and schedule.enabled
    and not run.cancellation_requested
    and run.status = 'preparing'
    and run.duoplus_task_id is null
    and run.lease_owner = btrim(p_worker_id)
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
    );

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

comment on column public.device_cycles.proxy_mode is
  'preconfigured means the phone proxy is externally managed and never inspected or changed; managed retains the strict binding path for a future gated release.';
comment on column public.device_cycles.proxy_diversity_status is
  'unknown is mandatory for preconfigured phone proxies because Stakeout does not inspect or verify their ISP.';

