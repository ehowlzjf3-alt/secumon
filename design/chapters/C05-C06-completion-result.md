# C05/C06 완주·개인기억 대화 결과

2026-09-09 · checkpoint402 · 기준 `f93305d` / checkpoint401. [계획](C05-C06-completion-plan.md)의 로컬 네 흐름을 확인하고 기억 전용 권한과 중복 조회 비용을 개선했다. **최종 코드에 대응하는 고유 시험 184개가 통과했다.** C05/C06 전체나 C01–C10 목표의 완료 선언은 아니며, 다음 순서는 C10이다. [사용법](C05-C06-completion-usage.md).

| 확인한 흐름 | 결과 |
| --- | --- |
| C05 권한 복구 후 원래 수집 업무 완주 | SQLite/file-journal 각각에서 신뢰된 호스트가 저장 업무의 원 읽기 정책을 복구한 뒤, 사용자의 명시 CLI 재개로 같은 업무·목표를 완료했다. 권한 복구·재접속·상태 조회만으로 실행하지 않는다. |
| C06 기억만 허용하는 두 담당 HTTP 배치 | 외부 쓰기 도구 등록 없이 개인기억을 HTTP로 저장하고 조회·명시 선택·후속 업무에 사용했다. 같은 기억 ID여도 담당별 원문·업무·세션을 분리하며, 기억을 독립 근거로 승격하지 않는다. |
| C06 기억 조회 비용과 완료 지연 | 안정된 조회 결과를 재사용해 논리 조회 수가 감소했다. 문서형 기억의 업무 완료는 약23.7초로 남았으며 일관된 속도 개선이나 SLA 달성은 입증하지 않았다. |
| C06 실제 브라우저 조작 | SQLite 상태+documents 기억에서 대화 출처 선택 → 기억 저장 → 업무에 명시 선택 → 실행 완료를 실제 화면으로 확인했다. 접수 안내와 결과를 표시하고 재접속 뒤 원 상태를 유지했다. |

## C05에서 보존한 내용

원 로컬 stdio 호출은 1회이며 저장 자료를 사용하는 후속 실행의 전송은 0회다. 원 시도의 `failed/lease_expired`를 성공으로 바꾸지 않고, 기존 `readResume` 연결을 가진 후속 시도로 원 응답을 검증·채택했다. 원 입력·목표·raw/head bytes·원 영수증·사용량 정산 1회를 보존했고, 합성 모델 응답 2개로 계획과 답변을 생성했다. 실제 모델/API 호출은 없다.

같은 명시 재개를 다시 전달하면 사용자 입력·수집·정산·결과 전달이 중복되지 않는다. 현재 결과를 조회하면서 원 응답을 다시 투영해 근거를 검사할 수는 있다. 이것은 새 전송이나 상태 게시가 아니다. 최초 시험의 “관측 콜백 전체가 추가되지 않아야 한다”는 과도한 기대를 이 구분에 맞춰 교정했다. [CLI 인수 시험](../../runtime/src/tests/mcp-collection-permission-resume-entry.test.ts).

## C06 권한과 조회 개선

호스트의 선택적 `allowPersonalMemoryWrites`는 개인기억 저장·정정·잊기·문서 초안·업무 선택에만 적용한다. 명시 `true`는 외부 `policy.allowWrites:false`를 유지한 채 기억 변경을 허용하며, 명시 `false`는 외부 쓰기 허용 여부와 관계없이 기억 변경을 거절한다. 미지정은 기존 actor 동작을 유지하고 새 필드를 추가하지 않아 기존 영수증 데이터 형태를 바꾸지 않는다. 공개 HTTP/Web 경로는 기존 구현을 재사용한다. 게시판·외부 도구 쓰기 권한은 확대하지 않았다.

`KnowledgeService.get`에서 결과를 버리는 사전 자료화를 제거하고 안정성 검사에 이미 만든 첫 snapshot을 재사용한다. 첫 snapshot에서 자료가 유효하지 않으면 즉시 거절하여 불필요한 후속 snapshot 반복을 막았다. 정상 조회의 안정된 세 snapshot, 현재 권한·원출처·마지막 검증은 유지하며 전체 요청에 검증 성공을 캐시하지 않는다.

| 로컬 단회 계측 | 변경 전 | 변경 후 |
| --- | ---: | ---: |
| SQLite 상태 + documents 기억, HTTP 실행 완료 | 24.634초 | 23.677초 |
| file-journal 상태 + SQLite 기억, HTTP 실행 완료 | 4.128초 | 4.185초 |
| 각 흐름의 기억 저장소 `get` | 2,064회 | 1,845회 |
| 각 흐름의 원 업무 상태 `get` | 6,365회 | 5,927회 |

이는 버전별 한 번의 로컬 측정이다. 변경 후 fixture는 공개 HTTP로 기억을 저장하며 불필요한 외부 쓰기 등록을 제거했으므로 두 배치 구성의 차이도 함께 기록했다. 메서드 포함 시간을 더해 물리 I/O·모델 토큰·전체 시간 절감으로 해석하지 않는다. **문서형 기억 약23.7초의 완료 지연은 최종 선택 배치의 성능 인수에 남긴다.** [계측 비교와 한계](../../runtime/evidence/checkpoint402-measurements.json).

## 실행 근거와 실패 이력

| 실행 | 결과 |
| --- | --- |
| build1 / target1 | 182개 중 176 통과·6 실패. C05 읽기 전용 재투영 관측의 과도한 기대 2개, 정상 knowledge 조회 수 4→3 기대 교정 2개, 잘못된 순환 자료에서 불필요한 snapshot 반복 비용 회귀 2개였다. |
| build2 / target2 | 제품의 첫 snapshot 실패 즉시 거절·초기 vector 재사용과 시험 기대 교정 후 163/163 통과. |
| build2 / target3 | 기억만 허용한 두 담당 HTTP 배치 2/2 통과. |
| 영향 없는 build1 결과 재사용 | C05 기존 custody 입구 4개 + 저장 collection 권한 gate 6개 + 외부 write/computer 등록 9개, 합계19개. |
| 최종 합계 | 163 + 2 + 19 = 고유184개 통과. 신규6개는 C05 CLI 2개와 일관된 knowledge 조회 4개다. 재실행을 중복 합산하지 않는다. |

build2·core2는 exit0이며 구조 검사는 204개·위반0이다. 두 빌드의 2,589개 파일을 비교하면 knowledge 제품 JS/map 2개와 시험 JS/map 4개만 달랐다. 영향 없는 19개를 최종 빌드에서 다시 실행했다고 표시하지 않는다. 최종 source digest는 `2fc02cb769a671b5937b84deb0e2aeda02e46f42823d757e6dc6b715afe3875f`다. [최종 소스](../../runtime/evidence/checkpoint402-final-source.json) · [빌드 비교](../../runtime/evidence/checkpoint402-build-comparison.json) · [build2](../../runtime/evidence/C05-C06-completion-build2.log) · [core2](../../runtime/evidence/C05-C06-completion-core2.log) · [구조 검사](../../runtime/evidence/C05-C06-completion-architecture2.log).

실패 기록을 삭제하지 않았다. [target1](../../runtime/evidence/C05-C06-completion-target1.log) · [target2](../../runtime/evidence/C05-C06-completion-target2.log) · [target3](../../runtime/evidence/C05-C06-completion-target3.log).

## 브라우저에서 확인한 범위

완료 후 state revision32, 원 기억·대화·예산과 원자료 읽기1회·합성 모델 응답3회를 기록했다. 재접속 뒤에도 같은 값과 접수 안내·결과를 유지하며 새 실행이 없었다. [저장 상태](../../runtime/evidence/checkpoint402-browser.json) · [최종 화면](../../runtime/evidence/checkpoint402-browser-final.png) · [완료 DOM](../../runtime/evidence/checkpoint402-browser-final.txt) · [재접속 DOM](../../runtime/evidence/checkpoint402-browser-reopen.txt).

초기 helper가 이미 소비된 일회 로그인 주소를 제공한 오류를 교정했다. 선택한 대화 원문은 읽기 전용이므로 편집 시도가 거절된 뒤 원문 그대로 저장했다. 첫 reload DOM은 로딩 도중 읽은 기록이므로 최종 인수 근거로 사용하지 않는다. 이 절차 기록을 실제 제품 완료 실패나 실제 모델 품질 검증으로 바꾸지 않는다.

## 이어갈 인수

C10의 초기 복원 중단·설치 구성과 C09 보존 이력의 백업/복원·저장소 이행 후 조회를 이어간다. 현재 Linux/native Windows의 실행·설치·복구, 실제 PostgreSQL, 사내 MCP/Knox·외부 A2A, 선택 배치의 보관 용량·복원 목표·성능과 최종 통합은 별도로 남는다. 실제 모델/API 시험 중단을 유지한다. [최신 남은 확인 목록](../REMAINING-ACCEPTANCE.md).
