-- The run ledger foreign key is (organization_id, run_id), without connection_id.
-- Replace the overly wide first pass with the exact covering index.

drop index if exists public.profile_score_events_run_fk_cover_idx;

create index profile_score_events_run_fk_cover_idx
  on public.profile_score_events (organization_id, run_id);

