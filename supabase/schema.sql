create extension if not exists pgcrypto;

create table if not exists public.search_cache (
  id uuid primary key default gen_random_uuid(),
  query text,
  original_query text,
  normalized_query text not null unique,
  canonical_query text,
  result jsonb,
  result_json jsonb,
  sources_json jsonb,
  cache_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.search_cache add column if not exists original_query text;
alter table public.search_cache add column if not exists canonical_query text;
alter table public.search_cache add column if not exists result_json jsonb;
alter table public.search_cache add column if not exists sources_json jsonb;
alter table public.search_cache add column if not exists cache_version integer;
alter table public.search_cache alter column query drop not null;
alter table public.search_cache alter column result drop not null;

update public.search_cache
set
  original_query = coalesce(original_query, query),
  canonical_query = coalesce(canonical_query, normalized_query),
  result_json = coalesce(result_json, result),
  sources_json = coalesce(sources_json, result -> 'sources'),
  cache_version = coalesce(cache_version, (result ->> 'cacheVersion')::integer)
where result is not null;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete cascade,
  search_id uuid not null references public.search_cache(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.saved_results (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete cascade,
  search_id uuid not null references public.search_cache(id) on delete cascade,
  result_id text not null,
  created_at timestamptz not null default now()
);

alter table public.saved_searches drop constraint if exists saved_searches_search_id_key;
alter table public.saved_results drop constraint if exists saved_results_search_id_result_id_key;

create unique index if not exists saved_searches_profile_search_idx
  on public.saved_searches(profile_id, search_id);

create unique index if not exists saved_results_profile_search_result_idx
  on public.saved_results(profile_id, search_id, result_id);

create index if not exists search_cache_canonical_query_idx
  on public.search_cache(canonical_query, cache_version);

create table if not exists public.places_validation_cache (
  cache_key text primary key,
  input_name text not null,
  normalized_input_name text not null,
  status text not null,
  canonical_name text,
  place_id text,
  formatted_address text,
  latitude double precision,
  longitude double precision,
  types text[],
  business_status text,
  location_confidence double precision,
  category_confidence double precision,
  name_confidence double precision,
  overall_confidence double precision,
  rejection_reason text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists places_validation_cache_expires_idx
  on public.places_validation_cache(expires_at);

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

alter table public.search_cache enable row level security;
alter table public.profiles enable row level security;
alter table public.saved_searches enable row level security;
alter table public.saved_results enable row level security;
alter table public.places_validation_cache enable row level security;
alter table public.search_events enable row level security;

create policy "Public can read cached consensus"
  on public.search_cache for select
  using (true);

create policy "Public can read profiles"
  on public.profiles for select
  using (true);

create policy "Public can read saved searches"
  on public.saved_searches for select
  using (true);

create policy "Public can read saved results"
  on public.saved_results for select
  using (true);

create policy "Public can read places validation cache"
  on public.places_validation_cache for select
  using (true);
