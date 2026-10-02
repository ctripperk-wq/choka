-- 釣果まとめ：自分の釣果投稿用のテーブルと写真置き場
-- Supabase の「SQL Editor」に全部貼り付けて Run する。何度流しても壊れない。

-- ===== 投稿 =====
create table if not exists public.catches (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 1 and 30),
  caught_at   timestamptz not null,
  pref        text check (char_length(pref) <= 10),
  spot        text check (char_length(spot) <= 60),
  fish        text not null check (char_length(fish) between 1 and 80),
  size        text check (char_length(size) <= 40),
  count       text check (char_length(count) <= 40),
  kind        text check (kind in ('岸', '船', '淡水')),
  tackle      text check (char_length(tackle) <= 200),
  memo        text check (char_length(memo) <= 1000),
  weather     text check (char_length(weather) <= 20),
  temp        numeric,
  wind        text check (char_length(wind) <= 40),
  tide_name   text check (char_length(tide_name) <= 10),
  tide_info   text check (char_length(tide_info) <= 200),
  lat         double precision,   -- みんなに見せる位置（ぼかし指定ならぼかした位置）
  lng         double precision,
  blurred     boolean not null default false,
  photos      text[] not null default '{}',
  is_public   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists catches_caught_at_idx on public.catches (caught_at desc);
create index if not exists catches_user_idx on public.catches (user_id);

alter table public.catches enable row level security;

drop policy if exists "公開か自分の投稿は読める" on public.catches;
create policy "公開か自分の投稿は読める" on public.catches
  for select using (is_public or user_id = auth.uid());

drop policy if exists "自分の投稿を追加" on public.catches;
create policy "自分の投稿を追加" on public.catches
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "自分の投稿を更新" on public.catches;
create policy "自分の投稿を更新" on public.catches
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "自分の投稿を削除" on public.catches;
create policy "自分の投稿を削除" on public.catches
  for delete to authenticated using (user_id = auth.uid());

-- ===== 本当の位置（ぼかして公開したときも、本人だけは正確な位置を見られる） =====
create table if not exists public.catch_spots (
  catch_id  uuid primary key references public.catches(id) on delete cascade,
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lat       double precision not null,
  lng       double precision not null
);
alter table public.catch_spots enable row level security;

drop policy if exists "本人だけ" on public.catch_spots;
create policy "本人だけ" on public.catch_spots
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===== 写真置き場（非公開バケット。読めるのは本人か、公開投稿に付いた写真だけ） =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg'];

drop policy if exists "写真を読む" on storage.objects;
create policy "写真を読む" on storage.objects
  for select using (
    bucket_id = 'photos' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.catches c where c.is_public and storage.objects.name = any (c.photos))
    )
  );

drop policy if exists "自分のフォルダに写真を置く" on storage.objects;
create policy "自分のフォルダに写真を置く" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "自分の写真を消す" on storage.objects;
create policy "自分の写真を消す" on storage.objects
  for delete to authenticated using (
    bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text
  );
