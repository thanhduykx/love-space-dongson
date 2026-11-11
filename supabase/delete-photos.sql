-- Lets the server delete photos. All requested rows are removed together or none are:
-- the function returns null when any id is missing, and the caught exception rolls back
-- the delete. On success it returns what the server needs to remove the stored objects.
begin;

grant delete on table public.giadinh_photos to service_role;

create or replace function public.delete_giadinh_photos(photo_ids text[])
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  removed jsonb;
  removed_count integer;
begin
  with deleted as (
    delete from public.giadinh_photos where id = any(photo_ids)
    returning object_key, size, part_size
  )
  select coalesce(jsonb_agg(to_jsonb(deleted)), '[]'::jsonb), count(*) into removed, removed_count from deleted;
  if removed_count <> cardinality(photo_ids) then
    raise no_data_found;
  end if;
  return removed;
exception when no_data_found then
  return null;
end;
$$;

revoke all on function public.delete_giadinh_photos(text[]) from public, anon, authenticated;
grant execute on function public.delete_giadinh_photos(text[]) to service_role;

commit;
