-- Fence repeated manual enqueues until the schedule's current work is terminal.

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

  -- This lock serializes manual enqueues for one schedule. The calendar
  -- materializer takes the same lock, so the open-run decision and insert do
  -- not race with another calendar occurrence being materialized.
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

  if exists (
    select 1
    from public.scheduler_runs as run
    where run.organization_id = p_organization_id
      and run.schedule_id = v_schedule.id
      and run.status in (
        'pending', 'preparing', 'queued', 'running', 'paused', 'retry_wait'
      )
  ) then
    raise exception using
      errcode = 'P4201',
      message = 'Schedule already has an unfinished run';
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

revoke all on function public.enqueue_schedule_run_now(uuid, uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.enqueue_schedule_run_now(uuid, uuid, uuid, timestamptz, timestamptz)
  to service_role;

comment on function public.enqueue_schedule_run_now(uuid, uuid, uuid, timestamptz, timestamptz) is
  'Atomically snapshots one enabled calendar schedule into a manual run only when that schedule has no unfinished run.';
