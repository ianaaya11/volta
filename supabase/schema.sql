-- ============================================================================
--  Volta community — schema and access rules
-- ============================================================================
--  Run this once in the Supabase SQL editor (Dashboard → SQL → New query).
--  It is idempotent: re-running it is safe.
--
--  The rules below are enforced by Postgres, not by the app. That distinction
--  matters here: the browser holds the anon key and talks to the database
--  directly, so anything the client is merely *asked* not to do, a determined
--  user simply does. Every "only the author may edit this" is a row-level
--  security policy, so it holds no matter what the client sends.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  profiles — the public identity attached to a published design
-- ---------------------------------------------------------------------------
--  Deliberately thin. This is a schools tool, so a large share of members are
--  minors, and a full name next to a school and a town is the combination that
--  says where to find a child. What is public by default is a handle, a chosen
--  display name and a country. `school` exists because teachers and students
--  want the credit, but it is only shown when `show_school` is switched on.
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  handle       text not null unique
                 check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null
                 check (char_length(display_name) between 1 and 40),
  -- ISO 3166-1 alpha-2. A country is coarse enough to be safe and specific
  -- enough to show the commons is worldwide, which is the point of showing it.
  country      text check (country ~ '^[A-Z]{2}$'),
  school       text check (char_length(school) <= 80),
  show_school  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
--  designs — a published circuit
-- ---------------------------------------------------------------------------
create table if not exists public.designs (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 80),
  description text check (char_length(description) <= 2000),
  -- The document exactly as the editor saves it, so opening a design is the
  -- same code path as opening a file. Capped because a jsonb column is not a
  -- place to discover you have no size limit.
  circuit     jsonb not null check (pg_column_size(circuit) < 512000),
  -- A small PNG data URL. Kept in the row rather than in Storage so the whole
  -- feature needs one migration and no bucket policies; revisit if the table
  -- grows past a few thousand rows.
  thumbnail   text check (char_length(thumbnail) <= 200000),
  -- Every design in the commons carries the same terms. Without a licence
  -- recorded at publish time the author keeps copyright by default and
  -- "open to all to use" is not true, whatever the site says.
  license     text not null default 'CC-BY-SA-4.0'
                check (license in ('CC-BY-SA-4.0')),
  forked_from uuid references public.designs(id) on delete set null,
  fork_count  integer not null default 0,
  published   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists designs_published_idx on public.designs (published, created_at desc);
create index if not exists designs_author_idx    on public.designs (author_id, created_at desc);
create index if not exists designs_forked_idx    on public.designs (forked_from);

-- ---------------------------------------------------------------------------
--  reports — the takedown route
-- ---------------------------------------------------------------------------
--  A commons open to all needs a way to flag what should not be in it. Reports
--  are write-only from the client: a reporter can file one and can never read
--  anyone's, including their own, so this table cannot be used to enumerate
--  what has been reported.
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  design_id   uuid not null references public.designs(id) on delete cascade,
  reporter_id uuid references auth.users on delete set null,
  reason      text not null check (char_length(reason) between 1 and 1000),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
--  updated_at
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists designs_touch on public.designs;
create trigger designs_touch before update on public.designs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
--  Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.designs  enable row level security;
alter table public.reports  enable row level security;

-- profiles: everyone can read (a design needs its author's name); you may only
-- create and edit your own, and `id` is checked against the caller's uid so a
-- profile cannot be created on someone else's behalf.
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_read   on public.profiles for select using (true);
create policy profiles_insert on public.profiles for insert with check (auth.uid() = id);
create policy profiles_update on public.profiles for update using (auth.uid() = id)
                                                  with check (auth.uid() = id);

-- designs: published ones are world-readable — that is what the commons means.
-- An author additionally sees their own unpublished drafts. Writes are the
-- author's alone.
drop policy if exists designs_read   on public.designs;
drop policy if exists designs_insert on public.designs;
drop policy if exists designs_update on public.designs;
drop policy if exists designs_delete on public.designs;
create policy designs_read   on public.designs for select
  using (published or auth.uid() = author_id);
create policy designs_insert on public.designs for insert with check (auth.uid() = author_id);
create policy designs_update on public.designs for update using (auth.uid() = author_id)
                                                 with check (auth.uid() = author_id);
create policy designs_delete on public.designs for delete using (auth.uid() = author_id);

-- reports: file one, never read one.
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert
  with check (auth.uid() is not null and auth.uid() = reporter_id);

-- ---------------------------------------------------------------------------
--  Table privileges
-- ---------------------------------------------------------------------------
--  RLS and GRANT are two separate gates and BOTH have to open. A policy says
--  *which rows* a role may touch; a grant says whether the role may touch the
--  table at all. A table with perfect policies and no grant simply returns
--  "permission denied" — which is why this block exists rather than relying on
--  the project's "automatically expose new tables" setting. Leave that setting
--  OFF: access should be something this file states, not something a checkbox
--  hands out to every table anyone adds later.
--
--  These are deliberately wider than the policies. The grant is the coarse
--  gate; the policy is what actually decides. `authenticated` is granted UPDATE
--  on designs, and the designs_update policy is what limits that to your own.
grant usage on schema public to anon, authenticated;

grant select                         on public.profiles to anon, authenticated;
grant insert, update                 on public.profiles to authenticated;

grant select                         on public.designs  to anon, authenticated;
grant insert, update, delete         on public.designs  to authenticated;

grant insert                         on public.reports  to authenticated;
-- Deliberately no SELECT on reports, for anyone. Filing a report must not
-- double as a way to read what has been reported.

-- ---------------------------------------------------------------------------
--  record_fork — bump a counter on a row you do not own
-- ---------------------------------------------------------------------------
--  Forking has to increment the ORIGINAL author's fork_count, which the update
--  policy above rightly forbids. security definer lets exactly this one
--  operation through, and nothing else: it takes an id, adds one, returns
--  nothing. search_path is pinned so the function cannot be hijacked by a
--  caller-controlled schema.
create or replace function public.record_fork(source uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.designs set fork_count = fork_count + 1
   where id = source and published;
$$;

revoke all on function public.record_fork(uuid) from public;
grant execute on function public.record_fork(uuid) to authenticated;

-- ---------------------------------------------------------------------------
--  gallery — the commons listing, without shipping every circuit body
-- ---------------------------------------------------------------------------
--  A view rather than a client-side select so the school-privacy rule is
--  applied in the database. `show_school` is honoured here once, instead of in
--  every caller that might forget.
create or replace view public.gallery as
  select d.id, d.title, d.description, d.thumbnail, d.license,
         d.fork_count, d.forked_from, d.created_at,
         p.handle, p.display_name, p.country,
         case when p.show_school then p.school end as school
    from public.designs d
    join public.profiles p on p.id = d.author_id
   where d.published;

-- The view runs with the querying user's permissions, so the designs_read
-- policy still applies through it.
alter view public.gallery set (security_invoker = on);
grant select on public.gallery to anon, authenticated;
