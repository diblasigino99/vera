create extension if not exists pgcrypto;

create table if not exists public.search_cache (
  id uuid primary key default gen_random_uuid(),
  query text,
  original_query text,
  normalized_query text not null unique,
  result jsonb,
  result_json jsonb,
  sources_json jsonb,
  cache_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.search_cache add column if not exists original_query text;
alter table public.search_cache add column if not exists result_json jsonb;
alter table public.search_cache add column if not exists sources_json jsonb;
alter table public.search_cache add column if not exists cache_version integer;
alter table public.search_cache alter column query drop not null;
alter table public.search_cache alter column result drop not null;

update public.search_cache
set
  original_query = coalesce(original_query, query),
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

alter table public.search_cache enable row level security;
alter table public.profiles enable row level security;
alter table public.saved_searches enable row level security;
alter table public.saved_results enable row level security;

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
