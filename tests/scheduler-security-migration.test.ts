import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260906224153_scheduler_security_and_lease_hardening.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("scheduler security and lease migration", () => {
  it("scrubs legacy log payloads and phone metadata recursively", () => {
    expect(migration).toContain(
      "create or replace function public.stakeout_redact_sensitive_jsonb",
    );
    expect(migration).toContain(
      "public.stakeout_redact_sensitive_jsonb(v_item)",
    );
    expect(migration).toMatch(
      /apikey\|accesskey\|authorization\|cookie\|credential\|password\|privatekey/,
    );
    expect(migration).toMatch(/proxy\(user\(name\)\?\|login\)\|secret\|session\|token/);
    expect(migration).toMatch(/update public\.duo_outbound_logs[\s\S]*request_body/);
    expect(migration).toMatch(/update public\.duo_phones[\s\S]*metadata/);
    expect(migration).toContain("stakeout_redact_duo_outbound_log");
    expect(migration).toContain("stakeout_redact_duo_phone_metadata");
  });

  it("removes member access to raw outbound payloads", () => {
    expect(migration).toContain(
      "drop policy if exists stakeout_outbound_logs_read_member",
    );
    expect(migration).toContain(
      "revoke all on table public.duo_outbound_logs from anon, authenticated",
    );
    expect(migration).toContain(
      "grant all on table public.duo_outbound_logs to service_role",
    );
  });

  it("fences remote submissions and separates the post-submit validity check", () => {
    expect(migration).toMatch(
      /create or replace function public\.authorize_run_submission[\s\S]*run\.submission_state = 'never'/,
    );
    expect(migration).toContain(
      "create or replace function public.validate_run_after_submission",
    );
    expect(migration).toMatch(
      /v_existing_task and \(\s*v_run\.phone_id is null\s*or v_run\.phone_id <> p_phone_id/,
    );
    expect(migration).toMatch(
      /v_starts_attempt := not v_existing_task and/,
    );
    expect(migration).toMatch(
      /create or replace function public\.acquire_phone_lease\(\s*p_phone_id uuid,\s*p_run_id uuid,\s*p_worker_id text,\s*p_run_lease_token uuid,/,
    );
    expect(migration).toMatch(
      /create or replace function public\.authorize_run_submission\([\s\S]*p_run_lease_token uuid[\s\S]*run\.lease_token = p_run_lease_token/,
    );
    expect(migration).toMatch(
      /p_submission_started_at timestamptz[\s\S]*set stage = 'submit_task',[\s\S]*submission_state = 'attempting'/,
    );
    expect(migration).toMatch(
      /from public\.scheduler_schedules as schedule,[\s\S]*public\.duo_templates as template,[\s\S]*public\.duo_connections as connection[\s\S]*schedule\.enabled[\s\S]*template\.enabled[\s\S]*connection\.status = 'active'/,
    );
    expect(migration).toMatch(
      /connection\.api_key_ciphertext is not null[\s\S]*phone\.enabled[\s\S]*phone\.provider_present/,
    );
    expect(migration).toMatch(
      /create or replace function public\.validate_run_after_submission\([\s\S]*run\.lease_token = p_run_lease_token/,
    );
  });

  it("renews the matching run and phone lease in one function", () => {
    expect(migration).toMatch(
      /create or replace function public\.renew_run_lease[\s\S]*phone\.lease_run_id = v_run\.id[\s\S]*phone\.lease_token = v_run\.phone_lease_token/,
    );
    expect(migration).toMatch(
      /update public\.duo_phones[\s\S]*busy_until = greatest[\s\S]*lease_expires_at = greatest/,
    );
    expect(migration).toContain("v_run.lease_token is distinct from p_run_lease_token");
    expect(migration).toContain("interval '60 minutes'");
    expect(migration).not.toContain("interval '24 hours'");
  });

  it("fences both phone and run cleanup by the lease generation", () => {
    expect(migration).toContain(
      "create or replace function public.release_phone_lease",
    );
    expect(migration).toContain(
      "create or replace function public.release_run_lease",
    );
    expect(migration).toContain(
      "revoke all on function public.release_run_lease(uuid, text)",
    );
    expect(migration).toMatch(
      /create or replace function public\.release_run_lease\(\s*p_run_id uuid,\s*p_worker_id text\s*\)[\s\S]*select false/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.release_run_lease\(uuid, text\)\s*to service_role/,
    );
  });

  it("keeps legacy RPC overloads callable but fail-closed during rollout", () => {
    for (const functionName of [
      "acquire_phone_lease",
      "authorize_run_submission",
      "release_run_lease",
      "renew_run_lease",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `create or replace function public\\.${functionName}\\([\\s\\S]*?select false`,
        ),
      );
    }
    expect(migration).toContain(
      "Legacy RPC overloads remain callable but fail closed",
    );
  });

  it("repairs and reaps ambiguous submissions into reconciliation without replay", () => {
    expect(migration).toMatch(
      /do \$repair_ambiguous_submissions\$[\s\S]*run\.status = 'failed'[\s\S]*run\.duoplus_task_id is null[\s\S]*run\.submission_state in \('attempting', 'accepted', 'unknown'\)[\s\S]*set status = 'retry_wait',[\s\S]*stage = 'resolve_task'/,
    );
    expect(migration).toContain("create or replace function public.reap_expired_run_leases");
    expect(migration).toMatch(
      /v_reconciliation_only := v_run\.submission_state in \(\s*'attempting', 'accepted', 'unknown'\s*\) or v_run\.duoplus_task_id is not null/,
    );

    const reconciliationBranch = migration.match(
      /if v_reconciliation_only then([\s\S]*?)elsif v_run\.status = 'preparing' then/,
    )?.[1];
    expect(reconciliationBranch).toBeDefined();
    expect(reconciliationBranch).toContain("status = 'retry_wait'");
    expect(reconciliationBranch).toContain("stage = 'resolve_task'");
    expect(reconciliationBranch).toContain("lease_token = v_run.lease_token");
    expect(reconciliationBranch).not.toContain("scheduler_run_attempts");
    expect(reconciliationBranch).not.toMatch(/attempt_count\s*=/);
    expect(reconciliationBranch).not.toMatch(/submission_state\s*=/);

    expect(migration).toMatch(
      /elsif v_run\.status = 'preparing' then[\s\S]*Only submission_state=never[\s\S]*update public\.scheduler_run_attempts/,
    );
    expect(migration).toMatch(
      /update public\.duo_phones[\s\S]*lease_run_id = v_run\.id[\s\S]*lease_token = v_run\.phone_lease_token/,
    );
  });

  it("keeps repaired reconciliation claimable past schedule and attempt gates", () => {
    expect(migration).toContain("create or replace function public.claim_due_runs");
    expect(migration).toMatch(
      /schedule\.enabled[\s\S]*or run\.submission_state <> 'never'[\s\S]*or run\.duoplus_task_id is not null[\s\S]*or run\.stage in \('cancel_task', 'resolve_task', 'monitor_task', 'fetch_logs'\)/,
    );
    expect(migration).toMatch(
      /or run\.submission_state <> 'never'[\s\S]*or run\.duoplus_task_id is not null[\s\S]*or run\.attempt_count < run\.max_attempts/,
    );
  });
});
