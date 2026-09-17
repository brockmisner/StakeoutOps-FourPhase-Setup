# Continuous scheduling on Railway

The Vercel app serves the dashboard and authenticated API. One Node.js process on Railway performs automatic scheduling. Supabase stores the queue, run claims, device limits, and history; no Redis or BullMQ service is required.

## Deploy

Use the existing `stakeout-ops` Railway project and `scheduler-worker` service listed in [deployment-status.md](deployment-status.md). Attach the confirmed GitHub repository after adding its database credentials. For another installation, use these settings:

| Setting | Value |
| --- | --- |
| Dockerfile | `Dockerfile.worker` |
| Start command | `node dist/railway-worker.cjs` |
| Replicas | 1 |
| Health check | `/health`, timeout 300 seconds |
| Sleep | Disabled |
| Cron schedule | None; continuous service |
| Restart policy | Always |
| Draining | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=240` |
| Overlap | `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0` |

Set these service variables before deploying:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | The scheduler's Supabase URL |
| `SUPABASE_SECRET_KEY` | The scheduler's server secret key |
| `INTEGRATION_ENCRYPTION_KEY` | Exactly the same value used by the Vercel app |
| `NEXT_PUBLIC_DEMO_MODE` | `false` |
| `NODE_ENV` | `production` |
| `PORT` | `8080` |
| `WORKER_INTERVAL_MS` | `30000` |
| `WORKER_TICK_BUDGET_MS` | `90000` |
| `WORKER_STALE_AFTER_MS` | `600000` |

Keep the dispatch and DuoPlus tuning values from `.env.example`. Public browser keys and `CRON_SECRET` are unnecessary on the worker. Its Docker image contains the bundled worker and Node.js, with no npm dependencies needed at runtime.

`vercel.json` contains an empty cron list. A production dashboard deployment removes the older Vercel cron definitions, so bring up the configured Railway worker as part of that cutover. Keep the existing production dashboard and triggers running until its database and worker are ready. Brief controller handovers use the existing database uniqueness, fenced claims, and shared physical Startup limits. Do not add another recurring controller to the same queue.

## Behavior and health

| Work | Schedule |
| --- | --- |
| Near-term dispatch and status reconciliation | Sequential loop targeting every 30 seconds |
| 26-hour horizon and history pruning | At startup and on the first iteration after 05:00 UTC each day |
| Subscription refresh | Checks each tick; fetches stale provider capacity snapshots |

Ticks never overlap within one process. Work that exceeds 30 seconds delays the next iteration. Database failures back off to at most two minutes between attempts. A worker without successful progress for ten minutes exits so Railway can restart it. `/health` stays unavailable until a successful tick; it exposes aggregate worker health, with no task or credential details. An HTTP 200 is evidence of scheduler/database progress, not proof that a device has completed a task. Individual task errors remain visible in the application's run history.

The existing 15-minute idle guard still applies before turning off a scheduler-started phone. Account for that time in workload planning. One Railway process can control many devices; it does not increase your DuoPlus subscription count.

SIGTERM stops new ticks and permits the in-flight tick to finish. If the platform terminates the process first, the existing lease expiry and remote-task reconciliation recover its work. The Docker runtime runs as the unprivileged `node` user. Worker logs contain aggregate counts, not provider credentials or raw upstream error messages.

## Run locally

With Node 22.x and real credentials in `.env.local`, run in a second terminal:

```bash
npm run build:worker
node --env-file=.env.local dist/railway-worker.cjs
```

The worker rejects `NEXT_PUBLIC_DEMO_MODE=true`. Stop the Railway worker before running a local controller against the same production database. `npm run dev` alone starts only the dashboard.

## References

Official Railway references: [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [health checks](https://docs.railway.com/deployments/healthchecks), and [deployment draining](https://docs.railway.com/deployments/deployment-teardown). Service settings are configured directly through Railway. New services use current service settings or [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code); no deprecated `railway.json` is included.
