create extension if not exists pgcrypto;

create table if not exists public.search_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  search_id uuid null,
  original_query text,
  normalized_query text,
  canonical_query text,
  evidence_type text,
  consensus_mode text,
  cache_hit boolean,
  cache_hit_type text,
  cache_version integer,
  total_ms integer,
  cache_ms integer,
  tavily_ms integer,
  openai_ms integer,
  cache_write_ms integer,
  tavily_calls integer default 0,
  openai_calls integer default 0,
  places_api_calls integer default 0,
  places_cache_hits integer default 0,
  places_validation_attempts integer default 0,
  error text
);

create index if not exists search_events_created_at_idx
  on public.search_events(created_at);

create index if not exists search_events_normalized_query_idx
  on public.search_events(normalized_query);

create index if not exists search_events_cache_hit_idx
  on public.search_events(cache_hit);

alter table public.search_events enable row level security;
