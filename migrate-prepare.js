#!/usr/bin/env node
/**
 * migrate-prepare.js
 * ──────────────────────────────────────────────────────────────────────────
 * 애니 점수표를 Supabase로 이관하기 위한 "정규화 CSV 생성" 스크립트.
 *
 * 입력 : 애니점수data - data_template.csv  (관리자 확정 최신 단일 소스)
 *        헤더 = title,score,type,quarter,series,note,genre (series는 무시 — 후속 제거됨)
 * 출력 : anime_seed.csv      (anime 테이블 import용 — type/score 정규화, year/season 파싱)
 *        quarters_seed.csv   (quarters 메타 테이블 import용 — distinct 분기 + year/season)
 *        seed_insert.sql     (★ 권장 적재 경로 — SQL Editor에 붙여 Run. 빈값=NULL 처리)
 *
 * ※ CSV import는 빈 정수("")를 int NULL로 못 바꿔 에러(22P02) → seed_insert.sql 권장.
 *
 * 안전 원칙:
 *   - DB에 접속하지 않는다. 파일만 읽고 파일만 쓴다(부작용 없음).
 *   - truncate/delete 등 destructive 명령은 절대 실행하지 않는다(스크립트 자동 실행 없음).
 *     생성된 seed_insert.sql 맨 앞 delete 문도 [관리자 승인 필요] 주석으로만 표기.
 *
 * 실행(PowerShell, 이 파일이 있는 폴더에서):
 *   node migrate-prepare.js
 *
 * Node 18+ 필요(별도 패키지 없음, 표준 라이브러리만 사용).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── 경로 ────────────────────────────────────────────────────────────────
const SRC = path.join(__dirname, '애니점수data - data_template.csv');
const OUT_ANIME = path.join(__dirname, 'anime_seed.csv');
const OUT_QUARTERS = path.join(__dirname, 'quarters_seed.csv');
const OUT_SQL = path.join(__dirname, 'seed_insert.sql');

// ── CSV 파서 (index.html parseCSV/parseCSVLine과 동일 규칙: 따옴표 인식) ──
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}

function parseCSV(text) {
  // CRLF/CR 모두 정규화 후 분리
  const lines = text.replace(/\r\n?/g, '\n').trim().split('\n');
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = parseCSVLine(line);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
      return obj;
    });
}

// ── CSV 출력용 셀 이스케이프 ───────────────────────────────────────────
// 빈값은 빈 셀로 둔다(Supabase Import 시 빈 셀 → NULL 처리됨).
function csvCell(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCSV(headers, rows) {
  const head = headers.map(csvCell).join(',');
  const body = rows.map(r => headers.map(h => csvCell(r[h])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}

// ── SQL 리터럴 변환 (★ 빈값/null → NULL, 텍스트는 작은따옴표 이스케이프) ──
// null·undefined·빈문자열 → SQL NULL (빈 int "" 캐스팅 에러 22P02 원천 차단).
function sqlText(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";   // 작은따옴표 → '' 이스케이프
}
function sqlNum(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  const n = Number(v);
  return Number.isNaN(n) ? 'NULL' : String(n);
}

// ── type 강제 정규화 (§9-2a — index.html buildData 분류 규칙과 100% 동일) ──
// 'seasonal'(trim+소문자 정확 일치)만 seasonal, 그 외 전부 classic.
function normalizeType(rawType) {
  return String(rawType ?? '').trim().toLowerCase() === 'seasonal'
    ? 'seasonal'
    : 'classic';
}

// ── score 정규화: 빈값/공백 → null, 그 외 parseFloat ───────────────────
function normalizeScore(rawScore) {
  const s = String(rawScore ?? '').trim();
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

// ── quarter 문자열 → { year, season } 파싱 ("25년 4분기" → 2025/4) ──────
// "25"처럼 2자리 연도는 2000+ 보정. 4자리(예: 2025)는 그대로.
const QUARTER_RE = /(\d+)\s*년\s*(\d+)\s*분기/;
function parseQuarter(quarterStr) {
  const s = String(quarterStr ?? '').trim();
  const m = s.match(QUARTER_RE);
  if (!m) return { year: null, season: null };
  let year = parseInt(m[1], 10);
  const season = parseInt(m[2], 10);
  if (year < 100) year += 2000;            // 25 → 2025
  if (season < 1 || season > 4) return { year, season: null };
  return { year, season };
}

// ── seed_insert.sql 본문 생성 (anime 전용 — quarters는 이미 적재됨) ──────
// multi-row INSERT (SQL Editor 한 번에 Run 가능). 빈 int/score는 NULL.
// quarters(17행)는 관리자가 이미 적재 완료 → 본 파일은 anime 만. quarters 미접촉.
function buildSeedSQL(animeNorm, quarterRows, counts) {
  const L = [];   // 줄 누적
  L.push('-- ════════════════════════════════════════════════════════════════════════');
  L.push('-- seed_insert.sql — 애니 점수표 anime 데이터 적재 (migrate-prepare.js 자동 생성)');
  L.push('-- ════════════════════════════════════════════════════════════════════════');
  L.push('-- 적재 방법: Supabase 대시보드 → SQL Editor → New query → 이 파일 전체 붙여넣기 → Run');
  L.push('-- 전제: supabase_schema.sql 실행 완료 + quarters(17행) 이미 적재됨.');
  L.push('-- 이 파일은 anime 테이블만 채운다(quarters 는 건드리지 않음 — PK 중복 방지).');
  L.push('-- 빈 정수/score 는 모두 NULL 로 명시 → CSV import 의 22P02(빈"" → int) 에러 회피.');
  L.push('--');
  L.push('-- ⚠️ [관리자 승인 필요] destructive — 아래 delete 는 anime 재적재용. 기본은 주석 처리.');
  L.push('--    anime 가 비어 있으면(첫 적재) 그대로 두고 실행해도 무방(삭제할 행 없음).');
  L.push('--    이미 anime 에 데이터가 있어 깨끗이 재적재하려면 아래 줄의 맨 앞 "-- " 를 직접 제거.');
  L.push('-- delete from public.anime;');
  L.push('');
  L.push('-- ── anime (seasonal + classic) ──');

  // anime multi-row INSERT
  const aCols = 'title, score, type, quarter, year, season, note, genre';
  const aVals = animeNorm.map(a =>
    `  (${sqlText(a.title)}, ${sqlNum(a.score)}, ${sqlText(a.type)}, ` +
    `${sqlText(a.quarter)}, ${sqlNum(a.year)}, ${sqlNum(a.season)}, ` +
    `${sqlText(a.note)}, ${sqlText(a.genre)})`
  );
  L.push(`insert into public.anime (${aCols}) values`);
  L.push(aVals.join(',\n') + ';');
  L.push('');

  // 검증 쿼리 주석 (적재 후 실행)
  L.push('-- ════════════════════════════════════════════════════════════════════════');
  L.push('-- 적재 후 검증 (아래 주석을 풀어 실행 — 기대값과 일치 확인)');
  L.push('-- ════════════════════════════════════════════════════════════════════════');
  L.push(`-- select type, count(*) from public.anime group by type;  -- seasonal ${counts.seasonalCount}, classic ${counts.classicCount}`);
  L.push(`-- select count(*) from public.anime;                       -- ${counts.seasonalCount + counts.classicCount}`);
  L.push(`-- select count(*) from public.quarters;                    -- ${quarterRows.length} (이미 적재됨, 참고용)`);
  L.push('-- select count(*) from public.anime where type=\'seasonal\' and (year is null or season is null);  -- 0');
  L.push('');
  return L.join('\n');
}

// ── 메인 ────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`[오류] 소스 CSV를 찾을 수 없습니다: ${SRC}`);
    process.exit(1);
  }

  const text = fs.readFileSync(SRC, 'utf8');
  const rows = parseCSV(text);

  const animeRows = [];            // CSV 출력용(빈값='')
  const animeNorm = [];            // SQL 출력용(빈값=null 보존)
  const quartersMap = new Map();   // quarter문자열 → { quarter, year, season }
  const parseFailures = [];        // seasonal인데 year/season 파싱 실패한 행

  let skippedEmptyTitle = 0;
  let seasonalCount = 0;
  let classicCount = 0;

  for (const row of rows) {
    const title = String(row.title ?? '').trim();
    if (title === '') { skippedEmptyTitle++; continue; }   // 빈 title 행 스킵(count 제외)

    const type = normalizeType(row.type);
    const score = normalizeScore(row.score);
    const note = String(row.note ?? '').trim() || null;
    const genre = String(row.genre ?? '').trim() || null;

    let quarter = null, year = null, season = null;
    if (type === 'seasonal') {
      quarter = String(row.quarter ?? '').trim() || null;
      const parsed = parseQuarter(quarter);
      year = parsed.year;
      season = parsed.season;
      if (quarter && (year === null || season === null)) {
        parseFailures.push({ title, quarter });
      }
      // quarters 메타 누적(distinct)
      if (quarter && !quartersMap.has(quarter)) {
        quartersMap.set(quarter, { quarter, year, season });
      }
      seasonalCount++;
    } else {
      classicCount++;
    }

    animeRows.push({
      title,
      score: score === null ? '' : score,
      type,
      quarter: quarter ?? '',
      year: year === null ? '' : year,
      season: season === null ? '' : season,
      note: note ?? '',
      genre: genre ?? '',
      sort_order: '',          // 빈값 → DB default 0
    });
    // SQL용: null 보존(빈 int/score는 NULL로 나가야 함)
    animeNorm.push({ title, score, type, quarter, year, season, note, genre });
  }

  // ── quarters 정렬(year/season DESC) — quarters_seed.csv 가독성용 ──────
  const quarterRows = [...quartersMap.values()].sort((a, b) => {
    const ya = a.year ?? -Infinity, yb = b.year ?? -Infinity;
    if (yb !== ya) return yb - ya;
    const sa = a.season ?? -Infinity, sb = b.season ?? -Infinity;
    return sb - sa;
  });

  // ── type distinct 검증 (CHECK 위반 사전 차단) ───────────────────────
  const distinctTypes = [...new Set(animeRows.map(r => r.type))].sort();

  // ── CSV 쓰기 ─────────────────────────────────────────────────────────
  const animeHeaders = ['title', 'score', 'type', 'quarter', 'year', 'season', 'note', 'genre', 'sort_order'];
  const quarterHeaders = ['quarter', 'year', 'season'];

  fs.writeFileSync(OUT_ANIME, toCSV(animeHeaders, animeRows), 'utf8');
  fs.writeFileSync(OUT_QUARTERS, toCSV(quarterHeaders, quarterRows), 'utf8');

  // ── seed_insert.sql 생성 (★ 권장 적재 경로 — 빈값=NULL, 작은따옴표 이스케이프) ──
  const sql = buildSeedSQL(animeNorm, quarterRows, { seasonalCount, classicCount });
  fs.writeFileSync(OUT_SQL, sql, 'utf8');

  // ── 적재 직전 재카운트 로그 (S6 기준값 — 정직 보고) ──────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' migrate-prepare.js — 정규화 완료');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` 소스 파일        : ${path.basename(SRC)}`);
  console.log(` 소스 데이터 행수 : ${rows.length} (헤더 제외)`);
  console.log(` 빈 title 스킵    : ${skippedEmptyTitle}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log(` [적재 기준값 — S6]`);
  console.log(`   seasonal       : ${seasonalCount}`);
  console.log(`   classic        : ${classicCount}`);
  console.log(`   합계(anime)    : ${animeRows.length}`);
  console.log(`   distinct type  : { ${distinctTypes.join(', ')} }  ${
    distinctTypes.length === 2 && distinctTypes[0] === 'classic' && distinctTypes[1] === 'seasonal'
      ? '✔ (seasonal/classic 외 값 0건)'
      : '✘ 비정상 type 존재 — 확인 필요'
  }`);
  console.log(`   distinct 분기  : ${quarterRows.length}`);
  console.log('───────────────────────────────────────────────────────────');
  if (parseFailures.length === 0) {
    console.log(' year/season 파싱 실패 : 0건 ✔ (모든 분기 NOT NULL 보장 — D1)');
  } else {
    console.log(` year/season 파싱 실패 : ${parseFailures.length}건 ✘`);
    parseFailures.forEach(f => console.log(`   - "${f.title}" / quarter="${f.quarter}"`));
  }
  console.log('───────────────────────────────────────────────────────────');
  console.log(' 출력 파일:');
  console.log(`   ${path.basename(OUT_SQL)}     (★ 권장 적재 — anime ${animeRows.length} INSERT, quarters는 이미 적재됨)`);
  console.log(`   ${path.basename(OUT_ANIME)}     (${animeRows.length} 행, CSV 참고용)`);
  console.log(`   ${path.basename(OUT_QUARTERS)}  (${quarterRows.length} 행, CSV 참고용)`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' [적재 — 관리자 실행]');
  console.log(`   ★ 권장: ${path.basename(OUT_SQL)} 전체를 SQL Editor에 붙여넣고 Run (anime 만 채움)`);
  console.log('     (빈 정수/score 를 NULL 로 명시 → CSV import 의 22P02 에러 회피)');
  console.log('   적재 후 검증: 파일 끝 주석의 select 쿼리로');
  console.log(`     seasonal ${seasonalCount} / classic ${classicCount} / 합 ${animeRows.length} (quarters ${quarterRows.length} 이미 적재) 일치 확인`);
  console.log('   재적재 필요 시 파일 맨 앞 delete 줄(주석)은 [관리자 승인 필요] destructive.');
  console.log('═══════════════════════════════════════════════════════════');
}

main();
