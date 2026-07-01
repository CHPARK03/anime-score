#!/usr/bin/env node
/**
 * bulk-fill-posters.js — 포스터 일괄 채우기 (일회용, 관리자 로컬 1회 실행)
 * ──────────────────────────────────────────────────────────────────────────
 * **전체 작품**을 TMDB(ko-KR)+AniList 로 자동 검색해 포스터 URL 을 DB에 저장한다.
 * 제목의 "N기"가 TMDB 시즌에 있으면 **그 시즌 포스터**, 없으면 **본작 포스터**로.
 * RLS 우회를 위해 service_role 키 사용.
 *
 * ⚠️ 전체 재처리(덮어쓰기): 매번 전체 작품을 재검색해 poster_url 을 **덮어쓴다**.
 *    (resume 아님 — 이미 채워진 것도 다시 검색·저장. 재실행하면 처음부터 전체.)
 *
 * ⚠️ 자동 1위/시즌 매칭이라 일부 오매칭(분할쿨·극장판·스핀오프 등) 가능하다.
 *    실행 후 사이트에서 로그인 → "🖼 포스터 검수" 갤러리로 틀린 것만 교정하라.
 *
 * ⚠️ [실행 전 백업 권장] 전체 덮어쓰기라 기존 정확 포스터가 바뀔 수 있다.
 *    Supabase SQL Editor에서 아래 결과를 파일로 저장해 두면 즉시 복구 가능:
 *      select id, title, poster_url from anime where poster_url is not null;
 *
 * ── 실행 방법 (PowerShell, 이 파일이 있는 폴더에서) ──────────────────────
 *   1) 의존성 설치:   npm install
 *   2) .env 작성:     .env.example 을 .env 로 복사 후 값 채우기
 *                     (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TMDB_API_KEY)
 *   3) (권장) 백업:   위 select 결과 저장
 *   4) 실행:          node bulk-fill-posters.js
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
  const queries = queryVariants(title);
  const seasonNo = extractSeasonNo(title);
  const t = await tmdbPoster(queries, seasonNo);
  if (t) return { url: t.url, source: 'tmdb', season: t.season };
  const a = await anilistPoster(queries);
  if (a) return { url: a, source: 'anilist', season: null };
  return null;
}

// ── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  // 대상: 전체 작품(덮어쓰기, SP3). 매번 전체 재검색 — resume 아님.
  const { data: rows, error } = await supabase
    .from('anime')
    .select('id,title,poster_url')
    .order('id', { ascending: true });

  if (error) {
    console.error('[오류] 대상 조회 실패:', error.message);
    process.exit(1);
  }

  const total = rows.length;
  console.log(`전체 재처리 대상: ${total}개 (기존 poster_url 덮어씀)`);
  if (total === 0) { console.log('작품이 없습니다. 종료.'); return; }
  console.log('※ 자동/시즌 매칭이라 일부 오매칭 가능 → 실행 후 사이트 "포스터 검수"로 교정하세요.');
  console.log('※ 실행 전 백업 권장: select id,title,poster_url from anime where poster_url is not null;\n');

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
