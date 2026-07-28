alter table public.feedback_events
  add column if not exists search_id uuid,
  add column if not exists actor_id text,
  add column if not exists helpful boolean,
  add column if not exists feedback_reason text,
  add column if not exists displayed_contenders jsonb,
  add column if not exists cache_version integer,
  add column if not exists engine_version text;

create index if not exists feedback_events_search_id_idx
  on public.feedback_events(search_id);

create index if not exists feedback_events_actor_id_created_at_idx
  on public.feedback_events(actor_id, created_at);

create index if not exists feedback_events_helpful_idx
  on public.feedback_events(helpful);

create index if not exists feedback_events_feedback_reason_idx
  on public.feedback_events(feedback_reason);
