# anime-score — 포스터 정확도 개선(A안: TMDB 도입 + poster_url DB 저장 + 검수 갤러리) 설계서

> 작성: planner (AgentRoom) · 기준일 2026-07-01
> 대상: `C:\Users\hohoh\chungho\coding\oneman\lab\개인_프로젝트(사업x)\anime`
> 전제: Supabase 전환 완료 + 편집 CRUD + 장르 후보선택 반자동(장르자동완성_series제거_계획서.md 작업 1-R) 동작 중.
> 상태: **설계(Design) 단계 — 구현/검수/라이브 미접근.** DB ALTER·git push는 관리자 게이트.
> 관련 선행 설계: `설계/사이트내_편집_전환_계획서.md`(스키마·RLS), `설계/장르자동완성_series제거_계획서.md`(후보선택 UI).
> **확장 2026-07-01: 전체 재처리(덮어쓰기) + 1기/2기 시즌 포스터 → §12 참조.**
>
> **⚠️ 정정 2026-08-27 — 덮어쓰기 기본값 폐기 (C11 대체 해결):**
> `bulk-fill-posters.js` 의 **기본 동작이 "빈 것만 채움(fill)"으로 바뀌었다.**
> `poster_url IS NULL` 인 작품만 처리하므로, **사람이 검수 갤러리에서 확정한 포스터는
> 재실행해도 절대 덮어써지지 않는다.** 전체 재처리는 `--all` 플래그를 명시할 때만 동작한다.
> → 이로써 미결이던 **C11(`poster_locked` 컬럼)은 스키마 변경 없이 해소**되었다.
> 아래 본문의 "매번 전체 덮어쓰기 / 백업 필수 / poster_locked 후속" 서술은
> **2026-07-01 시점 설계 이력**으로만 읽을 것.
> (동시 조치: 전체 poster_url 백업 304건 → `backup_posters_20260827.csv`)

---

## 1. 요구사항 (1줄)
한글 제목의 AniList(영/일 기반) 매칭 실패로 **포스터·장르가 부정확/누락**되는 문제를, **TMDB(ko-KR 한국어 검색)를 검색 소스로 추가**하고 후보 선택 시 **poster_url을 DB에 확정 저장**해 영구 정확하게 만들며, **기존 323개를 검수 갤러리로 일괄 교정**한다.

## 2. 근본 원인 (실측 기반)
- 포스터 표시 경로(index.html 955~974): `POSTERS[title](posters.json) → 없으면 fetchPoster()`. `fetchPoster`(807)는 **AniList `Media(search)` coverImage** — 한글 제목이 romaji/english/native 인덱스에 안 걸리면 실패 → **포스터 미표시**.
- 장르 후보(915 `fetchGenreCandidates`)도 같은 AniList 검색 → 같은 원인으로 후보 0건 다수.
- → **포스터·장르가 같은 뿌리(한글 매칭 실패)**. TMDB ko-KR로 한글 매칭률을 올리고, 한 번 고른 결과를 DB에 박아 재검색 의존을 끊는다.

## 3. 검증 가능한 성공기준
| # | 기준 | 확인 |
|---|------|------|
| P1 | 장르 자동 후보 목록에 **AniList + TMDB(ko-KR) 후보가 함께** 표시된다(소스 배지로 구분) | 후보에 TMDB 항목 등장 |
| P2 | 후보 클릭 시 **장르(AniList 있을 때) + poster_url이 함께 확정**되어 저장 payload에 포함된다 | 저장 후 DB row에 poster_url |
| P3 | 카드/모달 포스터 표시 우선순위 = **poster_url(DB) → posters.json → 라이브검색** 순으로 동작 | poster_url 있는 작품은 라이브 호출 0 |
| P4 | poster_url이 채워진 작품은 새로고침/타기기에서 동일 포스터 영구 표시 | 재로드 확인 |
| P5 | **검수 갤러리**에서 전 작품 썸네일 그리드 → 빈/틀린 포스터 클릭 → 후보 선택 → poster_url 저장 후 그리드 즉시 갱신 | 교정 1건 왕복 |
| P6 | 후보 0건 시 **영문/일본어 재검색 입력 + 포스터 URL 직접 입력**(최종수단) 제공, 폼 정상 | 실패 케이스 |
| P7 | 기존 조회·편집·장르후보·저장에 회귀 0. TMDB key 미설정 시 AniList만으로 기존대로 동작(graceful) | key 없이도 동작 |
| P8 | poster_url은 **소스 독립 문자열**(TMDB든 AniList든 절대 URL) — 미래 소스 교체/상업화 전환 시 컬럼 그대로 유지 | 스키마 검토 |

---

## 4. 스키마 변경 — `anime.poster_url` 추가

### 4-1. 컬럼 정의
```sql
-- anime 테이블에 포스터 URL 컬럼 추가 (소스 독립: TMDB/AniList/직접입력 무관 절대 URL 저장)
alter table public.anime add column if not exists poster_url text;
```
- **[관리자 승인 필요]는 아님** — `add column`은 non-destructive(기존 데이터 보존, 기본 NULL). 그래도 **라이브 DB 변경이므로 관리자가 SQL Editor에서 직접 실행**(planner/dev 라이브 미접근). destructive 아니라 백업 불필요.
- `supabase_schema.sql`에도 컬럼 추가(26행 note 근처)해 스키마 파일-라이브 정합.
- RLS 변경 불필요(컬럼 추가는 기존 anime 정책 그대로 적용).

### 4-2. 소스 독립성 (P8 / 미래 상업화 대비)
- poster_url은 **완성된 절대 URL 문자열**만 저장(예: `https://image.tmdb.org/t/p/w500/xxx.jpg` 또는 AniList coverImage URL). 소스 종류를 DB에 안 박음 → 나중에 소스를 바꿔도 컬럼 구조 불변.
- **상업화 전환 시**(TMDB 상업 라이선스 필요) : 이미 저장된 poster_url은 그대로 두고, 신규 검색만 라이선스/서버리스 프록시로 전환하면 됨. DB 구조 변경 0.

---

## 5. TMDB 통합 (검색 소스 추가)

### 5-1. 외부 의존성 (가정 — dev 구현 전 실측 검증 이관)
> planner 라이브 미접근. 아래는 director 조사 + 공개 문서 기준 **가정**.
- 검색: `https://api.themoviedb.org/3/search/tv?query={제목}&language=ko-KR&api_key={KEY}` (애니=대개 TV 시리즈. movie도 필요 시 `/search/movie`).
- 이미지: `https://image.tmdb.org/t/p/w500{poster_path}` (썸네일 w185/w342, 저장 w500 가정).
- 문서: `https://developer.themoviedb.org/reference/search-tv` / 이미지 `https://developer.themoviedb.org/docs/image-basics`.
- **[dev 실측 확인 필수]**: ① API key 발급/인증 방식(v3 api_key vs v4 Bearer) ② rate limit(가정: 관대, ~50/초대) ③ **무료 조건 = 비상업 한정, attribution(출처표기) 의무** ④ 응답 필드(`results[].id/name/original_name/poster_path/first_air_date/overview`).
- **⚠️ 라이선스**: TMDB 무료는 **비상업 전용**. 현재 개인·비영리라 OK. **광고 등 상업화 시 유료 라이선스 or 소스 전환 필요** — 설계·코드 주석에 명시(§9 리스크).
- **출처표기 의무(가정)**: "This product uses the TMDB API but is not endorsed or certified by TMDB." + 로고 → 푸터에 넣는다(P 미결 §8-C6).

### 5-2. API key 취급
- 관리자 발급 → index.html 인라인 상수 `TMDB_API_KEY`(anon key처럼 placeholder `<TMDB_API_KEY>`).
- **정적 사이트라 클라이언트 노출됨** — 개인 무료라 허용(설계 명시). 미래 상업/키보호 필요 시 **Supabase Edge Function 등 서버리스 프록시로 전환**(구조만 언급, 이번 범위 밖).
- 미설정(placeholder 그대로)이면 TMDB 스킵, AniList만으로 동작(P7 graceful).

### 5-3. 통일 후보 스키마 (AniList + TMDB 병합의 핵심)
두 소스를 **하나의 후보 객체 형태**로 정규화해 renderGenreCandidates가 소스 무관하게 렌더:
```
Candidate = {
  source: 'anilist' | 'tmdb',
  id,                          // 소스별 원본 id(중복제거 키 = source+id)
  titleMain,                   // 표시 제목(anilist=romaji, tmdb=name(ko))
  titleSub,                    // 보조(anilist=native, tmdb=original_name)
  posterUrl,                   // anilist=coverImage.large, tmdb=image w500
  thumbUrl,                    // 후보 목록 썸네일(anilist=coverImage.medium, tmdb w185)
  genres, tags,                // anilist만 보유. tmdb=[] (장르 매핑 불가 → 장르는 빈값)
}
```
- **AniList 후보**: 장르 매핑 O + 포스터. **TMDB 후보**: 포스터·한글제목 O, **장르 매핑 X**(genres 없음 → 장르 미리보기 "(TMDB — 장르 없음)").
- → 관리자가 **한글로 잘 잡히는 TMDB로 포스터 확정**하고, 장르는 AniList 후보에서 잡히면 그걸로, 아니면 수동 입력. (둘 다 잡히면 한 후보에서 포스터+장르 동시 확정 — AniList)
- **미결 §8-C1**: TMDB 후보 선택 시 장르는 어떻게? (추천: 포스터만 확정, 장르는 별도 AniList 후보나 수동)

### 5-4. 검색 전략 (호출 최소화)
1. **AniList Page 검색**(기존 fetchGenreCandidates 로직) → 후보 취득.
2. **TMDB search/tv?language=ko-KR** → 후보 취득(한글 그대로, 번역 불필요 — TMDB가 ko 지원).
3. 두 결과를 Candidate로 정규화 → 병합 → `source+id` 중복 제거 → **소스 섞어 정렬**(§8-C2: TMDB 우선? 관련도순?).
- TITLE_ALIAS는 AniList 경로에만 적용(기존). TMDB엔 한글 원제 그대로(ko-KR라 원제가 유리).
- 호출: AniList 1~3회(기존) + TMDB 1회 = 제목당 최대 ~4회. 편집 1회성이라 여유.

---

## 6. 편집/표시 경로 변경

### 6-1. 후보 선택 → 장르 + poster_url 동시 확정 (P2)
- `pickGenreCandidate(idx)` 확장: 선택 Candidate에서
  - `genres/tags` 있으면 `mapGenres` → `#f-genre`(기존).
  - **`posterUrl` → 폼에 hidden/표시 필드 `#f-poster` 세팅** → saveAnimeForm payload에 `poster_url` 포함.
- 폼에 **포스터 미리보기 + "포스터 URL 직접 입력" 필드**(P6 최종수단) 추가.

### 6-2. 포스터 표시 우선순위 (P3) — 렌더/모달 경로
현재 카드 클릭 → 모달(955~974)에서 `POSTERS[title] → fetchPoster`. 여기에 **poster_url 최우선** 삽입:
```
표시 URL = anime.poster_url (DB, 있으면 즉시)  ← 신규 최우선
         → POSTERS[title] (posters.json 캐시)
         → fetchPoster(title) (AniList 라이브, 최후)
```
- **[D1] 모달 핸들러의 poster_url 도달 경로(확정)**: 모달 핸들러(index.html **955~974**)에서 **`findAnimeById(card.dataset.id)?.poster_url`로 DATA를 조회 → 값 있으면 최우선 사용, 없으면 `POSTERS[title]`(posters.json) → `fetchPoster()`(라이브) fallback**. `findAnimeById`는 index.html **1082행에 기존 존재**하므로 그대로 재사용 → **makeCard에 `data-poster-url` 등 DOM 속성 추가 불필요(XSS 표면 0)**. data-poster-url 방식은 채택하지 않는다.
- `buildDataFromRows`(index.html 379~)에서 `anime.poster_url = row.poster_url` 흡수(select 컬럼 목록에 `poster_url` 추가 — **653/1091** 두 곳).
- **카드 썸네일에도 poster_url 적용할지**는 §8-C3(현재 카드엔 포스터 미표시, 모달에만 표시 — 검수 갤러리는 썸네일 필요).

### 6-3. 검수 갤러리 (P5) — 기존 323개 일괄 교정
**추천 방식: 편집모드 전용 별도 탭/뷰 "포스터 검수"**(기존 분기/정주행/전체 탭 옆, 편집모드에서만 노출).
```
포스터 검수 뷰:
  전 작품을 썸네일 그리드로 표시(poster_url→posters.json→없으면 '빈 포스터' 표식)
  → 빈/틀린 포스터 클릭 → 그 작품 제목으로 후보 검색(§5-4)
  → 후보 선택 → poster_url(+장르) 저장 → 그리드 셀 즉시 갱신
  → 진행률 표시(예: "포스터 있음 210 / 323")
```
- **별도 화면 vs 기존 목록 확장**: **별도 검수 뷰 추천**(교정 전용 UX, 빈 포스터가 한눈에). 기존 카드 목록은 포스터를 원래 안 보여주므로 확장보다 전용 뷰가 명확.
- 편집모드(로그인) 전용 — 방문자엔 안 보임. RLS가 실제 쓰기 방어.
- **미결 §8-C4**: 검수 뷰를 탭으로 추가 vs 편집모드 상단 버튼으로 진입.

---

## 7. 영향 파일
| 파일 | 변경 |
|------|------|
| `index.html` | ① select 컬럼에 `poster_url`(639,974) ② `buildDataFromRows` poster_url 흡수 ③ 모달 표시 우선순위(955~974)에 poster_url 최우선 ④ `fetchGenreCandidates`→AniList+TMDB 병합(Candidate 정규화) ⑤ `renderGenreCandidates` 소스 배지+TMDB 대응 ⑥ `pickGenreCandidate` 포스터 동시 확정 ⑦ 폼에 포스터 미리보기+URL 직접입력+영/일 재검색(P6) ⑧ 검수 갤러리 뷰+CSS ⑨ TMDB_API_KEY 상수 ⑩ 푸터 TMDB attribution |
| `supabase_schema.sql` | `poster_url text` 컬럼 추가 반영 |
| (라이브 DB) | `alter table anime add column poster_url text` — 관리자 직접(§4-1) |
| `설계/Supabase_셋업_가이드.md` | TMDB key 발급·poster_url ALTER 절차 1개 섹션 추가(권장) |
| (외부) TMDB | 신규 소스(무변경, 호출만) |

> 다중 함수(≥3) + 외부 API 신규 + 스키마 변경 → dev 구현 시 **깊은분석 라우팅 대상**.

---

## 8. 미해결 선택지 (관리자 결정 — 추천+근거)
| # | 질문 | 추천 | 근거 |
|---|------|------|------|
| C1 | TMDB 후보 선택 시 장르 처리 | ~~**포스터만 확정, 장르는 AniList 후보/수동**~~ → **2026-08-27 폐기, 아래 C1' 로 대체** | TMDB엔 앱 장르 매핑 소스 없음. 포스터는 TMDB, 장르는 AniList로 분업 |
| **C1'** | **TMDB 후보 선택 시 장르 처리 (2026-08-27 확정)** | **TMDB가 주는 `original_name`(일본어 원제)으로 AniList 를 1회 재조회해 장르 자동 입력** | **AniList 에는 한글 제목이 아예 없다** — 26년 3분기 신작 9편을 한글로 치면 전부 0건. 반면 TMDB ko-KR 은 한글로 찾아주면서 원제를 준다. 그 원제로 AniList 를 치면 native 필드와 직결돼 **9/9 정확 매칭 + 장르 확보**(실측 2026-08-27). C1 분업안은 "AniList 후보가 뜬다"를 전제했는데 신작에선 그 전제가 성립하지 않아 장르 자동이 사실상 죽어 있었다 |
| C2 | 후보 정렬(소스 섞기) | **TMDB(ko 매칭) 먼저 → AniList**(추천) | 한글 매칭이 목적. 단 관련도 뒤섞이면 C2b로 관련도순 검토 |
| C3 | 카드에도 poster_url 썸네일 표시할지 | **모달·검수뷰만(카드는 기존대로 텍스트)**(추천) | 카드 대량 이미지는 로딩부담·레이아웃 변경 큼. 범위 최소화 |
| C4 | 검수 갤러리 진입 | **편집모드 상단 "포스터 검수" 버튼 → 전용 뷰**(추천) vs 탭 추가 | 방문자 탭 오염 없이 편집자만. 탭이면 비편집자에도 보임 |
| C5 | TMDB key 미설정 시 | **TMDB 스킵, AniList만(graceful)**(추천) | key 없이도 기존대로 동작(P7) |
| C6 | TMDB attribution 위치 | **푸터에 문구+로고**(추천) | TMDB 무료 이용 의무. dev가 정확 문구 실측 |
| C7 | movie도 검색할지(극장판) | **tv 우선, 0건 시 movie**(추천) | 극장판·영화는 movie. 호출 절약 위해 tv 먼저 |

---

## 9. 리스크
| 리스크 | 영향 | 완화 |
|--------|------|------|
| TMDB 상업 라이선스(광고=상업) | 미래 유료화 필요 | 현재 개인 무료 OK. poster_url 소스독립(P8)이라 저장분은 유지, 신규만 전환. 코드 주석 명시 |
| TMDB attribution 누락 | 이용약관 위반 | 푸터 문구+로고 필수(C6), dev 실측 |
| API key 클라 노출 | 오남용 | 개인 무료 허용. 미래 서버리스 프록시 전환 경로 명시 |
| TMDB "N기" 시즌 통합 | 시즌별 포스터 구분 안 됨 | 본작 포스터로 충분(관리자 확인). 후보에서 사람이 선택하므로 오매칭 시 교정 가능 |
| 두 소스 후보 혼란 | 오선택 | 소스 배지 + 썸네일 + (장르)미리보기로 식별. 포스터 미리보기 제공 |
| poster_url ALTER(라이브) | 스키마 불일치 | add column은 non-destructive, 관리자 직접. select에 poster_url 추가 코드 동시 배포 |
| 검수 갤러리 대량 로딩(323썸네일) | 초기 지연 | lazy loading, poster_url/posters.json 우선(라이브 최소) |
| rate limit(TMDB/AniList) | 대량 교정 시 429 | 검수는 사람이 1건씩 → 자연 스로틀. 429 안내 |

---

## 10. 구현 단계 (작업 분해)
1. **스키마**: poster_url 컬럼 — supabase_schema.sql 반영 + 라이브 `alter table add column`(관리자 직접) + select 컬럼/buildDataFromRows 흡수.
2. **표시 경로**: 모달 표시 우선순위(poster_url→posters.json→라이브) 적용(P3/P4).
3. **TMDB 통합**: TMDB_API_KEY 상수 + search/tv ko-KR + Candidate 정규화 + fetchGenreCandidates 병합 + renderGenreCandidates 소스배지 + pickGenreCandidate 포스터 동시확정(P1/P2).
4. **보강**: 폼에 포스터 미리보기+URL 직접입력+영/일 재검색(P6), 푸터 attribution.
5. **검수 갤러리**: 편집모드 전용 뷰(그리드+교정+진행률)(P5).
6. **검증**: key 없이 graceful(P7), poster_url 영구표시(P4), 회귀 0, dev가 TMDB 무료조건·attribution·rate limit 실측.

---

## 11. 정직 보고 (가정/미결)
- TMDB API 필드·rate limit·무료조건·attribution 문구는 **가정** — dev 구현 전 실측(§5-1).
- **TMDB 무료 = 비상업 한정**. 현재 개인 OK, 상업화 시 전환 필요 — poster_url 소스독립 구조로 대비(P8).
- API key 클라 노출은 개인 무료 전제 허용 — 미래 서버리스 프록시 경로만 명시(구현 범위 밖).
- poster_url ALTER는 non-destructive지만 **라이브 변경이라 관리자 직접**(planner/dev 미접근). git push·배포 관리자 게이트.
- C1~C7 최종 확정은 관리자 게이트. 본 문서는 설계까지이며 **코드 미작성/미검증**.
- 미래 확장(다중사용자/에피소드점수/광고)은 이번 범위 밖 — poster_url 소스독립이라 확장에 구조적 무리 없음.

---
---

# §12 — 전체 재처리 + 1기/2기 시즌 포스터 (2026-07-01 확장)

> 관리자 확정: **전체 작품 재처리(덮어쓰기)** + **시즌(기수)별 다른 포스터**. 근본: 현재 검색은 기수 제거→본작 매칭이라 1기/2기가 같은 포스터가 됨.

## 12-1. 요구사항 (1줄)
일괄 스크립트(bulk-fill-posters.js)를 **전체 작품 대상(덮어쓰기)** 으로 확장하고, 제목의 **기수 N에 맞는 TMDB 시즌 포스터**를 저장한다. 검수 갤러리에서도 **시즌별 포스터를 후보로 펼쳐** 사람이 1기/2기를 고른다.

## 12-2. 검증 가능한 성공기준
| # | 기준 | 확인 |
|---|------|------|
| SP1 | "주술회전 3기"처럼 기수 있는 작품이 **해당 시즌(season_number=3) 포스터**로 저장된다(본작과 다름) | DB poster_url이 시즌 포스터 |
| SP2 | 기수 없는 작품/시즌 없는 경우 **본작 tv 포스터로 fallback**(빈값 아님) | fallback 동작 |
| SP3 | 스크립트가 **전체 작품**을 대상으로 돌며 기존 poster_url도 **덮어쓴다** | 대상 수 = 전체 |
| SP4 | 재실행 안전(멱등에 가깝게) + 진행 로그 + throttle로 429 회피 | 로그·재실행 |
| SP5 | 검수 갤러리에서 TMDB tv 후보 클릭 시 **본작 + season 1..N 포스터가 후보로 나열**되어 1기/2기 선택 가능 | 시즌 후보 렌더 |
| SP6 | 분할쿨·극장판 등 N≠season 어긋남 시 **본작 fallback**으로 빈 포스터 방지, 사람이 검수로 교정 가능 | 어긋남 케이스 |

## 12-3. 시즌 포스터 로직 (핵심)

### (a) 기수 N 추출
- `제목 → N`: 정규식 `(\d+)\s*기` 매칭(예 "주술회전 3기"→3, "스파이 패밀리 2기"→2). "쿨/시즌/Part"도 후보(§12-6 C8). N 없으면 `null`(기수 없는 작품).

### (b) TMDB 시즌 조회 흐름
```
1) search/tv(ko-KR, queryVariants) → 첫 유효 결과의 tv id 확보(현재는 poster_path만 쓰는데 id도 취함)
2) N == null → 본작 tv poster_path 사용(현행 동작 유지)
3) N != null → GET /tv/{id}?language=ko-KR → seasons[] 에서 season_number == N 검색
     - 있으면 그 season.poster_path 사용
     - 없거나 poster_path null → 본작 tv poster_path fallback (SP2/SP6)
4) tv 0건 → movie 검색(기존 C7) → 그 poster (극장판 등)
5) 전부 실패 → AniList → 그래도 0건 스킵
저장 URL = TMDB_IMG + 'w500' + poster_path
```
- **tmdbPoster 반환 확장**: 현재 `{url}`만 → `{ url, tvId, seasons }` 로(시즌 조회 재사용). 또는 findPoster에서 tvId 받아 `/tv/{id}` 1회 추가 호출.
- **N→season_number 어긋남(중요)**: 분할쿨("2쿨"=같은 시즌), 극장판, 스핀오프는 N이 TMDB season과 안 맞음 → **season_number==N 없으면 무조건 본작 fallback**(빈 포스터 금지). 정확 교정은 검수 갤러리(사람)로(SP6).

### (c) throttle (시즌 조회 추가 호출 대비 — SP4)
- 시즌 있는 작품마다 `/tv/{id}` 1회 추가 → 작품당 TMDB 호출 늘어남. 기존 `sleep(120)`(검색)·`sleep(300)`(작품간)에 더해 **`/tv/{id}` 호출 뒤 `sleep(150)`** 추가. 429는 기존 재시도(2000ms 대기) 유지.
- 전체 재처리는 323개 × (검색+시즌) → 넉넉히 잡아 수 분. 개인 1회성이라 허용.

## 12-4. 스크립트 변경점 (bulk-fill-posters.js)
| 위치 | 현재 | 변경 |
|------|------|------|
| 대상 쿼리(124~129) | `.is('poster_url', null)` | **필터 제거 → 전체 select**(덮어쓰기, SP3). 정렬 id asc 유지 |
| `tmdbPoster`(64~87) | 첫 poster_path만 반환 | **tv id 확보 + `/tv/{id}` seasons 조회 + season 매칭**(12-3b). 반환 `{url, source}` 유지하되 내부에서 시즌 결정 |
| `findPoster`(113~120) | 제목만 | **기수 N 추출**(extractSeasonNo) 후 tmdb에 N 전달 |
| 신규 | — | `extractSeasonNo(title)`, `tmdbSeasonPoster(tvId, N)` 함수 추가 |
| 로그(156) | source | source + `season N` 표기(예 "저장(tmdb·S3)") |
| 안내 문구 | "NULL만" | "전체 재처리(덮어쓰기)"로 문구 수정 |

> **[D1] 11~12행 재실행 스킵 주석 정정**: `bulk-fill-posters.js` **11~12행의 재실행 스킵 주석**('poster_url 있으면 건너뜀, 중간 끊겨도 남은 것만 처리')을 **전체 재처리(매번 전체 재검색·덮어쓰기, resume 아님)**로 정정하도록 dev에 지시한다. 전체 덮어쓰기로 바뀌어 resume(남은 것만 처리) 개념이 사라졌으므로, 주석이 실제 동작과 어긋나지 않게 문구를 맞춘다.

> service_role .env·커밋금지·관리자 로컬 실행은 **그대로 유지**(골격 준수). 스크립트는 DB 직접 update = **관리자 로컬에서만**, planner/dev 라이브 미접근.

## 12-5. 검수 갤러리 시즌 후보 (index.html)
- **후보 확장**: TMDB tv 후보 선택(또는 렌더) 시 `/tv/{id}` 호출해 **본작 poster + season 1..N poster를 후보 카드로 펼침**. 각 카드 라벨 = "본작" / "시즌 N (season.name)". 사람이 1기/2기 맞는 포스터 클릭 → 그 poster_url 확정.
- 기존 `fetchGenreCandidates`/`renderGenreCandidates`/`pickGenreCandidate`(§6·§5-3) 확장: Candidate에 `seasonPosters[]` 필드 추가, 렌더 시 시즌 포스터를 서브 후보로.
- **표시 개수**: 시즌이 많은 작품(장수 시리즈)은 후보 폭증 → **최대 표시 개수 제한**(§12-6 C10, 추천 본작+최대 6시즌).
- AniList는 2기가 별도 Media라 시즌 개념 없음 → **시즌 포스터는 TMDB 위주**, AniList는 단일 포스터 후보로만.

## 12-6. 미해결 선택지 (관리자 결정 — 추천+근거)
| # | 질문 | 추천 | 근거 |
|---|------|------|------|
| C8 | 기수 표기 범위(기/쿨/시즌/Part) → season_number 매핑 | **"N기"만 season_number=N 매핑, 쿨/Part는 본작 fallback**(추천) | 분할쿨(2쿨)은 같은 시즌이라 오매핑 위험. 애매하면 본작+검수 |
| C9 | N→season 어긋남 fallback | **season 없으면 본작 tv poster**(추천) | 빈 포스터 절대 방지(SP6). 정확 교정은 사람(검수) |
| C10 | 검수 갤러리 시즌 포스터 표시 개수 | **본작 + 최대 6시즌**(추천) | 후보 폭증 방지. 대부분 3~4기 이내 |
| C11 | 전체 재처리가 **수동 확정 poster_url도 덮어씀** | **지금은 덮어쓰기 OK(수동확정 개념 없음)** — 향후 `poster_locked` 플래그로 보호(후속) | 현재 수동확정 데이터 없음. 미래에 검수로 확정한 건 보호 필요 시 컬럼 추가 |
| C12 | 시즌 조회 API 추가 호출 throttle 강도 | **`/tv/{id}` 뒤 sleep(150) + 429 재시도 유지**(추천) | 개인 1회성이라 속도보다 안전 우선 |

## 12-7. 리스크 (§12 추가분)
| 리스크 | 영향 | 완화 |
|--------|------|------|
| N기≠TMDB season(분할쿨/극장판/스핀오프) | 엉뚱한 시즌 포스터 | season==N 없으면 본작 fallback(C9). 사람 검수로 최종 교정 |
| 시즌 조회로 TMDB 호출 급증 | 429/지연 | `/tv/{id}` 뒤 throttle(C12), 작품간 sleep 유지. 1회성이라 허용 |
| 전체 덮어쓰기로 좋은 포스터 유실 | 기존 정확 포스터 손상 | 관리자 확정(전체 재처리). **[N1] 전체 덮어쓰기 실행 전 기존 poster_url 백업 권장** — `select id, title, poster_url from anime where poster_url is not null` 결과를 파일로 저장(유실 대비 즉시 복구용). poster_locked(C11)는 후속이므로, 이번엔 즉시 백업으로 대비. 검수로 재교정도 가능 |
| 후보 시즌 폭증 | UI 부담 | 표시 개수 제한(C10) |
| tv id 확보 실패(검색 0건) | 시즌 조회 불가 | movie→AniList fallback, 그래도 0건 스킵(기존) |

## 12-8. §12 정직 보고
- TMDB `/tv/{id}` seasons[] 필드(season_number/poster_path/name)·rate limit은 **가정** — dev 구현 전 실측.
- "N기"→season_number는 **일반 시리즈엔 성립하나 분할쿨/극장판엔 어긋남** → 본작 fallback + 사람 검수로 보정(정직: 자동만으론 100% 정확 불가).
- 전체 재처리는 **기존 poster_url 덮어씀** — 관리자 확정. 수동확정 보호(poster_locked)는 후속(C11).
- 스크립트 DB 직접 update는 **관리자 로컬 실행**(service_role .env, 커밋금지). planner/dev 라이브 미접근. git push·배포 관리자 게이트.
