-- Device-cycle programs and Proxy-Seller alignment.
--
-- Cycle rules compile into the existing scheduler tables so DuoPlus dispatch,
-- cancellation, leases, status reconciliation, and proof capture keep one
-- execution path. Proxy credentials never enter Postgres; the server exchanges
-- them directly between Proxy-Seller and DuoPlus during provisioning.

create table public.cycle_programs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  duration_days smallint not null check (duration_days between 15 and 30),
  timezone text not null check (char_length(btrim(timezone)) between 1 and 80),
  version smallint not null default 1 check (version > 0),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'retired')),
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cycle_programs_connection_fk
    foreign key (organization_id, connection_id)
    references public.duo_connections (organization_id, id) on delete restrict,
  constraint cycle_programs_org_connection_id_unique
    unique (organization_id, connection_id, id),
  constraint cycle_programs_org_name_version_unique
    unique (organization_id, name, version),
  constraint cycle_programs_publish_timestamp check (
    (status = 'draft' and published_at is null)
    or (status in ('published', 'retired') and published_at is not null)
  )
);

create index cycle_programs_org_status_idx
  on public.cycle_programs (organization_id, status, name);

create table public.cycle_program_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  program_id uuid not null,
  template_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  rule_kind text not null
    check (rule_kind in ('daily_range', 'day_range', 'window_once')),
  start_day smallint not null check (start_day between 1 and 30),
  end_day smallint not null check (end_day between 1 and 30),
  local_time time not null,
  sequence smallint not null check (sequence between 1 and 100),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  expected_duration_seconds integer not null default 600
    check (expected_duration_seconds between 30 and 21600),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 10),
  required boolean not null default true,
  created_at timestamptz not null default now(),
  constraint cycle_program_rules_program_fk
    foreign key (organization_id, connection_id, program_id)
    references public.cycle_programs (organization_id, connection_id, id) on delete cascade,
  constraint cycle_program_rules_template_fk
    foreign key (organization_id, connection_id, template_id)
    references public.duo_templates (organization_id, connection_id, id) on delete restrict,
  constraint cycle_program_rules_org_connection_id_unique
    unique (organization_id, connection_id, id),
  constraint cycle_program_rules_program_sequence_unique unique (program_id, sequence),
  constraint cycle_program_rules_day_order check (end_day >= start_day),
  constraint cycle_program_rules_window_range check (
    rule_kind <> 'window_once' or end_day > start_day
  )
);

create index cycle_program_rules_program_idx
  on public.cycle_program_rules (program_id, sequence);
create index cycle_program_rules_template_idx
  on public.cycle_program_rules (organization_id, connection_id, template_id);

create table public.device_cycles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  connection_id uuid not null,
  program_id uuid not null,
  phone_id uuid not null,
  predecessor_cycle_id uuid,
  name text not null check (char_length(btrim(name)) between 2 and 160),
  keyword text not null check (char_length(btrim(keyword)) between 1 and 500),
  profile_label text check (profile_label is null or char_length(profile_label) <= 160),
  starts_on date not null,
  ends_on date not null,
  duration_days smallint not null check (duration_days between 15 and 30),
  timezone text not null check (char_length(btrim(timezone)) between 1 and 80),
  status text not null default 'provisioning'
    check (status in ('provisioning', 'active', 'paused', 'blocked', 'completed', 'cancelled')),
  proxy_mode text not null default 'preconfigured'
    check (proxy_mode in ('managed', 'preconfigured')),
  target_country text not null check (target_country ~ '^[A-Z]{2}$'),
  target_region text not null check (char_length(btrim(target_region)) between 1 and 120),
  target_city text not null check (char_length(btrim(target_city)) between 1 and 120),
  target_latitude numeric(9,6) check (target_latitude between -90 and 90),
  target_longitude numeric(9,6) check (target_longitude between -180 and 180),
  selected_proxy_isp text check (
    selected_proxy_isp is null
    or char_length(btrim(selected_proxy_isp)) between 1 and 180
  ),
  proxy_diversity_status text not null default 'unknown'
    check (proxy_diversity_status in ('pending', 'unique', 'reused', 'unknown')),
  activated_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_cycles_connection_fk
    foreign key (organization_id, connection_id)
    references public.duo_connections (organization_id, id) on delete restrict,
  constraint device_cycles_program_fk
    foreign key (organization_id, connection_id, program_id)
    references public.cycle_programs (organization_id, connection_id, id) on delete restrict,
  constraint device_cycles_phone_fk
    foreign key (organization_id, connection_id, phone_id)
    references public.duo_phones (organization_id, connection_id, id) on delete restrict,
  constraint device_cycles_predecessor_fk
    foreign key (predecessor_cycle_id) references public.device_cycles(id) on delete restrict,
  constraint device_cycles_org_connection_id_unique
    unique (organization_id, connection_id, id),
  constraint device_cycles_date_span check (ends_on = starts_on + (duration_days - 1)),
  constraint device_cycles_coordinates_complete check (
    (target_latitude is null and target_longitude is null)
    or (target_latitude is not null and target_longitude is not null)
  ),
  constraint device_cycles_lifecycle_timestamps check (
    (status <> 'provisioning' or (activated_at is null and completed_at is null))
    and (status not in ('active', 'paused') or (activated_at is not null and completed_at is null))
    and (status <> 'completed' or (activated_at is not null and completed_at is not null))
    and (status not in ('blocked', 'cancelled') or completed_at is null)
  ),
  constraint device_cycles_proxy_selection_consistent check (
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
  )
);

create unique index device_cycles_one_open_per_phone_idx
  on public.device_cycles (phone_id)
  where status in ('provisioning', 'active', 'paused', 'blocked');
create index device_cycles_org_status_end_idx
  on public.device_cycles (organization_id, status, ends_on);
create index device_cycles_client_idx
  on public.device_cycles (organization_id, client_id, status);
create index device_cycles_program_idx
  on public.device_cycles (organization_id, connection_id, program_id);
create index device_cycles_predecessor_idx
  on public.device_cycles (predecessor_cycle_id)
  where predecessor_cycle_id is not null;

create table public.proxy_package_snapshots (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  is_active boolean not null default false,
  auto_renew boolean,
  expired_on date,
  traffic_limit_bytes numeric(30,0),
  traffic_used_bytes numeric(30,0),
  traffic_left_bytes numeric(30,0),
  synced_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  constraint proxy_package_traffic_nonnegative check (
    (traffic_limit_bytes is null or traffic_limit_bytes >= 0)
    and (traffic_used_bytes is null or traffic_used_bytes >= 0)
    and (traffic_left_bytes is null or traffic_left_bytes >= 0)
  )
);

create table public.proxy_lists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_list_id bigint not null,
  title text not null check (char_length(btrim(title)) between 1 and 180),
  login_hint text check (login_hint is null or char_length(login_hint) <= 32),
  country text not null check (country ~ '^[A-Z]{2}$'),
  region text not null check (char_length(btrim(region)) between 1 and 120),
  city text not null check (char_length(btrim(city)) between 1 and 120),
  isp text not null check (char_length(btrim(isp)) between 1 and 180),
  rotation_seconds integer not null default -1
    check (rotation_seconds = -1 or rotation_seconds between 0 and 3600),
  port_count integer not null default 1 check (port_count between 1 and 1000),
  enabled boolean not null default true,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proxy_lists_org_provider_unique unique (organization_id, provider_list_id),
  constraint proxy_lists_org_title_unique unique (organization_id, title),
  constraint proxy_lists_org_id_unique unique (organization_id, id)
);

create index proxy_lists_geo_isp_idx
  on public.proxy_lists (organization_id, country, region, city, isp)
  where enabled;

create table public.phone_proxy_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  connection_id uuid not null,
  phone_id uuid not null,
  device_cycle_id uuid not null,
  proxy_list_id uuid not null,
  duoplus_proxy_id text check (
    duoplus_proxy_id is null
    or char_length(btrim(duoplus_proxy_id)) between 1 and 128
  ),
  gateway_host text not null check (gateway_host in (
    'res.proxy-seller.com', 'us.res.proxy-seller.com',
    'asia.res.proxy-seller.com', 'asia2.res.proxy-seller.com'
  )),
  gateway_port integer not null default 10000 check (gateway_port between 10000 and 10999),
  configured_country text not null check (configured_country ~ '^[A-Z]{2}$'),
  configured_region text not null check (char_length(btrim(configured_region)) between 1 and 120),
  configured_city text not null check (char_length(btrim(configured_city)) between 1 and 120),
  configured_isp text not null check (char_length(btrim(configured_isp)) between 1 and 180),
  target_latitude numeric(9,6) check (target_latitude between -90 and 90),
  target_longitude numeric(9,6) check (target_longitude between -180 and 180),
  observed_ip_masked text,
  observed_country text,
  observed_region text,
  observed_city text,
  observed_isp text,
  observed_latitude numeric(9,6) check (observed_latitude between -90 and 90),
  observed_longitude numeric(9,6) check (observed_longitude between -180 and 180),
  distance_km numeric(10,2) check (distance_km is null or distance_km >= 0),
  diversity_status text not null default 'unique'
    check (diversity_status in ('unique', 'reused', 'unknown')),
  health text not null default 'unverified'
    check (health in ('unverified', 'aligned', 'nearby', 'mismatch', 'stale', 'error', 'released')),
  checked_at timestamptz,
  last_error text,
  bound_at timestamptz not null default now(),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phone_proxy_bindings_phone_fk
    foreign key (organization_id, connection_id, phone_id)
    references public.duo_phones (organization_id, connection_id, id) on delete restrict,
  constraint phone_proxy_bindings_cycle_fk
    foreign key (organization_id, connection_id, device_cycle_id)
    references public.device_cycles (organization_id, connection_id, id) on delete restrict,
  constraint phone_proxy_bindings_list_fk
    foreign key (organization_id, proxy_list_id)
    references public.proxy_lists (organization_id, id) on delete restrict,
  constraint phone_proxy_bindings_org_id_unique unique (organization_id, id),
  constraint phone_proxy_bindings_coordinates_complete check (
    (target_latitude is null and target_longitude is null)
    or (target_latitude is not null and target_longitude is not null)
  ),
  constraint phone_proxy_bindings_observed_coordinates_complete check (
    (observed_latitude is null and observed_longitude is null)
    or (observed_latitude is not null and observed_longitude is not null)
  ),
  constraint phone_proxy_bindings_release_consistent check (
    (released_at is null and health <> 'released')
    or (released_at is not null and health = 'released')
  )
);

create unique index phone_proxy_bindings_one_active_phone_idx
  on public.phone_proxy_bindings (phone_id)
  where released_at is null;
create unique index phone_proxy_bindings_one_active_port_idx
  on public.phone_proxy_bindings (proxy_list_id, gateway_port)
  where released_at is null;
create unique index phone_proxy_bindings_one_cycle_idx
  on public.phone_proxy_bindings (device_cycle_id)
  where released_at is null;
create unique index phone_proxy_bindings_one_active_duoplus_proxy_idx
  on public.phone_proxy_bindings (connection_id, duoplus_proxy_id)
  where released_at is null and duoplus_proxy_id is not null;
create index phone_proxy_bindings_org_health_idx
  on public.phone_proxy_bindings (organization_id, health, checked_at);
create index phone_proxy_bindings_client_isp_idx
  on public.phone_proxy_bindings (organization_id, client_id, configured_isp)
  where released_at is null;

alter table public.scheduler_schedules
  add column source_kind text not null default 'calendar'
    check (source_kind in ('calendar', 'device_cycle')),
  add column device_cycle_id uuid,
  add column program_rule_id uuid,
  add column active_from timestamptz,
  add column active_through timestamptz,
  add constraint scheduler_schedules_cycle_fk
    foreign key (organization_id, connection_id, device_cycle_id)
    references public.device_cycles (organization_id, connection_id, id) on delete restrict,
  add constraint scheduler_schedules_program_rule_fk
    foreign key (organization_id, connection_id, program_rule_id)
    references public.cycle_program_rules (organization_id, connection_id, id) on delete restrict,
  add constraint scheduler_schedules_cycle_fields_check check (
    (source_kind = 'calendar' and device_cycle_id is null and program_rule_id is null
        and active_from is null and active_through is null)
    or (source_kind = 'device_cycle' and device_cycle_id is not null and program_rule_id is not null
        and phone_id is not null and active_from is not null and active_through is not null)
  ),
  add constraint scheduler_schedules_active_window_check check (
    active_from is null or active_through >= active_from
  );

create unique index scheduler_schedules_cycle_rule_unique_idx
  on public.scheduler_schedules (device_cycle_id, program_rule_id)
  where source_kind = 'device_cycle';

alter table public.scheduler_runs
  add column device_cycle_id uuid,
  add column program_rule_id uuid,
  add column cycle_day smallint check (cycle_day is null or cycle_day between 1 and 30),
  add column occurrence_key text check (
    occurrence_key is null or char_length(occurrence_key) between 3 and 40
  ),
  add column window_start_at timestamptz,
  add column window_end_at timestamptz,
  add column submission_state text not null default 'never'
    check (submission_state in ('never', 'attempting', 'accepted', 'unknown')),
  add column submission_started_at timestamptz,
  add column submission_acknowledged_at timestamptz,
  add constraint scheduler_runs_cycle_fk
    foreign key (organization_id, connection_id, device_cycle_id)
    references public.device_cycles (organization_id, connection_id, id) on delete restrict,
  add constraint scheduler_runs_program_rule_fk
    foreign key (organization_id, connection_id, program_rule_id)
    references public.cycle_program_rules (organization_id, connection_id, id) on delete restrict,
  add constraint scheduler_runs_cycle_fields_check check (
    (device_cycle_id is null and program_rule_id is null and cycle_day is null
        and occurrence_key is null and window_start_at is null and window_end_at is null)
    or (device_cycle_id is not null and program_rule_id is not null
        and cycle_day is not null and occurrence_key is not null
        and window_start_at is not null and window_end_at is not null)
  ),
  add constraint scheduler_runs_window_order check (
    (window_start_at is null and window_end_at is null)
    or (window_start_at is not null and window_end_at is not null and window_end_at > window_start_at)
  ),
  add constraint scheduler_runs_submission_timestamps check (
    (submission_state = 'never' and submission_started_at is null and submission_acknowledged_at is null)
    or (submission_state in ('attempting', 'unknown') and submission_started_at is not null)
    or (submission_state = 'accepted' and submission_started_at is not null and submission_acknowledged_at is not null)
  );

create unique index scheduler_runs_cycle_occurrence_unique_idx
  on public.scheduler_runs (device_cycle_id, program_rule_id, occurrence_key)
  where device_cycle_id is not null;
create index scheduler_runs_cycle_day_idx
  on public.scheduler_runs (device_cycle_id, cycle_day, status);
create index scheduler_runs_window_deadline_idx
  on public.scheduler_runs (window_end_at, next_action_at)
  where status in ('pending', 'retry_wait', 'preparing');

-- Capacity snapshots are all-or-nothing. A partial snapshot could otherwise
-- make a stale or truncated inventory look like spare Startup capacity.
-- Older application versions could stamp synced_at after an incomplete probe;
-- clear any such partial snapshot so this migration is safe and dispatch stays
-- fail-closed until the next successful inventory refresh.
update public.duo_connections
set subscription_capacity = null,
    subscription_in_use = null,
    subscription_available = null,
    subscription_synced_at = null
where not (
  (
    subscription_capacity is null
    and subscription_in_use is null
    and subscription_available is null
    and subscription_synced_at is null
  )
  or (
    subscription_capacity is not null
    and subscription_in_use is not null
    and subscription_available is not null
    and subscription_synced_at is not null
    and subscription_in_use + subscription_available = subscription_capacity
  )
);

alter table public.duo_connections
  add constraint duo_connections_subscription_snapshot_complete check (
    (
      subscription_capacity is null
      and subscription_in_use is null
      and subscription_available is null
      and subscription_synced_at is null
    )
    or (
      subscription_capacity is not null
      and subscription_in_use is not null
      and subscription_available is not null
      and subscription_synced_at is not null
      and subscription_in_use + subscription_available = subscription_capacity
    )
  );

create or replace function public.stakeout_validate_cycle_program()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names as zone
    where zone.name = new.timezone
  ) then
    raise exception using errcode = '22023', message = 'Cycle program timezone is invalid';
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'retired' and new.status <> 'retired' then
      raise exception using errcode = '23514', message = 'A retired cycle program cannot be reopened';
    end if;
    if old.status = 'published' and new.status not in ('published', 'retired') then
      raise exception using errcode = '23514', message = 'A published cycle program cannot return to draft';
    end if;
    if old.status in ('published', 'retired') and (
      new.organization_id is distinct from old.organization_id
      or new.connection_id is distinct from old.connection_id
      or new.name is distinct from old.name
      or new.duration_days is distinct from old.duration_days
      or new.timezone is distinct from old.timezone
      or new.version is distinct from old.version
    ) then
      raise exception using errcode = '23514', message = 'Published cycle program definitions are immutable';
    end if;
  end if;

  if new.status = 'published' and not exists (
       select 1 from public.cycle_program_rules as rule
       where rule.program_id = new.id
         and rule.organization_id = new.organization_id
         and rule.connection_id = new.connection_id
     ) then
    raise exception using errcode = '23514', message = 'A published cycle program requires at least one rule';
  end if;
  if new.status = 'published' and new.published_at is null then
    new.published_at := statement_timestamp();
  end if;
  return new;
end;
$function$;

create or replace function public.stakeout_validate_cycle_program_rule()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_program_id uuid;
  v_program_duration smallint;
  v_program_status text;
begin
  select program.id, program.duration_days, program.status
  into v_program_id, v_program_duration, v_program_status
  from public.cycle_programs as program
  where program.id = case when tg_op = 'DELETE' then old.program_id else new.program_id end
    and program.organization_id = case when tg_op = 'DELETE' then old.organization_id else new.organization_id end
    and program.connection_id = case when tg_op = 'DELETE' then old.connection_id else new.connection_id end
  for share;

  if v_program_id is null and tg_op = 'DELETE' then
    -- The parent may already be invisible while ON DELETE CASCADE removes a
    -- draft program's rules in the same statement.
    return old;
  end if;
  if v_program_id is null then
    raise exception using errcode = '23503', message = 'Cycle program not found';
  end if;
  if v_program_status <> 'draft' then
    raise exception using errcode = '23514', message = 'Rules on a published or retired cycle program are immutable';
  end if;
  if tg_op <> 'DELETE' and new.end_day > v_program_duration then
    raise exception using errcode = '23514', message = 'Cycle rule extends beyond the program duration';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

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

create or replace function public.stakeout_validate_cycle_schedule()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_cycle public.device_cycles%rowtype;
  v_rule public.cycle_program_rules%rowtype;
  v_expected_from timestamptz;
  v_expected_through timestamptz;
begin
  if new.source_kind = 'calendar' then
    return new;
  end if;

  select * into v_cycle
  from public.device_cycles as cycle
  where cycle.id = new.device_cycle_id
    and cycle.organization_id = new.organization_id
    and cycle.connection_id = new.connection_id
  for share;
  if not found then
    raise exception using errcode = '23503', message = 'Cycle-backed schedule device cycle not found';
  end if;
  select * into v_rule
  from public.cycle_program_rules as rule
  where rule.id = new.program_rule_id
    and rule.organization_id = new.organization_id
    and rule.connection_id = new.connection_id
  for share;
  if not found then
    raise exception using errcode = '23503', message = 'Cycle-backed schedule rule not found';
  end if;
  if v_rule.program_id <> v_cycle.program_id
     or new.client_id <> v_cycle.client_id
     or new.phone_id is distinct from v_cycle.phone_id
     or new.template_id <> v_rule.template_id
     or new.timezone <> v_cycle.timezone then
    raise exception using errcode = '23514', message = 'Cycle-backed schedule does not match its cycle and rule';
  end if;
  if new.enabled and v_cycle.status <> 'active' then
    raise exception using errcode = '23514', message = 'Only an active device cycle may have enabled schedules';
  end if;

  v_expected_from := ((v_cycle.starts_on + (v_rule.start_day - 1)) + v_rule.local_time)
    at time zone v_cycle.timezone;
  v_expected_through := ((v_cycle.starts_on + (v_rule.end_day - 1)) + v_rule.local_time)
    at time zone v_cycle.timezone;
  if new.active_from is distinct from v_expected_from
     or new.active_through is distinct from v_expected_through then
    raise exception using errcode = '23514', message = 'Cycle-backed schedule active window does not match its rule';
  end if;
  return new;
end;
$function$;

create or replace function public.stakeout_validate_cycle_run()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_schedule public.scheduler_schedules%rowtype;
  v_cycle public.device_cycles%rowtype;
  v_rule public.cycle_program_rules%rowtype;
  v_expected_occurrence_key text;
  v_expected_window_start timestamptz;
  v_expected_window_end timestamptz;
begin
  select * into v_schedule
  from public.scheduler_schedules as schedule
  where schedule.id = new.schedule_id
    and schedule.organization_id = new.organization_id
    and schedule.connection_id = new.connection_id
  for share;
  if not found then
    raise exception using errcode = '23503', message = 'Scheduler run schedule not found';
  end if;

  if new.device_cycle_id is null then
    if v_schedule.source_kind <> 'calendar' then
      raise exception using errcode = '23514', message = 'Cycle-backed schedules require cycle-backed runs';
    end if;
    return new;
  end if;

  select * into v_cycle
  from public.device_cycles as cycle
  where cycle.id = new.device_cycle_id
    and cycle.organization_id = new.organization_id
    and cycle.connection_id = new.connection_id
  for share;
  select * into v_rule
  from public.cycle_program_rules as rule
  where rule.id = new.program_rule_id
    and rule.organization_id = new.organization_id
    and rule.connection_id = new.connection_id
  for share;
  if v_cycle.id is null or v_rule.id is null then
    raise exception using errcode = '23503', message = 'Cycle-backed run cycle or rule not found';
  end if;
  if tg_op = 'INSERT' and v_cycle.status <> 'active' then
    raise exception using errcode = '23514', message = 'New cycle runs require an active device cycle';
  end if;
  if v_schedule.source_kind <> 'device_cycle'
     or v_schedule.device_cycle_id <> v_cycle.id
     or v_schedule.program_rule_id <> v_rule.id
     or v_rule.program_id <> v_cycle.program_id
     or new.client_id <> v_cycle.client_id
     or new.phone_id is distinct from v_cycle.phone_id
     or new.template_id <> v_rule.template_id then
    raise exception using errcode = '23514', message = 'Cycle-backed run does not match its schedule, cycle, and rule';
  end if;
  if new.cycle_day < v_rule.start_day
     or new.cycle_day > v_rule.end_day
     or new.cycle_day > v_cycle.duration_days then
    raise exception using errcode = '23514', message = 'Cycle run day is outside its rule window';
  end if;

  v_expected_window_start := ((v_cycle.starts_on + (new.cycle_day - 1)) + v_rule.local_time)
    at time zone v_cycle.timezone;
  v_expected_window_end := ((v_cycle.starts_on + case
      when v_rule.rule_kind = 'window_once' then v_rule.end_day
      else new.cycle_day
    end)::timestamp) at time zone v_cycle.timezone;
  v_expected_occurrence_key := case
    when v_rule.rule_kind = 'window_once'
      then 'window:' || v_rule.start_day || '-' || v_rule.end_day
    else 'day:' || new.cycle_day
  end;
  if new.occurrence_key <> v_expected_occurrence_key
     or new.window_start_at is distinct from v_expected_window_start
     or new.window_end_at is distinct from v_expected_window_end
     or new.scheduled_for is distinct from v_expected_window_start then
    raise exception using errcode = '23514', message = 'Cycle run occurrence window is not canonical';
  end if;
  return new;
end;
$function$;

revoke all on function public.stakeout_validate_cycle_program() from public;
revoke all on function public.stakeout_validate_cycle_program_rule() from public;
revoke all on function public.stakeout_validate_device_cycle() from public;
revoke all on function public.stakeout_validate_phone_proxy_binding() from public;
revoke all on function public.stakeout_validate_cycle_schedule() from public;
revoke all on function public.stakeout_validate_cycle_run() from public;

create trigger stakeout_validate_cycle_program
before insert or update on public.cycle_programs
for each row execute function public.stakeout_validate_cycle_program();

create trigger stakeout_validate_cycle_program_rule
before insert or update or delete on public.cycle_program_rules
for each row execute function public.stakeout_validate_cycle_program_rule();

create trigger stakeout_validate_device_cycle
before insert or update on public.device_cycles
for each row execute function public.stakeout_validate_device_cycle();

create trigger stakeout_validate_phone_proxy_binding
before insert or update on public.phone_proxy_bindings
for each row execute function public.stakeout_validate_phone_proxy_binding();

create trigger stakeout_validate_cycle_schedule
before insert or update of organization_id, client_id, connection_id, phone_id,
  template_id, source_kind, device_cycle_id, program_rule_id, active_from,
  active_through, enabled, timezone
on public.scheduler_schedules
for each row execute function public.stakeout_validate_cycle_schedule();

create trigger stakeout_validate_cycle_run
before insert or update of organization_id, client_id, connection_id,
  schedule_id, phone_id, template_id, scheduled_for, device_cycle_id,
  program_rule_id, cycle_day, occurrence_key, window_start_at, window_end_at
on public.scheduler_runs
for each row execute function public.stakeout_validate_cycle_run();

create trigger stakeout_touch_cycle_programs
before update on public.cycle_programs
for each row execute function public.stakeout_set_updated_at();

create trigger stakeout_touch_device_cycles
before update on public.device_cycles
for each row execute function public.stakeout_set_updated_at();

create trigger stakeout_touch_proxy_package_snapshots
before update on public.proxy_package_snapshots
for each row execute function public.stakeout_set_updated_at();

create trigger stakeout_touch_proxy_lists
before update on public.proxy_lists
for each row execute function public.stakeout_set_updated_at();

create trigger stakeout_touch_phone_proxy_bindings
before update on public.phone_proxy_bindings
for each row execute function public.stakeout_set_updated_at();

alter table public.cycle_programs enable row level security;
alter table public.cycle_program_rules enable row level security;
alter table public.device_cycles enable row level security;
alter table public.proxy_package_snapshots enable row level security;
alter table public.proxy_lists enable row level security;
alter table public.phone_proxy_bindings enable row level security;

create policy stakeout_cycle_programs_read_member
on public.cycle_programs for select to authenticated
using (public.is_organization_member(organization_id));
create policy stakeout_cycle_program_rules_read_member
on public.cycle_program_rules for select to authenticated
using (public.is_organization_member(organization_id));
create policy stakeout_device_cycles_read_member
on public.device_cycles for select to authenticated
using (public.is_organization_member(organization_id));
create policy stakeout_proxy_package_read_member
on public.proxy_package_snapshots for select to authenticated
using (public.is_organization_member(organization_id));
create policy stakeout_proxy_lists_read_member
on public.proxy_lists for select to authenticated
using (public.is_organization_member(organization_id));
create policy stakeout_proxy_bindings_read_member
on public.phone_proxy_bindings for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.cycle_programs, public.cycle_program_rules,
  public.device_cycles, public.proxy_package_snapshots, public.proxy_lists,
  public.phone_proxy_bindings from anon, authenticated;

grant select on table public.cycle_programs, public.cycle_program_rules,
  public.device_cycles, public.proxy_package_snapshots, public.proxy_lists,
  public.phone_proxy_bindings to authenticated;

grant all on table public.cycle_programs, public.cycle_program_rules,
  public.device_cycles, public.proxy_package_snapshots, public.proxy_lists,
  public.phone_proxy_bindings to service_role;

create or replace function public.create_cycle_program(
  p_organization_id uuid,
  p_connection_id uuid,
  p_name text,
  p_duration_days integer,
  p_timezone text,
  p_rules jsonb,
  p_created_by uuid default null
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
  v_start_day integer;
  v_end_day integer;
  v_sequence integer;
begin
  if nullif(btrim(p_name), '') is null then
    raise exception using errcode = '22023', message = 'Program name is required';
  end if;
  if p_duration_days not between 15 and 30 then
    raise exception using errcode = '22023', message = 'Cycle duration must be between 15 and 30 days';
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
    raise exception using errcode = '22023', message = 'Program requires between 1 and 50 rules';
  end if;
  if not exists (
    select 1 from public.duo_connections
    where id = p_connection_id and organization_id = p_organization_id and status = 'active'
  ) then
    raise exception using errcode = '23514', message = 'An active DuoPlus connection is required';
  end if;

  insert into public.cycle_programs (
    id, organization_id, connection_id, name, duration_days, timezone,
    status, published_at, created_by
  ) values (
    v_program_id, p_organization_id, p_connection_id, btrim(p_name),
    p_duration_days, btrim(p_timezone), 'draft', null, p_created_by
  );

  for v_rule in select value from jsonb_array_elements(p_rules)
  loop
    if jsonb_typeof(v_rule) <> 'object' then
      raise exception using errcode = '22023', message = 'Every program rule must be an object';
    end if;
    v_template_id := (v_rule->>'templateId')::uuid;
    v_rule_kind := v_rule->>'ruleKind';
    v_start_day := (v_rule->>'startDay')::integer;
    v_end_day := (v_rule->>'endDay')::integer;
    v_sequence := (v_rule->>'sequence')::integer;

    if v_rule_kind not in ('daily_range', 'day_range', 'window_once')
       or v_start_day not between 1 and p_duration_days
       or v_end_day not between v_start_day and p_duration_days then
      raise exception using errcode = '22023', message = 'Program rule has an invalid day range or kind';
    end if;
    if v_rule_kind = 'window_once' and v_end_day = v_start_day then
      raise exception using errcode = '22023', message = 'A window-once rule requires at least two eligible days';
    end if;
    if not exists (
      select 1 from public.duo_templates
      where id = v_template_id and organization_id = p_organization_id
        and connection_id = p_connection_id and enabled
    ) then
      raise exception using errcode = '23514', message = 'Program rule references an unavailable DuoPlus template';
    end if;

    insert into public.cycle_program_rules (
      organization_id, connection_id, program_id, template_id, name,
      rule_kind, start_day, end_day, local_time, sequence, config,
      expected_duration_seconds, max_attempts, required
    ) values (
      p_organization_id, p_connection_id, v_program_id, v_template_id,
      left(coalesce(nullif(btrim(v_rule->>'name'), ''), 'Cycle task ' || v_sequence), 160),
      v_rule_kind, v_start_day, v_end_day, (v_rule->>'localTime')::time,
      v_sequence, coalesce(v_rule->'config', '{}'::jsonb),
      coalesce((v_rule->>'expectedDurationSeconds')::integer, 600),
      coalesce((v_rule->>'maxAttempts')::integer, 3),
      coalesce((v_rule->>'required')::boolean, true)
    );
  end loop;

  update public.cycle_programs
  set status = 'published', published_at = clock_timestamp()
  where id = v_program_id;

  return v_program_id;
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

-- Keep the final runtime mutex, but reject new dispatches when Subscription
-- Startup inventory is older than one day. Existing remote tasks remain
-- monitorable/cancellable even if the capacity snapshot becomes stale.
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

create or replace function public.get_device_cycle_run_counts(
  p_organization_id uuid
)
returns table (
  device_cycle_id uuid,
  total bigint,
  done bigint,
  running bigint,
  failed bigint,
  pending bigint
)
language sql
security invoker
set search_path = pg_catalog, public
stable
as $function$
  select cycle.id as device_cycle_id,
         count(run.id) as total,
         count(*) filter (where run.status in ('succeeded', 'cancelled')) as done,
         count(*) filter (where run.status in ('preparing', 'queued', 'running')) as running,
         count(*) filter (where run.status = 'failed') as failed,
         count(*) filter (where run.status in ('pending', 'retry_wait', 'paused')) as pending
  from public.device_cycles as cycle
  left join public.scheduler_runs as run
    on run.organization_id = cycle.organization_id
   and run.device_cycle_id = cycle.id
  where cycle.organization_id = p_organization_id
  group by cycle.id
$function$;

revoke all on function public.create_cycle_program(uuid, uuid, text, integer, text, jsonb, uuid)
  from public, anon, authenticated;
revoke all on function public.reserve_cycle_proxy_isp(uuid, uuid, text[])
  from public, anon, authenticated;
revoke all on function public.activate_device_cycle(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.acquire_phone_lease(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.authorize_run_submission(uuid, text)
  from public, anon, authenticated;
revoke all on function public.get_device_cycle_run_counts(uuid)
  from public, anon, authenticated;
grant execute on function public.create_cycle_program(uuid, uuid, text, integer, text, jsonb, uuid)
  to service_role;
grant execute on function public.reserve_cycle_proxy_isp(uuid, uuid, text[])
  to service_role;
grant execute on function public.activate_device_cycle(uuid, uuid)
  to service_role;
grant execute on function public.acquire_phone_lease(uuid, uuid, integer)
  to service_role;
grant execute on function public.authorize_run_submission(uuid, text)
  to service_role;
grant execute on function public.get_device_cycle_run_counts(uuid)
  to service_role;

comment on table public.cycle_programs is
  'Published relative-day programs compiled into the existing durable scheduler.';
comment on column public.cycle_program_rules.rule_kind is
  'daily_range/day_range run once per eligible day; window_once is one logical run across the full window.';
comment on table public.phone_proxy_bindings is
  'Credential-free, stable phone-to-proxy assignment. Observed fields require an independent egress check.';
comment on column public.phone_proxy_bindings.health is
  'unverified means configured GEO only; aligned/nearby require observed egress evidence.';
comment on column public.scheduler_runs.submission_state is
  'Prevents automatic duplicate addTask calls after an ambiguous network response.';
comment on function public.reserve_cycle_proxy_isp(uuid, uuid, text[]) is
  'Serializes per-client ISP selection and chooses the least-used candidate for the exact target city.';
comment on function public.get_device_cycle_run_counts(uuid) is
  'Service-only cycle progress aggregate; done includes succeeded and cancelled runs, while paused runs remain pending.';
comment on function public.acquire_phone_lease(uuid, uuid, integer) is
  'Atomically leases a phone; new dispatch fails closed when Subscription Startup inventory is missing, stale, or full.';
