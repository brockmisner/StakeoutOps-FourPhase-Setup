-- Assign a DuoPlus phone to a client without racing device-cycle creation.

create or replace function public.assign_duoplus_phone_client(
  p_organization_id uuid,
  p_phone_id uuid,
  p_client_id uuid
)
returns setof public.duo_phones
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_phone public.duo_phones%rowtype;
  v_client_status text;
begin
  -- FOR UPDATE conflicts with the FOR SHARE lock taken by device-cycle
  -- validation. Whichever transaction arrives second must therefore observe
  -- the first transaction's committed phone assignment or open cycle.
  select * into v_phone
  from public.duo_phones as phone
  where phone.id = p_phone_id
    and phone.organization_id = p_organization_id
  for update;

  if not found then
    raise exception using errcode = 'P4101', message = 'Phone not found';
  end if;

  if p_client_id is not null then
    select client.status into v_client_status
    from public.clients as client
    where client.id = p_client_id
      and client.organization_id = p_organization_id
    for share;

    if not found then
      raise exception using errcode = 'P4102', message = 'Client not found';
    end if;
    if v_client_status <> 'active' then
      raise exception using errcode = 'P4103', message = 'Client is not active';
    end if;
  end if;

  -- Repeating the current assignment is harmless, including while a cycle is
  -- open. Only transitions can move a phone out from under materialized work.
  if v_phone.client_id is not distinct from p_client_id then
    return next v_phone;
    return;
  end if;

  if exists (
    select 1
    from public.device_cycles as cycle
    where cycle.organization_id = p_organization_id
      and cycle.phone_id = p_phone_id
      and cycle.status in ('provisioning', 'active', 'paused', 'blocked')
  ) then
    raise exception using errcode = 'P4104', message = 'Phone has an open device cycle';
  end if;

  return query
  update public.duo_phones as phone
  set client_id = p_client_id,
      updated_at = clock_timestamp()
  where phone.id = p_phone_id
    and phone.organization_id = p_organization_id
  returning phone.*;
end;
$function$;

revoke all on function public.assign_duoplus_phone_client(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.assign_duoplus_phone_client(uuid, uuid, uuid)
  to service_role;

comment on function public.assign_duoplus_phone_client(uuid, uuid, uuid) is
  'Atomically assigns a tenant phone to an active tenant client while fencing open device cycles.';
