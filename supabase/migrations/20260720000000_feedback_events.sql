create extension if not exists pgcrypto;

create table if not exists public.feedback_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  search_query text,
  result_slug text,
  feedback_type text not null check (feedback_type in ('yes', 'no', 'report_issue')),
  feedback_text text,
  evidence_type text,
  consensus_classification text
);

create index if not exists feedback_events_created_at_idx
  on public.feedback_events(created_at);

create index if not exists feedback_events_feedback_type_idx
  on public.feedback_events(feedback_type);

alter table public.feedback_events enable row level security;
