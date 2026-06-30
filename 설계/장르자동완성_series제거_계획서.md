# anime-score 후속 — 장르 자동완성 + series 완전 삭제 설계서

> 작성: planner (AgentRoom) · 기준일 2026-07-01
> 대상: `C:\Users\hohoh\chungho\coding\oneman\lab\개인_프로젝트(사업x)\anime`
> 전제: 구글시트→Supabase 전환 완료 + production 배포(commit d8b882f). anime/quarters 테이블 + RLS + 편집 CRUD 동작 중.
> 상태: **설계(Design) 단계 — 구현/검수/라이브 미접근.** 미해결 선택지 §C, 관리자 게이트 항목은 태그 표시.
> 범위 밖(다음 작업): 포스터 로딩 방식 개선(클릭 지연).

---

# 작업 1 — 장르 자동완성 (정확도가 핵심)

## 1-1. 요구사항 (1줄)
작품 **추가/편집 시 제목으로 AniList를 조회해 장르를 자동 제안**(장르 입력칸을 자동 채움 → 관리자가 그대로 두거나 수정), 결과는 **현재 한글 슬래시(/) 표기 스타일**에 맞춰 정확·세분하게 분류한다.

## 1-2. 검증 가능한 성공기준
| # | 기준 | 확인 |
|---|------|------|
| G1 | 작품 추가/수정 폼에서 "장르 자동" 버튼(또는 제목 입력 후 자동) 실행 시, 장르 입력칸이 한글 슬래시 표기(예: `로맨스/코미디/학원`)로 채워진다 | 폼에서 실제 채워짐 확인 |
| G2 | 자동 채운 값을 관리자가 자유롭게 수정/삭제 가능(덮어쓰기 강제 없음) | 입력칸 편집 가능 |
| G3 | AniList 미검색·매핑 실패 시에도 폼이 깨지지 않고, 빈칸 또는 "자동 실패" 안내만 표시(기존 수동 입력 그대로 가능) | 실패 케이스에서 수동입력 유지 |
| G4 | 자동 제안 장르가 **기존 표기 어휘 집합(약 35개 한글 대분류)** 내 값으로 정규화돼, 장르 필터(populateGenreFilter)에 이질적 신규 토큰을 난립시키지 않는다 | 제안 결과의 토큰이 매핑 사전 내 값인지 |
| G5 | 자동완성 추가가 **기존 조회·편집·포스터 기능에 영향 없음**(렌더/CRUD 회귀 0) | 전후 동작 비교 |

## 1-3. 현재 인프라 분석 (재활용 대상)
- `fetchPoster(title)` (index.html 793~836): 이미 `https://graphql.anilist.co` GraphQL POST로 `Media(search,type:ANIME){coverImage}` 조회. 3단계 fallback(원제목 → N기/쿨 제거 → mymemory 번역 ko→en 후 재검색) + `TITLE_ALIAS`(687~791) 보유.
- → **같은 엔드포인트·같은 fallback 경로에 GraphQL 필드만 추가**하면 장르 획득. 새 외부 의존성 0.
- 편집 폼: `openAnimeForm`(1065), 장르 입력 `#f-genre`(1090~1091), 저장 `saveAnimeForm`(1102~1140 `payload.genre`).
- 장르 표기 스타일: anime_seed.csv genre 컬럼 실측 — 323행 전부 약 35개 한글 대분류(로맨스/코미디/학원/판타지/액션/심리/드라마/SF/일상/음악/스포츠/이세계/하렘/미스터리/공포/좀비/히어로/마법/역사/모험/초능력/게임/아이돌/스파이/도박/가족/성인/경제/청춘/직장/격투/마법소녀/오컬트/코스프레 등)로 수렴. 스릴러/메카/백합 등은 0건 → **닫힌 어휘 집합**으로 매핑 사전 설계 가능.

## 1-4. AniList API 외부 의존성 검증 (가정 — dev 착수 시 재확인)
> planner는 라이브 미접근. 아래는 공개 문서 기준 **가정**, dev가 구현 전 실측 확인.
- 엔드포인트: `https://graphql.anilist.co` (현재 포스터에 이미 사용 중 = 실존·동작 확인됨).
- 문서: `https://docs.anilist.co/` / GraphQL 스키마 `https://studio.apollographql.com/public/AniList/` (Media 타입).
- **필드(가정)**: `Media { genres }` = 문자열 배열(영어 대분류 ~17개: Action, Adventure, Comedy, Drama, Romance, Sci-Fi, Slice of Life, Fantasy, Mystery, Supernatural, Sports, Music, Psychological, Mecha, Horror, Ecchi, Mahou Shoujo …). `Media { tags { name rank isMediaSpoiler } }` = 세분 태그 수백 개 + `rank`(0~100 신뢰도) + 스포일러 플래그.
- **무료/인증**: 인증 불필요(공개 쿼리). **rate limit(가정)**: 분당 ~90 요청(현재 포스터도 무인증 사용). 편집 시 1회성 호출이라 한도 압박 없음.
- **검증 단계(구현 시)**: ① 실제 제목 1건으로 `genres`+`tags{name rank}` 응답 받아 필드명·형태 확인 ② rate limit 헤더(`X-RateLimit-*`) 확인 ③ 429 시 재시도/안내 처리.

## 1-5. 장르 매핑 + 세분 선별 전략 (정확도 핵심 — 설계의 중심)

### (a) 2단계 소스: genres(대분류) + tags(세분, rank로 신뢰도)
- AniList `genres`(영어 대분류)는 **항상 채택 후보**(신뢰도 높음).
- `tags`는 수백 개로 과다 → **rank ≥ 임계값(가정 60)** + **isMediaSpoiler=false** 인 것만, 그리고 **매핑 사전에 한글 대응이 있는 태그만** 선별(난립 방지 G4).

### (b) 영한 매핑 사전(앱 표기 스타일로 정규화) — 닫힌 집합
**[N1] 매핑 사전의 한글 우변(target)은 anime_seed.csv 실측 장르 토큰 집합으로만 한정한다.** CSV에 장르로 등장하지 않는 한글 토큰(예: **메카·스릴러**)은 사전에서 **제외** — AniList가 Mecha/Thriller를 반환해도 매핑 대상이 없어 자동으로 버려진다(닫힌 집합 원칙 G4 자기충족).
> 실측 근거(2026-07-01): `메카`는 작품 제목 "메카닉 암즈"의 부분 문자열일 뿐 genre 컬럼엔 없음(해당 작 장르=`액션/SF/모험`), `스릴러`는 grep 0건. 둘 다 **장르 토큰으로는 부재**.

AniList 영어 → 현재 한글 표기(우변은 전부 CSV 실측 토큰):
```
// genres → (CSV 실측 토큰에 대응되는 것만)
Action→액션, Adventure→모험, Comedy→코미디, Drama→드라마, Romance→로맨스,
Sci-Fi→SF, Fantasy→판타지, Slice of Life→일상, Mystery→미스터리,
Supernatural→오컬트, Sports→스포츠, Music→음악, Psychological→심리,
Horror→공포, Ecchi→성인, Mahou Shoujo→마법소녀
//  ※ Mecha→(제외, CSV 0건), Thriller→(제외, CSV 0건) — 매핑하지 않음
// tags(세분) — rank 높고 CSV 실측 어휘에 대응되는 것만
School→학원, Isekai→이세계, Harem→하렘, Idol→아이돌, Zombie→좀비,
Super Power→초능력, Magic→마법, Video Games→게임, Historical→역사,
Gambling→도박, Family→가족, Espionage→스파이, Time Manipulation→SF, …
```
- **정규화 규칙**: ① genres 변환값 + 선별 tags 변환값을 합침 ② 중복 제거 ③ **앱에 이미 흔한 순서 우선**(로맨스→코미디→학원→판타지→액션… 가중 정렬) ④ 상위 N개(가정 4~5개)만 슬래시로 연결.
- **매핑 사전 구축 절차(구현 시)**: dev가 anime_seed.csv genre 컬럼을 distinct로 추출(약 34개 토큰)해 **그 집합을 매핑 우변의 허용 목록(allowlist)으로 고정** → 우변이 이 목록에 없으면 사전에 넣지 않음.
- 매핑에 없는 영어 장르/태그는 **버린다**(신규 한글 토큰 난립 방지 — G4). 단 결과가 0개면 genres 1개라도 음역해 최소 1개 보장.

### (c) 결과 형태
`로맨스/코미디/학원` 처럼 기존과 동일. 폼 `#f-genre`에 주입, 관리자 수정 가능(G2).

> **정확도 트레이드오프(미결 §C-1)**: tag rank 임계값(60 가정)·최대 장르 개수(4~5 가정)·매핑 사전 범위는 **관리자 취향에 영향** → 기본값으로 구현하되 관리자 검토 후 조정.

## 1-6. UI 흐름
```
편집 폼 열림 → 제목 입력
  → [장르 자동] 버튼 클릭 (또는 제목 blur 시 자동 1회)
  → fetchGenres(title): TITLE_ALIAS 적용 → AniList genres+tags 조회
       (포스터와 동일 3단계 fallback: 원제목→N기제거→번역)
  → mapGenres(): 영한 매핑 + tag rank 필터 + 정규화 → "A/B/C"
  → #f-genre.value = 결과 (비어있을 때만 자동, 이미 값 있으면 덮어쓰기 확인 — 미결 §C-2)
  → 실패 시 #f-msg에 "장르 자동 실패, 수동 입력하세요" (폼 정상)
```
- 로딩 표시: 버튼 "조회 중..." 비활성화. 응답/실패 후 복구.
- **렌더·CRUD 함수 불변**: 자동완성은 폼 입력칸을 채우는 보조 기능일 뿐, 저장 경로(saveAnimeForm)·표시(makeCard genre-badge)는 그대로.

## 1-7. 영향 파일 (작업 1)
| 파일 | 변경 | 내용 |
|------|------|------|
| `index.html` | 수정 | ① `fetchGenres(title)` 추가(fetchPoster의 AL 호출 경로 재사용, GraphQL에 `genres`/`tags{name rank isMediaSpoiler}` 추가) ② 영한 매핑 사전 `GENRE_MAP` + `mapGenres()` 추가 ③ openAnimeForm에 "장르 자동" 버튼 + 핸들러 ④ 소량 CSS(버튼) |
| (외부) AniList | 무변경 | 기존 엔드포인트 필드만 더 요청 |

> 단일 파일 변경이나 **외부 API 응답을 파싱·정규화→입력에 반영**(보안·복잡로직 성격) → dev 구현 시 깊은분석 라우팅 대상.

---

# 작업 2 — series(시리즈) 항목 완전 삭제

## 2-1. 요구사항 (1줄)
`series`(시리즈) 개념을 DB·코드·시드·문서에서 **완전 제거**한다. 기존 series 데이터(Fate 11건 등)는 손실되며 관리자 승인 완료.

## 2-2. 검증 가능한 성공기준
| # | 기준 | 확인 |
|---|------|------|
| R1 | 카드/모달에 series-badge가 더 이상 렌더되지 않고, 레이아웃이 깨지지 않는다 | 전후 화면 비교 |
| R2 | 편집 폼에 "시리즈" 입력칸이 없고, 저장 payload에 series 키가 없다 | 폼·payload 확인 |
| R3 | DB `anime` 테이블에 series 컬럼이 없고, select 쿼리(컬럼 목록)에 series가 없어 에러가 나지 않는다 | 스키마·쿼리 확인 |
| R4 | 시드/마이그레이션 산출물(SQL·CSV·스크립트)에 series가 없다 | 파일 검색 0건 |
| R5 | 코드베이스 전체 `series` 검색 시 잔존 참조 0건(주석 포함 정리) | grep 0 |

## 2-3. series 영향 전수 조사 (실측 — 2026-07-01)
| 위치 | 라인 | 내용 | 제거 방식 |
|------|------|------|----------|
| **DB** anime.series 컬럼 | supabase_schema.sql:26 | `series text,` | **[관리자 승인 필요] destructive** — 라이브는 ALTER DROP COLUMN(아래 2-4), 스키마 파일은 줄 삭제 |
| index.html CSS | 120 | `.series-badge {…}` | 삭제 |
| index.html buildDataFromRows | 387 | `if (row.series) anime.series = row.series;` | 삭제 |
| index.html makeCard | 474~476 | series-badge 렌더 + `(a.series||a.genre)` 마진 분기 | series 제거, 마진 조건을 `a.genre?'4px':'0'`로 |
| index.html select | 639, 974 | 컬럼 목록에 `series,` | 두 곳에서 series 제거 |
| index.html 주석 | 1063 | `// 작품 추가/수정 폼 (… series 필드 포함 — Q2)` | **주석에서 "series 필드 포함" 문구 제거**(R5 주석 포함 grep 0건 자기충족 — D1) |
| index.html openAnimeForm | 1086~1087 | "시리즈" 입력 필드(`#f-series`) | 필드 블록 삭제 |
| index.html saveAnimeForm | 1116, 1120 | `const series=…` + `payload={…series…}` | 두 줄 series 제거 |
| migrate-prepare.js | 8,143,146-147,190,219,225,240 | 헤더 주석·SQL 컬럼·CSV 헤더·정규화·푸시 | series 전부 제거(헤더 주석 포함) |
| anime_seed.csv | 헤더+전행 | `…,series,…` 컬럼 | series 컬럼 제거(재생성 권장) |
| seed_insert.sql | 15~ | insert 컬럼·값에 series | series 제거(재생성 권장) |
| supabase_schema.sql | 26 | 컬럼 정의 | 삭제 |
| 설계/Supabase_셋업_가이드.md | series 언급 0건(실측) | — | 변경 없음 |
| **전환 계획서** 설계/사이트내_편집_전환_계획서.md | series 다수 언급(설계 이력) | 과거 설계 기록 | 이력 문서이므로 본문 수정 대신 "series는 후속 제거됨(이 문서 참조)" 1줄 주석 추가 권장(미결 §C-3) |

> **주의**: `anime_seed.csv`·`seed_insert.sql`은 **migrate-prepare.js 산출물**이다. migrate-prepare.js에서 series 제거 후 **재생성**하면 두 파일이 자동 정합 — 수기 편집보다 재생성이 안전(단, 재생성은 소스 CSV 필요).

## 2-4. DB 컬럼 DROP 절차 — [관리자 승인 필요] destructive (분류기 차단, 관리자 직접 수행)
> planner/dev/분류기는 **라이브 DB에 접근·실행하지 않는다.** 아래 SQL을 **관리자가 Supabase 콘솔 SQL Editor에서 직접 실행**.

```sql
-- ⚠️ [관리자 승인 필요] DESTRUCTIVE — 기존 series 데이터(Fate 11건 등) 영구 손실.
-- 실행 전 권장: 백업( select id,title,series from public.anime where series is not null; 결과 보관 )
alter table public.anime drop column if exists series;
```
- **순서 권장**: ① (선택) 위 select로 series 데이터 백업 보관 → ② ALTER DROP → ③ 그 다음 **코드 배포**(series 없는 index.html). 컬럼이 사라진 뒤에도 코드가 series를 select하면 에러나므로 **DROP과 코드 배포는 같은 시점에** 진행(짧은 불일치 구간 주의 — 미결 §C-4).
- RLS·트리거엔 series 의존 없음(컬럼 단순 drop 안전).

## 2-5. 작업 2 영향 파일 요약
`index.html`(7개 지점), `migrate-prepare.js`, `supabase_schema.sql`, `anime_seed.csv`(재생성), `seed_insert.sql`(재생성), (라이브 DB ALTER — 관리자 직접). 전환 계획서는 이력 주석만.

---

# 공통 — 구현 단계(작업 분해)

1. **작업1 장르 자동완성**: `fetchGenres` + `GENRE_MAP`/`mapGenres` 추가 → openAnimeForm에 버튼·핸들러 → 제목 1건 실측으로 AniList genres/tags 응답 확인 → 매핑·정규화 검증(G1~G5).
2. **작업2 코드 series 제거**: index.html 7개 지점 + migrate-prepare.js + supabase_schema.sql 수정, seed CSV/SQL 재생성(R1~R5 grep 0 확인).
3. **DB DROP**: [관리자 승인 필요] — 관리자가 SQL Editor에서 `alter table … drop column series` 직접 실행(2-4).
4. **배포 정합**: series 없는 코드 배포를 DROP과 같은 시점에(불일치 구간 최소화). git push·배포는 **관리자 게이트**.
5. **검증**: 조회/편집/포스터/장르필터/자동완성 회귀 0, series 잔존 0건.

> 작업1·작업2는 **독립적이라 순서 무관**하나, 둘 다 openAnimeForm/저장 payload를 건드리므로 **충돌 방지 위해 한 번에 함께 수정** 권장(같은 함수 2회 편집 회피).

---

# §C. 미해결 선택지 (관리자 결정 — planner 추천+근거만, 단정 금지)
| # | 질문 | 추천 | 근거 |
|---|------|------|------|
| C1 | tag rank 임계값 / 최대 장르 개수 | rank ≥ 60, 최대 4~5개(추천) | 과다 태그 난립 방지 + 기존 카드가 보통 3~4개. 관리자가 결과 보고 조정 |
| C2 | 자동완성이 기존 #f-genre 값을 덮어쓸지 | **빈칸일 때만 자동, 값 있으면 "덮어쓸까요?" 확인**(추천) | 수정 중 실수 덮어쓰기 방지(G2) |
| C3 | 전환 계획서의 series 언급 처리 | 이력 보존 + "후속 제거됨" 주석 1줄(추천) | 과거 설계 기록은 삭제보다 이력 유지가 안전 |
| C4 | DB DROP과 코드 배포 시점 | **동시 진행**(추천) | series 컬럼 없는데 코드가 select하면 에러 → 불일치 최소화 |
| C5 | 자동완성 트리거 | 제목 옆 "장르 자동" 버튼(추천) vs 제목 blur 자동 | 버튼이 의도적·예측가능. 불필요 API 호출 감소 |
| C6 | AniList 외부 한도/필드 | dev가 구현 전 실측 검증(§1-4) | planner 라이브 미접근 — 가정 명시 |

---

# §D. 리스크
| 리스크 | 영향 | 완화 |
|--------|------|------|
| AniList 장르 부정확(영어 장르≠앱 표기) | 잘못된 자동 장르 | 매핑 사전 + 관리자 수정(G2) 최종 보정. 자동은 "제안"일 뿐 |
| 신규 한글 토큰 난립 | 장르 필터 오염 | 매핑 없는 장르 버림(G4), 닫힌 어휘 집합 |
| AniList rate limit(429) | 자동 실패 | 실패해도 폼 정상(G3), 안내만. 편집 1회성이라 한도 여유 |
| series DROP 후 코드가 series select | 조회 에러 | DROP·배포 동시(C4). select 컬럼에서 series 선제거 |
| series 데이터 영구 손실 | Fate 등 11건 시리즈 정보 소멸 | 관리자 승인 완료. DROP 전 select 백업 권장(2-4) |
| seed 파일 수기 편집 불일치 | 재마이그레이션 오류 | migrate-prepare.js 수정 후 **재생성**으로 정합 |
| 라이브 DB 직접 접근 | 사고 | planner/dev 미접근, DROP은 관리자 직접(2-4) |

---

# §E. 정직 보고 (가정/미결)
- AniList `genres`/`tags{rank}` 필드·rate limit은 **가정** — dev가 구현 전 실측(§1-4, C6).
- 장르 매핑 사전·임계값·최대 개수는 기본값 제안이며 **관리자 취향 조정 대상**(C1).
- DB `series` DROP은 **[관리자 승인 필요] destructive**, 관리자가 SQL Editor에서 직접 실행 — planner/dev/분류기 라이브 미접근.
- git push·배포는 관리자 게이트. 본 문서는 설계까지이며 **코드 미작성/미검증**.
- series 영향 12개 위치는 grep 실측(2026-07-01). 셋업 가이드 series 언급 0건 확인.
