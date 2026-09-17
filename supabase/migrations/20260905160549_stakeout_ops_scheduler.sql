-- Stakeout Ops: multi-tenant DuoPlus scheduler foundation.
--
-- Secrets are encrypted in the application with AES-256-GCM before insert.
-- The authenticated role intentionally has no column privileges for the three
-- encrypted credential columns. Server-side code uses the service_role key.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- A fresh Supabase project has no Stakeout tenancy tables, while the existing
-- Stakeout project already owns them. Bootstrap only the all-absent case. A
-- partial or incompatible schema fails clearly; an existing compatible schema
-- is never altered, re-granted, or given replacement policies.
do $base_tenancy$
declare
  v_existing_count integer;
begin
  v_existing_count :=
    (to_regclass('public.organizations') is not null)::integer
    + (to_regclass('public.organization_members') is not null)::integer
    + (to_regclass('public.clients') is not null)::integer;

  if v_existing_count not in (0, 3) then
    raise exception 'Stakeout tenancy bootstrap requires organizations, organization_members, and clients to be either all present or all absent';
  end if;

  if v_existing_count = 0 then
    execute $ddl$
      create table public.organizations (
        id uuid primary key default gen_random_uuid(),
        name text not null check (char_length(name) between 2 and 80),
        slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
        owner_user_id uuid not null references auth.users(id) on delete restrict,
        plan_key text check (plan_key in ('starter', 'growth', 'agency')),
        subscription_status text not null default 'inactive' check (
          subscription_status in (
            'inactive', 'trialing', 'active', 'past_due', 'unpaid',
            'paused', 'canceled', 'incomplete'
          )
        ),
        stripe_customer_id text unique,
        current_period_end timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table public.organization_members (
        organization_id uuid not null references public.organizations(id) on delete cascade,
        user_id uuid not null references auth.users(id) on delete cascade,
        role text not null check (role in ('owner', 'admin', 'analyst', 'viewer')),
        created_at timestamptz not null default now(),
        primary key (organization_id, user_id)
      );

      create index organization_members_user_id_idx
        on public.organization_members (user_id, organization_id);

      create table public.clients (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id) on delete cascade,
        name text not null check (char_length(name) between 2 and 120),
        brand_name text not null,
        domain text not null,
        logo_url text,
        accent_color text not null default '#f2b93b',
        timezone text not null default 'America/New_York',
        status text not null default 'active' check (status in ('active', 'paused', 'archived')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary_color text not null default '#39bda7'
      );

      create index clients_organization_status_idx
        on public.clients (organization_id, status, name);

      create or replace function public.stakeout_bootstrap_set_updated_at()
      returns trigger
      language plpgsql
      security invoker
      set search_path = pg_catalog, public
      as $function$
      begin
        new.updated_at := statement_timestamp();
        return new;
      end;
      $function$;

      revoke all on function public.stakeout_bootstrap_set_updated_at() from public;

      create trigger stakeout_bootstrap_touch_organizations
      before update on public.organizations
      for each row execute function public.stakeout_bootstrap_set_updated_at();

      create trigger stakeout_bootstrap_touch_clients
      before update on public.clients
      for each row execute function public.stakeout_bootstrap_set_updated_at();

      alter table public.organizations enable row level security;
      alter table public.organization_members enable row level security;
      alter table public.clients enable row level security;

      create policy "members can read their organizations"
      on public.organizations for select to authenticated
      using (
        owner_user_id = (select auth.uid())
        or id in (
          select membership.organization_id
          from public.organization_members as membership
          where membership.user_id = (select auth.uid())
        )
      );

      create policy "users can read their own memberships"
      on public.organization_members for select to authenticated
      using (user_id = (select auth.uid()));

      create policy "tenant access clients"
      on public.clients for select to authenticated
      using (
        organization_id in (
          select membership.organization_id
          from public.organization_members as membership
          where membership.user_id = (select auth.uid())
        )
      );

      revoke all on table public.organizations, public.organization_members, public.clients
        from anon, authenticated;
      grant select on table public.organizations, public.organization_members to authenticated;
      grant select on table public.clients to authenticated;
      grant all on table public.organizations, public.organization_members, public.clients
        to service_role;
    $ddl$;
  end if;

  if exists (
    select 1
    from (
      values
        ('organizations', 'id'),
        ('organizations', 'name'),
        ('organizations', 'slug'),
        ('organizations', 'owner_user_id'),
        ('organizations', 'created_at'),
        ('organizations', 'updated_at'),
        ('organization_members', 'organization_id'),
        ('organization_members', 'user_id'),
        ('organization_members', 'role'),
        ('organization_members', 'created_at'),
        ('clients', 'id'),
        ('clients', 'organization_id'),
        ('clients', 'name'),
        ('clients', 'brand_name'),
        ('clients', 'domain'),
        ('clients', 'status'),
        ('clients', 'created_at'),
        ('clients', 'updated_at')
    ) as required(table_name, column_name)
    left join information_schema.columns as actual
      on actual.table_schema = 'public'
     and actual.table_name = required.table_name
     and actual.column_name = required.column_name
    where actual.column_name is null
  ) then
    raise exception 'Stakeout base tables are missing required tenancy columns';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as index_definition
    where index_definition.indrelid = 'public.organization_members'::regclass
      and index_definition.indisunique
      and index_definition.indnkeyatts = 2
      and (
        select count(*)
        from unnest(index_definition.indkey) as indexed(attnum)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = index_definition.indrelid
         and attribute.attnum = indexed.attnum
        where attribute.attname in ('organization_id', 'user_id')
      ) = 2
  ) then
    raise exception 'organization_members requires a unique key on (organization_id, user_id)';
  end if;
end;
$base_tenancy$;

create or replace function public.stakeout_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  new.updated_at := statement_timestamp();
  return new;
end;
$function$;

revoke all on function public.stakeout_set_updated_at() from public;

create table if not exists public.duo_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null default 'DuoPlus' check (char_length(btrim(name)) between 1 and 80),
  is_default boolean not null default false,
  base_url text not null default 'https://openapi.duoplus.net'
    check (base_url in ('https://openapi.duoplus.net', 'https://openapi.duoplus.net/')),
  issue_timezone text not null default 'UTC'
    check (char_length(btrim(issue_timezone)) between 1 and 80),
  api_key_ciphertext text,
  api_key_iv text,
  api_key_auth_tag text,
  key_version smallint not null default 1 check (key_version > 0),
  key_hint text check (key_hint is null or char_length(key_hint) <= 24),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'invalid', 'disconnected', 'error')),
  min_gap_ms integer not null default 1200 check (min_gap_ms between 1200 and 60000),
  verified_at timestamptz,
  inventory_synced_at timestamptz,
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint duo_connections_org_id_id_unique unique (organization_id, id),
  constraint duo_connections_org_name_unique unique (organization_id, name),
  constraint duo_connections_encrypted_key_complete check (
    (api_key_ciphertext is null and api_key_iv is null and api_key_auth_tag is null)
    or
    (api_key_ciphertext is not null and api_key_iv is not null and api_key_auth_tag is not null)
  ),
  constraint duo_connections_disconnected_has_no_key check (
    status <> 'disconnected'
    or (api_key_ciphertext is null and api_key_iv is null and api_key_auth_tag is null)
  )
);

create unique index if not exists duo_connections_one_default_per_org_idx
  on public.duo_connections (organization_id)
  where is_default;
create index if not exists duo_connections_org_status_idx
  on public.duo_connections (organization_id, status);

create table if not exists public.duo_phones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  client_id uuid references public.clients(id) on delete set null,
  duoplus_image_id text not null check (char_length(btrim(duoplus_image_id)) between 1 and 128),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  status integer not null default 2 check (status >= 0),
  link_status integer,
  enabled boolean not null default true,
  adb_endpoint text,
  ip_address text,
  os_version text,
  expired_at timestamptz,
  gps_latitude numeric(9,6) check (gps_latitude between -90 and 90),
  gps_longitude numeric(9,6) check (gps_longitude between -180 and 180),
  gps_mode smallint not null default 0 check (gps_mode in (0, 1, 2)),
  locale_timezone text,
  locale_language text,
  busy_until timestamptz,
  lease_run_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint duo_phones_connection_fk
    foreign key (organization_id, connection_id)
    references public.duo_connections (organization_id, id) on delete cascade,
  constraint duo_phones_connection_image_unique unique (connection_id, duoplus_image_id),
  constraint duo_phones_org_connection_id_unique unique (organization_id, connection_id, id),
  constraint duo_phones_coordinates_complete check (
    (gps_latitude is null and gps_longitude is null)
    or (gps_latitude is not null and gps_longitude is not null)
  ),
  constraint duo_phones_lease_complete check (
    (lease_run_id is null and lease_token is null and lease_expires_at is null)
    or (lease_run_id is not null and lease_token is not null and lease_expires_at is not null)
  )
);

create index if not exists duo_phones_org_enabled_idx
  on public.duo_phones (organization_id, enabled, status);
create index if not exists duo_phones_client_idx
  on public.duo_phones (organization_id, client_id);
create index if not exists duo_phones_available_idx
  on public.duo_phones (connection_id, busy_until, lease_expires_at)
  where enabled;

create table if not exists public.duo_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  duoplus_template_id text not null check (char_length(btrim(duoplus_template_id)) between 1 and 128),
  template_type smallint not null default 2 check (template_type in (1, 2)),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  description text,
  config_schema jsonb not null default '{}'::jsonb check (jsonb_typeof(config_schema) = 'object'),
  enabled boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint duo_templates_connection_fk
    foreign key (organization_id, connection_id)
    references public.duo_connections (organization_id, id) on delete cascade,
  constraint duo_templates_remote_unique
    unique (connection_id, duoplus_template_id, template_type),
  constraint duo_templates_org_connection_id_unique
    unique (organization_id, connection_id, id)
);

create index if not exists duo_templates_org_enabled_idx
  on public.duo_templates (organization_id, enabled, name);

create table if not exists public.scheduler_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  connection_id uuid not null,
  phone_id uuid,
  template_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 180),
  keyword text not null check (char_length(btrim(keyword)) between 1 and 500),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  cron_expression text not null check (char_length(btrim(cron_expression)) between 5 and 120),
  timezone text not null default 'UTC' check (char_length(btrim(timezone)) between 1 and 80),
  next_run_at timestamptz not null,
  last_enqueued_at timestamptz,
  enabled boolean not null default true,
  gps_latitude numeric(9,6) check (gps_latitude between -90 and 90),
  gps_longitude numeric(9,6) check (gps_longitude between -180 and 180),
  gps_mode smallint not null default 0 check (gps_mode in (0, 1, 2)),
  locale_timezone text,
  locale_language text,
  max_attempts smallint not null default 3 check (max_attempts between 1 and 10),
  expected_duration_seconds integer not null default 600
    check (expected_duration_seconds between 30 and 21600),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduler_schedules_connection_fk
    foreign key (organization_id, connection_id)
    references public.duo_connections (organization_id, id) on delete restrict,
  constraint scheduler_schedules_phone_fk
    foreign key (organization_id, connection_id, phone_id)
    references public.duo_phones (organization_id, connection_id, id) on delete restrict,
  constraint scheduler_schedules_template_fk
    foreign key (organization_id, connection_id, template_id)
    references public.duo_templates (organization_id, connection_id, id) on delete restrict,
  constraint scheduler_schedules_org_connection_id_unique
    unique (organization_id, connection_id, id),
  constraint scheduler_schedules_coordinates_complete check (
    (gps_latitude is null and gps_longitude is null)
    or (gps_latitude is not null and gps_longitude is not null)
  ),
  constraint scheduler_schedules_coordinate_mode_valid check (
    gps_mode <> 2 or (gps_latitude is not null and gps_longitude is not null)
  )
);

create index if not exists scheduler_schedules_due_idx
  on public.scheduler_schedules (next_run_at, organization_id)
  where enabled;
create index if not exists scheduler_schedules_org_client_idx
  on public.scheduler_schedules (organization_id, client_id, enabled);
create index if not exists scheduler_schedules_phone_idx
  on public.scheduler_schedules (organization_id, phone_id)
  where enabled;

create table if not exists public.scheduler_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  connection_id uuid not null,
  schedule_id uuid not null,
  phone_id uuid,
  template_id uuid not null,
  scheduled_for timestamptz not null,
  issue_at timestamptz not null,
  expected_duration_seconds integer not null default 600
    check (expected_duration_seconds between 30 and 21600),
  planned_window tstzrange not null,
  status text not null default 'pending' check (
    status in (
      'pending', 'preparing', 'queued', 'running', 'paused',
      'succeeded', 'failed', 'cancelled', 'retry_wait'
    )
  ),
  stage text not null default 'pending' check (
    stage in (
      'pending', 'prepare_phone', 'wait_phone', 'apply_settings',
      'submit_task', 'resolve_task', 'monitor_task', 'fetch_logs',
      'cancel_task', 'complete', 'error'
    )
  ),
  next_action_at timestamptz not null default now(),
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 10),
  task_name text not null check (char_length(task_name) between 1 and 120),
  duoplus_task_id text,
  duoplus_status smallint check (duoplus_status is null or duoplus_status between 0 and 5),
  cancellation_requested boolean not null default false,
  cancellation_requested_at timestamptz,
  cancellation_reason text,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  phone_lease_token uuid,
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  log_json jsonb check (log_json is null or pg_column_size(log_json) <= 524288),
  screenshots jsonb not null default '[]'::jsonb check (
    jsonb_typeof(screenshots) = 'array'
    and pg_column_size(screenshots) <= 65536
    and strpos(lower(screenshots::text), 'base64,') = 0
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduler_runs_schedule_fk
    foreign key (organization_id, connection_id, schedule_id)
    references public.scheduler_schedules (organization_id, connection_id, id) on delete restrict,
  constraint scheduler_runs_phone_fk
    foreign key (organization_id, connection_id, phone_id)
    references public.duo_phones (organization_id, connection_id, id) on delete restrict,
  constraint scheduler_runs_template_fk
    foreign key (organization_id, connection_id, template_id)
    references public.duo_templates (organization_id, connection_id, id) on delete restrict,
  constraint scheduler_runs_schedule_occurrence_unique unique (schedule_id, scheduled_for),
  constraint scheduler_runs_org_id_unique unique (organization_id, id),
  constraint scheduler_runs_attempt_limit check (attempt_count <= max_attempts),
  constraint scheduler_runs_lease_complete check (
    (lease_owner is null and lease_token is null and lease_expires_at is null)
    or (lease_owner is not null and lease_token is not null and lease_expires_at is not null)
  ),
  constraint scheduler_runs_terminal_finished check (
    status not in ('succeeded', 'failed', 'cancelled') or finished_at is not null
  ),
  constraint scheduler_runs_cancellation_timestamp check (
    not cancellation_requested or cancellation_requested_at is not null
  ),
  constraint scheduler_runs_no_phone_overlap exclude using gist (
    phone_id with =,
    planned_window with &&
  ) where (phone_id is not null and status <> 'cancelled')
);

create index if not exists scheduler_runs_actionable_idx
  on public.scheduler_runs (next_action_at, issue_at, created_at)
  where status in ('pending', 'retry_wait', 'preparing', 'queued', 'running', 'paused');
create index if not exists scheduler_runs_org_status_idx
  on public.scheduler_runs (organization_id, status, issue_at desc);
create index if not exists scheduler_runs_schedule_idx
  on public.scheduler_runs (schedule_id, scheduled_for desc);
create index if not exists scheduler_runs_phone_idx
  on public.scheduler_runs (phone_id, issue_at)
  where phone_id is not null;
create index if not exists scheduler_runs_lease_expiry_idx
  on public.scheduler_runs (lease_expires_at)
  where lease_owner is not null;
create index if not exists scheduler_runs_cancellation_requested_idx
  on public.scheduler_runs (next_action_at, issue_at)
  where cancellation_requested and status not in ('succeeded', 'failed', 'cancelled');
create unique index if not exists scheduler_runs_duoplus_task_unique_idx
  on public.scheduler_runs (connection_id, duoplus_task_id)
  where duoplus_task_id is not null;
create unique index if not exists scheduler_runs_one_dispatch_mutex_per_phone_idx
  on public.scheduler_runs (phone_id)
  where phone_id is not null and status = 'preparing';

alter table public.duo_phones
  add constraint duo_phones_lease_run_fk
  foreign key (organization_id, lease_run_id)
  references public.scheduler_runs (organization_id, id)
  on delete set null (lease_run_id);

create table if not exists public.scheduler_run_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  phone_id uuid references public.duo_phones(id) on delete restrict,
  attempt_number smallint not null check (attempt_number between 1 and 10),
  worker_id text,
  stage text not null default 'prepare_phone',
  status text not null default 'started'
    check (status in ('started', 'succeeded', 'failed', 'abandoned', 'cancelled')),
  duoplus_task_id text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  constraint scheduler_run_attempts_run_fk
    foreign key (organization_id, run_id)
    references public.scheduler_runs (organization_id, id) on delete cascade,
  constraint scheduler_run_attempts_run_number_unique unique (run_id, attempt_number),
  constraint scheduler_run_attempts_finished_consistent check (
    status = 'started' or finished_at is not null
  )
);

create index if not exists scheduler_run_attempts_run_idx
  on public.scheduler_run_attempts (run_id, attempt_number desc);
create index if not exists scheduler_run_attempts_org_started_idx
  on public.scheduler_run_attempts (organization_id, started_at desc);

create table if not exists public.scheduler_run_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  attempt_id uuid references public.scheduler_run_attempts(id) on delete set null,
  event_type text not null check (char_length(btrim(event_type)) between 1 and 80),
  stage text,
  status text,
  message text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  constraint scheduler_run_events_run_fk
    foreign key (organization_id, run_id)
    references public.scheduler_runs (organization_id, id) on delete cascade
);

create index if not exists scheduler_run_events_run_created_idx
  on public.scheduler_run_events (run_id, created_at desc);
create index if not exists scheduler_run_events_org_created_idx
  on public.scheduler_run_events (organization_id, created_at desc);

create table if not exists public.duo_outbound_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  run_id uuid references public.scheduler_runs(id) on delete set null,
  attempt_id uuid references public.scheduler_run_attempts(id) on delete set null,
  endpoint text not null check (endpoint like '/api/v1/%'),
  request_body jsonb check (request_body is null or pg_column_size(request_body) <= 262144),
  response_body jsonb check (response_body is null or pg_column_size(response_body) <= 262144),
  http_status integer check (http_status is null or http_status between 100 and 599),
  duo_code integer,
  ok boolean not null default false,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint duo_outbound_logs_connection_fk
    foreign key (organization_id, connection_id)
    references public.duo_connections (organization_id, id) on delete restrict,
  constraint duo_outbound_logs_time_order check (
    finished_at is null or finished_at >= started_at
  )
);

create index if not exists duo_outbound_logs_connection_started_idx
  on public.duo_outbound_logs (connection_id, started_at desc);
create index if not exists duo_outbound_logs_run_started_idx
  on public.duo_outbound_logs (run_id, started_at desc)
  where run_id is not null;
create index if not exists duo_outbound_logs_failures_idx
  on public.duo_outbound_logs (organization_id, started_at desc)
  where not ok;

create table if not exists public.duo_rate_slots (
  connection_id uuid primary key,
  organization_id uuid not null,
  next_available_at timestamptz not null default now(),
  last_reserved_at timestamptz,
  reservation_count bigint not null default 0 check (reservation_count >= 0),
  updated_at timestamptz not null default now(),
  constraint duo_rate_slots_connection_fk
    foreign key (organization_id, connection_id)
    references public.duo_connections (organization_id, id) on delete cascade
);

create index if not exists duo_rate_slots_org_idx
  on public.duo_rate_slots (organization_id);

create or replace function public.stakeout_set_run_planned_window()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  new.planned_window := tstzrange(
    new.issue_at,
    new.issue_at + (interval '1 second' * new.expected_duration_seconds),
    '[)'
  );
  return new;
end;
$function$;

revoke all on function public.stakeout_set_run_planned_window() from public;

create or replace function public.stakeout_set_run_cancellation_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if new.cancellation_requested and new.cancellation_requested_at is null then
    new.cancellation_requested_at := statement_timestamp();
  end if;
  return new;
end;
$function$;

revoke all on function public.stakeout_set_run_cancellation_at() from public;

drop trigger if exists stakeout_set_run_planned_window on public.scheduler_runs;
create trigger stakeout_set_run_planned_window
before insert or update on public.scheduler_runs
for each row execute function public.stakeout_set_run_planned_window();

drop trigger if exists stakeout_set_run_cancellation_at on public.scheduler_runs;
create trigger stakeout_set_run_cancellation_at
before insert or update on public.scheduler_runs
for each row execute function public.stakeout_set_run_cancellation_at();

create or replace function public.stakeout_validate_client_tenant()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_client_organization_id uuid;
begin
  if new.client_id is null then
    return new;
  end if;

  select client.organization_id
  into v_client_organization_id
  from public.clients as client
  where client.id = new.client_id;

  if v_client_organization_id is null then
    raise exception using errcode = '23503', message = 'Client not found';
  end if;
  if v_client_organization_id <> new.organization_id then
    raise exception using errcode = '23514', message = 'Client organization mismatch';
  end if;
  return new;
end;
$function$;

revoke all on function public.stakeout_validate_client_tenant() from public;

-- Serialize enabling a schedule with connection disconnects. FOR KEY SHARE
-- conflicts with the disconnect RPC's FOR UPDATE lock, closing the otherwise
-- possible check-then-clear race between those two operations.
create or replace function public.stakeout_validate_schedule_connection()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_status text;
  v_has_key boolean;
begin
  select connection.status,
         connection.api_key_ciphertext is not null
           and connection.api_key_iv is not null
           and connection.api_key_auth_tag is not null
  into v_status, v_has_key
  from public.duo_connections as connection
  where connection.id = new.connection_id
    and connection.organization_id = new.organization_id
  for key share;

  if not found then
    raise exception using errcode = '23503', message = 'DuoPlus connection not found';
  end if;
  if new.enabled and (v_status <> 'active' or not v_has_key) then
    raise exception using errcode = '23514', message = 'Enabled schedules require an active DuoPlus connection';
  end if;
  return new;
end;
$function$;

revoke all on function public.stakeout_validate_schedule_connection() from public;

-- Run-now and materialization inserts take the same connection key-share lock,
-- so a new open run cannot appear between disconnect's dependency count and
-- credential removal.
create or replace function public.stakeout_validate_run_connection()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_status text;
  v_has_key boolean;
begin
  if new.status in ('succeeded', 'failed', 'cancelled') then
    return new;
  end if;

  select connection.status,
         connection.api_key_ciphertext is not null
           and connection.api_key_iv is not null
           and connection.api_key_auth_tag is not null
  into v_status, v_has_key
  from public.duo_connections as connection
  where connection.id = new.connection_id
    and connection.organization_id = new.organization_id
  for key share;

  if not found then
    raise exception using errcode = '23503', message = 'DuoPlus connection not found';
  end if;
  if v_status <> 'active' or not v_has_key then
    raise exception using errcode = '23514', message = 'Open runs require an active DuoPlus connection';
  end if;
  return new;
end;
$function$;

revoke all on function public.stakeout_validate_run_connection() from public;

create or replace function public.stakeout_validate_phone_lease()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if new.lease_run_id is not null and not exists (
    select 1
    from public.scheduler_runs as run
    where run.id = new.lease_run_id
      and run.organization_id = new.organization_id
      and run.connection_id = new.connection_id
      and run.phone_id = new.id
      and run.phone_lease_token = new.lease_token
  ) then
    raise exception using errcode = '23514', message = 'Phone lease does not belong to this tenant, connection, phone, and run';
  end if;

  if new.lease_run_id is not null and exists (
    select 1
    from public.scheduler_runs as other_run
    where other_run.phone_id = new.id
      and other_run.id <> new.lease_run_id
      and other_run.status not in ('succeeded', 'failed', 'cancelled')
      and other_run.planned_window @> clock_timestamp()
  ) then
    -- acquire_phone_lease catches exclusion_violation and returns false, so the
    -- worker can defer or select another phone without leaking a SQL error.
    raise exception using
      errcode = '23P01',
      message = 'Phone is inside another nonterminal run window';
  end if;
  return new;
end;
$function$;

revoke all on function public.stakeout_validate_phone_lease() from public;

drop trigger if exists stakeout_validate_phone_client on public.duo_phones;
create trigger stakeout_validate_phone_client
before insert or update on public.duo_phones
for each row execute function public.stakeout_validate_client_tenant();

drop trigger if exists stakeout_validate_phone_lease on public.duo_phones;
create trigger stakeout_validate_phone_lease
before insert or update on public.duo_phones
for each row execute function public.stakeout_validate_phone_lease();

drop trigger if exists stakeout_validate_schedule_client on public.scheduler_schedules;
create trigger stakeout_validate_schedule_client
before insert or update on public.scheduler_schedules
for each row execute function public.stakeout_validate_client_tenant();

drop trigger if exists stakeout_validate_schedule_connection on public.scheduler_schedules;
create trigger stakeout_validate_schedule_connection
before insert or update of organization_id, connection_id, enabled
on public.scheduler_schedules
for each row execute function public.stakeout_validate_schedule_connection();

drop trigger if exists stakeout_validate_run_client on public.scheduler_runs;
create trigger stakeout_validate_run_client
before insert or update on public.scheduler_runs
for each row execute function public.stakeout_validate_client_tenant();

drop trigger if exists stakeout_validate_run_connection on public.scheduler_runs;
create trigger stakeout_validate_run_connection
before insert or update of organization_id, connection_id
on public.scheduler_runs
for each row execute function public.stakeout_validate_run_connection();

-- Derive denormalized tenant keys for append-only child/audit records. Besides
-- making server inserts concise, these triggers reject cross-tenant FK mixing
-- even though service_role correctly bypasses RLS.
create or replace function public.stakeout_fill_run_child_organization()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_organization_id uuid;
begin
  select run.organization_id
  into v_organization_id
  from public.scheduler_runs as run
  where run.id = new.run_id;

  if v_organization_id is null then
    raise exception using errcode = '23503', message = 'Parent scheduler run not found';
  end if;
  if new.organization_id is not null and new.organization_id <> v_organization_id then
    raise exception using errcode = '23514', message = 'Run child organization mismatch';
  end if;
  new.organization_id := v_organization_id;

  return new;
end;
$function$;

create or replace function public.stakeout_validate_attempt_phone()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if new.phone_id is not null and not exists (
    select 1 from public.duo_phones as phone
    where phone.id = new.phone_id
      and phone.organization_id = new.organization_id
  ) then
    raise exception using errcode = '23514', message = 'Attempt phone organization mismatch';
  end if;
  return new;
end;
$function$;

create or replace function public.stakeout_validate_event_attempt()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if new.attempt_id is not null and not exists (
    select 1 from public.scheduler_run_attempts as attempt
    where attempt.id = new.attempt_id
      and attempt.run_id = new.run_id
      and attempt.organization_id = new.organization_id
  ) then
    raise exception using errcode = '23514', message = 'Event attempt does not belong to run';
  end if;
  return new;
end;
$function$;

create or replace function public.stakeout_fill_outbound_organization()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_organization_id uuid;
begin
  select connection.organization_id
  into v_organization_id
  from public.duo_connections as connection
  where connection.id = new.connection_id;

  if v_organization_id is null then
    raise exception using errcode = '23503', message = 'DuoPlus connection not found';
  end if;
  if new.organization_id is not null and new.organization_id <> v_organization_id then
    raise exception using errcode = '23514', message = 'Outbound log organization mismatch';
  end if;
  new.organization_id := v_organization_id;

  if new.run_id is not null and not exists (
    select 1 from public.scheduler_runs as run
    where run.id = new.run_id
      and run.connection_id = new.connection_id
      and run.organization_id = v_organization_id
  ) then
    raise exception using errcode = '23514', message = 'Outbound log run does not belong to connection';
  end if;

  if new.attempt_id is not null and not exists (
    select 1
    from public.scheduler_run_attempts as attempt
    join public.scheduler_runs as run on run.id = attempt.run_id
    where attempt.id = new.attempt_id
      and run.connection_id = new.connection_id
      and attempt.organization_id = v_organization_id
  ) then
    raise exception using errcode = '23514', message = 'Outbound log attempt does not belong to connection';
  end if;

  return new;
end;
$function$;

revoke all on function public.stakeout_fill_run_child_organization() from public;
revoke all on function public.stakeout_validate_attempt_phone() from public;
revoke all on function public.stakeout_validate_event_attempt() from public;
revoke all on function public.stakeout_fill_outbound_organization() from public;

drop trigger if exists stakeout_fill_attempt_organization on public.scheduler_run_attempts;
create trigger stakeout_fill_attempt_organization
before insert or update
on public.scheduler_run_attempts
for each row execute function public.stakeout_fill_run_child_organization();

drop trigger if exists stakeout_validate_attempt_phone on public.scheduler_run_attempts;
create trigger stakeout_validate_attempt_phone
before insert or update
on public.scheduler_run_attempts
for each row execute function public.stakeout_validate_attempt_phone();

drop trigger if exists stakeout_fill_event_organization on public.scheduler_run_events;
create trigger stakeout_fill_event_organization
before insert or update
on public.scheduler_run_events
for each row execute function public.stakeout_fill_run_child_organization();

drop trigger if exists stakeout_validate_event_attempt on public.scheduler_run_events;
create trigger stakeout_validate_event_attempt
before insert or update
on public.scheduler_run_events
for each row execute function public.stakeout_validate_event_attempt();

drop trigger if exists stakeout_fill_outbound_organization on public.duo_outbound_logs;
create trigger stakeout_fill_outbound_organization
before insert or update
on public.duo_outbound_logs
for each row execute function public.stakeout_fill_outbound_organization();

-- Keep mutable rows' timestamps trustworthy regardless of client code.
drop trigger if exists stakeout_touch_duo_connections on public.duo_connections;
create trigger stakeout_touch_duo_connections
before update on public.duo_connections
for each row execute function public.stakeout_set_updated_at();

drop trigger if exists stakeout_touch_duo_phones on public.duo_phones;
create trigger stakeout_touch_duo_phones
before update on public.duo_phones
for each row execute function public.stakeout_set_updated_at();

drop trigger if exists stakeout_touch_duo_templates on public.duo_templates;
create trigger stakeout_touch_duo_templates
before update on public.duo_templates
for each row execute function public.stakeout_set_updated_at();

drop trigger if exists stakeout_touch_scheduler_schedules on public.scheduler_schedules;
create trigger stakeout_touch_scheduler_schedules
before update on public.scheduler_schedules
for each row execute function public.stakeout_set_updated_at();

drop trigger if exists stakeout_touch_scheduler_runs on public.scheduler_runs;
create trigger stakeout_touch_scheduler_runs
before update on public.scheduler_runs
for each row execute function public.stakeout_set_updated_at();

-- RLS helper deliberately remains SECURITY INVOKER. organization_members exposes
-- a user's own membership row, so the helper neither bypasses RLS nor recurses.
create or replace function public.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $function$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.organization_members as membership
      where membership.organization_id = p_organization_id
        and membership.user_id = (select auth.uid())
    );
$function$;

revoke all on function public.is_organization_member(uuid) from public;
grant execute on function public.is_organization_member(uuid) to authenticated, service_role;

create or replace function public.can_manage_scheduler(p_organization_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $function$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.organization_members as membership
      where membership.organization_id = p_organization_id
        and membership.user_id = (select auth.uid())
        and membership.role in ('owner', 'admin', 'analyst')
    );
$function$;

revoke all on function public.can_manage_scheduler(uuid) from public;
grant execute on function public.can_manage_scheduler(uuid) to authenticated, service_role;

alter table public.duo_connections enable row level security;
alter table public.duo_phones enable row level security;
alter table public.duo_templates enable row level security;
alter table public.scheduler_schedules enable row level security;
alter table public.scheduler_runs enable row level security;
alter table public.scheduler_run_attempts enable row level security;
alter table public.scheduler_run_events enable row level security;
alter table public.duo_outbound_logs enable row level security;
alter table public.duo_rate_slots enable row level security;

drop policy if exists stakeout_connections_read_member on public.duo_connections;
create policy stakeout_connections_read_member
on public.duo_connections for select to authenticated
using (public.is_organization_member(organization_id));

drop policy if exists stakeout_phones_read_member on public.duo_phones;
create policy stakeout_phones_read_member
on public.duo_phones for select to authenticated
using (public.is_organization_member(organization_id));

drop policy if exists stakeout_templates_read_member on public.duo_templates;
create policy stakeout_templates_read_member
on public.duo_templates for select to authenticated
using (public.is_organization_member(organization_id));

drop policy if exists stakeout_schedules_read_member on public.scheduler_schedules;
create policy stakeout_schedules_read_member
on public.scheduler_schedules for select to authenticated
using (public.is_organization_member(organization_id));

drop policy if exists stakeout_runs_read_member on public.scheduler_runs;
create policy stakeout_runs_read_member
on public.scheduler_runs for select to authenticated
using (public.is_organization_member(organization_id));

drop policy if exists stakeout_attempts_read_member on public.scheduler_run_attempts;
create policy stakeout_attempts_read_member
on public.scheduler_run_attempts for select to authenticated
using (public.is_organization_member(organization_id));

drop policy if exists stakeout_events_read_member on public.scheduler_run_events;
create policy stakeout_events_read_member
on public.scheduler_run_events for select to authenticated
using (public.is_organization_member(organization_id));

drop policy if exists stakeout_outbound_logs_read_member on public.duo_outbound_logs;
create policy stakeout_outbound_logs_read_member
on public.duo_outbound_logs for select to authenticated
using (public.is_organization_member(organization_id));

-- No authenticated policy is provided for duo_rate_slots. It is internal
-- coordination state and is only available to service_role callers.

revoke all on table public.duo_connections from anon, authenticated;
revoke all on table public.duo_phones from anon, authenticated;
revoke all on table public.duo_templates from anon, authenticated;
revoke all on table public.scheduler_schedules from anon, authenticated;
revoke all on table public.scheduler_runs from anon, authenticated;
revoke all on table public.scheduler_run_attempts from anon, authenticated;
revoke all on table public.scheduler_run_events from anon, authenticated;
revoke all on table public.duo_outbound_logs from anon, authenticated;
revoke all on table public.duo_rate_slots from anon, authenticated;

grant select (
  id, organization_id, name, is_default, base_url, issue_timezone, key_version, key_hint,
  status, min_gap_ms, verified_at, inventory_synced_at, last_error,
  created_by, created_at, updated_at
) on public.duo_connections to authenticated;
grant select (
  id, organization_id, connection_id, client_id, duoplus_image_id, name,
  status, link_status, enabled, os_version, expired_at,
  gps_latitude, gps_longitude, gps_mode, locale_timezone, locale_language,
  busy_until, lease_run_id, lease_expires_at, last_seen_at,
  created_at, updated_at
) on public.duo_phones to authenticated;
grant select on table public.duo_templates to authenticated;
grant select on table public.scheduler_schedules to authenticated;
grant select on table public.scheduler_runs to authenticated;
grant select on table public.scheduler_run_attempts to authenticated;
grant select on table public.scheduler_run_events to authenticated;
grant select on table public.duo_outbound_logs to authenticated;

grant all on table public.duo_connections to service_role;
grant all on table public.duo_phones to service_role;
grant all on table public.duo_templates to service_role;
grant all on table public.scheduler_schedules to service_role;
grant all on table public.scheduler_runs to service_role;
grant all on table public.scheduler_run_attempts to service_role;
grant all on table public.scheduler_run_events to service_role;
grant all on table public.duo_outbound_logs to service_role;
grant all on table public.duo_rate_slots to service_role;

-- Idempotently create the caller's first organization. This narrowly scoped
-- SECURITY DEFINER function is the one intentional exception to the invoker
-- rule: a new user cannot insert their first membership under membership RLS.
create or replace function public.ensure_personal_workspace(p_name text default null)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_organization_id uuid;
  v_name text := coalesce(nullif(btrim(p_name), ''), 'My workspace');
  v_slug_base text;
  v_slug text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 743921));

  select organization.id
  into v_organization_id
  from public.organizations as organization
  left join public.organization_members as membership
    on membership.organization_id = organization.id
   and membership.user_id = v_user_id
  where organization.owner_user_id = v_user_id
     or membership.user_id = v_user_id
  order by (organization.owner_user_id = v_user_id) desc, organization.created_at, organization.id
  limit 1;

  if v_organization_id is not null then
    insert into public.organization_members (organization_id, user_id, role)
    values (v_organization_id, v_user_id, 'owner')
    on conflict (organization_id, user_id) do nothing;
    return v_organization_id;
  end if;

  if char_length(v_name) < 2 then
    v_name := v_name || ' workspace';
  end if;
  v_name := left(v_name, 80);

  v_slug_base := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  if v_slug_base = '' then
    v_slug_base := 'workspace';
  end if;
  v_slug := left(v_slug_base, 60) || '-' || left(replace(v_user_id::text, '-', ''), 10);

  insert into public.organizations (name, slug, owner_user_id)
  values (v_name, v_slug, v_user_id)
  returning id into v_organization_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_organization_id, v_user_id, 'owner');

  return v_organization_id;
end;
$function$;

revoke all on function public.ensure_personal_workspace(text) from public, anon;
grant execute on function public.ensure_personal_workspace(text) to authenticated;

-- The application computes cron occurrences with cron-parser (including DST),
-- then commits all occurrences plus the next cursor in one transaction. The
-- unique constraint makes retries harmless; the exclusion constraint rejects
-- two planned windows on the same fixed phone.
create or replace function public.materialize_schedule_runs(
  p_schedule_id uuid,
  p_occurrences timestamptz[],
  p_next_run_at timestamptz
)
returns setof public.scheduler_runs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_schedule public.scheduler_schedules%rowtype;
  v_occurrence_count integer;
  v_max_occurrence timestamptz;
begin
  select *
  into v_schedule
  from public.scheduler_schedules
  where id = p_schedule_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Schedule not found';
  end if;
  if not v_schedule.enabled then
    raise exception using errcode = '22023', message = 'Schedule is disabled';
  end if;

  v_occurrence_count := coalesce(cardinality(p_occurrences), 0);
  if v_occurrence_count > 1000 then
    raise exception using errcode = '22023', message = 'At most 1000 occurrences may be materialized at once';
  end if;
  if exists (select 1 from unnest(coalesce(p_occurrences, array[]::timestamptz[])) as item(value) where value is null) then
    raise exception using errcode = '22004', message = 'Occurrences may not contain null';
  end if;

  select max(value)
  into v_max_occurrence
  from unnest(coalesce(p_occurrences, array[]::timestamptz[])) as item(value);

  if p_next_run_at is null then
    raise exception using errcode = '22004', message = 'next_run_at is required';
  end if;
  if v_max_occurrence is not null and p_next_run_at <= v_max_occurrence then
    raise exception using errcode = '22023', message = 'next_run_at must be after every materialized occurrence';
  end if;

  update public.scheduler_schedules
  set next_run_at = p_next_run_at,
      last_enqueued_at = coalesce(v_max_occurrence, last_enqueued_at)
  where id = v_schedule.id;

  return query
  with distinct_occurrences as (
    select distinct value as scheduled_for
    from unnest(coalesce(p_occurrences, array[]::timestamptz[])) as item(value)
  ),
  prepared as (
    select gen_random_uuid() as id, occurrence.scheduled_for
    from distinct_occurrences as occurrence
  )
  insert into public.scheduler_runs (
    id, organization_id, client_id, connection_id, schedule_id, phone_id,
    template_id, scheduled_for, issue_at, expected_duration_seconds,
    status, stage, next_action_at, attempt_count, max_attempts, task_name
  )
  select
    prepared.id,
    v_schedule.organization_id,
    v_schedule.client_id,
    v_schedule.connection_id,
    v_schedule.id,
    v_schedule.phone_id,
    v_schedule.template_id,
    prepared.scheduled_for,
    prepared.scheduled_for,
    v_schedule.expected_duration_seconds,
    'pending',
    'pending',
    clock_timestamp(),
    0,
    v_schedule.max_attempts,
    'stk_' || prepared.id::text
  from prepared
  on conflict (schedule_id, scheduled_for) do nothing
  returning *;
end;
$function$;

-- Recover only expired pre-dispatch work. Accepted/queued/running DuoPlus tasks
-- are intentionally excluded because their remote execution remains canonical.
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
begin
  if p_limit not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 1000';
  end if;

  for v_run in
    select run.*
    from public.scheduler_runs as run
    where run.status in ('pending', 'retry_wait', 'preparing')
      and run.lease_owner is not null
      and run.lease_expires_at <= clock_timestamp()
    order by run.lease_expires_at
    for update skip locked
    limit p_limit
  loop
    if v_run.phone_id is not null and v_run.phone_lease_token is not null then
      update public.duo_phones
      set busy_until = null,
          lease_run_id = null,
          lease_token = null,
          lease_expires_at = null
      where id = v_run.phone_id
        and lease_run_id = v_run.id
        and lease_token = v_run.phone_lease_token
        and lease_expires_at <= clock_timestamp();
    end if;

    if v_run.status = 'preparing' then
      update public.scheduler_run_attempts
      set status = 'abandoned',
          error_message = coalesce(error_message, 'Worker lease expired before DuoPlus accepted the task'),
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
          last_error = 'Worker lease expired before DuoPlus accepted the task',
          lease_owner = null,
          lease_token = null,
          lease_expires_at = null,
          phone_lease_token = null
      where id = v_run.id;
    else
      -- A worker died before acquiring a phone; no attempt was consumed.
      update public.scheduler_runs
      set next_action_at = clock_timestamp(),
          lease_owner = null,
          lease_token = null,
          lease_expires_at = null,
          phone_lease_token = null
      where id = v_run.id;
    end if;

    insert into public.scheduler_run_events (
      organization_id, run_id, event_type, stage, status, message, metadata
    ) values (
      v_run.organization_id,
      v_run.id,
      'lease_expired',
      v_run.stage,
      v_run.status,
      'Expired worker/device lease was safely released',
      jsonb_build_object('previous_worker', v_run.lease_owner)
    );

    v_reaped := v_reaped + 1;
  end loop;

  return v_reaped;
end;
$function$;

-- Claiming is a short worker lease, not the phone lease. p_horizon_end lets the
-- daily Vercel tick enqueue a 26-hour window; a Supabase minute tick passes now().
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
        or run.stage = 'cancel_task'
        or run.status in ('preparing', 'queued', 'running', 'paused')
      )
      and run.status in ('pending', 'retry_wait', 'preparing', 'queued', 'running', 'paused')
      and (
        run.status in ('preparing', 'queued', 'running', 'paused')
        or run.cancellation_requested
        or run.stage in ('cancel_task', 'resolve_task', 'monitor_task')
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
        when run.status = 'pending' and run.attempt_count = 0 then 'prepare_phone'
        else run.stage
      end
  from candidates
  where run.id = candidates.id
  returning run.*;
end;
$function$;

-- Acquire a short mutex only while powering/configuring/submitting a task. The
-- planned-window exclusion is what prevents true run-time overlap.
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
  v_configured_gap integer;
  v_effective_gap integer;
  v_next_available timestamptz;
  v_reserved_at timestamptz;
begin
  if p_min_gap_ms not between 1200 and 60000 then
    raise exception using errcode = '22023', message = 'min_gap_ms must be between 1200 and 60000';
  end if;

  select organization_id, min_gap_ms
  into v_organization_id, v_configured_gap
  from public.duo_connections
  where id = p_connection_id
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'DuoPlus connection not found';
  end if;

  v_effective_gap := greatest(1200, p_min_gap_ms, v_configured_gap);

  insert into public.duo_rate_slots (connection_id, organization_id)
  values (p_connection_id, v_organization_id)
  on conflict (connection_id) do nothing;

  select next_available_at
  into v_next_available
  from public.duo_rate_slots
  where connection_id = p_connection_id
  for update;

  v_reserved_at := greatest(clock_timestamp(), v_next_available);

  update public.duo_rate_slots
  set last_reserved_at = v_reserved_at,
      next_available_at = v_reserved_at + (interval '1 millisecond' * v_effective_gap),
      reservation_count = reservation_count + 1,
      updated_at = clock_timestamp()
  where connection_id = p_connection_id;

  return v_reserved_at;
end;
$function$;

-- Final, atomic preflight immediately before addTask. A cancellation arriving
-- just after this transaction remains durable and is reconciled by cancel_task.
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
    and phone.lease_expires_at > clock_timestamp();

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

-- Clear a BYO credential only when it is safe to do so. Locking the connection
-- makes the enabled-schedule check atomic with the schedule validation trigger.
-- Open remote work must reach a terminal state before the key can be removed,
-- because cancellation/status reconciliation still needs that credential.
create or replace function public.disconnect_duoplus_connection(
  p_connection_id uuid,
  p_organization_id uuid
)
returns table (
  disconnected boolean,
  enabled_schedules integer,
  open_runs integer
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_connection public.duo_connections%rowtype;
  v_enabled_schedules integer;
  v_open_runs integer;
begin
  select *
  into v_connection
  from public.duo_connections
  where id = p_connection_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'DuoPlus connection not found';
  end if;

  select count(*)::integer
  into v_enabled_schedules
  from public.scheduler_schedules
  where connection_id = p_connection_id
    and organization_id = p_organization_id
    and enabled;

  select count(*)::integer
  into v_open_runs
  from public.scheduler_runs
  where connection_id = p_connection_id
    and organization_id = p_organization_id
    and status not in ('succeeded', 'failed', 'cancelled');

  if v_enabled_schedules > 0 or v_open_runs > 0 then
    return query select false, v_enabled_schedules, v_open_runs;
    return;
  end if;

  update public.duo_connections
  set api_key_ciphertext = null,
      api_key_iv = null,
      api_key_auth_tag = null,
      key_hint = null,
      status = 'disconnected',
      verified_at = null,
      last_error = null
  where id = p_connection_id
    and organization_id = p_organization_id;

  return query select true, 0, 0;
end;
$function$;

create or replace function public.release_run_lease(
  p_run_id uuid,
  p_worker_id text
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

  if not found or v_run.lease_owner is distinct from btrim(p_worker_id) then
    return false;
  end if;

  if v_run.phone_id is not null and v_run.phone_lease_token is not null then
    update public.duo_phones
    set busy_until = null,
        lease_run_id = null,
        lease_token = null,
        lease_expires_at = null
    where id = v_run.phone_id
      and lease_run_id = v_run.id
      and lease_token = v_run.phone_lease_token;
  end if;

  update public.scheduler_runs
  set lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      phone_lease_token = null
  where id = v_run.id;

  return true;
end;
$function$;

create or replace function public.renew_run_lease(
  p_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_updated integer;
begin
  if p_lease_seconds not between 15 and 3600 then
    raise exception using errcode = '22023', message = 'lease_seconds must be between 15 and 3600';
  end if;

  update public.scheduler_runs
  set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
  where id = p_run_id
    and lease_owner = btrim(p_worker_id)
    and lease_expires_at > clock_timestamp();

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

-- Bounded retention for the Supabase free tier. This deliberately leaves
-- scheduler_runs and scheduler_run_attempts untouched. Repeated calls drain
-- old verbose rows in small batches without holding long table locks.
create or replace function public.prune_scheduler_history()
returns table (outbound_logs_deleted integer, run_events_deleted integer)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_outbound_deleted integer;
  v_events_deleted integer;
begin
  with doomed as (
    select log.id
    from public.duo_outbound_logs as log
    where log.started_at < clock_timestamp() - interval '30 days'
    order by log.started_at
    limit 5000
  )
  delete from public.duo_outbound_logs as log
  using doomed
  where log.id = doomed.id;
  get diagnostics v_outbound_deleted = row_count;

  with doomed as (
    select event.id
    from public.scheduler_run_events as event
    where event.created_at < clock_timestamp() - interval '90 days'
    order by event.created_at
    limit 5000
  )
  delete from public.scheduler_run_events as event
  using doomed
  where event.id = doomed.id;
  get diagnostics v_events_deleted = row_count;

  return query select v_outbound_deleted, v_events_deleted;
end;
$function$;

revoke all on function public.materialize_schedule_runs(uuid, timestamptz[], timestamptz) from public, anon, authenticated;
revoke all on function public.reap_expired_run_leases(integer) from public, anon, authenticated;
revoke all on function public.claim_due_runs(text, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.acquire_phone_lease(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.reserve_duoplus_rate_slot(uuid, integer) from public, anon, authenticated;
revoke all on function public.authorize_run_submission(uuid, text) from public, anon, authenticated;
revoke all on function public.disconnect_duoplus_connection(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_run_lease(uuid, text) from public, anon, authenticated;
revoke all on function public.renew_run_lease(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.prune_scheduler_history() from public, anon, authenticated;

grant execute on function public.materialize_schedule_runs(uuid, timestamptz[], timestamptz) to service_role;
grant execute on function public.reap_expired_run_leases(integer) to service_role;
grant execute on function public.claim_due_runs(text, integer, integer, timestamptz) to service_role;
grant execute on function public.acquire_phone_lease(uuid, uuid, integer) to service_role;
grant execute on function public.reserve_duoplus_rate_slot(uuid, integer) to service_role;
grant execute on function public.authorize_run_submission(uuid, text) to service_role;
grant execute on function public.disconnect_duoplus_connection(uuid, uuid) to service_role;
grant execute on function public.release_run_lease(uuid, text) to service_role;
grant execute on function public.renew_run_lease(uuid, text, integer) to service_role;
grant execute on function public.prune_scheduler_history() to service_role;

comment on column public.duo_connections.api_key_ciphertext is
  'Application-encrypted DuoPlus API key ciphertext. Never readable by authenticated clients.';
comment on column public.duo_connections.api_key_iv is
  'Unique AES-GCM IV/nonce encoded as text. Never readable by authenticated clients.';
comment on column public.duo_connections.api_key_auth_tag is
  'AES-GCM authentication tag encoded as text. Never readable by authenticated clients.';
comment on column public.scheduler_schedules.gps_mode is
  '0=no change, 1=derive fake GPS from proxy IP, 2=use explicit coordinates.';
comment on column public.scheduler_runs.screenshots is
  'JSON array of screenshot URLs and compact metadata only; never image bytes or base64 payloads.';
comment on function public.claim_due_runs(text, integer, integer, timestamptz) is
  'Atomically leases materialized pending/retry runs through a caller-provided horizon using FOR UPDATE SKIP LOCKED.';
comment on function public.reserve_duoplus_rate_slot(uuid, integer) is
  'Atomically reserves one outbound-call timestamp per DuoPlus connection and enforces at least 1.2 seconds between starts.';
comment on function public.disconnect_duoplus_connection(uuid, uuid) is
  'Atomically clears a BYO DuoPlus credential only when no enabled schedules or open runs still depend on it.';
comment on function public.prune_scheduler_history() is
  'Deletes up to 5000 outbound logs older than 30 days and run events older than 90 days; never deletes runs or attempts.';
