-- Cover the multi-column foreign keys used by cycle provisioning and cleanup.
-- These indexes keep tenant-scoped joins and parent deletes bounded as cycle
-- history grows across many clients and phones.

create index if not exists cycle_program_rules_program_fk_idx
  on public.cycle_program_rules (organization_id, connection_id, program_id);

create index if not exists device_cycles_phone_fk_idx
  on public.device_cycles (organization_id, connection_id, phone_id);

create index if not exists phone_proxy_bindings_cycle_fk_idx
  on public.phone_proxy_bindings (organization_id, connection_id, device_cycle_id);

create index if not exists phone_proxy_bindings_list_fk_idx
  on public.phone_proxy_bindings (organization_id, proxy_list_id);

create index if not exists phone_proxy_bindings_phone_fk_idx
  on public.phone_proxy_bindings (organization_id, connection_id, phone_id);

create index if not exists scheduler_schedules_cycle_fk_idx
  on public.scheduler_schedules (organization_id, connection_id, device_cycle_id)
  where device_cycle_id is not null;

create index if not exists scheduler_schedules_program_rule_fk_idx
  on public.scheduler_schedules (organization_id, connection_id, program_rule_id)
  where program_rule_id is not null;

create index if not exists scheduler_runs_cycle_fk_idx
  on public.scheduler_runs (organization_id, connection_id, device_cycle_id)
  where device_cycle_id is not null;

create index if not exists scheduler_runs_program_rule_fk_idx
  on public.scheduler_runs (organization_id, connection_id, program_rule_id)
  where program_rule_id is not null;
