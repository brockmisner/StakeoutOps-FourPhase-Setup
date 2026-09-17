-- Run only against a disposable database after applying all migrations.
-- All fixture data rolls back. No external calls, credentials, or devices.
begin;

do $test$
declare
  v_user uuid := gen_random_uuid();
  v_org uuid := gen_random_uuid();
  v_other_org uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_other_client uuid := gen_random_uuid();
  v_connection uuid := gen_random_uuid();
  v_phone uuid := gen_random_uuid();
  v_template uuid := gen_random_uuid();
  v_program uuid;
  v_legacy uuid;
  v_cycle uuid := gen_random_uuid();
  v_run uuid;
  v_plan jsonb := '{"version":1,"warmupDays":10,"moneyDays":3,"finalSqueezeDays":3,"afterActionDays":14,"continueDailyTasks":true,"appRequirements":[{"appKind":"chrome","minSuccessfulRuns":10,"minActiveDays":8}]}';
  v_rules jsonb;
  v_gate jsonb;
  v_count integer;
  v_assertion_failed boolean;
  v_history_phone uuid := gen_random_uuid();
  v_history_cycle uuid := gen_random_uuid();
  v_long_cycle uuid := gen_random_uuid();
  v_long_program uuid;
  v_long_plan jsonb;
  v_long_rules jsonb;
begin
  insert into auth.users(id, email) values(v_user, 'phase-fixture@example.invalid');
  insert into public.organizations(id, name, slug, owner_user_id)
  values(v_org, 'Phase fixture', 'phase-fixture', v_user),
    (v_other_org, 'Other fixture', 'other-phase-fixture', v_user);
  insert into public.clients(id, organization_id, name, brand_name, domain)
  values(v_client, v_org, 'Miami fixture', 'Miami fixture', 'example.invalid'),
    (v_other_client, v_org, 'Other client', 'Other client', 'example.invalid');
  insert into public.duo_connections(id, organization_id, name, status,
    api_key_ciphertext, api_key_iv, api_key_auth_tag, subscription_capacity,
    subscription_in_use, subscription_available, subscription_synced_at)
  values(v_connection, v_org, 'Fixture connection', 'active', 'fixture-only', 'fixture-only', 'fixture-only',
    3, 0, 3, clock_timestamp());
  perform public.link_duoplus_capacity_pool(v_connection, v_org, repeat('a', 64), 3);
  insert into public.duo_phones(id, organization_id, connection_id, client_id, duoplus_image_id, name)
  values(v_phone, v_org, v_connection, v_client, 'phase-fixture-phone', 'Miami fixture 01');
  insert into public.duo_templates(id, organization_id, connection_id, duoplus_template_id, name)
  values(v_template, v_org, v_connection, 'phase-fixture-template', 'Fixture observation');

  select jsonb_agg(jsonb_build_object(
    'templateId', v_template, 'name', phase.kind || ' ' || item.n,
    'ruleKind', 'daily_range', 'phaseKind', phase.kind,
    'appKind', case when phase.kind = 'baseline' then
      (array['chrome','maps','google','waze','gmail'])[item.n] else 'chrome' end,
    'points', 1, 'startDay', win.start_day, 'endDay', win.end_day,
    'localTime', '09:00', 'sequence', phase.offset_number + item.n,
    'required', true
  ) order by phase.offset_number + item.n) into v_rules
  from (values('baseline',5,0),('money',4,5),('final_squeeze',6,9),('after_action',4,15))
    as phase(kind, task_count, offset_number)
  cross join lateral generate_series(1, phase.task_count) as item(n)
  cross join lateral public.get_cycle_phase_window(v_plan, phase.kind) as win;

  v_program := public.create_cycle_program(v_org, v_connection, 'Thirty day phase fixture',
    30, 'America/New_York', v_rules, v_user, 10, 80, 90, v_plan);
  assert (select phase_plan = v_plan from public.cycle_programs where id = v_program), 'Phase plan was not saved';

  v_assertion_failed := false;
  begin
    perform public.create_cycle_program(v_org, v_connection, 'Optional bypass',
      30, 'America/New_York', (
        select jsonb_agg(jsonb_set(value, '{required}', 'false')) from jsonb_array_elements(v_rules)
      ), v_user, 10, 80, 90, v_plan);
    v_assertion_failed := true;
  exception when check_violation then null; end;
  assert not v_assertion_failed, 'Optional rules bypassed required minimum counts';

  v_assertion_failed := false;
  begin
    update public.cycle_programs set phase_plan = jsonb_set(v_plan, '{continueDailyTasks}', 'false') where id = v_program;
    v_assertion_failed := true;
  exception when check_violation then null; end;
  assert not v_assertion_failed, 'Published phase plan was mutable';

  v_legacy := public.create_cycle_program(v_org, v_connection, 'Legacy fixture',
    15, 'UTC', jsonb_build_array((v_rules->0) - 'phaseKind' || jsonb_build_object('endDay', 15)), v_user);
  assert (select phase_plan is null from public.cycle_programs where id = v_legacy), 'Legacy factory compatibility failed';

  insert into public.device_cycles(id, organization_id, connection_id, client_id, phone_id, program_id,
    name, keyword, starts_on, ends_on, duration_days, timezone,
    target_country, target_region, target_city, target_latitude, target_longitude)
  values(v_cycle, v_org, v_connection, v_client, v_phone, v_program, 'Miami observation profile',
    'local observation', (clock_timestamp() at time zone 'America/New_York')::date,
    (clock_timestamp() at time zone 'America/New_York')::date + 29, 30, 'America/New_York',
    'US', 'Florida', 'Miami', 25.7617, -80.1918);
  assert (select dedicated_city = 'Miami' and dedicated_client_id = v_client from public.duo_phones where id = v_phone),
    'Phone was not persistently dedicated';

  v_assertion_failed := false;
  begin
    update public.duo_phones set client_id = v_other_client where id = v_phone;
    v_assertion_failed := true;
  exception when check_violation then null; end;
  assert not v_assertion_failed, 'Phone client assignment was mutable after dedication';
  v_assertion_failed := false;
  begin
    update public.device_cycles set target_city = 'Tampa' where id = v_cycle;
    v_assertion_failed := true;
  exception when check_violation then null; end;
  assert not v_assertion_failed, 'Cycle escaped its dedicated city';

  v_gate := public.get_device_cycle_phase_gate(v_org, v_cycle, 'money')->'phaseGate';
  assert (v_gate->>'missingRequiredRuns')::integer = 50, 'Unmaterialized required work did not block';
  assert v_gate->>'status' = 'waiting' and not (v_gate->>'allowed')::boolean, 'Future Money phase was allowed';

  v_count := public.activate_device_cycle(v_org, v_cycle);
  assert v_count = 236, 'Thirty day plan should materialize exactly 236 logical runs';
  select run.id into v_run from public.scheduler_runs as run
  join public.cycle_program_rules as rule on rule.id = run.program_rule_id
  where run.device_cycle_id = v_cycle and rule.phase_kind = 'money' order by run.cycle_day limit 1;
  assert not (public.get_scheduler_run_phase_gate(v_other_org, v_run)->>'allowed')::boolean,
    'Cross-organization run access did not fail closed';

  v_assertion_failed := false;
  begin
    update public.scheduler_runs set submission_state = 'attempting', submission_started_at = clock_timestamp() where id = v_run;
    v_assertion_failed := true;
  exception when check_violation then null; end;
  assert not v_assertion_failed, 'Database submission fence allowed unfinished warmup';

  -- Award ten separate planned Chrome days, all completed on one actual local
  -- date. The run quota is met, but the eight-active-day quota must remain unmet.
  update public.scheduler_runs as run set status = 'succeeded', finished_at = clock_timestamp()
  from public.cycle_program_rules as rule
  where run.program_rule_id = rule.id and run.device_cycle_id = v_cycle
    and rule.phase_kind = 'baseline' and rule.app_kind = 'chrome' and run.cycle_day <= 10;
  v_gate := public.get_device_cycle_phase_gate(v_org, v_cycle, 'money')->'phaseGate';
  assert (v_gate->'requirements'->0->>'successfulRuns')::integer = 10, 'Successful logical run count incorrect';
  assert (v_gate->'requirements'->0->>'activeDays')::integer = 1, 'Planned days inflated actual active days';
  assert not (v_gate->'requirements'->0->>'met')::boolean, 'App active-day requirement was bypassed';
  perform public.reconcile_profile_score_credits(1000);
  v_gate := public.get_device_cycle_phase_gate(v_org, v_cycle, 'money')->'phaseGate';
  assert (v_gate->'requirements'->0->>'successfulRuns')::integer = 10, 'Credit reconciliation double-counted runs';

  update public.scheduler_runs set status = 'cancelled', finished_at = clock_timestamp() where id = v_run;
  assert (select done = 10 from public.get_device_cycle_run_counts(v_org) where device_cycle_id = v_cycle),
    'Cancellation was reported as successful completion';

  assert exists (select 1 from public.get_device_cycle_phase_gates(v_org) where device_cycle_id = v_cycle),
    'Batch phase gate omitted the cycle';
  assert not has_function_privilege('authenticated', 'public.get_scheduler_run_phase_gate(uuid,uuid)', 'EXECUTE'),
    'Authenticated callers can execute internal dispatch gate';
  assert not has_function_privilege('anon', 'public.get_device_cycle_phase_gates(uuid)', 'EXECUTE'),
    'Anonymous callers can read tenant phase gates';

  -- Model a cycle that was activated 35 days ago. This disposable fixture
  -- disables only the late-activation/immutable-identity trigger during its
  -- historical setup; all phase, score, run, city, and capacity fences stay on.
  insert into public.duo_phones(id, organization_id, connection_id, client_id, duoplus_image_id, name)
  values(v_history_phone, v_org, v_connection, v_client, 'historical-phase-phone', 'Historical Miami phone');
  insert into public.device_cycles(id, organization_id, connection_id, client_id, phone_id, program_id,
    name, keyword, starts_on, ends_on, duration_days, timezone,
    target_country, target_region, target_city, target_latitude, target_longitude)
  values(v_history_cycle, v_org, v_connection, v_client, v_history_phone, v_program, 'Historical cycle',
    'observation', (clock_timestamp() at time zone 'America/New_York')::date - 35,
    (clock_timestamp() at time zone 'America/New_York')::date - 6, 30, 'America/New_York',
    'US', 'Florida', 'Miami', 25.7617, -80.1918);
  alter table public.device_cycles disable trigger stakeout_validate_device_cycle;
  perform public.activate_device_cycle(v_org, v_history_cycle);
  alter table public.device_cycles enable trigger stakeout_validate_device_cycle;
  v_gate := public.get_device_cycle_phase_gate(v_org, v_history_cycle, 'money')->'phaseGate';
  assert v_gate->>'status' = 'recovery_required' and not (v_gate->>'allowed')::boolean,
    'Elapsed time bypassed missing required warmup work';

  update public.scheduler_runs as run set status = 'succeeded',
    finished_at = ((cycle.starts_on + run.cycle_day - 1)::timestamp + interval '12 hours') at time zone cycle.timezone
  from public.cycle_program_rules as rule, public.device_cycles as cycle
  where run.program_rule_id = rule.id and cycle.id = run.device_cycle_id
    and run.device_cycle_id = v_history_cycle and rule.phase_kind = 'baseline' and run.cycle_day <= 10;
  v_gate := public.get_device_cycle_phase_gate(v_org, v_history_cycle, 'money')->'phaseGate';
  assert (v_gate->>'allowed')::boolean and (v_gate->'requirements'->0->>'activeDays')::integer = 10,
    'Successful warmup on ten actual local days did not unlock Money';
  v_gate := public.get_device_cycle_phase_gate(v_org, v_history_cycle, 'final_squeeze')->'phaseGate';
  assert (v_gate->>'missingRequiredRuns')::integer = 27 and not (v_gate->>'allowed')::boolean,
    'Final squeeze did not require all twelve Money and fifteen intervening baseline runs';

  update public.scheduler_runs as run set status = 'succeeded',
    finished_at = ((cycle.starts_on + run.cycle_day - 1)::timestamp + interval '12 hours') at time zone cycle.timezone
  from public.cycle_program_rules as rule, public.device_cycles as cycle
  where run.program_rule_id = rule.id and cycle.id = run.device_cycle_id
    and run.device_cycle_id = v_history_cycle
    and (rule.phase_kind = 'money' or (rule.phase_kind = 'baseline' and run.cycle_day <= 13));
  assert (public.get_device_cycle_phase_gate(v_org, v_history_cycle, 'final_squeeze')->'phaseGate'->>'allowed')::boolean,
    'Completed Money and intervening baseline work did not unlock Final squeeze';
  v_gate := public.get_device_cycle_phase_gate(v_org, v_history_cycle, 'after_action')->'phaseGate';
  assert (v_gate->>'missingRequiredRuns')::integer = 33 and not (v_gate->>'allowed')::boolean,
    'After action did not require all eighteen Final squeeze and fifteen intervening baseline runs';

  update public.scheduler_runs as run set status = 'succeeded',
    finished_at = ((cycle.starts_on + run.cycle_day - 1)::timestamp + interval '12 hours') at time zone cycle.timezone
  from public.cycle_program_rules as rule, public.device_cycles as cycle
  where run.program_rule_id = rule.id and cycle.id = run.device_cycle_id
    and run.device_cycle_id = v_history_cycle
    and (rule.phase_kind = 'final_squeeze' or (rule.phase_kind = 'baseline' and run.cycle_day <= 16));
  assert (public.get_device_cycle_phase_gate(v_org, v_history_cycle, 'after_action')->'phaseGate'->>'allowed')::boolean,
    'Completed prior work did not unlock After action';
  assert (select state <> 'completed' from public.device_profiles where device_cycle_id = v_history_cycle),
    'Elapsed cycle duration counted pending After action tasks as completed';
  update public.scheduler_runs as run set status = 'succeeded',
    finished_at = ((cycle.starts_on + run.cycle_day - 1)::timestamp + interval '12 hours') at time zone cycle.timezone
  from public.device_cycles as cycle
  where cycle.id = run.device_cycle_id and run.device_cycle_id = v_history_cycle and run.status <> 'succeeded';
  assert (select state = 'completed' from public.device_profiles where device_cycle_id = v_history_cycle),
    'All required successful work and elapsed duration did not complete the profile';
  assert (select status = 'completed' from public.device_cycles where id = v_history_cycle),
    'Completed profile did not close its cycle';

  v_long_plan := v_plan || '{"warmupDays":14,"moneyDays":5,"finalSqueezeDays":3,"afterActionDays":14}'::jsonb;
  select jsonb_agg(rule.value || jsonb_build_object('startDay', win.start_day, 'endDay', win.end_day))
  into v_long_rules from jsonb_array_elements(v_rules) as rule(value)
  cross join lateral public.get_cycle_phase_window(v_long_plan, rule.value->>'phaseKind') as win;
  v_long_program := public.create_cycle_program(v_org, v_connection, 'Thirty six day fixture',
    36, 'America/New_York', v_long_rules, v_user, 14, 80, 90, v_long_plan);
  insert into public.device_cycles(id, organization_id, connection_id, client_id, phone_id, program_id,
    name, keyword, starts_on, ends_on, duration_days, timezone,
    target_country, target_region, target_city, target_latitude, target_longitude)
  values(v_long_cycle, v_org, v_connection, v_client, v_history_phone, v_long_program, 'Thirty six day cycle',
    'observation', (clock_timestamp() at time zone 'America/New_York')::date + 1,
    (clock_timestamp() at time zone 'America/New_York')::date + 36, 36, 'America/New_York',
    'US', 'Florida', 'Miami', 25.7617, -80.1918);
  v_count := public.activate_device_cycle(v_org, v_long_cycle);
  assert v_count = 274, 'Thirty six day plan should materialize 274 logical runs';
  assert (select max(cycle_day) = 36 from public.scheduler_runs where device_cycle_id = v_long_cycle),
    'Thirty six day activation truncated its final required day';
  raise notice 'PASS four-phase factory, city assignment, coverage, app days, idempotency, submission, tenant fences, positive progression, completion, and 36-day activation';
end;
$test$;

rollback;
