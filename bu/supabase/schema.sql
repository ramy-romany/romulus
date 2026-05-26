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
  action_clock_seconds integer not null default 30,
  require_result_approval boolean not null default true,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

create table if not exists table_seats (
  table_id uuid references tables(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  seat_number integer not null,
  stack_cents integer not null default 0,
  is_active boolean not null default true,
  primary key (table_id, user_id)
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
  created_at timestamptz not null default now()
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

-- MVP policies. Tighten before production.
create policy "authenticated read profiles" on profiles for select to authenticated using (true);
create policy "authenticated read tables" on tables for select to authenticated using (true);
create policy "authenticated read seats" on table_seats for select to authenticated using (true);
create policy "authenticated read messages" on table_messages for select to authenticated using (true);
create policy "authenticated insert messages" on table_messages for insert to authenticated with check (auth.uid() = user_id);
