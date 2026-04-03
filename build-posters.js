#!/usr/bin/env node
/**
 * build-posters.js
 * anime_score.json의 모든 제목에 대해 포스터 URL을 사전 수집하고
 * posters.json으로 저장한다.
 *
 * 사용법: node build-posters.js
 * Node.js 18+ 필요 (built-in fetch)
 */

const fs = require('fs');
const path = require('path');

// ── 제목 정규화 매핑 (축약·은어 → 실제 제목) ──────────────
const TITLE_ALIAS = {
  '나혼렙 2기':             '나 혼자만 레벨업',
  '귀칼 4기(대장장이)':     '귀멸의 칼날',
  '내청코':                 '나의 청춘 러브코미디는 잘못됐어',
  '중2병':                  '중2병이라도 사랑이 하고 싶어',
  '코미상':                 '코미 양은 커뮤증입니다',
  '코미상 2기':             '코미 양은 커뮤증입니다',
  '카구야님':               '카구야 님은 고백받고 싶어',
  '청춘돼지':               '청춘 돼지는 바니걸 선배의 꿈을 꾸지 않는다',
  '노겜노라 (극장판 포함)': '노 게임 노 라이프',
  'Fate/밥상':              "Today's Menu for Emiya Family",
  '블루록 1기, 2기':        '블루 로크',
  '진격의 거인 3기까지':    '진격의 거인',
  '너에게 닿기를 3기까지':  '너에게 닿기를',
  '비비':                   'Vivy Fluorite Eyes Song',
  '좀100':                  'Zom 100 Bucket List of the Dead',
  '팬스가 2기':             'Panty Stocking with Garterbelt',
  '팬티와 스타킹':          'Panty Stocking with Garterbelt',
  '오키나와 사투리':        '오키나와에서 좋아하게 된 아이가 사투리가 심해서 너무 괴로워',
  '이과 사랑':              '이과가 사랑에 빠졌기에 증명해보았다',
  '야한 이야기 sox':        'Shimoneta',
  '용족':                   'Long Zu',
};

// ── 제목 정규화 함수 ─────────────────────────────────────
function cleanTitle(t) {
  // 괄호 내용 제거 (극장판 포함, 여름 special 등)
  t = t.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  // 시즌/쿨 제거
  t = t.replace(/\s*\d+기$|\s*\d+쿨$|\s*시즌\s*\d+$|\s*Part\s*\d+$/i, '').trim();
  // 앞뒤 공백 정리
  return t.replace(/\s+/g, ' ').trim();
}

function stripSeason(t) {
  return t.replace(/\s*\d+기$|\s*\d+쿨$|\s*시즌\s*\d+$|\s*Part\s*\d+$/i, '').trim();
}

// ── API 함수들 ────────────────────────────────────────────
async function searchAniList(title) {
  try {
    const query = `query($s:String){Media(search:$s,type:ANIME){coverImage{large}}}`;
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { s: title } }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.Media?.coverImage?.large ?? null;
  } catch { return null; }
}

async function searchKitsu(title) {
  try {
    const url = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const json = await res.json();
    const img = json.data?.[0]?.attributes?.posterImage;
    return img?.original ?? img?.large ?? img?.medium ?? null;
  } catch { return null; }
}

async function translateWithGoogle(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = await res.json();
    // Google 번역 응답 파싱: [[["translated","original"...],...]...]
    const translated = json[0]?.map(t => t[0]).join('').trim();
    return translated || null;
  } catch { return null; }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── 포스터 검색 (5단계 fallback) ─────────────────────────
async function findPoster(originalTitle) {
  const canonical = TITLE_ALIAS[originalTitle] ?? originalTitle;

  // 1단계: canonical 원제목으로 AniList 검색
  let url = await searchAniList(canonical);
  if (url) return { url, method: 'AniList/canonical' };

  // 2단계: 시즌 제거 후 AniList 검색
  const stripped = stripSeason(canonical);
  if (stripped !== canonical) {
    url = await searchAniList(stripped);
    if (url) return { url, method: 'AniList/stripped' };
  }

  // 3단계: Kitsu로 한국어 그대로 검색 (Kitsu는 한국어 일부 지원)
  url = await searchKitsu(canonical);
  if (url) return { url, method: 'Kitsu/canonical' };

  // 4단계: Google Translate → 영어 → AniList 검색
  const base = stripped || canonical;
  const enTitle = await translateWithGoogle(base);
  if (enTitle && enTitle.toLowerCase() !== base.toLowerCase()) {
    url = await searchAniList(enTitle);
    if (url) return { url, method: 'AniList/google-translated' };

    // 5단계: Google 번역 결과로 Kitsu 검색
    url = await searchKitsu(enTitle);
    if (url) return { url, method: 'Kitsu/google-translated' };
  }

  return { url: null, method: 'not-found' };
}

// ── 메인 ─────────────────────────────────────────────────
async function main() {
  const dataPath = path.join(__dirname, 'anime_score.json');
  const outputPath = path.join(__dirname, 'posters.json');

  if (!fs.existsSync(dataPath)) {
    console.error('❌ anime_score.json이 없음:', dataPath);
    process.exit(1);
  }

  // 기존 posters.json 로드 (증분 업데이트 지원)
  let existing = {};
  if (fs.existsSync(outputPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      console.log(`📦 기존 posters.json 로드: ${Object.keys(existing).length}개\n`);
    } catch { existing = {}; }
  }

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  const allTitles = [
    ...data.seasonal.flatMap(s => s.anime.map(a => a.title)),
    ...data.classics.map(a => a.title)
  ];
  const unique = [...new Set(allTitles)];

  console.log(`🎯 총 ${unique.length}개 고유 제목 처리 시작\n`);

  const posters = { ...existing };
  let found = 0, skipped = 0, failed = [];
  const methodStats = {};

  for (let i = 0; i < unique.length; i++) {
    const title = unique[i];

    // 이미 있으면 스킵
    if (posters[title]) {
      skipped++;
      process.stdout.write(`⏭  [${i+1}/${unique.length}] ${title} (캐시)\n`);
      continue;
    }

    const { url, method } = await findPoster(title);
    methodStats[method] = (methodStats[method] || 0) + 1;

    if (url) {
      posters[title] = url;
      found++;
      process.stdout.write(`✅ [${i+1}/${unique.length}] ${title}  [${method}]\n`);
    } else {
      failed.push(title);
      process.stdout.write(`❌ [${i+1}/${unique.length}] ${title}\n`);
    }

    // 중간 저장 (10개마다)
    if ((i + 1) % 10 === 0) {
      fs.writeFileSync(outputPath, JSON.stringify(posters, null, 2), 'utf-8');
    }

    // Rate limit 방지
    await sleep(700);
  }

  // 최종 저장
  fs.writeFileSync(outputPath, JSON.stringify(posters, null, 2), 'utf-8');

  const total = unique.length;
  const totalFound = Object.keys(posters).length;
  console.log('\n' + '─'.repeat(60));
  console.log(`📊 결과 요약`);
  console.log('─'.repeat(60));
  console.log(`총 고유 제목: ${total}개`);
  console.log(`신규 수집:    ${found}개`);
  console.log(`캐시 재사용:  ${skipped}개`);
  console.log(`실패:         ${failed.length}개`);
  console.log(`최종 커버리지: ${totalFound}/${total} (${Math.round(totalFound/total*100)}%)`);
  console.log('\n검색 방법별 통계:');
  Object.entries(methodStats).forEach(([k, v]) => console.log(`  ${k}: ${v}개`));
  if (failed.length) {
    console.log('\n❌ 포스터 못 찾은 제목:');
    failed.forEach(t => console.log(`  - ${t}`));
    console.log('\n위 제목들은 TITLE_ALIAS에 수동으로 영어 제목을 추가하면 해결됩니다.');
  }
  console.log('\n✅ posters.json 저장 완료:', outputPath);
}

main().catch(e => {
  console.error('오류:', e);
  process.exit(1);
});
