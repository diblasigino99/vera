alter table public.search_events
  add column if not exists actor_id text;

create index if not exists search_events_actor_id_idx
  on public.search_events(actor_id);

create index if not exists search_events_actor_id_created_at_idx
  on public.search_events(actor_id, created_at);
