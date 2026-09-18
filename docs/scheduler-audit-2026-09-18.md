**Scheduler audit — September 18, 2026**

The demo is missing a map on Schedules because that view never mounted the fleet map; the map existed only inside Command center. The prepared correction shares the same map component between both views, retains the original visual style, and spreads phones that share a coordinate into separate selectable markers. The sample remains 50 phones, 10 clients, and six location groups.

**Scope and evidence**

- Reviewed the publicly accessible original login and the interactive Railway demo before browser access was interrupted.
- Reviewed the classic/demo source at commit `50718ca8bce3990d3e3168e2becbf8f07952c704`, including the two dashboard components, schedule and run APIs, phone eligibility, profile endpoint, worker health, and readiness checks.
- Cross-checked the schedule/run loading and time calculations against current main at `32ae147ebbbb7662e680a265a75dfa6a937b3969`.
- The original site, https://stakeout-ops.vercel.app/, requires authentication. Its authenticated screens, deployed source revision, Supabase data, email delivery, and real device execution were not verified during this audit. The connected Vercel teams did not expose that project.
- Findings below are source-confirmed unless explicitly marked as a product gap or a deployment check. They must not be read as proof that the original Vercel deployment contains every issue.
- No production database, authentication settings, worker configuration, or phone operation was changed.

**Changes prepared for the demo**

| Change | Result |
|---|---|
| Shared fleet map on Schedules and Command center | Restores the missing map without maintaining two different map implementations. |
| Client, status, cadence and text filters connected to Schedules pins | The map follows the relevant schedule filters; the default fleet map also includes phones without standalone schedules. |
| Separate hit targets for coincident phones | Eight or nine phones at one sample location can each be selected. Stored coordinates are unchanged. |
| Fit to viewport and bounding-box center | All six groups use the map area instead of being compressed by coarse zoom thresholds or biased toward a larger group. |
| Fit all devices and close-details controls | Users can recover after zooming and dismiss a popup covering the map. |
| View full schedule and View all devices wired to views | These controls open Schedules and device setup instead of only showing a toast. |
| Clear stale schedule filters when following a schedule link | A previously selected client/status/query no longer hides the linked schedule. |

**Prioritized bugs and missing connections**

| Priority | Finding and evidence | User impact | Fix and effort |
|---|---|---|---|
| P1 | Run history is capped at 200 in both the classic and current dashboards. The API orders by `issue_at` descending; that same list supplies running/due counts, latest run per schedule, and the seven-day success rate. [Dashboard](../src/components/operations-dashboard.tsx), [run API](../src/app/api/runs/route.ts). | At 250+ daily tasks, the dashboard cannot establish complete daily or weekly coverage. Future runs may also displace current/history records from the returned list. | Query active work separately; calculate period totals in the database; paginate history. Medium. |
| P1 | Classic live-mode schedule loading requests the API default of 200 rows, with no cursor or total. Current main explicitly requests 500, but still has no pagination. [Schedule API](../src/app/api/schedules/route.ts). | In classic live mode, 50 phones × five standalone recurring schedules can omit at least 50 rows. The static demo's 250 rows bypass this API, hiding the discrepancy. Current main postpones the cutoff rather than removing it. | Add pagination with exact total, stable ordering, and server-side filters. Medium. |
| P1 | The Schedules API filters `source_kind = calendar`. Cycle-generated work is shown through cycles/runs elsewhere, not in this list. [Schedule API](../src/app/api/schedules/route.ts). | An agency cannot inspect all standalone and four-phase work in one scheduling view. This is a visibility gap, not evidence that cycle jobs fail to execute. | Add a unified occurrence view with Standalone/Cycle badges; retain appropriate edit permissions for generated work. Medium. |
| P1 | `dashboardNowMs`, the seven-day boundary, and the editor's `previewAnchor` use the initial server timestamp. Command center has a live clock; Schedules does not. [Dashboard](../src/components/operations-dashboard.tsx). | Leaving the page open makes due counts and future-run previews stale even though data refreshes every 15 seconds. | Share the live clock with Schedules; refresh preview time when opening the editor. Small. |
| P1 | Unknown subscription capacity falls back to three worker lanes, and an empty workload can say all three are free. The capacity summary separately says sync is required. [Command center](../src/components/command-center.tsx). | Users may interpret an unknown capacity as verified availability. This is a display defect, not evidence that the worker bypasses its capacity controls. | Render Capacity unknown until a valid fresh capacity snapshot is available; mark estimates explicitly. Small. |
| P1 | Background refresh failures show a toast for 2.8 seconds; identical failures are then suppressed while old data stays visible. Command center does not receive the persistent dashboard error. [Dashboard](../src/components/operations-dashboard.tsx). | A stale control room can look current during an outage. | Persist last-successful-refresh time and a stale-data state across both views until recovery. Small. |
| P2 | The schedule drawer receives every eligible phone name. It does not narrow choices to the selected client. The API correctly rejects phones already assigned to another client. [Dashboard](../src/components/operations-dashboard.tsx), [server validation](../src/app/api/schedules/_shared.ts). | The user can fill in a form that cannot be saved; default client and default phone may not belong together. | Use phone IDs and client IDs throughout the picker; filter by selected client and update defaults together. Small. |
| P2 | Command center receives only `schedulablePhones`, while its attention builder tries to find expired statuses 3 and 4. Eligibility filtering has already removed those statuses. [Eligibility](../src/lib/duoplus/phone-eligibility.ts), [Command center](../src/components/command-center.tsx). | Expired phones can disappear from the operational warning surface. | Supply all active inventory to monitoring and apply eligibility only to scheduling choices. Small. |
| P2 | Several sidebar destinations are explicitly disabled: Runs, Devices, Clients, Templates and Settings. | These are unfinished product areas, not working navigation. Device setup exists elsewhere, but there is no full run-history destination here. | Connect existing screens where available; label remaining areas consistently. Small–medium. |
| P2 | The demo timeline uses six illustrative jobs, while its schedule table shows 250 tasks. Recent proof uses decorative cards and no completed demo run records; View all proof only shows a message. [Command center](../src/components/command-center.tsx). | The demo shows scale in the table without demonstrating full-fleet capacity planning or proof inspection. | Generate schedule rows, occurrences, timeline, progress and proof from one consistent sample dataset. Medium. |
| P2 | Demo cycle start/end dates and current-day values are fixed independently. [Dashboard sample records](../src/components/operations-dashboard.tsx). | The same sample becomes contradictory as the real date changes. | Generate relative sample dates from one demo clock and derive current day from them. Small. |
| P2 | Dashboard readiness checks validate environment configuration. The worker has a last-successful-tick health signal, but the dashboard does not consume it. [Readiness](../src/lib/runtime-readiness.ts), [worker health](../src/worker/loop.ts). | Scheduler configured does not establish that work is currently being processed. | Surface worker heartbeat age and consecutive failures through an authenticated health endpoint. Small–medium. |
| P3 | Map target deduplication keys cycles by client ID and schedules by client name. [Command center](../src/components/command-center.tsx). | The same client/location can be counted twice when represented by both a cycle and a schedule. | Use the same client-ID + coordinate key for both. Small. |
| P3 | View/filter selection is local component state, not URL state. [Dashboard](../src/components/operations-dashboard.tsx). | Reloading returns to the default view, and teammates cannot share a filtered schedule link. | Persist view/client/status/query in the URL. Small. |

**High-value product upgrades**

These are proposed improvements, not claims that they have been implemented.

| Upgrade | Benefit | Effort |
|---|---|---|
| Persistent status row: last sync, worker heartbeat, active subscriptions, next estimated free slot | Makes stale data and blocked execution immediately visible. | Small once the health data is connected. |
| Client-aware phone selector and bulk task assignment to that client's five phones | Removes selection errors and repeated setup. | Small–medium. |
| Clickable daily completion card: completed / due, failed, missed, and remaining | Directly answers “did every phone finish today's required work?” Count occurrences, not schedule definitions; use the client's timezone. | Medium. |
| Day/week calendar with three subscription lanes and an available-slot finder | Directly addresses the original need to find open time without manual calculation. Allow an estimated duration and dedicated phone/client when finding a slot. | Medium; a read-only calendar is simpler than drag-and-drop rescheduling. |
| Per-client coverage matrix across phones and apps | Makes missing daily/weekly work obvious and gives account managers an actionable report. | Medium after period aggregates exist. |
| One consistent full-fleet demo dataset | Lets the table, six location groups, four phases, completion chart, slot timeline and proof drawer agree. | Medium. |
| URL filters, saved views, and CSV export | Speeds handoffs, support, and client reporting. | Small after pagination is correct. |

The first production work should address complete run counts, stale-state visibility, and trustworthy slot availability. These improve scheduling decisions more than additional decoration.

**Verification and remaining checks**

New regression coverage checks the Schedules navigation, all 50 phone markers across six groups, five-phone client filtering, matching Running filtering, nine separately selectable phones at the same coordinate, unchanged saved location values, map-fit controls, and device setup navigation.

The existing baseline CI run had a five-second timeout in a full-dashboard UI test. Full-page button searches became expensive with 250 rows. Related test queries were scoped to the navigation or heading while retaining their assertions and original time limits. [Branch checks](https://github.com/brockmisner/StakeoutOps-FourPhase-Setup/actions?query=branch%3Afix%2Fdemo-schedules-map).

A fresh browser visual pass, authenticated original-site audit, complete period-count checks against real data, and controlled live task execution remain unverified. No live task dispatch was attempted during this audit.
