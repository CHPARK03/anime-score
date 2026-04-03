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

// ── 제목 정규화 매핑 (축약·은어 + 잘못 검색되는 제목 → 영어/로마자 정식명) ──
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

  // ── 극장판 (서로 다른 애니인데 같은 포스터 할당되는 문제 수정) ──
  '5등분의 신부 극장판':    'The Quintessential Quintuplets Movie',
  '귀멸의 칼날 극장판':     'Demon Slayer Mugen Train',
  '주술회전 극장판':        'Jujutsu Kaisen 0',
  '오렌지 (극장판 포함)':   'Orange',

  // ── Fate 시리즈 (각각 다른 작품) ──
  'Fate/UBW':               'Fate stay night Unlimited Blade Works',
  'Fate/HF 전체':           'Fate stay night Heavens Feel',
  'Fate/카니발 판타즘':     'Carnival Phantasm',
  'Fate/이리야 시리즈':     'Fate kaleid liner Prisma Illya',
  'Fate/Grand Order':       'Fate Grand Order',

  // ── 감성 영화 (너의~, 날씨의~ 등 번역 오류) ──
  '너의 이름은':            'Kimi no Na wa',
  '날씨의 아이':            'Weathering with You',
  '너의 췌장을 먹고 싶어':  'I Want to Eat Your Pancreas',
  '목소리의 형태':          'A Silent Voice',
  '초속5cm':                '5 Centimeters per Second',

  // ── 최애의 아이 / 어둠의 실력자 혼선 ──
  '최애의 아이':            'Oshi no Ko',
  '날씨의 아이':            'Weathering with You',
  '어둠의 실력자가 되고 싶어서': 'The Eminence in Shadow',
  '어둠의 실력자 2기':      'The Eminence in Shadow Season 2',

  // ── 우자키 / 중2병 / 카구야님 혼선 ──
  '우자키 양은 놀고 싶어':     'Uzaki-chan Wants to Hang Out',
  '우자키 양은 놀고 싶어 2기': 'Uzaki-chan Wants to Hang Out 2',
  '중2병이라도 사랑이 하고 싶어': 'Chuunibyou demo Koi ga Shitai',
  '카구야 님은 고백받고 싶어 - 첫 키스는 끝나지 않아': 'Kaguya-sama Love Is War The First Kiss That Never Ends',

  // ── "나를~" 계열 혼선 ──
  '나를 먹고 싶은, 괴물':        'Watashi wo Tabetai Hitodenashi',
  '나를 좋아하는 건 너뿐이냐':   'Oresuki Are You the Only One Who Likes Me',
  '나를 너무 좋아하는 100명의 그녀': '100 Girlfriends Who Really Love You',
  '나를 좋아하는 100명의 히로인 2기': '100 Girlfriends Who Really Love You Season 2',

  // ── "내~" 계열 혼선 ──
  '내 마음의 위험한 녀석':       'The Dangers in My Heart',
  '내 마음의 위험한 녀석 2기':   'The Dangers in My Heart Season 2',
  '내 옆의 은하':               'The Galaxy Next Door',
  '내 여자친구와 소꿉친구가 완전 수라장': 'Oreshura',

  // ── "~할 수 없어" 계열 혼선 ──
  '소꿉친구와는 러브 코미디를 할 수 없어': 'Osananajimi ga Zettai ni Makenai Love Comedy',
  '밤의 해파리는 헤엄칠 수 없어': 'Yoru no Kurage wa Oyogenai',
  '아하렌 양은 알 수가 없어':     'Aharen-san wa Hakarenai',
  '사랑은 쌍둥이로 나눌 수 없어': 'Koi wa Futago de Warikirenai',

  // ── "이~" 계열 혼선 ──
  '이 미술부에는 문제가 있다':    'This Art Club Has a Problem',

  // ── 블루 계열 혼선 ──
  '블루 아카이브':               'Blue Archive the Animation',
  '블루 로크':                   'Blue Lock',

  // ── 기타 혼선 ──
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

  // ── 귀멸의 칼날 시즌별 ──
  '귀멸의 칼날 1기':             'Demon Slayer Kimetsu no Yaiba',
  '귀멸의 칼날 2기':             'Demon Slayer Entertainment District Arc',
  '귀멸의 칼날 3기':             'Demon Slayer Swordsmith Village Arc',

  // ── 주술회전 시즌별 ──
  '주술회전 1기':                'Jujutsu Kaisen',
  '주술회전 2기 1쿨':            'Jujutsu Kaisen Season 2',
  '주술회전 2기 2쿨':            'Jujutsu Kaisen Season 2',
  '주술회전 3기':                'Jujutsu Kaisen Season 3',

  // ── 스파이 패밀리 시즌별 ──
  '스파이 패밀리 1기':           'Spy x Family',
  '스파이 패밀리 2기':           'Spy x Family Part 2',
  '스파이 패밀리 3기':           'Spy x Family Season 3',

  // ── 최애의 아이 시즌별 ──
  '최애의 아이 2기':             'Oshi no Ko Season 2',
  '최애의 아이 3기':             'Oshi no Ko Season 3',

  // ── 샹그릴라 프론티어 시즌별 ──
  '샹그릴라 프론티어 1쿨':       'Shangri-La Frontier',
  '샹그릴라 프론티어 2쿨':       'Shangri-La Frontier',
  '샹그릴라 프론티어 2기':       'Shangri-La Frontier Season 2',

  // ── 진격의 거인 시즌별 ──
  '진격의 거인 최종편':          'Attack on Titan Final Season',
  '진격의 거인 4시 전편':        'Attack on Titan The Final Season Part 3',
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
