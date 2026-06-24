create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null unique,
  role text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.or_meetings (
  id text primary key,
  title text not null,
  meeting_date date,
  attendees text default '',
  tags jsonb not null default '[]'::jsonb,
  body text default '',
  actions jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id),
  visibility text not null default 'legacy_all' check (visibility in ('legacy_all', 'restricted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.or_meetings
add column if not exists created_by uuid references auth.users(id);

alter table public.or_meetings
add column if not exists visibility text not null default 'legacy_all';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'or_meetings_visibility_check'
  ) then
    alter table public.or_meetings
    add constraint or_meetings_visibility_check
    check (visibility in ('legacy_all', 'restricted'));
  end if;
end $$;

create table if not exists public.or_meeting_members (
  meeting_id text not null references public.or_meetings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (meeting_id, user_id)
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1), 'User'),
    coalesce(new.email, ''),
    'member'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

create or replace function public.can_access_meeting(target_meeting_id text, meeting_visibility text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    public.is_admin()
    or meeting_visibility = 'legacy_all'
    or exists (
      select 1
      from public.or_meeting_members mm
      where mm.meeting_id = target_meeting_id
        and mm.user_id = auth.uid()
    );
$$;

alter table public.profiles enable row level security;
alter table public.or_meetings enable row level security;
alter table public.or_meeting_members enable row level security;

drop policy if exists "Profiles readable by signed in users" on public.profiles;
drop policy if exists "Users can create own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Admins can update profiles" on public.profiles;

create policy "Profiles readable by signed in users"
on public.profiles
for select
to authenticated
using (true);

create policy "Users can create own profile"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

create policy "Admins can update profiles"
on public.profiles
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Allow anon read meetings" on public.or_meetings;
drop policy if exists "Allow anon insert meetings" on public.or_meetings;
drop policy if exists "Allow anon update meetings" on public.or_meetings;
drop policy if exists "Allow anon delete meetings" on public.or_meetings;
drop policy if exists "Authenticated users can read accessible meetings" on public.or_meetings;
drop policy if exists "Admins can create meetings" on public.or_meetings;
drop policy if exists "Admins can update meetings" on public.or_meetings;
drop policy if exists "Admins can delete meetings" on public.or_meetings;

create policy "Authenticated users can read accessible meetings"
on public.or_meetings
for select
to authenticated
using (public.can_access_meeting(id, visibility));

create policy "Admins can create meetings"
on public.or_meetings
for insert
to authenticated
with check (public.is_admin() and created_by = auth.uid());

create policy "Admins can update meetings"
on public.or_meetings
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Admins can delete meetings"
on public.or_meetings
for delete
to authenticated
using (public.is_admin());

drop policy if exists "Meeting members readable for accessible meetings" on public.or_meeting_members;
drop policy if exists "Admins manage meeting members" on public.or_meeting_members;

create policy "Meeting members readable for accessible meetings"
on public.or_meeting_members
for select
to authenticated
using (public.can_access_meeting(meeting_id, 'restricted'));

create policy "Admins manage meeting members"
on public.or_meeting_members
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create index if not exists or_meetings_meeting_date_idx on public.or_meetings (meeting_date desc);
create index if not exists or_meetings_tags_idx on public.or_meetings using gin (tags);
create index if not exists or_meetings_actions_idx on public.or_meetings using gin (actions);
create index if not exists or_meeting_members_user_id_idx on public.or_meeting_members (user_id);
