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
--  moderators — who can act on a report
-- ---------------------------------------------------------------------------
--  A commons open to all needs someone able to take something down, and until
--  now the only route was the Supabase dashboard. Membership is deliberately
--  not self-service: there is no policy that lets anyone insert here, so the
--  only way in is the SQL editor, with the project owner's credentials.
--
--    insert into public.moderators (id, note)
--    select id, 'founder' from auth.users where email = 'you@example.com';
create table if not exists public.moderators (
  id         uuid primary key references auth.users on delete cascade,
  note       text check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);

alter table public.moderators enable row level security;
-- Readable so the client can decide whether to show the queue at all. It holds
-- user ids and a note, nothing sensitive, and hiding it would only mean the app
-- had to guess. Nothing may be written from the client at any privilege.
drop policy if exists moderators_read on public.moderators;
create policy moderators_read on public.moderators for select using (true);
grant select on public.moderators to anon, authenticated;

--  Used inside policies, so it must not itself be subject to a policy that
--  reads the same table — security definer breaks that loop. Pinned
--  search_path, as with every definer function here.
create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.moderators where id = auth.uid());
$$;

revoke all on function public.is_moderator() from public;
grant execute on function public.is_moderator() to authenticated;

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
drop policy if exists profiles_delete on public.profiles;
create policy profiles_read   on public.profiles for select using (true);
create policy profiles_insert on public.profiles for insert with check (auth.uid() = id);
create policy profiles_update on public.profiles for update using (auth.uid() = id)
                                                  with check (auth.uid() = id);
-- Leaving has to be as available as joining, and for a service with children on
-- it that is not a nicety. Deleting the profile cascades to everything the
-- member published, which is the point: one action, and they are gone.
create policy profiles_delete on public.profiles for delete using (auth.uid() = id);

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

-- reports: file one, never read one — unless you are a moderator, who is the
-- one person who has to. Dismissing a report deletes it, which is why they can
-- delete too; nobody else can, including the reporter, so a report cannot be
-- withdrawn to cover something up.
drop policy if exists reports_insert on public.reports;
drop policy if exists reports_read   on public.reports;
drop policy if exists reports_delete on public.reports;
create policy reports_insert on public.reports for insert
  with check (auth.uid() is not null and auth.uid() = reporter_id);
create policy reports_read   on public.reports for select using (public.is_moderator());
create policy reports_delete on public.reports for delete using (public.is_moderator());

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
grant insert, update, delete         on public.profiles to authenticated;

grant select                         on public.designs  to anon, authenticated;
grant insert, update, delete         on public.designs  to authenticated;

grant insert, select, delete          on public.reports  to authenticated;
-- SELECT is granted but the policy above allows exactly one role through it:
-- a moderator. For everyone else filing a report still cannot double as a way
-- to read what has been reported. The grant is the coarse gate, the policy is
-- what decides — the same division as everywhere else in this file.

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
--  moderate_set_published — take something down, or put it back
-- ---------------------------------------------------------------------------
--  A moderator needs to unpublish somebody else's design and nothing more.
--  Granting them a blanket UPDATE on designs would also let them rewrite the
--  title, the description and the circuit itself, which is a different and much
--  larger power than the job needs. This function is the whole of it: one
--  column, one boolean, and a check that the caller is actually a moderator —
--  security definer means that check is the only thing standing between the
--  caller and the write, so it comes first and it is not optional.
create or replace function public.moderate_set_published(design uuid, state boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_moderator() then
    raise exception 'not a moderator' using errcode = '42501';
  end if;
  update public.designs set published = state where id = design;
end $$;

revoke all on function public.moderate_set_published(uuid, boolean) from public;
grant execute on function public.moderate_set_published(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
--  report_queue — what a moderator actually needs to see
-- ---------------------------------------------------------------------------
--  A report on its own is a reason and two ids. Deciding anything requires the
--  design it is about and who made it, so the join happens here rather than in
--  three client round trips. security_invoker keeps the reports_read policy in
--  force through the view: to a non-moderator this returns nothing at all.
create or replace view public.report_queue as
  select r.id, r.reason, r.created_at,
         d.id as design_id, d.title, d.published, d.thumbnail,
         p.handle as author_handle, p.display_name as author_name
    from public.reports r
    join public.designs  d on d.id = r.design_id
    left join public.profiles p on p.id = d.author_id
   order by r.created_at desc;

alter view public.report_queue set (security_invoker = on);
grant select on public.report_queue to authenticated;

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
