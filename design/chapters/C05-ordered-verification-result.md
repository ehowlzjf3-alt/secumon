# C05 도구·문맥·MCP 순차 검증

## Checkpoint374 — 선택·정리, MCP 보관·재개·중단 검증

이전 게시 `0ceef23` 뒤 checkpoint373 build3의 고정 산출물을 재사용해 도구·기억·스킬/문맥 8파일 **163/163**, MCP 읽기·수집·대기 7파일 **99/99**, custody A/B 5파일 **54/54**를 확인했다. 이어 새 build5에서 MCP profile/CLI/Web·중단 재개 **46/46**, 단순 응답 보관·정산·조회 **89/89**, 신규 collection 실제 중단/종료 **10/10**을 확인했다. 이전 201개에 별도 461개를 더한 선택 고유 **662개**다. [실행별 원로그·명령·지문](../../runtime/evidence/C05-ordered-checkpoint.json).

기억/스킬 원문 변경·권한 철회 때 이전 내용을 재사용하지 않는지, 실제 사용·문맥 한도에 따른 퇴출, 재사용의 논리 호출과 실제 전송 정산 분리, MCP 원응답 보관과 재개를 확인했다. MCP profile fixture는 같은 임시 registry를 사용하도록 연결했다. 보존한 crash6/drain4 후보는 제품 사본 없이 기존 fixture 위에 통합했다. 두 저장소에서 실제 SIGKILL의 raw-only/response receipt/usage commit 경계를 구분하고, profile 종료 시 원문 보관을 마치거나 기한 뒤 추가 게시를 차단하는지 확인했다. 이미 통합된 body/resume 시험은 다시 복사하지 않았다.

build4는 신규 crash worker의 검증된 입력 타입이 내부 함수에서 유지되지 않아 실패했다. 런타임 enum 검증 뒤 상수에 고정해 교정했고 build5(session51406)는 exit0이다. sourceDigest는 `4a6dbaed0f90f4a8fa251fb60e7296fafc8217376690ae7b6f1e467170506f6c`다. target5~7은 이전 build3, target8~10은 새 build5의 결과이며 전체662개를 한 소스에서 재실행한 것으로 표시하지 않는다. 이번에는 제품 코드를 바꾸지 않았고 전체 시험·코어/구조 검사를 이유 없이 반복하지 않았다. [build4 실패](../../runtime/evidence/C05-ordered-build4.log) · [build5](../../runtime/evidence/C05-ordered-build5.log) · [manifest](../../runtime/evidence/C05-ordered-build5-manifest.json).

남은 C05 로컬 인수는 **collection의 custody-only 결과를 가진 일반 CLI/HTTP 재개**다. 현재 collection 입구의 complete/nonfinal/partial batch와 profile 중단/종료 결과만으로 이 조합을 통과 처리하지 않는다. [비용 검토](C05-context-cost-review.md)의 현재 소스 기준선·중복 원문 조회 개선과 경합 검증도 남아 있다. 이번 기능 시험을 실제 토큰/I/O 절감 측정으로 확대하지 않는다. 현재 Linux/native Windows·최종 통합과 실제 모델/사내 서비스는 별도 인수이며 모델/API 시험 중단을 유지한다. 다음 [C06 준비](C06-ordered-verification-preparation.md)에서 Knox 직접 입구·격리 설치·두 담당 배치의 검증 공백도 기록했다.

아래 checkpoint373의 결과와 당시 남은 목록은 이력이다.

2026-09-08 · checkpoint373. 이번 선택 범위는 **고유 201개 통과**다. 신규 등록·일반 입구·관찰 진행 26개와 관련 기존 175개를 합한 수이며 재실행을 더하지 않는다. 전체 C05 또는 전체 목표의 완료는 아니다. [실행별 기록](../../runtime/evidence/C05-ordered-checkpoint.json)에 환경·소스 지문·실패 원로그·수정 후 결과를 보존했다.

## 바뀐 동작

일반 CLI/Web에서 컴퓨터 도구가 화면을 정상 관찰해도 준비 진전으로 계산되지 않아, 계획 → 관찰 → 행동 계획 단계에서 기본 무진전 한도 3에 걸렸다. 이제 코어가 생성한 관찰 도구의 신원을 확인하고 원관찰 검증·현재 권한 검사·결과 채택을 통과한 경우 새로운 화면 내용을 준비 진전으로 인정한다. 도구 등록 시 콜백을 고정하는 복사 과정에도 이 신원을 유지한다. 같은 이름·설명·콜백을 가진 임의 객체나 결과의 `kind`만으로 인정하지 않는다.

관찰 ID, 시각, lease 세대, revision, focus revision, element ref와 요소 배열 순서는 새 진전의 기준이 아니다. 같은 화면은 한 번만 인정하며 빈 화면도 진전으로 계산하지 않는다. 실제 값·상태가 달라지면 새로운 준비 진전이 될 수 있다. 이 처리는 근거 생성·완료 판정·실행 권한 부여가 아니다. 기본 무진전 한도와 자원 한도는 유지했다. 허용 목적지가 `local` 이외인 컴퓨터 관찰도 지원하도록 기존 로컬 자료 도구의 조건과 분리했다. 다른 목적지의 실제 드라이버 연동은 이번 검증 범위가 아니다.

## 확인한 입구와 시험 교정

- SQLite/file-journal 각각에서 일반 쓰기·합성 컴퓨터 도구를 CLI 및 loopback HTTP에 연결했다. 쓰기 1회, 합성 화면 입력 2회·저장 1회를 확인하고 같은 요청 재전달·동일 세션 재개·재접속에서 중복 실행이 없음을 확인했다. 쓰기 권한이 없으면 물리 입력은 없다.
- 일반 쓰기는 임시 원본과 보관 artifact·효과 영수증을 비교한다. 외부 원본을 바꾸면 현재 효과 검사가 실패한다. 합성 컴퓨터는 기존 원관찰·checkpoint 검증을 재사용한다. 두 경로 모두 원근거와 정산을 보존한다.
- HTTP의 같은 명령 재전달은 저장 결과를 반환한다. 완료된 업무에 새 run 명령을 보내면 기존 계약대로 `409 work_terminal`이다. 시험의 잘못된 성공 기대를 수정했다.
- 등록 충돌 시험은 provider namespace와 효과 reader 귀속을 맞춰 실제 충돌을 검사하게 했다. 기존 reconciliation 시험에는 실제 동일 화면 재관측을 한 번 추가해 기본 3회 차단 이후 효과 확인으로 진전을 회복하는 원래 시나리오를 유지했다.
- 기존 host 시험은 담당별 임시 identity registry를 사용한다. HTTP 종료 시 프로필을 닫고 임시 폴더를 삭제하도록 순서를 고쳐 정리 과정의 오류를 숨기지 않는다.

## 실행 근거

| 실행 | 소스 | 결과 |
| --- | --- | --- |
| build1 / target1 | `8f3ec0f6e0946a3a015a0ca1486701d23ab832eff891bd449bffb385061cd8fd` | 빌드 통과; 새 입구·등록 18개 중 11 통과·7 실패. 원인과 진단 로그 보존 |
| build2 / target2 | `15a899e3af2fc22909debb5466a8ad7c7b7f8d031fafac90d8d2baa25b6a663c` | 신규 25/25 통과 |
| build2 / target3 | 같은 build2 | 관련 13파일 175개 중 167 통과·8 실패. 6개 무진전 fixture와 2개 종료 hook 교정 필요 |
| build2 / core1·architecture1 | 같은 build2 | 코어 타입 검사 통과; 구조 189개 검사·위반 0 |
| build3 / target4 | `0f6dc7c8aecebc952a940cc23e279fa58b29cf1a39f730cbd38d76f79bd89341` | 최종 빌드 통과; 관찰 7·reconciliation 6·기존 host 입구 5, 합계 18/18 통과 |

최종 합계는 신규 26 + 관련 175 = 201이다. build3에서 전체 201개를 다시 실행한 것은 아니다. source/build manifest와 실행별 원로그를 구분했고, 통과한 넓은 묶음을 단순 반복하지 않았다. macOS/arm64 Node v24.20.0, 준비한 모델 응답·임시 파일/DB·합성 드라이버·loopback HTTP로 확인했다. 실제 모델/API·사용자 GUI·사내 서비스 연결은 실행하지 않았다.

## 남은 작업

[기존 준비 목록](C05-ordered-verification-preparation.md)의 도구·기억·스킬 발견/퇴출, MCP 원응답 보관·collection·wait 및 미통합 crash/drain 후보 인수를 이어간다. 문맥 비용 개선은 측정 결과가 아직 없다. C03의 [명시 복구 잔여](C03-remaining-acceptance.md), C06–C10의 [별도 검증](C06-C10-verification-plan.md), 최종 통합·현재 Linux/native Windows·PostgreSQL/사내 MCP/Knox/A2A 운영 인수도 남는다. 실제 모델/API 시험 중단을 유지한다.
