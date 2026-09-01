/* 친구 대결(도전장) 저장용 Supabase 설정.
   비워두면 도전장 기록을 링크 자체에 담는 방식으로 자동 대체된다(이미지 제외).

   Supabase를 쓰려면 아래 SQL로 테이블을 만들고 URL/KEY를 채운다.

   create table public.challenges (
     challenge_id uuid primary key,
     nickname text not null,
     score int not null,
     shape_score int,
     spiral_score int,
     center_score int,
     balance_score int,
     finish_score int,
     clean_score int,
     toothpaste_type text,
     result_image_url text,
     created_at timestamptz default now()
   );
   alter table public.challenges enable row level security;
   create policy "anon insert" on public.challenges for insert with check (true);
   create policy "anon read" on public.challenges for select using (true);
*/
window.TOOTHPASTE_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
};
