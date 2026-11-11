begin;

create table if not exists public.giadinh_visit_counter (
  singleton boolean primary key default true check (singleton),
  total bigint not null default 0 check (total >= 0)
);

alter table public.giadinh_visit_counter enable row level security;
revoke all on table public.giadinh_visit_counter from public, anon, authenticated;
grant select, update on table public.giadinh_visit_counter to service_role;

insert into public.giadinh_visit_counter (singleton) values (true) on conflict do nothing;

create or replace function public.record_giadinh_visit()
returns bigint
language sql
set search_path = ''
as $$
  update public.giadinh_visit_counter
  set total = total + 1
  where singleton
  returning total;
$$;

revoke all on function public.record_giadinh_visit() from public, anon, authenticated;
grant execute on function public.record_giadinh_visit() to service_role;

commit;
