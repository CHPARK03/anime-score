#!/usr/bin/env node
/**
 * bulk-fill-posters.js — 포스터 일괄 채우기 (반복 실행 가능, 관리자 로컬 실행)
 * ──────────────────────────────────────────────────────────────────────────
 * TMDB(ko-KR)+AniList 로 자동 검색해 포스터 URL 을 DB에 저장한다.
 * 제목의 "N기"가 TMDB 시즌에 있으면 **그 시즌 포스터**, 없으면 **본작 포스터**로.
 * RLS 우회를 위해 service_role 키 사용.
 *
 * ★ 기본 동작 = **빈 것만 채움(fill)** — `poster_url IS NULL` 인 작품만 처리한다.
 *   이미 채워진 포스터(자동 저장분·검수 갤러리에서 사람이 확정한 것 모두)는
 *   **절대 건드리지 않는다.** 신작 방영 후 아무 때나 다시 실행해도 안전하다.
 *
 * ⚠️ `--all` 플래그를 줄 때만 **전체 재처리(덮어쓰기)** 로 동작한다.
 *      node bulk-fill-posters.js --all
 *   이 모드는 사람이 검수로 확정한 포스터까지 자동 1위 결과로 **덮어쓴다.**
 *   전체 재매칭이 정말 필요할 때만 쓰고, 실행 전 반드시 백업하라(아래).
 *
 * ⚠️ 자동 1위/시즌 매칭이라 일부 오매칭(분할쿨·극장판·스핀오프 등) 가능하다.
 *    실행 후 사이트에서 로그인 → "🖼 포스터 검수" 갤러리로 틀린 것만 교정하라.
 *
 * ⚠️ [--all 실행 전 백업 필수] 기존 정확 포스터가 바뀔 수 있다.
 *    Supabase SQL Editor에서 아래 결과를 파일로 저장해 두면 즉시 복구 가능:
 *      select id, title, poster_url from anime where poster_url is not null;
 *    (기본 fill 모드는 덮어쓰지 않으므로 백업 없이 실행해도 된다.)
 *
 * ── 실행 방법 (PowerShell, 이 파일이 있는 폴더에서) ──────────────────────
 *   1) 의존성 설치:   npm install
 *   2) .env 작성:     .env.example 을 .env 로 복사 후 값 채우기
 *                     (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TMDB_API_KEY)
 *   3) 실행(기본):    node bulk-fill-posters.js          # 빈 것만 채움 — 안전
 *   3') 전체 재매칭:  node bulk-fill-posters.js --all    # 덮어씀 — 백업 후에만
 *
 * ⚠️ service_role 키는 DB 전권 키다. .env 에만 두고 절대 커밋/공유하지 마라
 *    (.gitignore 가 .env* 를 이미 제외). 노출 시 Supabase 대시보드에서 즉시 rotate.
 *
 * Node 18+ (v24 권장 — fetch 내장). 의존성: @supabase/supabase-js, dotenv.
 */

'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// ── 환경변수 (하드코딩 금지 — .env 에서만) ──────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('[오류] .env 에 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 를 설정하세요.');
  process.exit(1);
}
const TMDB_CONFIGURED = !!TMDB_API_KEY && !TMDB_API_KEY.startsWith('<');
if (!TMDB_CONFIGURED) {
  console.warn('[경고] TMDB_API_KEY 미설정 → TMDB 스킵, AniList 만으로 검색합니다.');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const TMDB_IMG = 'https://image.tmdb.org/t/p/'; // + w500 + poster_path

// ── TITLE_ALIAS: 줄임말/약칭 → 정식 검색명 (index.html 과 동일 사전 — 이중정의 허용) ──
// index.html 의 TITLE_ALIAS 를 그대로 복사. 사이트와 동기화 시 양쪽 함께 수정.
const TITLE_ALIAS = {
  // 축약·은어
  '나혼렙 2기':             '나 혼자만 레벨업',
  '귀칼 4기(대장장이)':     '귀멸의 칼날',
  '내청코':                 'My Teen Romantic Comedy SNAFU',
  '나의 행복한 결혼':       'My Happy Marriage',
  '중2병':                  'Chuunibyou demo Koi ga Shitai',
  '코미상':                 '코미 양은 커뮤증입니다',
  '코미상 2기':             '코미 양은 커뮤증입니다',
  '카구야님':               'Kaguya-sama Love Is War',
  '청춘돼지':               '청춘 돼지는 바니걸 선배의 꿈을 꾸지 않는다',
  '노겜노라 (극장판 포함)': 'No Game No Life',
  'Fate/밥상':              "Today's Menu for Emiya Family",
  '블루록 1기, 2기':        'Blue Lock',
  '진격의 거인 3기까지':    'Attack on Titan',
  '너에게 닿기를 3기까지':  'Kimi ni Todoke',
  '비비':                   'Vivy Fluorite Eyes Song',
  '좀100':                  'Zom 100 Bucket List of the Dead',
  '팬스가 2기':             'Panty and Stocking with Garterbelt',
  '팬티와 스타킹':          'Panty and Stocking with Garterbelt',
  '오키나와 사투리':        '오키나와에서 좋아하게 된 아이가 사투리가 심해서 너무 괴로워',
  '이과 사랑':              '이과가 사랑에 빠졌기에 증명해보았다',
  '야한 이야기 sox':        'Shimoneta',
  '용족':                   'Long Zu',
  // 극장판
  '5등분의 신부 극장판':    'The Quintessential Quintuplets Movie',
  '귀멸의 칼날 극장판':     'Demon Slayer Mugen Train',
  '주술회전 극장판':        'Jujutsu Kaisen 0',
  '오렌지 (극장판 포함)':   'Orange',
  // Fate 시리즈
  'Fate/UBW':               'Fate stay night Unlimited Blade Works',
  'Fate/HF 전체':           'Fate stay night Heavens Feel',
  'Fate/카니발 판타즘':     'Carnival Phantasm',
  'Fate/이리야 시리즈':     'Fate kaleid liner Prisma Illya',
  'Fate/Grand Order':       'Fate Grand Order',
  // 감성 영화
  '너의 이름은':            'Kimi no Na wa',
  '날씨의 아이':            'Weathering with You',
  '너의 췌장을 먹고 싶어':  'I Want to Eat Your Pancreas',
  '목소리의 형태':          'A Silent Voice',
  '초속5cm':                '5 Centimeters per Second',
  // 최애의 아이 / 어둠의 실력자 혼선
  '최애의 아이':            'Oshi no Ko',
  '최애의 아이 2기':        'Oshi no Ko Season 2',
  '최애의 아이 3기':        'Oshi no Ko Season 3',
  '어둠의 실력자가 되고 싶어서': 'The Eminence in Shadow',
  '어둠의 실력자 2기':      'The Eminence in Shadow Season 2',
  // 우자키 / 중2병 혼선
  '우자키 양은 놀고 싶어':     'Uzaki-chan Wants to Hang Out',
  '우자키 양은 놀고 싶어 2기': 'Uzaki-chan Wants to Hang Out 2',
  '중2병이라도 사랑이 하고 싶어': 'Chuunibyou demo Koi ga Shitai',
  '카구야 님은 고백받고 싶어 - 첫 키스는 끝나지 않아': 'Kaguya-sama Love Is War The First Kiss That Never Ends',
  // "나를~" 계열
  '나를 먹고 싶은, 괴물':        'Watashi wo Tabetai Hitodenashi',
  '나를 좋아하는 건 너뿐이냐':   'Oresuki Are You the Only One Who Likes Me',
  '나를 너무 좋아하는 100명의 그녀': '100 Girlfriends Who Really Love You',
  '나를 좋아하는 100명의 히로인 2기': '100 Girlfriends Who Really Love You Season 2',
  // "내~" 계열
  '내 마음의 위험한 녀석':       'The Dangers in My Heart',
  '내 마음의 위험한 녀석 2기':   'The Dangers in My Heart Season 2',
  '내 옆의 은하':               'The Galaxy Next Door',
  '내 여자친구와 소꿉친구가 완전 수라장': 'Oreshura',
  // "~할 수 없어" 계열
  '소꿉친구와는 러브 코미디를 할 수 없어': 'Osananajimi ga Zettai ni Makenai Love Comedy',
  '밤의 해파리는 헤엄칠 수 없어': 'Yoru no Kurage wa Oyogenai',
  '아하렌 양은 알 수가 없어':     'Aharen-san wa Hakarenai',
  '사랑은 쌍둥이로 나눌 수 없어': 'Koi wa Futago de Warikirenai',
  // "이~" 계열
  '이 미술부에는 문제가 있다':    'This Art Club Has a Problem',
  // 블루 계열
  '블루 아카이브':               'Blue Archive the Animation',
  '블루 로크':                   'Blue Lock',
  // 기타
  '연애 플롭스':                 'Love Flops',
  '이능배틀은 일상계 속에서':    'Inou Battle wa Nichijou-kei no Naka de',
  '탐정은 이미 죽었다':          'The Detective Is Already Dead',
  '보스 따님과 돌보미':          'Kumichou Musume to Sewagakari',
  '마사무네 군의 리벤지 2기':    'Masamune-kun no Revenge R',
  '아트리 my dear moments':      'ATRI My Dear Moments',
  '도메스틱한 그녀':             'Domestic na Kanojo',
  '앗군과 그녀':                 'Akkun to Kanojo',
  '새 엄마가 데려온 딸이 전 여친이었다.': 'My Stepmom Daughter Is My Ex',
  '우리 회사의 작은 선배 이야기': 'Chiisana Koi no Uta',
  '친구 여동생이 나한테만 짜증나게 군다': 'Imouto sae Ireba Ii',
  // 귀멸 시즌별
  '귀멸의 칼날 1기':             'Demon Slayer Kimetsu no Yaiba',
  '귀멸의 칼날 2기':             'Demon Slayer Entertainment District Arc',
  '귀멸의 칼날 3기':             'Demon Slayer Swordsmith Village Arc',
  // 주술회전 시즌별
  '주술회전 1기':                'Jujutsu Kaisen',
  '주술회전 2기 1쿨':            'Jujutsu Kaisen Season 2',
  '주술회전 2기 2쿨':            'Jujutsu Kaisen Season 2',
  '주술회전 3기':                'Jujutsu Kaisen Season 3',
  // 스파이 패밀리 시즌별
  '스파이 패밀리 1기':           'Spy x Family',
  '스파이 패밀리 2기':           'Spy x Family Part 2',
  '스파이 패밀리 3기':           'Spy x Family Season 3',
  // 샹그릴라 시즌별
  '샹그릴라 프론티어 1쿨':       'Shangri-La Frontier',
  '샹그릴라 프론티어 2쿨':       'Shangri-La Frontier',
  '샹그릴라 프론티어 2기':       'Shangri-La Frontier Season 2',
  // 진격의 거인 시즌별
  '진격의 거인 최종편':          'Attack on Titan Final Season',
  '진격의 거인 4시 전편':        'Attack on Titan The Final Season Part 3',
  // 줄임말/약칭 보강 (2026-07-01 — 기존 키와 중복 없는 신규 8건만)
  '노겜노라':                    '노 게임 노 라이프',
  '월간순정 노자키군':           '월간 소녀 노자키 군',
  '아마가미ss':                  '아마가미 SS',
  '코바야시네 메이드 드래곤':    '코바야시네 메이드래곤',
  '스파이교실':                  '스파이 교실',
  '스파이 교실 파트2':           '스파이 교실 2기',
  '선배가 짜증나는 후배이야기':  'My Senpai is Annoying',
  '로드 엘 멜로이 2세 (극장판 포함)': "Lord El-Melloi II's Case Files",
};

// ── 검색어 변형 (사이트 index.html queryVariants 와 동일 규칙) ───────────
const stripSeason = (t) => t.replace(/\s*\d+기$|\s*\d+쿨$|\s*시즌\s*\d+$|\s*Part\s*\d+$/i, '').trim();
function queryVariants(base) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const nospace = (s) => s.replace(/\s+/g, '');
  const stripped = stripSeason(base);
  const variants = [base, norm(base), nospace(base), stripped, norm(stripped), nospace(stripped)];
  return [...new Set(variants.filter((v) => v && v.trim()))];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 제목에서 기수 N 추출 ("N기"만 season_number=N — C8). 쿨/Part는 본작(null).
function extractSeasonNo(title) {
  const m = String(title).match(/(\d+)\s*기/);
  return m ? parseInt(m[1], 10) : null;
}

// TMDB /tv/{id} → season_number==N 의 poster_path. 없으면 null(→ 본작 fallback).
async function tmdbSeasonPoster(tvId, n) {
  const url = `https://api.themoviedb.org/3/tv/${tvId}?language=ko-KR&api_key=${TMDB_API_KEY}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) { await sleep(2000); continue; }
    if (!res.ok) return null;
    const json = await res.json();
    await sleep(150); // /tv/{id} 뒤 throttle (C12)
    const season = (json.seasons || []).find((s) => s.season_number === n);
    return season?.poster_path || null;
  }
  return null;
}

// ── TMDB 검색 (search/tv?ko-KR → 0건이면 movie, C7). 기수 N이면 시즌 poster 우선 ──
async function tmdbPoster(queries, seasonNo) {
  if (!TMDB_CONFIGURED) return null;
  async function search(kind, q) {
    const url = `https://api.themoviedb.org/3/search/${kind}?query=${encodeURIComponent(q)}&language=ko-KR&api_key=${TMDB_API_KEY}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(2000); continue; } // 대기 후 재시도
      if (!res.ok) return [];
      const json = await res.json();
      return json.results || [];
    }
    return [];
  }
  // tv 우선: 각 변형 검색 → 첫 유효 결과(id + poster_path)
  for (const q of queries) {
    const results = await search('tv', q);
    const hit = results.find((r) => r.poster_path);
    if (hit) {
      // 기수 N이 있으면 시즌 poster 시도 → 없으면 본작 poster fallback(C9, 빈 포스터 금지)
      if (seasonNo != null) {
        const seasonPath = await tmdbSeasonPoster(hit.id, seasonNo);
        if (seasonPath) return { url: TMDB_IMG + 'w500' + seasonPath, season: seasonNo };
      }
      return { url: TMDB_IMG + 'w500' + hit.poster_path, season: null }; // 본작
    }
    await sleep(120); // TMDB 안전 간격
  }
  // tv 0건 → movie(극장판 등, 시즌 개념 없음)
  for (const q of queries) {
    const results = await search('movie', q);
    const hit = results.find((r) => r.poster_path);
    if (hit) return { url: TMDB_IMG + 'w500' + hit.poster_path, season: null };
    await sleep(120);
  }
  return null;
}

// ── AniList 검색 (Page). 첫 coverImage 반환 ──────────────────────────────
async function anilistPoster(queries) {
  const query =
    'query($s:String){Page(perPage:5){media(search:$s,type:ANIME,sort:SEARCH_MATCH){coverImage{large medium}}}}';
  for (const q of queries) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { s: q } }),
      });
      if (res.status === 429) { await sleep(3000); break; } // 다음 변형으로(또는 대기)
      const json = await res.json();
      const media = json.data?.Page?.media || [];
      const hit = media.find((m) => m.coverImage?.large || m.coverImage?.medium);
      if (hit) return hit.coverImage.large || hit.coverImage.medium;
      break; // 이 변형은 결과 없음 → 다음 변형
    }
    await sleep(700); // AniList 30/분 대비 요청 간 딜레이
  }
  return null;
}

// ── 한 작품의 포스터 결정: TMDB(시즌 우선) → AniList ─────────────────────
async function findPoster(title) {
  // 기수 N은 원제(별칭 전)에서 추출("나혼렙 2기"의 2기 보존). 검색 base는 별칭 정식명.
  const seasonNo = extractSeasonNo(title);
  const base = TITLE_ALIAS[title] ?? title;   // 줄임말/약칭 → 정식 검색명
  const queries = queryVariants(base);
  const t = await tmdbPoster(queries, seasonNo);
  if (t) return { url: t.url, source: 'tmdb', season: t.season };
  const a = await anilistPoster(queries);
  if (a) return { url: a, source: 'anilist', season: null };
  return null;
}

// ── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  // 모드: 기본 = 빈 것만 채움(fill, 덮어쓰기 없음) / --all = 전체 재처리(덮어씀).
  // 사람이 검수로 확정한 포스터를 재실행이 날려먹는 사고를 막기 위해
  // "덮어쓰기"는 반드시 명시적 플래그를 요구한다.
  const overwriteAll = process.argv.slice(2).includes('--all');

  let query = supabase.from('anime').select('id,title,poster_url');
  if (!overwriteAll) query = query.is('poster_url', null);   // 빈 것만

  const { data: rows, error } = await query.order('id', { ascending: true });

  if (error) {
    console.error('[오류] 대상 조회 실패:', error.message);
    process.exit(1);
  }

  const total = rows.length;
  if (overwriteAll) {
    console.log(`[--all] 전체 재처리 대상: ${total}개 — 기존 poster_url 을 덮어씁니다.`);
    console.log('※ 사람이 검수로 확정한 포스터도 자동 결과로 바뀝니다.');
    console.log('※ 백업 필수: select id,title,poster_url from anime where poster_url is not null;');
  } else {
    console.log(`[기본] 빈 포스터 채우기 대상: ${total}개 (poster_url 이 비어 있는 작품만)`);
    console.log('※ 이미 채워진 포스터는 건드리지 않습니다. 전체 재매칭이 필요하면 --all 을 붙이세요.');
  }
  if (total === 0) {
    console.log(overwriteAll ? '작품이 없습니다. 종료.' : '채울 빈 포스터가 없습니다. 종료.');
    return;
  }
  console.log('※ 자동/시즌 매칭이라 일부 오매칭 가능 → 실행 후 사이트 "포스터 검수"로 교정하세요.\n');

  let saved = 0, empty = 0, failed = 0;

  for (let i = 0; i < total; i++) {
    const { id, title } = rows[i];
    try {
      const found = await findPoster(title);
      const seasonTag = found && found.season != null ? `시즌${found.season}` : '본작';
      const tag = `[${i + 1}/${total}] ${title} (${found ? seasonTag : '-'})`;
      if (!found) { console.log(`${tag} → 스킵(후보 0건)`); empty++; continue; }

      const { error: upErr } = await supabase
        .from('anime')
        .update({ poster_url: found.url })
        .eq('id', id);

      if (upErr) { console.log(`${tag} → 실패(저장): ${upErr.message}`); failed++; }
      else { console.log(`${tag} → 저장(${found.source}${found.season != null ? '·S' + found.season : ''})`); saved++; }
    } catch (e) {
      console.log(`[${i + 1}/${total}] ${title} → 실패: ${e.message || e}`);
      failed++;
    }
    await sleep(300); // 작품 간 추가 안전 간격
  }

  console.log('\n═══════════════════════════════════════');
  console.log(` 완료 — 저장 ${saved} / 0건 ${empty} / 실패 ${failed} (대상 ${total})`);
  console.log(' 다음: 사이트 로그인 → "🖼 포스터 검수" 로 틀린 포스터 교정');
  console.log('═══════════════════════════════════════');
}

main().catch((e) => { console.error('[치명적 오류]', e); process.exit(1); });
