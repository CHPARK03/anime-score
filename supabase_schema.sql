-- ════════════════════════════════════════════════════════════════════════
-- supabase_schema.sql — 애니 점수표 Supabase 스키마 + RLS
-- ════════════════════════════════════════════════════════════════════════
-- 설계서: 설계/사이트내_편집_전환_계획서.md (§5 스키마, §6-3 RLS)
--
-- 실행 위치: Supabase 대시보드 → SQL Editor → New query → 전체 붙여넣기 → Run
--
-- 주의:
--   - 아래 <ADMIN_UID> 자리표시자를 실제 관리자 계정의 user uid로 교체해야
--     쓰기(insert/update/delete)가 동작한다. (가이드 4단계 참조)
--   - 이 파일은 destructive 명령(drop/truncate)을 포함하지 않는다.
--     기존 테이블 재생성이 필요하면 가이드의 [관리자 승인 필요] 절차를 따른다.
-- ════════════════════════════════════════════════════════════════════════


-- ── 1. anime 테이블 ─────────────────────────────────────────────────────
create table if not exists public.anime (
  id          bigint generated always as identity primary key,
  title       text not null,
  score       numeric(3,1),                       -- null = 시청 중
  type        text not null default 'seasonal'
              check (type in ('seasonal','classic')),
  quarter     text,                               -- "25년 4분기" (seasonal만)
  year        int,                                -- 정렬용 (예: 2025)
  season      int check (season between 1 and 4), -- 정렬용 (1~4)
  note        text,
  genre       text,                               -- "로맨스/코미디" 슬래시 구분
  poster_url  text,                               -- 포스터 절대 URL(소스독립: TMDB/AniList/직접입력)
  sort_order  int not null default 0,             -- 분기 내 수동 정렬용(선택)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- anime 정렬 인덱스 (year/season DESC + sort_order)
create index if not exists anime_sort_idx
  on public.anime (year desc, season desc, sort_order);


-- ── 2. quarters 메타 테이블 (빈 분기 보존 — §5-1a) ──────────────────────
-- 분기 목록의 단일 진실원천. 빈 분기(작품 0편)도 여기 행으로 존재.
create table if not exists public.quarters (
  quarter  text primary key,                      -- "26년 2분기"
  year     int  not null,                          -- 2026
  season   int  not null check (season between 1 and 4)
);

-- quarters 정렬 인덱스 (year/season DESC)
create index if not exists quarters_sort_idx
  on public.quarters (year desc, season desc);


-- ════════════════════════════════════════════════════════════════════════
-- 3. RLS (Row Level Security) — 쓰기는 관리자 uid만, 읽기는 공개
-- ════════════════════════════════════════════════════════════════════════
-- 정책은 for all 대신 연산별(select/insert/update/delete) 분리 (§6-3, D3).
--
-- ★ 아래 <ADMIN_UID> 를 실제 관리자 user uid로 교체할 것.
--   예: auth.uid() = '11111111-2222-3333-4444-555555555555'
--   (가이드 4단계: Authentication → Users 에서 관리자 계정 생성 후 uid 복사)
-- ════════════════════════════════════════════════════════════════════════

-- ── anime RLS ────────────────────────────────────────────────────────────
alter table public.anime enable row level security;

-- 읽기: 누구나 (조회 공개)
create policy "anime_public_read" on public.anime
  for select using (true);

-- 쓰기: 관리자 uid만
create policy "anime_admin_insert" on public.anime
  for insert with check (auth.uid() = '<ADMIN_UID>');

create policy "anime_admin_update" on public.anime
  for update using (auth.uid() = '<ADMIN_UID>')
              with check (auth.uid() = '<ADMIN_UID>');

create policy "anime_admin_delete" on public.anime
  for delete using (auth.uid() = '<ADMIN_UID>');


-- ── quarters RLS ─────────────────────────────────────────────────────────
alter table public.quarters enable row level security;

create policy "quarters_public_read" on public.quarters
  for select using (true);

create policy "quarters_admin_insert" on public.quarters
  for insert with check (auth.uid() = '<ADMIN_UID>');

create policy "quarters_admin_update" on public.quarters
  for update using (auth.uid() = '<ADMIN_UID>')
              with check (auth.uid() = '<ADMIN_UID>');

create policy "quarters_admin_delete" on public.quarters
  for delete using (auth.uid() = '<ADMIN_UID>');


-- ════════════════════════════════════════════════════════════════════════
-- 4. updated_at 자동 갱신 트리거 (anime)
-- ════════════════════════════════════════════════════════════════════════
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists anime_set_updated_at on public.anime;
create trigger anime_set_updated_at
  before update on public.anime
  for each row execute function public.set_updated_at();


-- ════════════════════════════════════════════════════════════════════════
-- 5. 적재 후 검증 쿼리 (참고 — import 완료 뒤 실행)
-- ════════════════════════════════════════════════════════════════════════
-- select type, count(*) from public.anime group by type;
--   기대값: { seasonal: 215, classic: 108 }  (합 323)
-- select count(*) from public.quarters;
--   기대값: 17
-- select count(*) from public.anime where type='seasonal' and (year is null or season is null);
--   기대값: 0  (모든 seasonal 행 year/season NOT NULL)
-- ════════════════════════════════════════════════════════════════════════
