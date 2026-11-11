alter table public.giadinh_photos
  drop constraint if exists giadinh_photos_size_check,
  alter column size type bigint,
  add constraint giadinh_photos_size_check check (size >= 0),
  add column if not exists media_type text,
  add column if not exists part_size integer check (part_size > 0);
