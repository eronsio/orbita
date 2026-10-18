-- Orbita cloud sync: run this once in a NEW Supabase project (SQL Editor -> New query -> Run).
-- Use a separate project from the student portal: testers' contacts must never share a database with student data.
--
-- One row per user holds their whole contact list as JSON. Row-level security means a signed-in user can
-- only ever read or write their own row, even though the public "anon" key is visible in the page source.

create table if not exists public.orbita_data (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '[]'::jsonb,
  version    integer     not null default 1,      -- optimistic concurrency: bumped on every save
  updated_at timestamptz not null default now(),
  constraint orbita_data_is_list check (jsonb_typeof(data) = 'array'),
  constraint orbita_data_size    check (pg_column_size(data) < 8000000)   -- ~8 MB cap per user
);

alter table public.orbita_data enable row level security;

drop policy if exists "orbita: read own row"   on public.orbita_data;
drop policy if exists "orbita: insert own row" on public.orbita_data;
drop policy if exists "orbita: update own row" on public.orbita_data;
drop policy if exists "orbita: delete own row" on public.orbita_data;

create policy "orbita: read own row"   on public.orbita_data for select to authenticated using (auth.uid() = user_id);
create policy "orbita: insert own row" on public.orbita_data for insert to authenticated with check (auth.uid() = user_id);
create policy "orbita: update own row" on public.orbita_data for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "orbita: delete own row" on public.orbita_data for delete to authenticated using (auth.uid() = user_id);

-- Signed-out visitors (the anon role) get nothing at all.
revoke all on public.orbita_data from anon;
grant select, insert, update, delete on public.orbita_data to authenticated;
