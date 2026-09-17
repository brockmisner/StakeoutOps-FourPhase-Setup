# Agency command center upgrade

This release adds a planning workspace to the existing scheduler. The original operations, readiness, map, subscription, device, workload, and proof views remain available in dedicated tabs. The separately hosted, approved demo stays on its existing branch.

## What changed

- Day and Week calendars with a timezone selector, date navigation, client filtering, and 2/6/12/24-hour zoom.
- Completion totals, attention counts, estimated finish times, and warnings when unfinished work extends beyond the selected period.
- Startup-slot forecasting that includes the current queue, recurring calendar occurrences, phone serialization, startup allowance, and spacing. Find open time locates a 15-minute opening plus startup allowance.
- Expandable client progress with dedicated phones, phase, confirmed completion, and task details. Mobile keeps client names and completion bars visible together.
- A keyboard-accessible task inspector with phone, client, template, attempts, timing, errors, schedule access, and the existing execution-evidence viewer.
- Navy navigation, a cool light canvas, clearer typography, consistent panels, and removal of unfinished navigation destinations.

## Existing visual aids

| Tab | Retained visual aids |
| --- | --- |
| Operations | Due/running/queued/attention/success indicators, live task progress, attention queue, device capacity, Next 24 hours workload timeline, recent proof |
| Cycles & readiness | Readiness scores, app completion evidence, phase/day progress, active cycles, proxy policy |
| Device map | Device and target map, map legend, subscription utilization and available slots |
| Schedule | New slot calendar, completion indicators, capacity outlook, and client completion bars |

## Data and forecast boundaries

The planning API uses the authenticated organization context on every query and is private/no-store. It reads the selected week, earlier unfinished work, and recurring calendar schedules separately from the smaller recent-activity feed. Pagination supports more than one thousand weekly tasks; safety limits are visible as partial-data warnings.

A recorded run means a persisted scheduler record, not proof that execution succeeded. Only successful results count as completed. Recurring calendar entries are marked projected. Cycle tasks appear after the scheduler records them; the UI does not invent future cycle completions or outcomes.

The forecast is advisory and does not write schedules or change worker dispatch. Startup and spacing controls affect estimates only. Unknown subscription limits, untracked occupied slots, overrunning tasks, or truncated feeds suppress reliable availability claims. Failed, paused, ineligible, or out-of-window tasks remain unresolved. Phone aliases sharing a provider image are serialized as one physical device. Retries honor their next-action timestamp.

The existing Operations timeline displays America/New_York explicitly so server and browser rendering agree. The new planning calendar has its own visible timezone selector.

## Design verification

Design references generated for this upgrade:

- Primary concept: `/workspace/scratch/7770c9608b1c/generated_images/exec-47cf601a-2be6-477a-a80d-7d66c77e95da.png`.
- Inspector/mobile detail concept: `/workspace/scratch/7770c9608b1c/generated_images/exec-55bedead-9f16-4b57-b7e7-c8becf695af1.png`.

Browser verification used the supported cloud Browser/Playwright interface, semantic controls, read-only DOM measurements, and `tab.screenshot`. The primary and detail concepts and captured desktop/mobile renders were inspected with `view_image`. No standalone Playwright or raw browser protocol fallback was used.

The browser viewport was 1363 × 936. Because this browser exposes no viewport-resize capability, a temporary same-origin iframe harness exercised real CSS layout at 390 × 844 and the primary concept's 1469 × 1072 dimensions. The inner layout widths were 375 and 1454 pixels after the browser scrollbar, respectively. This verifies responsive layout, not a physical touch device or mobile browser engine. The temporary harness is removed from the release.

### Fidelity ledger

| Comparison | Concept and browser evidence | Resolution |
| --- | --- | --- |
| Copy and hierarchy | Fleet command center, its subtitle, Add schedule, four tabs, summary, calendar, outlook, then client progress | Preserved in the same order. |
| Navigation | Primary concept contains two working sidebar destinations | Command center and Schedules retained; unfinished destinations removed. Existing Stakeout mark and navigation icon family retained. |
| Palette | Navy sidebar, cool tinted canvas, white panels, blue actions, teal completion | Fixed an inherited white command-center background to restore the specified `#f4f7fb` canvas. No decorative gradients or raster UI introduced. |
| Typography and controls | Strong headline, smaller panel titles, readable controls | Verified 32px headline, 22px panel headings, deliberate control fonts, and readable mobile line breaks. Fixed inherited 38px mobile action width that clipped Add schedule. |
| Timeline anatomy | Time axis, slot labels, positioned tasks, current-time line, legend, opening action | Preserved. Added functional zoom and exact task timing. Condensed lane spacing. Initial pan is immediate; future days focus their scheduled work. |
| Client progress | Table with completion bars and expandable details | Preserved on desktop. Mobile displays name plus completion together; phase, phone and attention details remain available through expansion. |
| Inspector | Task metadata, timing, close action and evidence access | Implemented with a native modal dialog, Escape closing, focus restoration, and a viewport-bounded width. |
| Spacing and containers | Purposeful summary cards, calendar panel, outlook band and client table | Preserved, with extra height for genuine date/data freshness/forecast context. No decorative feature panels added. |
| Responsive behavior | Two-column mobile summary and scrollable calendar | Verified no page-level horizontal overflow at 390px; calendar and tabs scroll within their own regions. |
| Original visual aids | Prior operations, workload, readiness and map panels | Retained and browser-checked under their tabs. |

Above-the-fold copy audit: product title, subtitle, navigation, tab names, section names and primary actions match the primary concept. Intentional differences are real/sample record totals instead of illustration numbers; **Recorded run** replaces **Confirmed run** to avoid implying successful execution; native date/time formatting; zoom, refresh, forecast settings and explanatory status labels needed for the working planner. The detail concept's invented extra sidebar destinations were not adopted. Timezone, buffer and missing-data messages explain actual scheduling assumptions. Small-duration tasks remain proportionally sized, with zoom, tooltips and the inspector exposing full details.

The implementation was compared against the design for copy, layout, typography, palette, icon treatment, spacing, responsive behavior and task interactions. Material issues found during review—canvas color, mobile action clipping, hidden mobile completion, initial calendar positioning, modal width, and timezone-dependent initial rendering—were corrected. The remaining differences above are intentional functional accommodations.

## Verification and release limits

- Planning tests cover physical-phone serialization, concurrent slots, deduplicated recurrence, unknown occupancy, overruns, retry delays, execution deadlines, unresolved failures, partial feeds, DST, and 50 phones/250 tasks constrained to three subscriptions.
- Planning-route tests cover organization isolation, authentication, window bounds, backlog and multi-page reads.
- Existing dashboard regression coverage checks operations, Quick Run, duplicate-run protection, map behavior, templates and evidence wiring.
- A timezone regression compares complete initial markup in UTC and America/Los_Angeles.
- Browser paths checked: Day/Week, client filter, day selection, zoom, open-time discovery, client expansion, inspector/Escape, mobile navigation, Add schedule, and the three retained visual tabs.
- Preview verification uses marked sample data with no database credentials and no device dispatch. Production retains authentication and its existing database configuration. Actual phone-task execution is outside this UI release check.
