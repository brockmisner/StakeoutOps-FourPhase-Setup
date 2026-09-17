-- Cover the full composite foreign keys used by the immutable readiness ledger.
-- These indexes keep parent-row validation and cleanup bounded as run history grows.

create index profile_score_events_profile_fk_cover_idx
  on public.profile_score_events (organization_id, connection_id, profile_id);

create index profile_score_events_run_fk_cover_idx
  on public.profile_score_events (organization_id, connection_id, run_id);

