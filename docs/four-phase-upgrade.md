# Four-phase scheduler candidate

**Historical September 7 upgrade notes.** In the September 15 complete setup bundle, the newer capacity migrations are included, the test conflicts are resolved, and all 459 tests pass. Use `SETUP.md` for current setup, validation, and remaining capacity limits. The earlier standalone-patch instructions below describe the original review package.

Prepared as an isolated upgrade to Stakeout Ops. This package has not been deployed and has not changed live phones, tasks, or database records.

## Program behavior

Each device has a dedicated client, city, and profile. A reusable program defines its four consecutive phases. A five-task daily routine continues throughout the program by default; phase tasks are additional. Operators may choose to stop that routine after warmup.

| Phase | Allowed duration | Default cycle days | Default tasks per day |
| --- | --- | --- | --- |
| Warmup | 10–14 days | 1–10 | 5 daily tasks |
| Money | 2–5 days | 11–13 | 5 daily + 4 phase tasks |
| Final squeeze | 1–3 days | 14–16 | 5 daily + 6 phase tasks |
| After action | 10–14 days | 17–30 | 5 daily + 4 phase tasks |

The default is 236 runs per device, or 11,800 for 50 devices. Maximum phase durations produce a 36-day program. Dates and run estimates recalculate when durations or counts change. Runtime estimates exclude phone startup, shutdown, retries, and required gaps.

Each rule maps to a synced RPA template and an app, with duration and local time. App requirements independently count successful occurrences and distinct local dates with confirmed successes. Chrome, Maps, Google, Waze, Gmail, Discover, and a general app category are available. Requirement values are operator-defined; the UI does not assert that particular counts establish tracking accuracy.

## Execution and completion

- New phases require successful completion of required occurrences in previous phases. Missing materialized rows also block advancement.
- Money tasks additionally require configured app coverage from warmup. Completing several planned days on one actual date counts as one active date.
- Worker and database submission checks enforce the prerequisites before new external task submission. Existing external tasks can still be reconciled.
- Failed and cancelled runs do not count as completed. Retries cannot award duplicate occurrence credit.
- Missed prerequisites show recovery needed. Existing execution windows remain fixed; this upgrade does not extend dates or run expired tasks automatically.
- Database constraints retain device client and city dedication across later cycles. Configured coordinates are required for new phased cycles; configured coordinates are not proof of observed GPS accuracy.
- Programs without phase metadata retain their existing behavior.

## Validation

Production build succeeds. The complete JavaScript suite reports 396 passed and 2 failed. Both failures reproduce unchanged in the isolated starting snapshot: an inventory RPC-count expectation and a map-label expectation. The full lint run has one pre-existing `set-state-in-effect` error in `operations-dashboard.tsx`; ESLint passes for every changed TypeScript file.

Desktop (1440 × 1100) and mobile (390 × 844) browser checks passed for opening the builder, the default 236-run total, automatic phase-date shifts after a warmup change, app requirements, and absence of horizontal page overflow. Screenshots are included. The demo dashboard emitted a hydration warning involving existing map styling during capture; the builder interactions remained functional.

The entire migration chain applies in local PGlite with the required extension and minimal Supabase auth stubs. The rollback-only SQL fixture covers canonical program creation, legacy compatibility, 30- and 36-day activation, positive and blocked phase transitions, tenant isolation, permanent client/city assignment, required task failures, cancelled-run accounting, actual completion dates, duplicate scoring, and internal RPC privileges. This is local database validation, not a live Supabase deployment or DuoPlus execution test.

## Integration notes

The candidate starts from local snapshot `c6cd94c17f33585214884a68b841cfc503bed732`. The original checkout contains other unfinished work. Apply the included patch against that snapshot or review and merge the changed files individually; do not replace the live application wholesale.

Two inherited startup-pool migration files are empty placeholders: `20260907000740_shared_adjustable_startup_worker_pool.sql` and `20260907001030_shared_adjustable_startup_worker_pool.sql`. They must be reconciled with the existing capacity work before a live release. The existing database planner also uses fixed spacing that may reject dense 50-device plans despite optimistic task-hour estimates. This phase upgrade does not establish end-to-end capacity for 50 phones on three slots.

The new migration is `supabase/migrations/20260907002851_four_phase_profile_programs.sql`. Apply it only after checking the target migration history and resolving the capacity integration work. Then deploy the API, worker, and UI together. Final verification needs an authorized test cycle against the target Supabase and DuoPlus accounts, including the three-slot power-off handoff.
