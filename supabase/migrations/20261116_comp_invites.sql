-- Free (comped) access by invite. Applied to Supabase Nov 16, 2026.
create table if not exists public.comp_invites (
  email text primary key check (email = lower(email)),
  plan text not null default 'growth' check (plan in ('workspace','membership','growth','alumni')),
  note text,
  invited_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.comp_invites enable row level security;

create or replace function public.apply_comp_invite(p_user_id uuid, p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare inv public.comp_invites;
begin
  select * into inv from public.comp_invites where email = lower(p_email);
  if not found then return; end if;
  if exists (select 1 from public.memberships where user_id = p_user_id) then
    update public.memberships set plan = inv.plan, status = 'active', is_comped = true, current_period_end = null
      where user_id = p_user_id;
  else
    insert into public.memberships (user_id, plan, status, is_comped, is_founding_member)
      values (p_user_id, inv.plan, 'active', true, true);
  end if;
  update public.comp_invites set used_at = coalesce(used_at, now()) where email = inv.email;
end $$;

create or replace function public.comp_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform public.apply_comp_invite(new.id, new.email); return new; end $$;
create trigger comp_on_signup after insert on auth.users for each row execute function public.comp_on_signup();

create or replace function public.comp_on_invite() returns trigger
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email) = new.email limit 1;
  if uid is not null then perform public.apply_comp_invite(uid, new.email); end if;
  return new;
end $$;
create trigger comp_on_invite after insert or update of plan on public.comp_invites for each row execute function public.comp_on_invite();
