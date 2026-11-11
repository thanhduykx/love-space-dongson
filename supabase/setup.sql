begin;

create table if not exists public.giadinh_photos (
  id text primary key,
  object_key text not null unique,
  original_name text not null,
  title text not null,
  day date not null,
  size integer not null check (size between 0 and 26214400),
  created_at timestamptz not null default now()
);

alter table public.giadinh_photos enable row level security;
revoke all on table public.giadinh_photos from public, anon, authenticated;
grant select, insert, update on table public.giadinh_photos to service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values ('giadinh-originals', 'giadinh-originals', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create or replace function public.move_giadinh_photos(photo_ids text[], new_day date)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.giadinh_photos set day = new_day where id = any(photo_ids);
  get diagnostics changed = row_count;
  if changed <> cardinality(photo_ids) then
    raise no_data_found;
  end if;
  return true;
exception when no_data_found then
  return false;
end;
$$;

revoke all on function public.move_giadinh_photos(text[], date) from public, anon, authenticated;
grant execute on function public.move_giadinh_photos(text[], date) to service_role;

commit;
