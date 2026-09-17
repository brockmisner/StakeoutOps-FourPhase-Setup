# Deploy Stakeout Ops to Vercel

This guide deploys one shared Stakeout Ops application while keeping each person's DuoPlus key and inventory isolated in their own Supabase-backed workspace.

## Current deployment

The current source runs automatic scheduling on Railway. Start with [SETUP.md](../SETUP.md), [Railway worker configuration](railway-worker.md), and [deployment status](deployment-status.md). The dashboard stays on Vercel; Supabase stores the queue and claims. `vercel.json` has no cron jobs.

Sections 5A and 5B below describe optional legacy trigger configurations. They are not enabled in this source. Use them only if deliberately replacing the Railway worker, after stopping that worker. The authentication, migration, timestamp-probe, and device-verification details remain applicable.

## Prerequisites

- A Vercel project connected to this repository.
- A hosted Supabase project. Use a separate project for previews if preview deployments need real data.
- Node.js 22 or newer for local builds and the Vercel project runtime.
- Supabase CLI access and the database password for schema migration.
- `curl` and `jq` for the manual DuoPlus probe.
- At least one DuoPlus user-template id and one powered-on cloud phone for the final integration test.
- Phones whose dedicated proxies have already been configured and are maintained outside Stakeout Ops.

Do not use a user's DuoPlus key as a deployment environment variable. Users add keys after signing in; the app encrypts each key under its workspace.

Production v1 does not require Proxy-Seller credentials. It treats the proxy already on each phone as external configuration and never creates, rotates, changes, verifies, or health-checks it. Leave Proxy-Seller automation disabled for launch.

Use a distinct DuoPlus account per workspace. The rate gate is keyed by the local connection id, so two workspaces that reuse one upstream key can collectively violate the account's one-request-per-second limit.

**Blocking timestamp preflight:** DuoPlus's `issue_at` string contains no UTC offset. The adapter defaults each connection's `issue_timezone` to `UTC`, but that interpretation must be confirmed against your DuoPlus account before enabling recurring schedules. The manual probe below schedules a task two minutes ahead specifically to expose a timezone mismatch.

## 1. Migrate a Supabase project

Take a database backup or create a Supabase branch before changing a project that already contains production data. The migration adds application tables, policies, and RPCs; it must not replace unrelated schemas.

The checked-in migration under `supabase/migrations/` supports two deliberate starting states. On a fresh project, when `organizations`, `organization_members`, and `clients` are all absent, it bootstraps those tenancy tables with their grants and RLS policies. When all three already exist, it preserves their definitions, grants, and policies and validates the columns Stakeout Ops needs before adding the scheduler tables. A partial base schema, or an existing schema with incompatible ownership semantics, fails closed. Compare existing columns, keys, role values, and RLS behavior with the bootstrap definitions before pushing; stop and write a deliberate compatibility migration if they differ.

First inspect the installed CLI instead of assuming flags from another version:

```bash
npx supabase --version
npx supabase --help
npx supabase db --help
npx supabase migration --help
```

Link the repository to the existing project:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase migration list --linked
```

If the remote project already has migration history that belongs in this repository, reconcile it on a dedicated integration branch before continuing; inspect `npx supabase migration fetch --help` and `npx supabase db pull --help` for the installed CLI. Do not blindly run `db pull` into the current chain: a newly generated baseline can sort after the Stakeout Ops migration and duplicate pre-existing base tables during a future local reset. A Dashboard-managed project can receive the additive Stakeout Ops migration directly, provided the compatibility review above passes. Establish a clean baseline as a separate migration-history project afterward if this repository must become the source of truth for all of the pre-existing schema.

Preview exactly what the linked project will receive, then apply it:

```bash
npx supabase db push --linked --dry-run
npx supabase db push --linked
npx supabase migration list --linked
npx supabase db lint --linked --fail-on error
```

Never run `supabase db reset --linked` on an existing project; remote reset drops user-created objects. Resolve a migration-history mismatch deliberately with `supabase migration repair` only after comparing the local and remote version lists.

After the push, verify that these objects exist in the Supabase SQL Editor:

```sql
select to_regclass('public.organizations') as organizations,
       to_regclass('public.duo_connections') as duo_connections,
       to_regclass('public.scheduler_runs') as scheduler_runs,
       to_regclass('public.duo_outbound_logs') as duo_outbound_logs;

select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'ensure_personal_workspace',
    'materialize_schedule_runs',
    'reap_expired_run_leases',
    'claim_due_runs',
    'acquire_phone_lease',
    'reserve_duoplus_rate_slot',
    'authorize_run_submission',
    'disconnect_duoplus_connection',
    'renew_run_lease',
    'release_run_lease',
    'prune_scheduler_history'
  )
order by routine_name;

select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in (
    'organizations',
    'organization_members',
    'clients',
    'duo_connections',
    'duo_phones',
    'duo_templates',
    'scheduler_schedules',
    'scheduler_runs'
  )
order by relname;
```

Every listed application table should report `relrowsecurity = true`. Supabase projects created with automatic Data API exposure disabled require explicit grants as well as RLS. The migration owns scheduler grants and supplies base-table grants only for a fresh bootstrap; compatible pre-existing tenancy tables retain their access model. If a browser call returns `42501`, inspect grants instead of disabling RLS.

## 2. Configure Supabase Auth

Configure only `supabase-apricot-globe` (`mvihrrewqzvqpsufzeid`), not the unrelated `stakeout` project. In Supabase Dashboard → Authentication:

1. Enable the Email provider. The UI supports both email/password and email magic-link sign-in.
2. Set the Site URL to exactly `https://stakeout-ops.vercel.app`.
3. Add the following Redirect URLs:

   ```text
   https://stakeout-ops.vercel.app/auth/callback
   https://*-brockmisner13211321-6243s-projects.vercel.app/**
   http://localhost:3000/**
   ```

   The exact URL is Production. The team-scoped wildcard lets the deployment that initiated a Vercel Preview login receive its own PKCE callback. Keep the localhost entry only for local development.
4. Keep email confirmation enabled for a public-facing deployment unless there is a deliberate alternative verification flow.
5. For an invitation-only production deployment, disable **Allow new users to sign up** and send invitations only to approved users from the Supabase dashboard.
6. In the Confirm signup, Invite user, and Magic link templates, keep the button link as `{{ .ConfirmationURL }}`. Do not hard-code localhost and do not use `{{ .SiteURL }}` as the action when the deployment-specific `redirectTo` must be preserved.
7. Configure custom SMTP for Production. Supabase's default mailer is development-only and heavily restricted, so an accepted signup or magic-link request does not guarantee reliable delivery.

If a message redirects to `http://localhost:3000/?code=...`, the Auth project is still falling back to its default Site URL instead of the requested `/auth/callback`. Correct the Site URL and allow list above, then request a fresh single-use email. Stakeout Ops also recognizes a code returned to the Production root and forwards it to the callback handler, but it cannot intercept a link whose host is another person's localhost.

Stakeout Ops also hides public signup unless `NEXT_PUBLIC_ALLOW_SIGNUPS=true`. That UI/page gate reduces accidental exposure, but it does **not** replace disabling new-user signup in Supabase Auth: the provider setting is the authoritative server-side control. Keep both closed in production. Temporarily open both only when deliberately testing public signup.

The first authenticated API request invokes `ensure_personal_workspace`, which creates the user's private organization and owner membership. Invite each approved friend separately; after signing in, they save their own DuoPlus key. Do not pre-seed shared credentials.

## 3. Create deployment secrets

Generate independent values:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

Use the first output as `INTEGRATION_ENCRYPTION_KEY` and the second as `CRON_SECRET`. Store both in a password manager before adding them to Vercel. Losing the encryption key makes stored DuoPlus credentials unrecoverable; changing it without re-encryption breaks every saved connection.

Configure these Vercel environment variables:

| Variable | Scope | Required | Value |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser + server | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser + server | Yes | Publishable key, never the secret key |
| `SUPABASE_SECRET_KEY` | Server only | Yes | Supabase secret key used after route authorization |
| `INTEGRATION_ENCRYPTION_KEY` | Server only | Yes | Base64-encoded 32-byte key |
| `PROXY_SELLER_AUTOMATION_ENABLED` | Server only | No | Future managed-proxy opt-in; leave unset or `false` for production v1 |
| `PROXY_SELLER_API_KEY` | Server only | No | Future managed-proxy credential; required only together with `PROXY_SELLER_AUTOMATION_ENABLED=true`, not for launch |
| `CRON_SECRET` | Server only | Yes | Random value of at least 32 characters |
| `NEXT_PUBLIC_APP_URL` | Browser + server | Yes | Canonical deployment URL, for example `https://ops.example.com` |
| `NEXT_PUBLIC_ALLOW_SIGNUPS` | Browser + server | No | Leave unset or `false` for invitation-only access; only exact `true` exposes signup |
| `NEXT_PUBLIC_DEMO_MODE` | Browser + server | Yes | `false` in any real deployment |
| `DUOPLUS_BASE_URL` | Server only | Optional | Defaults to `https://openapi.duoplus.net` |
| `DUOPLUS_MIN_GAP_MS` | Server only | Optional | Default and minimum recommended value: `1200` |
| `DUOPLUS_ISSUE_TIMEZONE` | Server only | Optional | Valid IANA timezone persisted for new connections; default `UTC`, subject to the manual probe below |
| `DISPATCH_LOOKAHEAD_MINUTES` | Server only | Optional | Recommended/default configuration `15` for minute dispatch |
| `DISPATCH_BATCH_SIZE` | Server only | Optional | Maximum minute-tick claim batch; defaults to `20` |
| `HORIZON_DISPATCH_BATCH_SIZE` | Server only | Optional | Maximum daily-horizon claim batch; defaults to `100` |

Use Vercel Project Settings → Environment Variables or the interactive `vercel env add <NAME> --sensitive` command for secrets. Never pass secret values on a command line, commit `.env.local`, or prefix a secret with `NEXT_PUBLIC_`.

For the production v1 deployment, do not add `PROXY_SELLER_API_KEY`; leave `PROXY_SELLER_AUTOMATION_ENABLED` unset or set it to `false`. The dormant managed-proxy path is a future opt-in and can run only when the flag is exactly `true` and a server-only key is present. If that mode is evaluated later, rotate any previously exposed key before storing its replacement, and never log a complete Proxy-Seller URL because the credential is part of the path.

Scope production secrets to Production. For Preview, use a separate Supabase project and separate encryption/cron secrets. If no preview database exists, use the static demo mode without server credentials rather than pointing arbitrary branch deployments at production data.

For local development after linking the Vercel project:

```bash
npx vercel env pull .env.local --yes
npm ci
npm run dev
```

`vercel env pull` replaces its target file. Keep manual local-only overrides in `.env.development.local` or restore them afterward.

## 4. Build and deploy

Validate the same artifact before production:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Deploy a preview, test invited authentication and workspace isolation, confirm `/signup` returns to the invitation-only login, then promote or deploy production:

```bash
npx vercel link
npx vercel deploy
npx vercel deploy --prod
```

Git integration can replace the final two commands: feature branches receive preview deployments and the production branch deploys to production. Cron jobs run only on production deployments.

After deployment, set `NEXT_PUBLIC_APP_URL` and the Supabase Auth Site URL to the final domain, then redeploy so the production build receives the canonical URL.

## 5A. Alternative Vercel Cron scheduler

For this optional configuration, stop the Railway worker and replace the empty cron list in `vercel.json` with the following definitions:

```json
{
  "crons": [
    {
      "path": "/api/cron/tick?mode=minute",
      "schedule": "* * * * *"
    },
    {
      "path": "/api/cron/tick?mode=horizon&hours=26",
      "schedule": "0 5 * * *"
    }
  ]
}
```

Vercel Cron expressions use UTC and invoke only production deployments. It calls the minute path every minute and the horizon path at 05:00 UTC. Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` when that Production environment variable exists. Confirm it is configured before deployment; a missing secret returns `503`, while a missing or mismatched bearer value returns `401`.

The route declares a 300-second function limit and stops scheduler work before that boundary. Minute mode uses `DISPATCH_LOOKAHEAD_MINUTES` (default `15`) and claims at most `DISPATCH_BATCH_SIZE` runs (default `20`). Horizon mode computes a 26-hour window, materializes unique runs, claims at most `HORIZON_DISPATCH_BATCH_SIZE` runs (default `100`), and prunes history. Monitor both request paths in Vercel Runtime Logs. At one DuoPlus call every 1.2 seconds per connection, phone power-on polling can dominate duration; reduce the relevant batch size if invocations approach the limit.

Schedule-level GPS or locale mutations are deferred until two minutes before execution so a future run cannot overwrite a phone too early. The minute job resumes those runs at the correct boundary. Leave idle time before a differently geotargeted run on the same phone: the worker refuses to mutate a phone during another run's planned window and shifts the later task forward if necessary. High-volume work on one connection remains sequential and can approach the function-duration budget even when other connections run in parallel.

Vercel documents Cron delivery as best effort and allows both missed and duplicate invocations. The scheduler is built for that contract: schedule occurrence uniqueness prevents duplicate materialization, database claims prevent two workers from owning one run, and phone leases prevent concurrent use of a device. A daily horizon invocation can overlap a minute invocation safely, although Vercel may run two function instances while either is still processing.

## 5B. Alternative minute mode with Supabase Cron (Railway stopped)

Use this only when Supabase, rather than Vercel Pro, should own the minute trigger. Before enabling it, remove `/api/cron/tick?mode=minute` from `vercel.json` and deploy that change. The daily Vercel horizon may remain enabled.

1. Enable Supabase Cron (`pg_cron`) in Dashboard → Integrations → Cron.
2. Enable `pg_net` in Database → Extensions.
3. Add the production tick URL and the same `CRON_SECRET` used by Vercel to Supabase Vault. Vault secrets are decrypted only inside the scheduled SQL command.

Create the secrets in the SQL Editor, replacing both placeholders:

```sql
select vault.create_secret(
  'https://<production-domain>/api/cron/tick?mode=minute',
  'stakeout_ops_tick_url',
  'Stakeout Ops production tick endpoint'
);

select vault.create_secret(
  '<same-value-as-vercel-CRON_SECRET>',
  'stakeout_ops_cron_secret',
  'Bearer secret for the Stakeout Ops tick endpoint'
);
```

Do not paste the secret directly into `cron.job`; its command text is inspectable. Schedule the Vault-backed request:

```sql
select cron.schedule(
  'stakeout-ops-minute-tick',
  '* * * * *',
  $job$
  select net.http_get(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'stakeout_ops_tick_url'
    ),
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'stakeout_ops_cron_secret'
      )
    ),
    timeout_milliseconds := 290000
  ) as request_id;
  $job$
);
```

Job names are case-sensitive. Re-running `cron.schedule` with the same name replaces the existing job. Inspect scheduling and delivery:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'stakeout-ops-minute-tick';

select jobid, status, start_time, end_time, return_message
from cron.job_run_details
where jobid = (
  select jobid from cron.job where jobname = 'stakeout-ops-minute-tick'
)
order by start_time desc
limit 20;

select id, status_code, timed_out, error_msg, created
from net._http_response
order by created desc
limit 20;
```

`pg_net` is asynchronous and currently beta; its response table is the delivery record, while Vercel Runtime Logs show application processing. The request timeout is deliberately close to the route's 300-second limit because a tick can perform several rate-spaced DuoPlus calls. A successful call should return HTTP `200`. `401` means the two cron-secret values differ.

The `mode=minute` query parameter is required. Without it, the route defaults to horizon mode and every minute invocation would scan and dispatch the next 26 hours. The endpoint accepts `GET` or `POST`, always requires `Authorization: Bearer <CRON_SECRET>`, and supports bounded overrides through `hours` (horizon), `lookahead` (minute), and `limit` query parameters for controlled recovery runs.

The daily Vercel horizon should remain enabled as the safety materializer. Do not enable this Supabase minute job until the Vercel minute entry has been removed in a production deployment; running two minute sources doubles wake-ups without improving the worker's one-minute resolution.

The application migration intentionally does not create a `pg_cron` job: the production domain and bearer secret are deployment-specific. Horizon ticks call `prune_scheduler_history` automatically. A minute-only installation with no daily horizon can add a low-frequency Supabase job:

```sql
select cron.schedule(
  'stakeout-ops-prune-history',
  '15 4 * * *',
  $job$ select * from public.prune_scheduler_history(); $job$
);
```

The RPC deletes up to 5,000 outbound logs older than 30 days and up to 5,000 run events older than 90 days per call, while preserving runs and attempts.

## 6. Exact manual DuoPlus probe

Run this before testing through the UI. It proves the upstream contract and uses a 1.2-second pause after every call. Run it in a disposable shell; the key remains only in that shell's environment.

```bash
export DUOPLUS_BASE_URL='https://openapi.duoplus.net'
read -r -s -p 'DuoPlus API key: ' DUOPLUS_API_KEY
export DUOPLUS_API_KEY
printf '\n'

duo_post() {
  local curl_status=0
  curl --silent --show-error --fail-with-body \
    --request POST \
    --header 'Content-Type: application/json' \
    --header "DuoPlus-API-Key: ${DUOPLUS_API_KEY}" \
    --header 'Lang: en' \
    --data "$2" \
    "${DUOPLUS_BASE_URL}$1" || curl_status=$?
  sleep 1.2
  return "$curl_status"
}
```

List custom templates and copy the SERP template `id`:

```bash
duo_post '/api/v1/automation/userTemplateList' '{"page":1,"pagesize":100}' | jq .
duo_post '/api/v1/automation/officialTemplateList' '{"page":1,"pagesize":100}' | jq .
export DUOPLUS_TEMPLATE_ID='<template-id>'
```

List powered-on phones and copy one phone `id` (the DuoPlus `image_id`):

```bash
duo_post '/api/v1/cloudPhone/list' '{"link_status":[1],"page":1,"pagesize":20}' | jq .
export DUOPLUS_IMAGE_ID='<image-id>'
```

Create a unique name and a UTC issue window. DuoPlus timestamps are minute precision in `YYYY-MM-DD HH:mm`, with no offset in the payload:

```bash
export PROBE_NAME="stk_probe_$(date -u +%s)"
export PROBE_ISSUE_AT="$(node -e "console.log(new Date(Date.now()+120000).toISOString().slice(0,16).replace('T',' '))")"
export PROBE_START="$(node -e "console.log(new Date(Date.now()-480000).toISOString().slice(0,16).replace('T',' '))")"
export PROBE_END="$(node -e "console.log(new Date(Date.now()+720000).toISOString().slice(0,16).replace('T',' '))")"
```

Create the waiting task:

```bash
ADD_BODY="$(jq -nc \
  --arg template_id "$DUOPLUS_TEMPLATE_ID" \
  --arg image_id "$DUOPLUS_IMAGE_ID" \
  --arg issue_at "$PROBE_ISSUE_AT" \
  --arg name "$PROBE_NAME" \
  '{template_id:$template_id,template_type:2,name:$name,remark:"manual deployment probe",images:[{image_id:$image_id,issue_at:$issue_at,config:{keyword:{key:"keyword",value:"beaches near me",type:"string",required:true}}}]}')"

ADD_RESPONSE="$(duo_post '/api/v1/automation/addTask' "$ADD_BODY")"
printf '%s\n' "$ADD_RESPONSE" | jq -e '.code == 200'
```

Immediately open DuoPlus Plan Management and verify that the task is scheduled for approximately two minutes from now—not merely that the API returned `code: 200`. If the displayed or actual start time is shifted, stop here. Confirm the timezone DuoPlus applies to API timestamps, then set this connection's `issue_timezone` to that IANA zone before continuing:

```sql
select id, organization_id, name, issue_timezone, key_hint
from public.duo_connections
where is_default;

update public.duo_connections
set issue_timezone = 'America/New_York'
where id = '<verified-connection-uuid>';
```

`issue_timezone` controls only serialization to DuoPlus. A schedule's `timezone` separately controls when its cron expression occurs. Do not compensate for a DuoPlus timestamp mismatch by changing every schedule's business timezone.

The expected create data may be only `{ "message": "success" }`. Find the task by exact name and issue window rather than reading an id from the create response:

```bash
LIST_BODY="$(jq -nc \
  --arg name "$PROBE_NAME" \
  --arg start "$PROBE_START" \
  --arg end "$PROBE_END" \
  '{name:$name,issue_at_start:$start,issue_at_end:$end,page:1,pagesize:20}')"

TASK_RESPONSE="$(duo_post '/api/v1/automation/taskList' "$LIST_BODY")"
printf '%s\n' "$TASK_RESPONSE" | jq .
export DUOPLUS_TASK_ID="$(printf '%s\n' "$TASK_RESPONSE" | jq -r \
  --arg name "$PROBE_NAME" \
  '[.data.list, .data.rows, .data.data, .data] | map(select(type == "array")) | first // [] | map(select(.name == $name)) | first | .id // empty')"
test -n "$DUOPLUS_TASK_ID"
```

Cancel before the task starts, then list again and confirm status `5`:

```bash
CANCEL_BODY="$(jq -nc --arg id "$DUOPLUS_TASK_ID" '{ids:[$id],status:5}')"
CANCEL_RESPONSE="$(duo_post '/api/v1/automation/setTaskStatus' "$CANCEL_BODY")"
printf '%s\n' "$CANCEL_RESPONSE" | jq -e '.code == 200'

duo_post '/api/v1/automation/taskList' "$LIST_BODY" | jq .
```

Finally, create a second task, allow it to finish, locate its id with `taskList`, and fetch proof:

```bash
export PROBE_NAME="stk_probe_$(date -u +%s)_finish"
export PROBE_ISSUE_AT="$(node -e "console.log(new Date(Date.now()+120000).toISOString().slice(0,16).replace('T',' '))")"
export PROBE_START="$(node -e "console.log(new Date(Date.now()-480000).toISOString().slice(0,16).replace('T',' '))")"
export PROBE_END="$(node -e "console.log(new Date(Date.now()+720000).toISOString().slice(0,16).replace('T',' '))")"

ADD_BODY="$(jq -nc \
  --arg template_id "$DUOPLUS_TEMPLATE_ID" \
  --arg image_id "$DUOPLUS_IMAGE_ID" \
  --arg issue_at "$PROBE_ISSUE_AT" \
  --arg name "$PROBE_NAME" \
  '{template_id:$template_id,template_type:2,name:$name,remark:"manual completion probe",images:[{image_id:$image_id,issue_at:$issue_at,config:{keyword:{key:"keyword",value:"beaches near me",type:"string",required:true}}}]}')"
duo_post '/api/v1/automation/addTask' "$ADD_BODY" | jq -e '.code == 200'

LIST_BODY="$(jq -nc \
  --arg name "$PROBE_NAME" \
  --arg start "$PROBE_START" \
  --arg end "$PROBE_END" \
  '{name:$name,issue_at_start:$start,issue_at_end:$end,page:1,pagesize:20}')"

PROBE_STATUS=''
for attempt in $(seq 1 120); do
  TASK_RESPONSE="$(duo_post '/api/v1/automation/taskList' "$LIST_BODY")"
  DUOPLUS_TASK_ID="$(printf '%s\n' "$TASK_RESPONSE" | jq -r \
    --arg name "$PROBE_NAME" \
    '[.data.list, .data.rows, .data.data, .data] | map(select(type == "array")) | first // [] | map(select(.name == $name)) | first | .id // empty')"
  PROBE_STATUS="$(printf '%s\n' "$TASK_RESPONSE" | jq -r \
    --arg name "$PROBE_NAME" \
    '[.data.list, .data.rows, .data.data, .data] | map(select(type == "array")) | first // [] | map(select(.name == $name)) | first | .status // empty')"
  printf 'task=%s status=%s\n' "$DUOPLUS_TASK_ID" "$PROBE_STATUS"
  if [ "$PROBE_STATUS" = '3' ] || [ "$PROBE_STATUS" = '4' ]; then break; fi
  sleep 5
done
if [ "$PROBE_STATUS" != '3' ] && [ "$PROBE_STATUS" != '4' ]; then
  printf 'Probe did not finish within the polling window.\n' >&2
  exit 1
fi
export DUOPLUS_TASK_ID

LOG_BODY="$(jq -nc --arg task_id "$DUOPLUS_TASK_ID" '{task_id:$task_id,pagesize:100}')"
LOG_RESPONSE="$(duo_post '/api/v1/automation/taskLogList' "$LOG_BODY")"
printf '%s\n' "$LOG_RESPONSE" | jq .
```

The completed probe must show `code: 200`, a task row found by the `stk_` name, and node logs. Record whether `result_info.extra_data.screenshot` is a string or an array for this DuoPlus template. Clear the shell variables afterward:

```bash
unset DUOPLUS_API_KEY DUOPLUS_TEMPLATE_ID DUOPLUS_IMAGE_ID DUOPLUS_TASK_ID
unset ADD_BODY ADD_RESPONSE LIST_BODY TASK_RESPONSE CANCEL_BODY CANCEL_RESPONSE LOG_BODY LOG_RESPONSE PROBE_STATUS
```

## 7. Production smoke test

1. Sign up as two different users. Confirm each receives a different organization and cannot select the other's `organizationId`.
2. Save a different DuoPlus key in each workspace. The API must never return plaintext or encrypted key material.
3. Run inventory sync. Confirm each workspace sees only its own phones plus custom and official templates, and that Command Center shows the same non-expired Subscription Startup total as DuoPlus. Verify that one assigned/in-use subscription and one available subscription are both counted.
4. Create one schedule on a powered-on phone and one on an off phone. Confirm the latter powers on before `addTask`.
5. Confirm `duo_outbound_logs` contains redacted entries and call starts for one connection are at least 1.2 seconds apart.
6. Confirm `addTask` is followed by `taskList` reconciliation and the run stores a DuoPlus task id.
7. Let a task finish and confirm node results, errors, and screenshots appear in run evidence.
8. Remove a waiting run and confirm cancellation reports it in `success`; surface `fail_reason` instead of assuming success.
9. With every Subscription Startup slot occupied, queue a run that requires an off phone. Confirm it stays deferred and that no Temporary Startup is purchased or used.
10. Create a device cycle in the default preconfigured-proxy mode with no Proxy-Seller variables present. Confirm activation succeeds without a provider call and that the Command Center map marker reflects the configured target location only; it is not observed proxy GEO or exit-IP verification.

## Operations and rollback

- Check Vercel Runtime Logs for tick status and Supabase Cron history for trigger delivery.
- Alert on repeated non-`200` DuoPlus envelopes, any DuoPlus `401`, expired leases, and runs that remain unreconciled after a successful `addTask`.
- Keep database backups and migration files. Roll back application code with `vercel rollback <deployment>`; use a forward database migration for schema corrections rather than reversing a migration that may already contain user data.
- Rotate a user's DuoPlus key by replacing that workspace connection. Rotate the application encryption key only with a tested re-encryption procedure.

## References

- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Supabase migration environments](https://supabase.com/docs/guides/deployment/managing-environments)
- [Supabase Cron](https://supabase.com/docs/guides/cron)
- [Supabase pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)
- [Supabase Vault](https://supabase.com/docs/guides/database/vault)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
