# 애니 점수표 — Supabase 셋업 가이드 (관리자 작업)

> 대상: `lab/개인_프로젝트(사업x)/anime`
> 전제: 구글시트 읽기전용 → Supabase 직접 편집 전환 (설계서: `설계/사이트내_편집_전환_계획서.md`)
> 작성: dev (AgentRoom) · 기준일 2026-06-29
> 명령은 PowerShell 기준. **destructive 단계는 `[관리자 승인 필요]` 태그를 붙였고, 그 단계는 관리자가 직접 판단·실행한다.**

이 가이드대로 따라 하면 사이트가 Supabase에 연결되어 점수 수정·작품/분기 추가·삭제가 가능해진다.
**dev(코드)는 placeholder만 넣어 두었고, 실제 키/계정 생성은 관리자가 이 절차로 직접 수행**한다.

---

## 0. 무료 티어 한도 (2026-06-29 공식 페이지 재확인 — `https://supabase.com/pricing`)

| 항목 | Free 플랜 한도 | 이 프로젝트(애니 323행) |
|------|---------------|------------------------|
| API 요청 | **무제한**(공정사용) | 여유 |
| 월간 활성 사용자(MAU) | 50,000 | 여유 |
| DB 용량 | 500 MB | 수십 KB 수준 → 압도적 여유 |
| Egress(전송) | 5 GB/월 (+ 캐시 5 GB) | 여유 |
| 파일 저장 | 1 GB | 포스터는 외부(AniList)라 미사용 |
| **프로젝트 일시정지** | **1주 무방문 시 pause** | 첫 로드 시 깨어남(수 초 지연) — 개인용 허용 |

> ⚠️ pause 주의: 1주 이상 사이트를 안 열면 프로젝트가 멈춘다. 다시 열면 자동으로 깨어나지만 첫 로드가 느릴 수 있다. 가끔이라도 방문하면 영향 적음.

---

## 1. Supabase 프로젝트 생성

1. `https://supabase.com/` 접속 → 로그인(GitHub 계정 등)
2. **New project** 클릭
   - Organization 선택(없으면 생성)
   - Project name: `anime-score` (자유)
   - Database Password: **강한 비밀번호 지정 후 안전한 곳에 보관** (DB 직접 접속용 — 사이트 로그인과 별개)
   - Region: `Northeast Asia (Seoul)` 권장(한국에서 가장 빠름)
   - Plan: **Free**
3. 생성 완료까지 1~2분 대기.

---

## 2. SQL 스키마 + RLS 실행

1. 좌측 메뉴 **SQL Editor** → **New query**
2. 프로젝트 폴더의 **`supabase_schema.sql`** 내용을 **전체 복사 → 붙여넣기**
3. ⚠️ **아직 Run 하지 말 것.** 파일 안의 `<ADMIN_UID>` 자리표시자를 먼저 교체해야 한다.
   - → **3단계(관리자 계정 생성)에서 uid를 얻은 뒤** 다시 와서 교체하고 Run.
   - (순서상 계정을 먼저 만들고 와도 되고, 일단 테이블만 만들고 RLS 정책은 uid 교체 후 별도 실행해도 된다. 아래 4단계에 통합 안내.)

---

## 3. 단일 관리자 계정 생성

1. 좌측 메뉴 **Authentication** → **Users** → **Add user** → **Create new user**
   - Email: 관리자 이메일(예: 본인 이메일)
   - Password: **사이트 로그인에 쓸 비밀번호** 지정
   - **Auto Confirm User**: 체크(이메일 인증 생략)
2. 생성된 사용자 행을 클릭 → **User UID**(UUID 형식) 복사.
   - 예: `11111111-2222-3333-4444-555555555555`

---

## 4. RLS 정책에 관리자 uid 기입 후 SQL 실행

1. **SQL Editor**로 돌아가 붙여넣은 `supabase_schema.sql` 안의 모든 `<ADMIN_UID>` 를
   3단계에서 복사한 **실제 uid로 일괄 교체**.
   - 에디터에서 `<ADMIN_UID>` 찾기(Ctrl+F) → 전부 바꾸기(총 6곳: anime insert/update/delete, quarters insert/update/delete).
2. **Run** 클릭.
   - 결과: `anime`·`quarters` 테이블 + 인덱스 + RLS 8정책 + updated_at 트리거 생성.
3. 좌측 **Table Editor**에서 `anime`, `quarters` 두 테이블이 보이면 성공.

> RLS 검증(권장): SQL Editor에서 로그인 없이 `insert into anime(title,type) values('test','classic');` 실행 →
> **거부되면 정상**(쓰기는 관리자 uid만). 테이블 우상단 RLS enabled 표시도 확인.

---

## 5. 데이터 변환 (정규화 CSV 생성) — 로컬

> 이 단계는 DB에 접속하지 않는다. CSV 파일만 만든다(안전).

PowerShell에서:
```powershell
cd "C:\Users\hohoh\chungho\coding\oneman\lab\개인_프로젝트(사업x)\anime"
node migrate-prepare.js
```
- 출력 파일 2개 생성:
  - `anime_seed.csv` (323행 — anime 테이블용, type/score 정규화·year/season 파싱 완료)
  - `quarters_seed.csv` (17행 — quarters 메타용)
- 콘솔에 **적재 기준값**이 출력된다(검증용):
  ```
  seasonal : 215
  classic  : 108
  합계     : 323
  distinct type : { classic, seasonal }  ✔
  distinct 분기 : 17
  year/season 파싱 실패 : 0건 ✔
  ```
  이 숫자를 7단계 검증에서 비교한다.

---

## 6. CSV import (대시보드)

> ⚠️ **import 전 필수 — 빈 테이블 확인** (중복 누적 방지)

1. **SQL Editor**에서 실행:
   ```sql
   select count(*) from anime;
   select count(*) from quarters;
   ```
   - **둘 다 0이어야 한다.** 0이 아니면 import 금지(같은 데이터가 2배로 쌓임).
   - 이미 데이터가 있어 재적재가 필요하면 → **[관리자 승인 필요]**: 테이블 비우기(`truncate`/대량 `delete`)는
     복구 불가한 destructive 작업이다. dev/스크립트가 자동 실행하지 않는다. 관리자가 직접 판단·실행한다.

2. **적재 순서를 지킬 것** (quarters 먼저 → anime):
   - **Table Editor → `quarters` 테이블 → Insert → Import data from CSV** → `quarters_seed.csv` 선택 → import.
   - **Table Editor → `anime` 테이블 → Insert → Import data from CSV** → `anime_seed.csv` 선택 → import.
   - import 시 컬럼 매핑이 자동으로 맞는지 확인(헤더명 동일). `id`/`created_at`/`updated_at`은 비워두면 DB가 자동 채움.

---

## 7. 적재 검증 (S6 — 카운트 대조)

SQL Editor에서:
```sql
select type, count(*) from anime group by type;     -- 기대: seasonal 215, classic 108
select count(*) from anime;                          -- 기대: 323
select count(*) from quarters;                        -- 기대: 17
select count(*) from anime where type='seasonal' and (year is null or season is null);  -- 기대: 0
```
- 5단계 `migrate-prepare.js` 콘솔 숫자와 **정확히 일치**하면 성공.
- 불일치 시 import를 잘못한 것 → 6단계 [관리자 승인 필요] 절차로 비우고 재적재.

---

## 8. 사이트에 anon key / URL 기입

> **SUPABASE_URL은 이미 기입됨**(`https://oyrpghzgypwippdllcmc.supabase.co`). 남은 건 anon key 1개뿐.

1. Supabase 좌측 **Project Settings → API**(또는 **API Keys**)에서:
   - **anon public** key 복사 (`eyJhbGciOi...` 로 시작하는 긴 문자열)
   - ⚠️ **`service_role` key는 절대 사이트에 넣지 말 것**(전권 키 — 노출 시 RLS 우회됨). anon key만 사용.
2. **`index.html`** 열어서 상단 스크립트의 anon key 상수만 교체:
   ```js
   const SUPABASE_URL = 'https://oyrpghzgypwippdllcmc.supabase.co'; // (이미 기입됨)
   const SUPABASE_ANON_KEY = '<SUPABASE_ANON_KEY_HERE>'; // ← 복사한 anon public key로 교체
   ```
   - anon key·URL 노출은 **정상**(설계상 공개 전제, RLS가 쓰기 방어).

---

## 9. 로컬 확인

1. PowerShell에서 정적 서버 실행(둘 중 하나):
   ```powershell
   cd "C:\Users\hohoh\chungho\coding\oneman\lab\개인_프로젝트(사업x)\anime"
   npx serve .
   # 또는
   python -m http.server 8080
   ```
   > ⚠️ `index.html`을 파일로 직접 열면(`file://`) ES module import가 막힐 수 있으니 **반드시 http 서버로** 연다.
2. 브라우저에서 표시된 주소(예: `http://localhost:3000`) 접속.
3. **비로그인 확인**: 화면이 기존(구글시트 버전)과 동일하게 보이는지 — 탭/검색/정렬/점수필터/장르필터/카드/모달/통계 4종.
4. **편집 확인**:
   - 우상단 **`✎ 편집`** 버튼 클릭 → 로그인 폼 → 3단계 이메일/비번 입력 → 로그인.
   - 로그인 후: 각 카드에 ✎/🗑, 분기 헤더에 "작품 추가"/"분기 삭제", 상단에 "+ 새 분기 추가" 노출.
   - 점수 하나를 바꿔 저장 → 새로고침 후에도 유지되는지 확인.
   - 다른 기기/시크릿창에서 같은 변경이 보이는지 확인(DB 반영).

---

## 10. 배포 (관리자 요청 시에만 — dev/git push 금지 규칙)

- 이 사이트는 Vercel 정적 배포(`anime-score`)다. **빌드 설정 변경 불필요**(여전히 정적 HTML).
- anon key/URL을 기입한 `index.html`을 배포하면 운영에 반영된다.
- ⚠️ **git commit·push·배포는 관리자가 직접/명시 요청 시에만.** (CLAUDE.md 규칙 — dev는 자동 실행 안 함)

---

## 참고 — 보안 모델 (오해 방지)

- 화면의 `✎ 편집` 토글·로그인 폼은 **UX 가림막**일 뿐 진짜 보안이 아니다. 공개 사이트라 anon key·코드는 누구나 소스에서 볼 수 있다.
- **실제 쓰기 차단은 Supabase RLS**가 한다: `auth.uid() = 관리자 uid` 일 때만 insert/update/delete 통과.
- 즉 로그인 안 한 사람이 콘솔에서 직접 쓰기를 시도해도 RLS가 거부한다(S5). anon key 노출은 설계상 정상.
- **DB 패스워드는 코드/깃에 절대 넣지 않는다(클라이언트는 anon key만 사용). Postgres 직접 연결 시에만 쓰며, 채팅·문서에 노출되면 대시보드 Settings→Database에서 즉시 rotate.**

---

## series 컬럼 제거 (후속 작업 — series 기능 삭제)

> series(시리즈) 기능을 코드·DB에서 제거하는 작업. **순서가 중요** — 코드 배포와 컬럼 DROP을 같은 시점에(C4).

### ⚠️ 절대 금지: seed 재적재
- `anime_seed.csv` / `seed_insert.sql`로 **재적재하면 사이트에서 편집한 점수(8.5 등)가 원본 seed로 덮여 손실된다.**
- seed/CSV의 series 제거는 **"향후 새 프로젝트용 파일 정합"일 뿐.** 현재 운영 중인 DB에는 **재적재 금지**.
- 현 DB에는 **`series` 컬럼만 DROP**(데이터 행·점수는 그대로 보존).

### 절차 (관리자 직접 — 라이브 DB)
1. **(완료) 백업**: 관리자가 이미 `backup_anime_rows.csv`로 export 보관. (필요 시 SQL Editor에서 `select * from public.anime;` 결과 보관)
2. **series 없는 코드 배포** (series를 select하지 않는 index.html) — 컬럼이 사라진 뒤 코드가 series를 조회하면 에러나므로, 배포와 DROP을 **연이어** 진행.
3. **[관리자 승인 필요] DESTRUCTIVE — 컬럼 DROP** (SQL Editor에서 직접 실행):
   ```sql
   -- ⚠️ 기존 series 데이터(Fate 11건 등) 영구 손실. 백업(1단계) 확인 후 실행.
   alter table public.anime drop column if exists series;
   ```
   - 이 DROP은 **컬럼만 제거**한다. 행·점수·다른 컬럼은 그대로. **재적재 아님.**
   - RLS·트리거엔 series 의존 없음 → 단순 drop 안전.

---

## 트러블슈팅

| 증상 | 원인/해결 |
|------|----------|
| "Supabase 연결이 아직 설정되지 않았습니다" | 8단계 URL/anon key 미기입 → `index.html` 상수 교체 |
| 데이터가 안 보임/에러 | RLS select 정책 미적용 or 키 오타. 2·8단계 재확인 |
| 로그인은 되는데 저장이 안 됨(거부) | RLS의 `<ADMIN_UID>`가 실제 로그인 계정 uid와 불일치 → 4단계 uid 재확인 |
| import 후 카운트가 2배 | 6단계 빈 테이블 확인을 건너뜀(중복) → [관리자 승인 필요] 비우고 재적재 |
| `file://`로 열어서 동작 안 함 | 9단계처럼 http 서버로 열 것 |
| 분기 순서가 이상함 | quarters의 year/season 값 확인(파싱 오류). 정상 데이터면 year/season DESC로 자동 정렬 |
