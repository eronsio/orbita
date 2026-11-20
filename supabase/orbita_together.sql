-- Orbita "Together": chat + shared and private journals.
-- Run once in the Orbita Supabase project (SQL Editor -> New query -> Run). Safe to run again.
--
-- The model:
--   circle  = a group of Orbita accounts. kind 'group' (named) or 'direct' (two people: a one-to-one chat).
--             Every circle has a chat and a journal.
--   invite  = how people join a circle: by email. Nobody can look up whether an email has an account.
--             The invitee must have a CONFIRMED email, sees the invitation after signing in, and accepts or declines.
--   entry   = one journal memory. It belongs to its author and is shared into zero or more circles.
--             "My journal" = everything I wrote + everything shared into any circle I'm in, so group memories
--             are automatically part of every member's private journal too.
--
-- Security: every table has row-level security and is read-only for signed-in users. All writes go through the
-- orbita_* functions below, which check who is asking. Signed-out visitors (the anon role) get nothing.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table if not exists public.orbita_profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  updated_at   timestamptz not null default now(),
  constraint orbita_profiles_name_len check (char_length(display_name) <= 60)
);

create table if not exists public.orbita_circles (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '',
  kind       text not null default 'group' check (kind in ('group', 'direct')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint orbita_circles_name_len check (char_length(name) <= 60)
);

create table if not exists public.orbita_members (
  circle_id    uuid not null references public.orbita_circles (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (circle_id, user_id)
);
create index if not exists orbita_members_user_idx on public.orbita_members (user_id);

create table if not exists public.orbita_invites (
  id         uuid primary key default gen_random_uuid(),
  circle_id  uuid not null references public.orbita_circles (id) on delete cascade,
  email      text not null,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint orbita_invites_email_lower check (email = lower(email)),
  unique (circle_id, email)
);
create index if not exists orbita_invites_email_idx on public.orbita_invites (email);

create table if not exists public.orbita_messages (
  id         uuid primary key default gen_random_uuid(),
  circle_id  uuid not null references public.orbita_circles (id) on delete cascade,
  author_id  uuid not null references auth.users (id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),
  constraint orbita_messages_len check (char_length(body) between 1 and 4000)
);
create index if not exists orbita_messages_circle_idx on public.orbita_messages (circle_id, created_at desc);

create table if not exists public.orbita_entries (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references auth.users (id) on delete cascade,
  title       text,
  body        text not null,
  happened_on date not null default current_date,
  place       text,
  people      text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint orbita_entries_title_len check (char_length(title) <= 120),
  constraint orbita_entries_body_len  check (char_length(body) between 1 and 20000),
  constraint orbita_entries_place_len check (char_length(place) <= 120),
  constraint orbita_entries_people_n  check (cardinality(people) <= 30)
);
create index if not exists orbita_entries_author_idx on public.orbita_entries (author_id, happened_on desc);

create table if not exists public.orbita_entry_circles (
  entry_id  uuid not null references public.orbita_entries (id) on delete cascade,
  circle_id uuid not null references public.orbita_circles (id) on delete cascade,
  primary key (entry_id, circle_id)
);
create index if not exists orbita_entry_circles_circle_idx on public.orbita_entry_circles (circle_id);

-- Photos on memories. Stored in the database as small JPEGs (a thumbnail for lists, a larger copy for viewing), resized in the
-- browser first. They are exactly as visible as the memory they belong to.
create table if not exists public.orbita_entry_photos (
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid not null references public.orbita_entries (id) on delete cascade,
  position   integer not null default 0,
  w          integer,
  h          integer,
  thumb      text not null,
  data       text not null,
  created_at timestamptz not null default now(),
  constraint orbita_photo_thumb_size check (char_length(thumb) <= 80000),
  constraint orbita_photo_data_size  check (char_length(data) <= 1200000),
  constraint orbita_photo_jpeg       check (thumb ~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' and data ~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$')
);
create index if not exists orbita_entry_photos_entry_idx on public.orbita_entry_photos (entry_id, position);

-- ---------------------------------------------------------------------------------------------
-- Helpers (security definer so the policies below can look at membership without recursing into themselves)
-- ---------------------------------------------------------------------------------------------
create or replace function public.orbita_my_email() returns text
language sql stable security definer set search_path = public, auth as $$
  select lower(email) from auth.users where id = auth.uid() and email_confirmed_at is not null
$$;

create or replace function public.orbita_is_member(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.orbita_members where circle_id = cid and user_id = auth.uid())
$$;

create or replace function public.orbita_is_owner(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.orbita_members where circle_id = cid and user_id = auth.uid() and role = 'owner')
$$;

create or replace function public.orbita_shares_circle(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select uid = auth.uid() or exists (
    select 1 from public.orbita_members a join public.orbita_members b on a.circle_id = b.circle_id
    where a.user_id = auth.uid() and b.user_id = uid)
$$;

create or replace function public.orbita_can_see_entry(eid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.orbita_entries e where e.id = eid and e.author_id = auth.uid())
      or exists (select 1 from public.orbita_entry_circles ec where ec.entry_id = eid and public.orbita_is_member(ec.circle_id))
$$;

create or replace function public.orbita_is_my_entry(eid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.orbita_entries e where e.id = eid and e.author_id = auth.uid())
$$;

-- valid, lower-cased, de-duplicated emails, never including the asker's own
create or replace function public.orbita_clean_emails(p_emails text[], p_me text) returns text[]
language plpgsql immutable set search_path = public as $$
declare out text[] := '{}'; raw text; e text;
begin
  foreach raw in array coalesce(p_emails, '{}') loop
    e := lower(btrim(coalesce(raw, '')));
    if char_length(e) <= 254 and e ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
       and e is distinct from p_me and not (e = any (out)) then
      out := out || e;
    end if;
  end loop;
  return out;
end $$;

-- when someone leaves: delete an empty circle, or hand ownership to the longest-standing member
create or replace function public.orbita_after_member_leaves() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.orbita_members where circle_id = old.circle_id) then
    delete from public.orbita_circles where id = old.circle_id;
  elsif old.role = 'owner' and not exists (select 1 from public.orbita_members where circle_id = old.circle_id and role = 'owner') then
    update public.orbita_members set role = 'owner'
     where circle_id = old.circle_id
       and user_id = (select user_id from public.orbita_members where circle_id = old.circle_id order by joined_at, user_id limit 1);
  end if;
  return null;
end $$;

drop trigger if exists orbita_member_leaves on public.orbita_members;
create trigger orbita_member_leaves after delete on public.orbita_members
  for each row execute function public.orbita_after_member_leaves();

-- ---------------------------------------------------------------------------------------------
-- Row-level security: signed-in users can READ what they are entitled to; every write goes through a function
-- ---------------------------------------------------------------------------------------------
alter table public.orbita_profiles      enable row level security;
alter table public.orbita_circles       enable row level security;
alter table public.orbita_members       enable row level security;
alter table public.orbita_invites       enable row level security;
alter table public.orbita_messages      enable row level security;
alter table public.orbita_entries       enable row level security;
alter table public.orbita_entry_circles enable row level security;
alter table public.orbita_entry_photos  enable row level security;

drop policy if exists "together: read profiles" on public.orbita_profiles;
create policy "together: read profiles" on public.orbita_profiles for select to authenticated
  using (public.orbita_shares_circle(user_id));

drop policy if exists "together: read my circles" on public.orbita_circles;
create policy "together: read my circles" on public.orbita_circles for select to authenticated
  using (public.orbita_is_member(id));

drop policy if exists "together: read members of my circles" on public.orbita_members;
create policy "together: read members of my circles" on public.orbita_members for select to authenticated
  using (public.orbita_is_member(circle_id));

drop policy if exists "together: read invites" on public.orbita_invites;
create policy "together: read invites" on public.orbita_invites for select to authenticated
  using (email = public.orbita_my_email() or public.orbita_is_member(circle_id));

drop policy if exists "together: read messages" on public.orbita_messages;
create policy "together: read messages" on public.orbita_messages for select to authenticated
  using (public.orbita_is_member(circle_id));

drop policy if exists "together: delete my messages" on public.orbita_messages;
create policy "together: delete my messages" on public.orbita_messages for delete to authenticated
  using (author_id = auth.uid());

drop policy if exists "together: read entries" on public.orbita_entries;
create policy "together: read entries" on public.orbita_entries for select to authenticated
  using (author_id = auth.uid() or public.orbita_can_see_entry(id));

drop policy if exists "together: delete my entries" on public.orbita_entries;
create policy "together: delete my entries" on public.orbita_entries for delete to authenticated
  using (author_id = auth.uid());

drop policy if exists "together: read entry sharing" on public.orbita_entry_circles;
create policy "together: read entry sharing" on public.orbita_entry_circles for select to authenticated
  using (public.orbita_is_member(circle_id) or public.orbita_is_my_entry(entry_id));

drop policy if exists "together: read photos" on public.orbita_entry_photos;
create policy "together: read photos" on public.orbita_entry_photos for select to authenticated
  using (public.orbita_can_see_entry(entry_id));

-- table privileges: nothing for signed-out visitors; read-only (plus deleting your own messages/entries) for signed-in users
revoke all on public.orbita_profiles, public.orbita_circles, public.orbita_members, public.orbita_invites,
              public.orbita_messages, public.orbita_entries, public.orbita_entry_circles, public.orbita_entry_photos from anon, authenticated;
grant select on public.orbita_profiles, public.orbita_circles, public.orbita_members, public.orbita_invites,
                public.orbita_messages, public.orbita_entries, public.orbita_entry_circles, public.orbita_entry_photos to authenticated;
grant delete on public.orbita_messages, public.orbita_entries to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Functions the app calls (security definer: each one checks who is asking)
-- ---------------------------------------------------------------------------------------------
create or replace function public.orbita_me() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare uid uuid := auth.uid(); me text := public.orbita_my_email(); nm text;
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select display_name into nm from public.orbita_profiles where user_id = uid;
  return jsonb_build_object('user_id', uid, 'email', me, 'name', coalesce(nullif(nm, ''), split_part(coalesce(me, ''), '@', 1)));
end $$;

create or replace function public.orbita_set_display_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); nm text := btrim(coalesce(p_name, ''));
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if char_length(nm) not between 1 and 60 then raise exception 'Please use 1 to 60 characters for your name.'; end if;
  insert into public.orbita_profiles (user_id, display_name) values (uid, nm)
  on conflict (user_id) do update set display_name = excluded.display_name, updated_at = now();
end $$;

create or replace function public.orbita_create_circle(p_name text, p_kind text default 'group', p_emails text[] default '{}')
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := auth.uid(); me text; cid uuid; clean text[]; existing uuid; nm text := btrim(coalesce(p_name, ''));
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  me := public.orbita_my_email();
  if me is null then raise exception 'Please confirm your email address first.'; end if;
  if p_kind not in ('group', 'direct') then raise exception 'bad kind'; end if;
  clean := public.orbita_clean_emails(p_emails, me);
  if cardinality(clean) > 30 then raise exception 'You can invite up to 30 people at a time.'; end if;
  if p_kind = 'direct' then
    if cardinality(clean) <> 1 then raise exception 'A one-to-one chat needs exactly one other email address.'; end if;
    select c.id into existing
      from public.orbita_circles c
      join public.orbita_members m on m.circle_id = c.id and m.user_id = uid
     where c.kind = 'direct' and (
             exists (select 1 from public.orbita_invites i where i.circle_id = c.id and i.email = clean[1])
          or exists (select 1 from public.orbita_members m2 join auth.users u on u.id = m2.user_id
                      where m2.circle_id = c.id and m2.user_id <> uid and lower(u.email) = clean[1]))
     limit 1;
    if existing is not null then return existing; end if;
    nm := '';
  elsif char_length(nm) not between 1 and 60 then
    raise exception 'Give the group a name (up to 60 characters).';
  end if;
  insert into public.orbita_profiles (user_id, display_name) values (uid, split_part(me, '@', 1)) on conflict (user_id) do nothing;
  insert into public.orbita_circles (name, kind, created_by) values (nm, p_kind, uid) returning id into cid;
  insert into public.orbita_members (circle_id, user_id, role) values (cid, uid, 'owner');
  insert into public.orbita_invites (circle_id, email, invited_by) select cid, e, uid from unnest(clean) as e;
  return cid;
end $$;

create or replace function public.orbita_invite(p_circle uuid, p_emails text[]) returns integer
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := auth.uid(); me text := public.orbita_my_email(); k text; clean text[]; n integer;
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not public.orbita_is_member(p_circle) then raise exception 'You are not in that group.'; end if;
  select kind into k from public.orbita_circles where id = p_circle;
  if k = 'direct' then raise exception 'A one-to-one chat can only have two people. Start a group instead.'; end if;
  clean := public.orbita_clean_emails(p_emails, me);
  if cardinality(clean) > 30 then raise exception 'You can invite up to 30 people at a time.'; end if;
  if (select count(*) from public.orbita_members where circle_id = p_circle)
   + (select count(*) from public.orbita_invites where circle_id = p_circle) + cardinality(clean) > 60 then
    raise exception 'A group can have up to 60 people.';
  end if;
  insert into public.orbita_invites (circle_id, email, invited_by)
  select p_circle, e, uid from unnest(clean) as e
   where not exists (select 1 from public.orbita_members m join auth.users u on u.id = m.user_id
                      where m.circle_id = p_circle and lower(u.email) = e)
  on conflict (circle_id, email) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.orbita_my_invites() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare uid uuid := auth.uid(); me text := public.orbita_my_email();
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if me is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'circle_id', c.id, 'name', c.name, 'kind', c.kind,
                                        'from', coalesce(nullif(p.display_name, ''), 'Someone'), 'created_at', i.created_at)
                     order by i.created_at desc)
      from public.orbita_invites i
      join public.orbita_circles c on c.id = i.circle_id
      left join public.orbita_profiles p on p.user_id = i.invited_by
     where i.email = me), '[]'::jsonb);
end $$;

create or replace function public.orbita_accept_invite(p_invite uuid) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := auth.uid(); me text := public.orbita_my_email(); inv public.orbita_invites; k text;
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if me is null then raise exception 'Please confirm your email address first.'; end if;
  select * into inv from public.orbita_invites where id = p_invite and email = me;
  if not found then raise exception 'That invitation is no longer available.'; end if;
  select kind into k from public.orbita_circles where id = inv.circle_id;
  if k = 'direct' and (select count(*) from public.orbita_members where circle_id = inv.circle_id) >= 2 then
    delete from public.orbita_invites where id = inv.id;
    raise exception 'That chat already has two people.';
  end if;
  insert into public.orbita_profiles (user_id, display_name) values (uid, split_part(me, '@', 1)) on conflict (user_id) do nothing;
  insert into public.orbita_members (circle_id, user_id, role) values (inv.circle_id, uid, 'member') on conflict do nothing;
  delete from public.orbita_invites where id = inv.id;
  return inv.circle_id;
end $$;

create or replace function public.orbita_decline_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  delete from public.orbita_invites where id = p_invite and email = public.orbita_my_email();
end $$;

create or replace function public.orbita_cancel_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  delete from public.orbita_invites i where i.id = p_invite and public.orbita_is_member(i.circle_id);
end $$;

create or replace function public.orbita_leave_circle(p_circle uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  delete from public.orbita_members where circle_id = p_circle and user_id = auth.uid();
end $$;

create or replace function public.orbita_rename_circle(p_circle uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare nm text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not public.orbita_is_owner(p_circle) then raise exception 'Only the person who runs the group can rename it.'; end if;
  if char_length(nm) not between 1 and 60 then raise exception 'Give the group a name (up to 60 characters).'; end if;
  update public.orbita_circles set name = nm where id = p_circle and kind = 'group';
end $$;

create or replace function public.orbita_my_circles() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(x.j order by x.last_at desc)
      from (
        select jsonb_build_object(
                 'id', c.id, 'name', c.name, 'kind', c.kind, 'role', m.role, 'created_at', c.created_at,
                 'unread', (select count(*) from public.orbita_messages g
                             where g.circle_id = c.id and g.created_at > m.last_read_at and g.author_id <> uid),
                 'last', (select jsonb_build_object('body', g.body, 'at', g.created_at, 'author_id', g.author_id)
                            from public.orbita_messages g where g.circle_id = c.id order by g.created_at desc limit 1),
                 'members', (select coalesce(jsonb_agg(jsonb_build_object(
                                      'user_id', m2.user_id, 'role', m2.role,
                                      'name', coalesce(nullif(p2.display_name, ''), 'Someone')) order by m2.joined_at), '[]'::jsonb)
                               from public.orbita_members m2
                               left join public.orbita_profiles p2 on p2.user_id = m2.user_id
                              where m2.circle_id = c.id),
                 'pending', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email) order by i.email), '[]'::jsonb)
                               from public.orbita_invites i where i.circle_id = c.id)
               ) as j,
               coalesce((select max(g.created_at) from public.orbita_messages g where g.circle_id = c.id), c.created_at) as last_at
          from public.orbita_members m
          join public.orbita_circles c on c.id = m.circle_id
         where m.user_id = uid) x), '[]'::jsonb);
end $$;

create or replace function public.orbita_mark_read(p_circle uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  update public.orbita_members set last_read_at = now() where circle_id = p_circle and user_id = auth.uid();
end $$;

create or replace function public.orbita_messages(p_circle uuid, p_after timestamptz default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not public.orbita_is_member(p_circle) then raise exception 'You are not in that chat.'; end if;
  return coalesce((
    select jsonb_agg(t.j order by t.created_at)
      from (select g.created_at,
                   jsonb_build_object('id', g.id, 'author_id', g.author_id, 'mine', g.author_id = uid,
                                      'author_name', coalesce(nullif(p.display_name, ''), 'Someone'),
                                      'body', g.body, 'created_at', g.created_at) as j
              from public.orbita_messages g
              left join public.orbita_profiles p on p.user_id = g.author_id
             where g.circle_id = p_circle and (p_after is null or g.created_at > p_after)
             order by g.created_at desc
             limit least(greatest(coalesce(p_limit, 100), 1), 200)) t), '[]'::jsonb);
end $$;

create or replace function public.orbita_send_message(p_circle uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); b text := btrim(coalesce(p_body, '')); r public.orbita_messages;
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not public.orbita_is_member(p_circle) then raise exception 'You are not in that chat.'; end if;
  if char_length(b) not between 1 and 4000 then raise exception 'Messages can be 1 to 4000 characters.'; end if;
  insert into public.orbita_messages (circle_id, author_id, body) values (p_circle, uid, b) returning * into r;
  update public.orbita_members set last_read_at = r.created_at where circle_id = p_circle and user_id = uid;
  return jsonb_build_object('id', r.id, 'created_at', r.created_at);
end $$;

create or replace function public.orbita_save_entry(
  p_id uuid, p_title text, p_body text, p_happened_on date, p_place text, p_people text[], p_circles uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); b text := btrim(coalesce(p_body, '')); eid uuid; ppl text[] := '{}'; raw text; nm text; c uuid;
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if char_length(b) not between 1 and 20000 then raise exception 'Write something first (up to 20000 characters).'; end if;
  foreach raw in array coalesce(p_people, '{}') loop
    nm := btrim(coalesce(raw, ''));
    if nm <> '' and char_length(nm) <= 60 and not (lower(nm) = any (select lower(x) from unnest(ppl) x)) then ppl := ppl || nm; end if;
  end loop;
  if cardinality(ppl) > 30 then raise exception 'You can tag up to 30 people.'; end if;
  foreach c in array coalesce(p_circles, '{}') loop
    if not public.orbita_is_member(c) then raise exception 'You can only share into groups you are in.'; end if;
  end loop;
  if p_id is null then
    insert into public.orbita_entries (author_id, title, body, happened_on, place, people)
    values (uid, nullif(btrim(coalesce(p_title, '')), ''), b, coalesce(p_happened_on, current_date), nullif(btrim(coalesce(p_place, '')), ''), ppl)
    returning id into eid;
  else
    update public.orbita_entries
       set title = nullif(btrim(coalesce(p_title, '')), ''), body = b, happened_on = coalesce(p_happened_on, happened_on),
           place = nullif(btrim(coalesce(p_place, '')), ''), people = ppl, updated_at = now()
     where id = p_id and author_id = uid returning id into eid;
    if eid is null then raise exception 'You can only edit your own memories.'; end if;
  end if;
  delete from public.orbita_entry_circles where entry_id = eid and not (circle_id = any (coalesce(p_circles, '{}')));
  insert into public.orbita_entry_circles (entry_id, circle_id)
  select eid, x from unnest(coalesce(p_circles, '{}')) as x on conflict do nothing;
  return eid;
end $$;

-- the journal: one list for "my journal" (p_circle null), one circle's journal, optionally only memories that tag a person
create or replace function public.orbita_journal(p_circle uuid default null, p_person text default null,
                                                 p_limit integer default 100, p_before date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_circle is not null and not public.orbita_is_member(p_circle) then raise exception 'You are not in that group.'; end if;
  return coalesce((
    select jsonb_agg(t.j order by t.happened_on desc, t.created_at desc)
      from (
        select e.happened_on, e.created_at,
               jsonb_build_object(
                 'id', e.id, 'author_id', e.author_id, 'mine', e.author_id = uid,
                 'author_name', coalesce(nullif(p.display_name, ''), 'Someone'),
                 'title', e.title, 'body', e.body, 'happened_on', e.happened_on, 'place', e.place, 'people', e.people,
                 'created_at', e.created_at, 'updated_at', e.updated_at,
                 'photos', (select coalesce(jsonb_agg(jsonb_build_object('id', ph.id, 'w', ph.w, 'h', ph.h) order by ph.position, ph.created_at), '[]'::jsonb)
                              from public.orbita_entry_photos ph where ph.entry_id = e.id),
                 'circles', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'kind', c.kind) order by c.created_at), '[]'::jsonb)
                               from public.orbita_entry_circles ec
                               join public.orbita_circles c on c.id = ec.circle_id
                               join public.orbita_members m on m.circle_id = c.id and m.user_id = uid
                              where ec.entry_id = e.id)) as j
          from public.orbita_entries e
          left join public.orbita_profiles p on p.user_id = e.author_id
         where (e.author_id = uid or exists (select 1 from public.orbita_entry_circles ec
                                               join public.orbita_members m on m.circle_id = ec.circle_id and m.user_id = uid
                                              where ec.entry_id = e.id))
           and (p_circle is null or exists (select 1 from public.orbita_entry_circles ec where ec.entry_id = e.id and ec.circle_id = p_circle))
           and (p_person is null or exists (select 1 from unnest(e.people) x where lower(x) = lower(btrim(p_person))))
           and (p_before is null or e.happened_on < p_before)
         order by e.happened_on desc, e.created_at desc
         limit least(greatest(coalesce(p_limit, 100), 1), 200)) t), '[]'::jsonb);
end $$;

-- how much photo data one person may keep (characters of base64, about 3/4 of that in bytes: roughly 90 MB)
create or replace function public.orbita_photo_quota() returns bigint
language sql immutable set search_path = public as $$ select 120000000::bigint $$;

create or replace function public.orbita_add_photo(p_entry uuid, p_thumb text, p_data text, p_w integer, p_h integer)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); pid uuid; n integer; used bigint;
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not public.orbita_is_my_entry(p_entry) then raise exception 'You can only add photos to your own memories.'; end if;
  if p_w is null or p_h is null or p_w not between 1 and 10000 or p_h not between 1 and 10000 then raise exception 'That image has an odd size.'; end if;
  select count(*) into n from public.orbita_entry_photos where entry_id = p_entry;
  if n >= 6 then raise exception 'A memory can have up to 6 photos.'; end if;
  select coalesce(sum(char_length(ph.thumb) + char_length(ph.data)), 0) into used
    from public.orbita_entry_photos ph join public.orbita_entries e on e.id = ph.entry_id where e.author_id = uid;
  if used + char_length(coalesce(p_thumb, '')) + char_length(coalesce(p_data, '')) > public.orbita_photo_quota() then
    raise exception 'Your photo storage is full. Delete some photos first.';
  end if;
  insert into public.orbita_entry_photos (entry_id, position, w, h, thumb, data)
  values (p_entry, n, p_w, p_h, p_thumb, p_data) returning id into pid;
  update public.orbita_entries set updated_at = now() where id = p_entry;
  return pid;
end $$;

create or replace function public.orbita_delete_photo(p_photo uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  delete from public.orbita_entry_photos ph using public.orbita_entries e
   where ph.id = p_photo and e.id = ph.entry_id and e.author_id = auth.uid();
end $$;

-- "delete my cloud data" from the account dialog also wipes this: my memories, messages and memberships
create or replace function public.orbita_delete_my_together_data() returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  delete from public.orbita_entries  where author_id = uid;
  delete from public.orbita_messages where author_id = uid;
  delete from public.orbita_members  where user_id = uid;
  delete from public.orbita_profiles where user_id = uid;
end $$;

-- only signed-in users may call any of this
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'orbita\_%' and p.prokind = 'f' loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
