create extension if not exists pgcrypto;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists tables (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references profiles(id),
  small_blind_cents integer not null default 250,
  big_blind_cents integer not null default 500,
  default_bomb_pot_cents integer not null default 2500,
  bomb_pot_cents integer not null default 2500,
  action_clock_seconds integer not null default 30,
  action_deadline timestamptz,
  require_result_approval boolean not null default true,
  current_game_id text not null default 'nlh',
  game_selection_mode text not null default 'dealer-choice' check (game_selection_mode in ('dealer-choice','random')),
  random_game_ids text[] not null default array['nlh','plo-4','plo-5','plo-6','plo-hilo-4','plo-hilo-5','plo-hilo-6','pastrami-4','pastrami-5','pastrami-6','costarica-4','costarica-5','costarica-6','get-fucked-4','get-fucked-5','get-fucked-6','stud-7','stud-minnesota','acey-deucey'],
  disabled_game_ids text[] not null default array[]::text[],
  felt_theme text not null default 'burgundy',
  card_back_theme text not null default 'gold',
  room_theme text not null default 'minimal',
  deck_mode text not null default 'four-color',
  button_seat integer not null default 1,
  paused boolean not null default false,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

-- Safe upgrades for anyone who already ran the first schema.
alter table tables add column if not exists bomb_pot_cents integer not null default 2500;
alter table tables add column if not exists action_deadline timestamptz;
alter table tables add column if not exists current_game_id text not null default 'nlh';
alter table tables add column if not exists game_selection_mode text not null default 'dealer-choice';
alter table tables add column if not exists random_game_ids text[] not null default array['nlh','plo-4','plo-5','plo-6','plo-hilo-4','plo-hilo-5','plo-hilo-6','pastrami-4','pastrami-5','pastrami-6','costarica-4','costarica-5','costarica-6','get-fucked-4','get-fucked-5','get-fucked-6','stud-7','stud-minnesota','acey-deucey'];
alter table tables add column if not exists disabled_game_ids text[] not null default array[]::text[];
alter table tables add column if not exists felt_theme text not null default 'burgundy';
alter table tables add column if not exists card_back_theme text not null default 'gold';
alter table tables add column if not exists room_theme text not null default 'minimal';
alter table tables add column if not exists deck_mode text not null default 'four-color';
alter table tables add column if not exists button_seat integer not null default 1;
alter table tables add column if not exists paused boolean not null default false;

update tables
set random_game_ids = array_append(random_game_ids, 'acey-deucey')
where not ('acey-deucey' = any(random_game_ids));

create table if not exists table_seats (
  table_id uuid references tables(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  seat_number integer not null,
  stack_cents integer not null default 0,
  is_active boolean not null default true,
  primary key (table_id, user_id),
  unique (table_id, seat_number)
);

create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  table_id uuid references tables(id) on delete cascade,
  user_id uuid references profiles(id),
  type text not null check (type in ('buyin','cashout','adjustment')),
  amount_cents integer not null,
  created_at timestamptz not null default now()
);

create table if not exists hands (
  id uuid primary key default gen_random_uuid(),
  table_id uuid references tables(id) on delete cascade,
  hand_number integer not null,
  game_id text not null,
  dealer_user_id uuid references profiles(id),
  result_status text not null default 'pending' check (result_status in ('pending','approved','rejected')),
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (table_id, hand_number)
);

create table if not exists table_messages (
  id uuid primary key default gen_random_uuid(),
  table_id uuid references tables(id) on delete cascade,
  user_id uuid references profiles(id),
  kind text not null check (kind in ('chat','system')),
  body text not null,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
alter table tables enable row level security;
alter table table_seats enable row level security;
alter table ledger_entries enable row level security;
alter table hands enable row level security;
alter table table_messages enable row level security;

-- Remove old MVP policies before recreating them.
drop policy if exists "authenticated read profiles" on profiles;
drop policy if exists "own profile insert" on profiles;
drop policy if exists "own profile update" on profiles;
drop policy if exists "authenticated read tables" on tables;
drop policy if exists "authenticated insert tables" on tables;
drop policy if exists "authenticated update tables" on tables;
drop policy if exists "creator or admin delete tables" on tables;
drop policy if exists "authenticated read seats" on table_seats;
drop policy if exists "authenticated insert seats" on table_seats;
drop policy if exists "authenticated update seats" on table_seats;
drop policy if exists "authenticated delete seats" on table_seats;
drop policy if exists "authenticated read ledger" on ledger_entries;
drop policy if exists "authenticated insert ledger" on ledger_entries;
drop policy if exists "authenticated read hands" on hands;
drop policy if exists "authenticated insert hands" on hands;
drop policy if exists "authenticated update hands" on hands;
drop policy if exists "authenticated read messages" on table_messages;
drop policy if exists "authenticated insert messages" on table_messages;

-- Private-friends MVP policies. Tighten before real production.
create policy "authenticated read profiles" on profiles for select to authenticated using (true);
create policy "own profile insert" on profiles for insert to authenticated with check (auth.uid() = id);
create policy "own profile update" on profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create policy "authenticated read tables" on tables for select to authenticated using (true);
create policy "authenticated insert tables" on tables for insert to authenticated with check (auth.uid() = created_by);
create policy "authenticated update tables" on tables for update to authenticated using (true) with check (true);
create policy "creator or admin delete tables" on tables for delete to authenticated
using (
  auth.uid() = created_by
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
);

create policy "authenticated read seats" on table_seats for select to authenticated using (true);
create policy "authenticated insert seats" on table_seats for insert to authenticated with check (auth.uid() = user_id);
create policy "authenticated update seats" on table_seats for update to authenticated using (true) with check (true);
create policy "authenticated delete seats" on table_seats for delete to authenticated using (true);

create policy "authenticated read ledger" on ledger_entries for select to authenticated using (true);
create policy "authenticated insert ledger" on ledger_entries for insert to authenticated with check (auth.uid() = user_id);

create policy "authenticated read hands" on hands for select to authenticated using (true);
create policy "authenticated insert hands" on hands for insert to authenticated with check (true);
create policy "authenticated update hands" on hands for update to authenticated using (true) with check (true);

create policy "authenticated read messages" on table_messages for select to authenticated using (true);
create policy "authenticated insert messages" on table_messages for insert to authenticated with check (auth.uid() = user_id);

-- Auto-create a profile when you create a Supabase Auth user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  raw_username text;
begin
  raw_username := coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1));
  insert into public.profiles (id, username, display_name, is_admin)
  values (
    new.id,
    raw_username,
    coalesce(new.raw_user_meta_data->>'display_name', initcap(replace(raw_username, '.', ' '))),
    false
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- After creating your own account, run this once, replacing ramy with your login username:
-- update profiles set is_admin = true where username = 'ramy';

-- Enable Supabase Realtime for live table updates.
-- Safe to run more than once.
alter table public.tables replica identity full;
alter table public.table_seats replica identity full;
alter table public.ledger_entries replica identity full;
alter table public.hands replica identity full;
alter table public.table_messages replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.tables;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.table_seats;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.ledger_entries;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.hands;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.table_messages;
  exception when duplicate_object then null;
  end;
end $$;

-- v0.4 defaults for new Romulus tables
alter table tables alter column felt_theme set default 'burgundy';
alter table tables alter column card_back_theme set default 'gold';
alter table tables alter column room_theme set default 'minimal';
alter table tables alter column deck_mode set default 'four-color';
