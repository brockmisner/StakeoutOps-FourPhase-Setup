-- Pause/resume/cancel a cycle atomically with its materialized schedules.

create or replace function public.set_device_cycle_operating_status(
  p_organization_id uuid,
  p_cycle_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_cycle public.device_cycles%rowtype;
  v_cancel_count integer := 0;
begin
  if p_status not in ('active', 'paused', 'cancelled') then
    raise exception using errcode = '22023', message = 'Unsupported device cycle status';
  end if;

  select * into v_cycle
  from public.device_cycles as cycle
  where cycle.id = p_cycle_id
    and cycle.organization_id = p_organization_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Device cycle not found';
  end if;

  if p_status = 'paused' then
    if v_cycle.status <> 'active' then
      raise exception using errcode = '22023', message = 'Only an active cycle can be paused';
    end if;
    update public.scheduler_schedules
    set enabled = false, updated_at = clock_timestamp()
    where organization_id = p_organization_id
      and device_cycle_id = p_cycle_id
      and source_kind = 'device_cycle';
    update public.device_cycles
    set status = 'paused', last_error = null, updated_at = clock_timestamp()
    where id = p_cycle_id;

  elsif p_status = 'active' then
    if v_cycle.status <> 'paused' then
      raise exception using errcode = '22023', message = 'Only a paused cycle can be resumed';
    end if;
    update public.device_cycles
    set status = 'active', last_error = null, updated_at = clock_timestamp()
    where id = p_cycle_id;

    -- Do not burst through work that became overdue while paused. Future
    -- materialized occurrences remain available after the schedules resume.
    update public.scheduler_runs
    set status = 'cancelled',
        stage = 'cancelled',
        finished_at = clock_timestamp(),
        last_error = 'Skipped while the device cycle was paused',
        updated_at = clock_timestamp()
    where organization_id = p_organization_id
      and device_cycle_id = p_cycle_id
      and status in ('pending', 'retry_wait')
      and duoplus_task_id is null
      and issue_at < clock_timestamp();

    update public.scheduler_schedules
    set enabled = true, updated_at = clock_timestamp()
    where organization_id = p_organization_id
      and device_cycle_id = p_cycle_id
      and source_kind = 'device_cycle'
      and active_through >= clock_timestamp();

  else
    if v_cycle.status not in ('provisioning', 'active', 'paused', 'blocked') then
      raise exception using errcode = '22023', message = 'This cycle is already finished';
    end if;
    update public.scheduler_schedules
    set enabled = false, updated_at = clock_timestamp()
    where organization_id = p_organization_id
      and device_cycle_id = p_cycle_id
      and source_kind = 'device_cycle';

    update public.device_cycles
    set status = 'cancelled', last_error = null, updated_at = clock_timestamp()
    where id = p_cycle_id;

    update public.scheduler_runs
    set cancellation_requested = true,
        next_action_at = least(next_action_at, clock_timestamp()),
        updated_at = clock_timestamp()
    where organization_id = p_organization_id
      and device_cycle_id = p_cycle_id
      and status in ('pending', 'retry_wait', 'preparing', 'queued', 'running', 'paused');
    get diagnostics v_cancel_count = row_count;
  end if;

  return jsonb_build_object(
    'cycleId', p_cycle_id,
    'status', p_status,
    'cancellationRequested', v_cancel_count
  );
end;
$function$;

revoke all on function public.set_device_cycle_operating_status(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_device_cycle_operating_status(uuid, uuid, text)
  to service_role;

comment on function public.set_device_cycle_operating_status(uuid, uuid, text) is
  'Atomically pauses, resumes, or cancels a device cycle and its materialized schedules.';
