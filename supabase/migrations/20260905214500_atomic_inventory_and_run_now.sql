-- Keep a complete provider phone snapshot and make manual enqueue race-safe.

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
begin
  if jsonb_typeof(p_phones) <> 'array' then
    raise exception using errcode = '22023', message = 'Phone inventory must be a JSON array';
  end if;

  if not exists (
    select 1
    from public.duo_connections as connection
    where connection.id = p_connection_id
      and connection.organization_id = p_organization_id
  ) then
    raise exception using errcode = '23503', message = 'DuoPlus connection not found';
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
    metadata, enabled, updated_at
  )
  select
    p_organization_id, p_connection_id, incoming.duoplus_image_id,
    incoming.name, incoming.status, incoming.adb_endpoint,
    incoming.ip_address, incoming.os_version, incoming.expired_at,
    coalesce(incoming.last_seen_at, p_synced_at), incoming.metadata,
    true, p_synced_at
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
      enabled = true,
      updated_at = excluded.updated_at
  where duo_phones.organization_id = p_organization_id;

  update public.duo_phones as phone
  set enabled = false,
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

  v_count := jsonb_array_length(p_phones);
  return v_count;
end;
$function$;

create or replace function public.enqueue_schedule_run_now(
  p_organization_id uuid,
  p_schedule_id uuid,
  p_run_id uuid,
  p_scheduled_for timestamptz,
  p_issue_at timestamptz
)
returns setof public.scheduler_runs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_schedule public.scheduler_schedules%rowtype;
begin
  if p_scheduled_for is null or p_issue_at is null then
    raise exception using errcode = '22004', message = 'Manual run timestamps are required';
  end if;
  if p_issue_at < p_scheduled_for then
    raise exception using errcode = '22023', message = 'Issue time cannot precede the manual request';
  end if;

  select * into v_schedule
  from public.scheduler_schedules as schedule
  where schedule.id = p_schedule_id
    and schedule.organization_id = p_organization_id
    and schedule.source_kind = 'calendar'
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Schedule not found';
  end if;
  if not v_schedule.enabled then
    raise exception using errcode = '22023', message = 'Schedule is disabled';
  end if;

  return query
  insert into public.scheduler_runs (
    id, organization_id, client_id, connection_id, schedule_id, phone_id,
    template_id, scheduled_for, issue_at, expected_duration_seconds,
    status, stage, next_action_at, attempt_count, max_attempts, task_name
  ) values (
    p_run_id, v_schedule.organization_id, v_schedule.client_id,
    v_schedule.connection_id, v_schedule.id, v_schedule.phone_id,
    v_schedule.template_id, p_scheduled_for, p_issue_at,
    v_schedule.expected_duration_seconds, 'pending', 'pending',
    clock_timestamp(), 0, v_schedule.max_attempts, 'stk_' || p_run_id::text
  )
  returning *;
end;
$function$;

revoke all on function public.replace_duoplus_phone_inventory(uuid, uuid, timestamptz, jsonb)
  from public, anon, authenticated;
revoke all on function public.enqueue_schedule_run_now(uuid, uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.replace_duoplus_phone_inventory(uuid, uuid, timestamptz, jsonb)
  to service_role;
grant execute on function public.enqueue_schedule_run_now(uuid, uuid, uuid, timestamptz, timestamptz)
  to service_role;

comment on function public.replace_duoplus_phone_inventory(uuid, uuid, timestamptz, jsonb) is
  'Atomically upserts the complete DuoPlus phone inventory and disables phones absent from the provider snapshot.';
comment on function public.enqueue_schedule_run_now(uuid, uuid, uuid, timestamptz, timestamptz) is
  'Locks an enabled calendar schedule and snapshots it into one manual scheduler run.';
