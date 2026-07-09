-- CompX Worker Migration — required schema changes for Phase 10/14/16
-- Run against your Supabase project before deploying the patched worker.

-- ── Phase 10: Session Pool ──────────────────────────────────────────────────
create table if not exists scraper_sessions (
  id uuid primary key default gen_random_uuid(),
  platform text not null,               -- 'instagram' | 'linkedin' | 'google'
  account_label text not null,          -- 'Session A', 'Session B', ...
  storage_state jsonb not null,
  status text not null default 'active', -- 'active' | 'cooldown' | 'banned'
  in_use boolean not null default false,
  fail_count int not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (platform, account_label)
);

create index if not exists idx_scraper_sessions_platform_status
  on scraper_sessions (platform, status, in_use);

-- ── Phase 14: AI Enrichment columns on leads_verified ───────────────────────
alter table leads_verified
  add column if not exists industry text,
  add column if not exists category text,
  add column if not exists ai_keywords text[],
  add column if not exists company_summary text,
  add column if not exists lead_score int,
  add column if not exists ai_enriched_at timestamptz;

-- ── Phase 16: Search log (feeds the pre-scrape scheduler) ───────────────────
create table if not exists search_log (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  keyword text,
  location text,
  created_at timestamptz not null default now()
);

create index if not exists idx_search_log_source_created
  on search_log (source, created_at desc);

create or replace function get_popular_searches(p_since timestamptz, p_limit int)
returns table(source text, keyword text, location text, search_count bigint)
language sql stable as $$
  select source, keyword, location, count(*) as search_count
  from search_log
  where created_at >= p_since and keyword is not null
  group by source, keyword, location
  order by search_count desc
  limit p_limit;
$$;

-- ── Optional: buffered job logs (utils/logger.ts's supabaseLogSink) ─────────
create table if not exists job_logs (
  id bigserial primary key,
  job_id text not null,
  line text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_job_logs_job_id on job_logs (job_id, created_at);

-- ── Optional but recommended: TTL cleanup for job_logs / search_log ────────
-- Run periodically (pg_cron or an external scheduled task):
--   delete from job_logs where created_at < now() - interval '30 days';
--   delete from search_log where created_at < now() - interval '90 days';
