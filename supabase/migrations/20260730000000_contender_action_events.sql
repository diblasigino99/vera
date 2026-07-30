create extension if not exists pgcrypto;

create table if not exists public.contender_action_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text not null check (event_type in ('contender_action_impression', 'contender_action_click')),
  search_id uuid,
  search_query text,
  category text,
  consensus_mode text,
  contender_name text not null,
  action_type text not null,
  display_position integer,
  destination_domain text
);

create index if not exists contender_action_events_created_at_idx
  on public.contender_action_events(created_at);

create index if not exists contender_action_events_event_type_idx
  on public.contender_action_events(event_type);

create index if not exists contender_action_events_search_id_idx
  on public.contender_action_events(search_id);

create index if not exists contender_action_events_category_idx
  on public.contender_action_events(category);

alter table public.contender_action_events enable row level security;
