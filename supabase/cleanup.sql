-- 釣果まとめ：容量の自動整理（cleanup.py）が使う関数
-- Supabase の「SQL Editor」に全部貼り付けて Run する。何度流しても壊れない。
-- 関数は service_role（GitHub Actions の秘密の鍵）からだけ呼べる。画面（公開用の鍵）からは呼べない。

-- 容量のため写真を消した投稿の印（本文は残す）
alter table public.catches add column if not exists photos_removed boolean not null default false;

-- 写真の合計サイズとデータベースの大きさ（バイト）
create or replace function public.storage_usage()
returns table (photo_bytes bigint, db_bytes bigint)
language sql security definer set search_path = '' as $$
  select coalesce((select sum((o.metadata->>'size')::bigint) from storage.objects o where o.bucket_id = 'photos'), 0)::bigint,
         pg_database_size(current_database())::bigint;
$$;

-- 投稿に付いている写真を、釣った日の古い順に
create or replace function public.oldest_photos(max_rows int default 500)
returns table (catch_id uuid, path text, bytes bigint, caught_at timestamptz)
language sql security definer set search_path = '' as $$
  select c.id, o.name, coalesce((o.metadata->>'size')::bigint, 0), c.caught_at
  from public.catches c
  join storage.objects o on o.bucket_id = 'photos' and o.name = any (c.photos)
  order by c.caught_at asc, o.name
  limit max_rows;
$$;

-- どの投稿にも付いていない写真（投稿の途中でやめた等）で、2日以上たったもの
create or replace function public.orphan_photos(max_rows int default 500)
returns table (path text, bytes bigint)
language sql security definer set search_path = '' as $$
  select o.name, coalesce((o.metadata->>'size')::bigint, 0)
  from storage.objects o
  where o.bucket_id = 'photos'
    and o.created_at < now() - interval '2 days'
    and not exists (select 1 from public.catches c where o.name = any (c.photos))
  order by o.created_at
  limit max_rows;
$$;

revoke all on function public.storage_usage() from public, anon, authenticated;
revoke all on function public.oldest_photos(int) from public, anon, authenticated;
revoke all on function public.orphan_photos(int) from public, anon, authenticated;
grant execute on function public.storage_usage() to service_role;
grant execute on function public.oldest_photos(int) to service_role;
grant execute on function public.orphan_photos(int) to service_role;
