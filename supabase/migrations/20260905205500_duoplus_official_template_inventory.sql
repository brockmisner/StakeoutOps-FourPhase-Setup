-- Atomically replace the successfully fetched DuoPlus template inventory.
-- Template ids are only unique inside a source, so official (1) and custom
-- (2) are always keyed independently.

create or replace function public.replace_duoplus_template_inventory(
  p_organization_id uuid,
  p_connection_id uuid,
  p_template_types smallint[],
  p_synced_at timestamptz,
  p_templates jsonb
)
returns table(saved_count integer, disabled_count integer)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_latest_sync timestamptz;
begin
  if p_organization_id is null or p_connection_id is null then
    raise exception using errcode = '22004', message = 'Organization and connection are required';
  end if;

  if p_synced_at is null then
    raise exception using errcode = '22004', message = 'Inventory sync time is required';
  end if;

  if jsonb_typeof(p_templates) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Template inventory must be a JSON array';
  end if;

  if coalesce(cardinality(p_template_types), 0) = 0
     or exists (
       select 1
       from unnest(p_template_types) as requested(template_type)
       where requested.template_type is null
          or requested.template_type not in (1, 2)
     ) then
    raise exception using errcode = '22023', message = 'Template types must contain only official (1) or custom (2)';
  end if;

  if not exists (
    select 1
    from public.duo_connections as connection
    where connection.id = p_connection_id
      and connection.organization_id = p_organization_id
  ) then
    raise exception using errcode = '23503', message = 'DuoPlus connection does not belong to this organization';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_templates) as candidate(
      duoplus_template_id text,
      template_type smallint,
      name text,
      description text,
      config_schema jsonb
    )
    where candidate.template_type is null
      or not (candidate.template_type = any(p_template_types))
      or char_length(btrim(coalesce(candidate.duoplus_template_id, ''))) not between 1 and 128
      or char_length(btrim(coalesce(candidate.name, ''))) not between 1 and 160
      or jsonb_typeof(candidate.config_schema) is distinct from 'object'
  ) then
    raise exception using errcode = '22023', message = 'Template inventory contains an invalid row';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_connection_id::text, 1457152067)
  );

  select max(template.last_synced_at)
  into v_latest_sync
  from public.duo_templates as template
  where template.organization_id = p_organization_id
    and template.connection_id = p_connection_id
    and template.template_type = any(p_template_types);

  -- Concurrent syncs may finish out of order. Never let an older complete
  -- snapshot replace a newer one.
  if v_latest_sync is not null and v_latest_sync > p_synced_at then
    saved_count := 0;
    disabled_count := 0;
    return next;
    return;
  end if;

  with incoming as materialized (
    select distinct on (source.duoplus_template_id, source.template_type)
      source.duoplus_template_id,
      source.template_type,
      source.name,
      source.description,
      source.config_schema
    from jsonb_to_recordset(p_templates) as source(
      duoplus_template_id text,
      template_type smallint,
      name text,
      description text,
      config_schema jsonb
    )
    where source.template_type = any(p_template_types)
      and nullif(btrim(source.duoplus_template_id), '') is not null
      and nullif(btrim(source.name), '') is not null
      and jsonb_typeof(source.config_schema) = 'object'
    order by source.duoplus_template_id, source.template_type
  )
  insert into public.duo_templates (
    organization_id,
    connection_id,
    duoplus_template_id,
    template_type,
    name,
    description,
    config_schema,
    enabled,
    last_synced_at,
    updated_at
  )
  select
    p_organization_id,
    p_connection_id,
    incoming.duoplus_template_id,
    incoming.template_type,
    incoming.name,
    incoming.description,
    incoming.config_schema,
    true,
    p_synced_at,
    p_synced_at
  from incoming
  on conflict (connection_id, duoplus_template_id, template_type)
  do update set
    organization_id = excluded.organization_id,
    name = excluded.name,
    description = excluded.description,
    config_schema = excluded.config_schema,
    enabled = true,
    last_synced_at = excluded.last_synced_at,
    updated_at = excluded.updated_at;

  get diagnostics saved_count = row_count;

  update public.duo_templates as template
  set
    enabled = false,
    updated_at = p_synced_at
  where template.organization_id = p_organization_id
    and template.connection_id = p_connection_id
    and template.template_type = any(p_template_types)
    and template.last_synced_at is distinct from p_synced_at
    and template.enabled;

  get diagnostics disabled_count = row_count;
  return next;
end;
$function$;

revoke all on function public.replace_duoplus_template_inventory(
  uuid, uuid, smallint[], timestamptz, jsonb
) from public, anon, authenticated;

grant execute on function public.replace_duoplus_template_inventory(
  uuid, uuid, smallint[], timestamptz, jsonb
) to service_role;

comment on function public.replace_duoplus_template_inventory(
  uuid, uuid, smallint[], timestamptz, jsonb
) is 'Atomically upserts a complete DuoPlus template fetch and disables source-scoped rows absent from it.';
