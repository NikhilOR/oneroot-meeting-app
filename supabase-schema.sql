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
    or exists (
      select 1
      from public.or_meetings m
      where m.id = target_meeting_id
        and m.created_by = auth.uid()
    )
    or meeting_visibility = 'legacy_all'
    or exists (
      select 1
      from public.or_meeting_members mm
      where mm.meeting_id = target_meeting_id
        and mm.user_id = auth.uid()
    );
$$;

create or replace function public.can_manage_meeting_members(target_meeting_id text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    public.is_admin()
    or exists (
      select 1
      from public.or_meetings m
      where m.id = target_meeting_id
        and m.created_by = auth.uid()
    );
$$;

create or replace function public.update_meeting_action_remarks(
  target_meeting_id text,
  target_action_id text,
  next_remarks text
)
returns public.or_meetings
language plpgsql
security definer
set search_path = public
as $$
declare
  current_profile public.profiles%rowtype;
  meeting_row public.or_meetings%rowtype;
  action_item jsonb;
  next_actions jsonb;
begin
  select *
  into current_profile
  from public.profiles
  where id = auth.uid();

  if current_profile.id is null then
    raise exception 'Profile not found';
  end if;

  select *
  into meeting_row
  from public.or_meetings
  where id = target_meeting_id
  for update;

  if meeting_row.id is null then
    raise exception 'Meeting not found';
  end if;

  select item
  into action_item
  from jsonb_array_elements(meeting_row.actions) as action_items(item)
  where item->>'id' = target_action_id
  limit 1;

  if action_item is null then
    raise exception 'Action item not found';
  end if;

  if not (
    public.is_admin()
    or meeting_row.created_by = auth.uid()
    or exists (
      select 1
      from public.or_meeting_members mm
      where mm.meeting_id = target_meeting_id
        and mm.user_id = auth.uid()
    )
  ) then
    raise exception 'Not allowed to update remarks for this meeting';
  end if;

  select jsonb_agg(
    case
      when item->>'id' = target_action_id then jsonb_set(item, '{remarks}', to_jsonb(coalesce(next_remarks, '')), true)
      else item
    end
    order by item_order
  )
  into next_actions
  from jsonb_array_elements(meeting_row.actions) with ordinality as action_items(item, item_order);

  update public.or_meetings
  set actions = coalesce(next_actions, '[]'::jsonb),
      updated_at = now()
  where id = target_meeting_id
  returning * into meeting_row;

  return meeting_row;
end;
$$;

grant execute on function public.update_meeting_action_remarks(text, text, text) to authenticated;

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
with check (id = auth.uid() and role = 'member');

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
drop policy if exists "Authenticated users can create meetings" on public.or_meetings;
drop policy if exists "Admins can update meetings" on public.or_meetings;
drop policy if exists "Admins and creators can update meetings" on public.or_meetings;
drop policy if exists "Meeting creators can update meetings" on public.or_meetings;
drop policy if exists "Admins can delete meetings" on public.or_meetings;
drop policy if exists "Meeting creators can delete meetings" on public.or_meetings;

create policy "Authenticated users can read accessible meetings"
on public.or_meetings
for select
to authenticated
using (public.can_access_meeting(id, visibility));

create policy "Authenticated users can create meetings"
on public.or_meetings
for insert
to authenticated
with check (created_by = auth.uid());

create policy "Admins and creators can update meetings"
on public.or_meetings
for update
to authenticated
using (public.is_admin() or created_by = auth.uid())
with check (public.is_admin() or created_by = auth.uid());

create policy "Admins can delete meetings"
on public.or_meetings
for delete
to authenticated
using (public.is_admin());

drop policy if exists "Meeting members readable for accessible meetings" on public.or_meeting_members;
drop policy if exists "Admins manage meeting members" on public.or_meeting_members;
drop policy if exists "Admins and meeting creators manage meeting members" on public.or_meeting_members;
drop policy if exists "Meeting creators manage meeting members" on public.or_meeting_members;

create policy "Meeting members readable for accessible meetings"
on public.or_meeting_members
for select
to authenticated
using (public.can_access_meeting(meeting_id, 'restricted'));

create policy "Admins and meeting creators manage meeting members"
on public.or_meeting_members
for all
to authenticated
using (public.can_manage_meeting_members(meeting_id))
with check (public.can_manage_meeting_members(meeting_id));

create index if not exists or_meetings_meeting_date_idx on public.or_meetings (meeting_date desc);
create index if not exists or_meetings_tags_idx on public.or_meetings using gin (tags);
create index if not exists or_meetings_actions_idx on public.or_meetings using gin (actions);
create index if not exists or_meeting_members_user_id_idx on public.or_meeting_members (user_id);
