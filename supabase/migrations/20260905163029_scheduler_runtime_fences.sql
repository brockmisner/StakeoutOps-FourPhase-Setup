-- Close the two remaining dispatch races after atomic connection disconnect.

-- Run-now and materialization inserts take the same connection key-share lock
-- as schedule enabling. If disconnect owns FOR UPDATE first, this insert waits
-- and then rejects the disconnected key. If the insert owns the lock first,
-- disconnect waits and its open-run count observes the committed row.
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

drop trigger if exists stakeout_validate_run_connection on public.scheduler_runs;
create trigger stakeout_validate_run_connection
before insert or update of organization_id, connection_id
on public.scheduler_runs
for each row execute function public.stakeout_validate_run_connection();

-- A short dispatch lease must not mutate GPS/locale while an earlier queued or
-- running job is inside its planned execution window. The acquiring RPC catches
-- the exclusion SQLSTATE and returns false so the worker can safely defer.
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
    raise exception using
      errcode = '23P01',
      message = 'Phone is inside another nonterminal run window';
  end if;
  return new;
end;
$function$;

revoke all on function public.stakeout_validate_phone_lease() from public;
