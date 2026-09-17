# Set up and run the four-phase scheduler

This is the complete Stakeout Ops source with the four-phase upgrade merged into the newer saved source from September 7. It includes the shared startup-pool migrations. You do not need to apply the earlier upgrade ZIP.

The app uses Next.js on Vercel, Supabase for accounts and the task database, a continuous Node.js worker on Railway, and DuoPlus RPA templates for device actions. GitHub stores the source and runs verification. Supabase stores the queue and leases; no Redis or BullMQ service is required. See [deployment status](docs/deployment-status.md) for the configured resources and remaining launch requirements.

## 1. Open the UI locally

Install Node.js **22.x** with npm. Unzip this package. On a Mac, if you extracted it into Downloads:

```bash
cd ~/Downloads/stakeout-ops
npm ci
cp .env.example .env.local
npm run dev -- --webpack
```

Open <http://localhost:3000>. Stop the server with Control+C.

The supplied example leaves Supabase credentials blank and sets `NEXT_PUBLIC_DEMO_MODE=true`. That opens the sample UI without connecting phones. Demo mode does not save programs or execute tasks. To see the builder, choose **Command center → Launch cycle → New readiness program**.

If you already configured `.env.local`, preserve it rather than replacing it with the empty example. This extraction is intended to live in its own folder.

## 2. Configure Supabase for real data

Use the Supabase project belonging to this scheduler, or a fresh project for testing. Do not assume the Observer project's database is the same database.

For a fresh test project, run the following from the `stakeout-ops` folder after installing the Supabase CLI:

```bash
npx supabase login
npx supabase link --project-ref YOUR_SCHEDULER_PROJECT_REF
npx supabase migration list
npx supabase db push --dry-run
npx supabase db push
```

Replace `YOUR_SCHEDULER_PROJECT_REF` with your project's reference. The push applies the full migration chain, including capacity and phase tables/functions. Review the dry-run list first. For an existing database, reconcile its migration history before pushing: the new phase migration is dated before the later capacity-hardening migration, so a simple push may require a reviewed migration-order reconciliation. Do not reset a live database or delete its migration history.

Supabase migration reference: <https://supabase.com/docs/guides/deployment/managing-environments>.

In **Authentication → URL Configuration**, use your app domain as the Site URL. Add the app's `/auth/callback` URL and `http://localhost:3000/**` as permitted redirects for the environments you will use. Invite your own user from Supabase and sign in. Public signup is disabled by default in this package. The longer `docs/deployment.md` covers invitation email and SMTP configuration.

## 3. Add application environment variables

Set these in `.env.local` for local use and in the Vercel project's environment settings for deployment:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Scheduler's Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key |
| `SUPABASE_SECRET_KEY` | Supabase secret key; server only |
| `INTEGRATION_ENCRYPTION_KEY` | Base64-encoded 32-byte encryption key; server only |
| `CRON_SECRET` | Separate random secret, at least 32 characters; server only |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` locally; your HTTPS app origin on Vercel |
| `NEXT_PUBLIC_DEMO_MODE` | `false` for real accounts and tasks |
| `NEXT_PUBLIC_ALLOW_SIGNUPS` | `false` for invitation-only access |

For a **new installation**, generate the encryption key and cron secret with:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

Use the first output for `INTEGRATION_ENCRYPTION_KEY` and the second for `CRON_SECRET`. An existing installation must retain its original encryption key so stored DuoPlus keys remain decryptable. Never commit `.env.local` or put server secrets into a `NEXT_PUBLIC_` variable.

Keep the initial tuning values from `.env.example`: request gap `1200`, lookahead `15`, dispatch batch `20`, horizon batch `100`, and DuoPlus issue timezone `UTC`. Verify DuoPlus task timestamps with one test before creating a fleet-wide cycle; the detailed timestamp probe is in `docs/deployment.md`.

Restart the local server after editing environment variables. A successful `/api/health` response reports configuration readiness; it is not proof that a real device task has completed.

## 4. Connect devices and create a program

1. Sign in, open the DuoPlus connection setup, paste your API key, and connect/sync. Keys are entered through the app, not supplied as a global Vercel environment variable.
2. Confirm the eligible device inventory and the provider-reported subscriptions. Set the worker limit to **3** for your account. The configured limit cannot create more subscriptions than DuoPlus actually provides.
3. Create clients and assign each device to its client and city. For phased cycles, provide the profile label and city coordinates. Device client/city dedication is retained across later cycles.
4. Choose **Launch cycle → New readiness program**. Map each daily and phase task to its actual synced RPA template. Set its variables, app, local time, expected duration, and any app completion requirements.
5. The default is warmup 10 days, Money 3 days, final squeeze 3 days, and after action 14 days. Five daily tasks continue throughout, with phase tasks added: 236 runs per phone.
6. Launch one test device's cycle first. Inspect Runs, logs, actual completion, and any required template input errors before adding the rest of the devices.

Demo data uses illustrative slot counts. The real account's synced capacity and chosen worker limit are the relevant values after setup.

## 5. Deploy the dashboard and Railway worker

Import this complete source into a Git repository and connect that repository to a Vercel project. Select Next.js and Node.js 22.x. Set the environment variables, then build with `npm run build -- --webpack` and deploy the tested version.

The included `vercel.json` sets the verified webpack build command and an empty cron list. [Deploy the continuous Railway worker](docs/railway-worker.md) using `Dockerfile.worker`, the same Supabase database, and exactly the same integration encryption key as the dashboard. Railway service settings and non-secret variables are already configured; see [deployment status](docs/deployment-status.md).

The worker performs:

| Work | Schedule |
| --- | --- |
| Near-term dispatch and status reconciliation | Sequential loop targeting every 30 seconds |
| 26-hour horizon and history pruning | At startup and first iteration after 05:00 UTC |

Keep one recurring worker for the production database. The production dashboard update removes the older Vercel cron definitions, so bring up Railway as part of that cutover. Preserve the existing deployment and triggers until its database and new worker are ready. Brief deployment handovers use database claims and shared physical Startup limits.

The [Railway worker guide](docs/railway-worker.md) includes service variables, health behavior, local startup, and current platform references.

For a deliberate local test with real credentials and a selected due test run, the scheduler endpoint also accepts a manual request. Set `CRON_SECRET` in that Terminal session to the same secret as the app; Next.js reads `.env.local`, but curl does not:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $CRON_SECRET" \
  'http://localhost:3000/api/cron/tick?mode=minute&limit=1'
```

This request can perform real device actions. A single tick may only move a task to its next stage; the Railway worker supplies continued reconciliation. `npm run dev` alone does not start a recurring scheduler loop.

## 6. Confirm the three-slot handoff before scaling

Validate one successful RPA run, then a controlled set of four devices with only three slots. Confirm the fourth waits, a scheduler-owned phone is confirmed off, and only then another phone starts. This version respects ownership of phones that were already on and includes an idle shutdown delay; it does not promise an immediate handoff at every task boundary.

Measure real task durations and include startup/shutdown time. At the default phase counts, 50 phones reach **550 tasks/day** in final squeeze. At 10 minutes each, that needs **30 hours 33 minutes across three slots**, even before overhead, so it cannot fit into 24 hours. The minimum raw-time budget for three slots is an average below **7.85 minutes per task** at that peak; overhead and the planner's spacing reduce it further. Use measured durations, available hours, and subscription count to make the schedule feasible.

The SQL planner currently includes conservative 15-minute spacing. This package therefore does not certify that every 50-device plan will fit. Expired or incomplete prerequisites require recovery; the scheduler does not silently compress phases to catch up.

## Verification for this package

- Node.js 22.23.2: all **468 tests** pass across 51 test files, including the new worker tests.
- Production build and TypeScript checking pass; ESLint passes.
- Local development startup serves the dashboard with HTTP 200 and confirms demo mode.
- The combined migration chain applies in local PGlite with minimal Supabase auth stubs, and the four-phase SQL fixture passes with a linked three-slot test pool.
- Railway project/service settings are configured and a Vercel preview build is READY. Production cutover, live Supabase migrations, and DuoPlus device actions remain pending; see deployment status.

The next production check is a real-account task and slot-handoff test, followed by a capacity plan for your measured task durations.
