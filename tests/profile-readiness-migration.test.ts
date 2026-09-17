import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260905203000_profile_readiness.sql",
    import.meta.url,
  ),
  "utf8",
);

const cycleMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260905180020_device_cycles_proxy_alignment.sql",
    import.meta.url,
  ),
  "utf8",
);

function sqlFunction(name: string): string {
  const start = migration.indexOf(`create or replace function public.${name}`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const bodyStart = migration.indexOf("as $function$", start);
  const end = migration.indexOf("$function$;", bodyStart + 13);
  expect(bodyStart, `${name} must have a function body`).toBeGreaterThan(start);
  expect(end, `${name} must have a closed function body`).toBeGreaterThan(bodyStart);
  return migration.slice(start, end + "$function$;".length);
}

describe("profile readiness database boundaries", () => {
  it("keeps profile rows tenant-readable but service-only writable", () => {
    expect(migration).toContain(
      "alter table public.device_profiles enable row level security",
    );
    expect(migration).toContain(
      "alter table public.profile_score_events enable row level security",
    );
    expect(migration).toContain(
      "using (public.is_organization_member(organization_id))",
    );
    expect(migration).toMatch(
      /revoke all on table public\.device_profiles, public\.profile_score_events\s+from anon, authenticated;/,
    );
    expect(migration).toMatch(
      /grant select on table public\.device_profiles, public\.profile_score_events\s+to authenticated;/,
    );
    expect(migration).not.toMatch(
      /grant (?:insert|update|delete|all) on table public\.(?:device_profiles|profile_score_events) to authenticated/,
    );
  });

  it("makes one successful run worth at most one immutable credit", () => {
    expect(migration).toContain(
      "constraint profile_score_events_run_unique unique (run_id)",
    );
    expect(migration).toContain("on conflict (run_id) do nothing");
    expect(migration).toContain(
      "before update or delete on public.profile_score_events",
    );
    expect(migration).toContain("Profile score events are immutable");
    expect(migration).toContain(
      "Profile score event must exactly match a successful scored run",
    );

    const credit = sqlFunction("credit_profile_run");
    expect(credit).toContain("v_run.status <> 'succeeded'");
    expect(credit).toContain("v_run.planned_points");
    expect(credit).toContain(
      "v_run.lease_owner is distinct from nullif(btrim(p_worker_id), '')",
    );
  });

  it("isolates scoring from canonical success and provides bounded repair", () => {
    const trigger = sqlFunction("stakeout_credit_profile_run_trigger");
    expect(trigger).toContain("old.status is distinct from new.status");
    expect(trigger).toContain("perform public.credit_profile_run(new.id, null)");
    expect(trigger).toContain("exception when others");
    expect(trigger).toContain("raise warning");

    const reconcile = sqlFunction("reconcile_profile_score_credits");
    expect(reconcile).toContain("run.status = 'succeeded'");
    expect(reconcile).toContain("not exists");
    expect(reconcile).toContain("public.credit_profile_run(v_run_id, null)");
  });

  it("snapshots immutable score and cycle associations onto each run", () => {
    const snapshot = sqlFunction("stakeout_snapshot_profile_run");
    expect(snapshot).toContain("new.profile_id is distinct from old.profile_id");
    expect(snapshot).toContain("new.app_kind is distinct from old.app_kind");
    expect(snapshot).toContain("new.planned_points is distinct from old.planned_points");
    expect(snapshot).toContain("new.device_cycle_id is distinct from old.device_cycle_id");
    expect(snapshot).toContain("new.program_rule_id is distinct from old.program_rule_id");
  });

  it("validates profile, cycle, and score-event tenant identity", () => {
    const eventValidation = sqlFunction(
      "stakeout_validate_profile_score_event",
    );
    for (const predicate of [
      "run.organization_id = new.organization_id",
      "run.connection_id = new.connection_id",
      "run.profile_id = new.profile_id",
      "run.device_cycle_id = new.device_cycle_id",
      "run.status = 'succeeded'",
      "run.planned_points = new.points",
    ]) {
      expect(eventValidation).toContain(predicate);
    }

    const cycleLink = sqlFunction("stakeout_validate_cycle_profile_link");
    expect(cycleLink).toContain(
      "new.profile_id is distinct from old.profile_id",
    );
    expect(cycleLink).toContain("profile.organization_id = new.organization_id");
    expect(cycleLink).toContain("profile.connection_id = new.connection_id");
    expect(cycleLink).toContain("profile.client_id = new.client_id");
    expect(cycleLink).toContain("profile.phone_id = new.phone_id");
  });

  it("does not add a second open-profile mutex beside the cycle mutex", () => {
    // A phone can have many historical profiles. The existing device-cycle
    // partial unique index is the source of truth for at most one open cycle.
    expect(migration).not.toContain("device_profiles_one_open_per_phone_idx");
  });

  it("backfills existing cycles and their successful run history", () => {
    expect(migration).toMatch(
      /insert into public\.device_profiles[\s\S]*from public\.device_cycles as cycle/,
    );
    expect(migration).toMatch(
      /insert into public\.profile_score_events[\s\S]*from public\.scheduler_runs as run[\s\S]*where run\.status = 'succeeded'/,
    );
  });

  it("keeps published scoring rules and threshold ordering immutable", () => {
    expect(migration).toContain(
      "completion_threshold_percent >= ready_threshold_percent",
    );
    expect(cycleMigration).toContain(
      "Rules on a published or retired cycle program are immutable",
    );
    expect(cycleMigration).toMatch(
      /before insert or update or delete on public\.cycle_program_rules/,
    );
  });

  it("refreshes failures and applies the full set of completion gates", () => {
    const refresh = sqlFunction("refresh_profile_readiness");
    expect(refresh).toContain("rule.required");
    expect(refresh).toContain("v_all_apps_covered");
    expect(refresh).toContain("and v_all_apps_covered");

    const terminalTrigger = sqlFunction("stakeout_credit_profile_run_trigger");
    expect(terminalTrigger).toMatch(
      /new\.status in \('succeeded', 'failed', 'cancelled'\)/,
    );
    expect(terminalTrigger).toContain(
      "perform public.refresh_profile_readiness(new.profile_id)",
    );
  });

  it("bounds app-score aggregation to the displayed profile cohort", () => {
    const aggregate = sqlFunction("get_profile_app_scores");
    expect(aggregate).toContain("limit 300");
    expect(aggregate).toContain("profile.organization_id = p_organization_id");
    expect(migration).toContain(
      "profile_score_events_org_profile_app_idx",
    );
    expect(migration).toContain("device_profiles_org_created_idx");
  });

  it("keeps the bounded repair scan index-backed", () => {
    const reconcile = sqlFunction("reconcile_profile_score_credits");
    expect(reconcile).toContain("for update of run skip locked");
    expect(reconcile).toContain("limit p_limit");
    expect(migration).toContain(
      "scheduler_runs_uncredited_profile_success_idx",
    );
  });

  it("keeps all readiness RPCs unavailable to browser roles", () => {
    for (const signature of [
      "public.refresh_profile_readiness(uuid)",
      "public.credit_profile_run(uuid, text)",
      "public.get_profile_app_scores(uuid)",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `revoke all on function ${signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+from public, anon, authenticated;`,
        ),
      );
    }
  });
});
