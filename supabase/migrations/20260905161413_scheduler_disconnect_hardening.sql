-- Post-deploy hardening for the Stakeout Ops scheduler.
--
-- All browser-visible scheduler tables remain read-only. Schedule mutation and
-- DuoPlus credential lifecycle operations go through authenticated server
-- routes backed by service_role so cancellation/reconciliation cannot be
-- bypassed with a direct publishable-key request.

revoke insert, update, delete, truncate
  on table public.scheduler_schedules
  from anon, authenticated;

drop policy if exists stakeout_schedules_insert_member on public.scheduler_schedules;
drop policy if exists stakeout_schedules_update_member on public.scheduler_schedules;

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

drop trigger if exists stakeout_validate_schedule_connection on public.scheduler_schedules;
create trigger stakeout_validate_schedule_connection
before insert or update of organization_id, connection_id, enabled
on public.scheduler_schedules
for each row execute function public.stakeout_validate_schedule_connection();

-- Lock, dependency check, and cryptographic removal happen in one transaction.
-- A false row gives the API exact dependency counts for its 409 response.
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

revoke all on function public.disconnect_duoplus_connection(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.disconnect_duoplus_connection(uuid, uuid)
  to service_role;

comment on function public.disconnect_duoplus_connection(uuid, uuid) is
  'Atomically clears a BYO DuoPlus credential only when no enabled schedules or open runs still depend on it.';
