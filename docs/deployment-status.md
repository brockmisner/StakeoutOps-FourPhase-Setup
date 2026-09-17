# Deployment status — September 15, 2026

The continuous worker is implemented and locally verified. The live stack cutover is pending the GitHub repository selection and access to the scheduler's Supabase database. No live migration or DuoPlus device action was performed during this setup.

## Configured Railway resources

- [Stakeout Ops project](https://railway.com/project/1ca503e1-f592-445b-8473-fea3579da54e)
- Workspace: `271ba902-4a86-4968-b082-e38ee08dd91c`
- Project: `1ca503e1-f592-445b-8473-fea3579da54e`
- Production environment: `775ce91d-9753-4e1d-95cc-51f3049f1d11`
- Worker service: `9b170a0d-1202-45bd-9b56-d690af2aa311`, named `scheduler-worker`
- Dockerfile: `Dockerfile.worker`; start: `node dist/railway-worker.cjs`
- One replica in `us-east4-eqdc4a`; restart policy `ALWAYS`; health path `/health`; health timeout 300 seconds; no cron schedule; sleeping disabled.
- Non-secret timing, dispatch, and draining variables are installed. Source is not attached and no worker deployment is running.

The service still needs `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and the original `INTEGRATION_ENCRYPTION_KEY` used by the dashboard if reusing its database. A new installation needs its own shared encryption key. Do not copy unrelated projects' credentials.

## Existing Vercel dashboard

- Project: `stakeout-ops`, ID `prj_2ZF9xbbE8v9cC0SFrEAVpvOUyBDr`
- Team: `team_He7O626ZZqpUA74OpqWcYRAQ`
- Existing production URL: <https://stakeout-ops.vercel.app>
- Existing production deployment was not replaced during infrastructure preparation.
- New dashboard preview: [open preview](https://stakeout-10kf0fejy-brockmisner13211321-6243s-projects.vercel.app), deployment `dpl_8HXcS45qVniQCCbPBvXComsrKFbe`, build status `READY`.
- The preview was submitted with demo mode enabled. HTTP inspection reached Vercel authentication (302), so live page/health behavior has not been independently verified through the connector. Sign into the owning Vercel account to open the preview.
- The new source uses Node 22.x, a webpack production build, and an empty cron list. Apply that production change when Railway is ready to take over scheduling.

## GitHub and Supabase choices still required

The connected GitHub account is `seo-ai-infrastructure`. Its `stakeout` repository is empty and public. It is a candidate, not a confirmed target, and no source was pushed to it. The Railway connector explicitly requires the user to identify the repository before a repository deployment.

The original scheduler database, `mvihrrewqzvqpsufzeid`, rejected access through the current Supabase connection. The accessible active project, `rgaxccniacasrabfnpsp` (`stakeout-stations`), has a different application schema and was left intact. Grant the Supabase connection access to the original scheduler database, or select an organization for a fresh dedicated project. The Supabase connector requires an organization choice and project-cost confirmation before creating a project.

## Validation

- 468 tests in 51 files passed, including shared capacity, four-phase programs, worker sequencing, retries, and shutdown.
- Lint and the Node 22 Next.js webpack production build passed.
- The standalone worker bundle built successfully and passed process-level checks against a local mock database: successful minute/horizon ticks, healthy/unavailable HTTP responses, redacted errors, and graceful SIGTERM.
- The full migration chain and SQL assertions had already passed in local PGlite; no database SQL was changed while adding the worker.
- Real account sign-in, live migrations, Git-linked deployments, and task completion/three-slot handoff remain unverified.
