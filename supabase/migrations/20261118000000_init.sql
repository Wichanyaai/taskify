-- Taskify schema: shared task list for exactly the people listed in public.members

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------- members (allow-list) ----------
create table public.members (
  email text primary key check (email = lower(email)),
  display_name text not null,
  color text not null default '#2f6fed',
  user_id uuid unique references auth.users on delete set null,
  created_at timestamptz not null default now()
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- Only allow-listed emails can create an account
create or replace function public.guard_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.members where email = lower(new.email)) then
    raise exception 'email not allowed';
  end if;
  return new;
end $$;

create trigger guard_signup before insert on auth.users
  for each row execute function public.guard_signup();

-- Link auth user -> member row after the account exists
create or replace function public.link_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.members set user_id = new.id where email = lower(new.email);
  return new;
end $$;

create trigger link_member after insert on auth.users
  for each row execute function public.link_member();

-- Members can update their own display name / colour
create or replace function public.update_my_profile(p_name text, p_color text) returns void
language sql security definer set search_path = public as $$
  update public.members
     set display_name = left(trim(p_name), 40), color = p_color
   where user_id = auth.uid();
$$;

-- ---------- categories ----------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  color text not null default '#2f6fed',
  sort double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- tasks ----------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 300),
  note text not null default '',
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  priority text not null default 'mid' check (priority in ('high', 'mid', 'low')),
  category_id uuid references public.categories on delete set null,
  assignee uuid references auth.users on delete set null,
  due_date date,
  due_time time,
  due_at timestamptz,
  remind_before int check (remind_before is null or remind_before >= 0),
  reminded_at timestamptz,
  repeat text not null default 'none' check (repeat in ('none', 'daily', 'weekly', 'monthly')),
  pinned boolean not null default false,
  sort double precision not null default 0,
  subtasks jsonb not null default '[]',
  attachments jsonb not null default '[]',
  time_spent int not null default 0,
  timer_started_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_due_idx on public.tasks (due_at) where status <> 'done';

-- ---------- activity / history / comments ----------
create table public.activity (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks on delete cascade,
  user_id uuid references auth.users on delete set null default auth.uid(),
  kind text not null check (kind in ('created', 'status', 'assigned', 'comment', 'edited')),
  body text not null default '',
  created_at timestamptz not null default now()
);
create index activity_task_idx on public.activity (task_id, created_at);

-- ---------- push subscriptions ----------
create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- ---------- triggers ----------
create or replace function public.touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger tasks_touch before update on public.tasks for each row execute function public.touch();
create trigger categories_touch before update on public.categories for each row execute function public.touch();

-- re-arm reminder when the due time or reminder offset changes
create or replace function public.rearm_reminder() returns trigger language plpgsql as $$
begin
  if new.due_at is distinct from old.due_at or new.remind_before is distinct from old.remind_before
     or (old.status = 'done' and new.status <> 'done') then
    new.reminded_at := null;
  end if;
  return new;
end $$;

create trigger tasks_rearm before update on public.tasks for each row execute function public.rearm_reminder();

-- ---------- row level security ----------
alter table public.members enable row level security;
alter table public.categories enable row level security;
alter table public.tasks enable row level security;
alter table public.activity enable row level security;
alter table public.push_subscriptions enable row level security;

create policy members_read on public.members for select using (public.is_member());
create policy categories_all on public.categories for all using (public.is_member()) with check (public.is_member());
create policy tasks_all on public.tasks for all using (public.is_member()) with check (public.is_member());
create policy activity_read on public.activity for select using (public.is_member());
create policy activity_insert on public.activity for insert with check (public.is_member() and user_id = auth.uid());
create policy activity_delete_own on public.activity for delete using (public.is_member() and user_id = auth.uid());
create policy push_own on public.push_subscriptions for all
  using (public.is_member() and user_id = auth.uid())
  with check (public.is_member() and user_id = auth.uid());

-- ---------- realtime ----------
alter publication supabase_realtime add table public.tasks, public.categories, public.activity, public.members;

-- ---------- storage for photo attachments ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

create policy attachments_read on storage.objects for select
  using (bucket_id = 'attachments' and public.is_member());
create policy attachments_insert on storage.objects for insert
  with check (bucket_id = 'attachments' and public.is_member());
create policy attachments_delete on storage.objects for delete
  using (bucket_id = 'attachments' and public.is_member());
