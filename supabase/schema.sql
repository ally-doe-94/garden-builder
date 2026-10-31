-- Garden Builder: shared gardens, plants and scan storage.
-- Run once in the Supabase dashboard: SQL Editor -> paste -> Run.
-- Every table is protected by row level security: only members of a garden can see or change it.

create table if not exists public.gardens (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our garden',
  join_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.garden_members (
  garden_id uuid not null references public.gardens (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text,
  joined_at timestamptz not null default now(),
  primary key (garden_id, user_id)
);

-- One row per plant. `data` holds the plant record (type, position, rotation, size, seed, planted, notes).
create table if not exists public.plants (
  id text primary key,
  garden_id uuid not null references public.gardens (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create index if not exists plants_garden_idx on public.plants (garden_id);

-- Shared settings (latitude, compass north) and the current scan (file list + orientation).
create table if not exists public.garden_state (
  garden_id uuid primary key references public.gardens (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  scan jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create or replace function public.is_member(g uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.garden_members where garden_id = g and user_id = auth.uid());
$$;

alter table public.gardens enable row level security;
alter table public.garden_members enable row level security;
alter table public.plants enable row level security;
alter table public.garden_state enable row level security;

create policy "members read garden" on public.gardens for select to authenticated using (public.is_member(id));
create policy "members rename garden" on public.gardens for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

create policy "members see members" on public.garden_members for select to authenticated using (public.is_member(garden_id));
create policy "members can leave" on public.garden_members for delete to authenticated using (user_id = auth.uid());

create policy "members manage plants" on public.plants for all to authenticated
  using (public.is_member(garden_id)) with check (public.is_member(garden_id));
create policy "members manage state" on public.garden_state for all to authenticated
  using (public.is_member(garden_id)) with check (public.is_member(garden_id));

-- Creating and joining go through functions so a garden can only be joined with its secret code.
create or replace function public.create_garden(garden_name text default 'Our garden')
returns public.gardens
language plpgsql
security definer
set search_path = public
as $$
declare g public.gardens;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.gardens (name, created_by) values (coalesce(nullif(trim(garden_name), ''), 'Our garden'), auth.uid()) returning * into g;
  insert into public.garden_members (garden_id, user_id, email) values (g.id, auth.uid(), auth.jwt() ->> 'email');
  insert into public.garden_state (garden_id) values (g.id);
  return g;
end;
$$;

create or replace function public.join_garden(code text)
returns public.gardens
language plpgsql
security definer
set search_path = public
as $$
declare g public.gardens;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into g from public.gardens where join_code = upper(trim(code));
  if not found then raise exception 'No garden found with that code'; end if;
  if (select count(*) from public.garden_members where garden_id = g.id) >= 5 and not public.is_member(g.id) then
    raise exception 'That garden is full';
  end if;
  insert into public.garden_members (garden_id, user_id, email) values (g.id, auth.uid(), auth.jwt() ->> 'email')
    on conflict do nothing;
  return g;
end;
$$;

revoke all on function public.create_garden(text) from public, anon;
revoke all on function public.join_garden(text) from public, anon;
grant execute on function public.create_garden(text) to authenticated;
grant execute on function public.join_garden(text) to authenticated;

-- Private bucket for scans. Files live under <garden id>/..., readable and writable by members only.
insert into storage.buckets (id, name, public) values ('scans', 'scans', false) on conflict (id) do nothing;

create policy "members read scans" on storage.objects for select to authenticated
  using (bucket_id = 'scans' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "members add scans" on storage.objects for insert to authenticated
  with check (bucket_id = 'scans' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "members replace scans" on storage.objects for update to authenticated
  using (bucket_id = 'scans' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "members delete scans" on storage.objects for delete to authenticated
  using (bucket_id = 'scans' and public.is_member(((storage.foldername(name))[1])::uuid));

-- Live updates between you and your partner.
alter table public.plants replica identity full;
alter publication supabase_realtime add table public.plants, public.garden_state;
