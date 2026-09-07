# 통합 구현 순서와 검증 플랜

2026-09-06 · v0.50 · P4-01 역할 간 자원 배정 권한과 정산

이번 [역할 간 자원 배정·정산 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-budget-authority-result.md)에서 별도 자료 권한을 가진 역할에 자원을 배정하고, 해당 역할 runtime으로 중단·사용량 정산·미사용 반환을 연결했다. 권한 철회·응답 유실·하위 위임·compact/reopen을 검증했다. 전체 **2416/2416**, 관련 **168/168**, 신규 **62개**가 통과했다. **P4-01은 진행 중**이며 다음은 [게시판 수락과 에이전트 자원 관리 연결](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-funding-plan.md)이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-budget-authority-local-verification.json).

이전 [MCP 단발 읽기 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-adapter-result.md)에서 공식 SDK의 실제 로컬 stdio 서버를 기존 도구·호출 장부·원본 proof에 연결했다. 전체 **1,992/1,992·실패/취소0**, 신규42개·관련58개가 통과했다. 문서/관측×두 저장소의 원본·근거 채택, 정책 변경·취소·목록 변경·크기/동시성 제한·명시 재연결과 저장 결과 재검증을 확인했다. SDK client/server2.0.0 추가는 의도한 lock 변경이며 기존 원본과 정본을 보존한다. P3-01은 부분 검증/진행 중이다. 다음은 MCP batch/page와 ReadCollections의 cursor·부분 결과·명시 재개 연결이다. 실제 사내 MCP·모델·Knox·운영 검증은 아니다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-local-verification.json).

이전 [로컬 Web driver 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-local-web-driver-result.md)에서 기존 실행·증거·이어가기 코어를 실제 계측 HTML 앱과 Chrome에 연결했다. 전체 **1,950개 시험·실패/취소0**, 신규·관련20개, 별도 실제 browser **17/17**이 통과했다. 두 저장소의 같은 목표8셀 모두 입력2·저장1로 완료했고 개별 도구3회→batch2회, Web bridge13→10회를 관측했다. 저장후 응답 유실의 정산·입력 없는 verify, reload·앱 재열기와 사람의 연속 입력·브라우저 fill도 검증했다. 1280/390/320px 화면 검수와 소유 서버/브라우저 종료를 확인했다. DOM 자동화이며 native OS·사내 화면·모델/API 검증은 아니다. P3-04는 부분 검증/진행 중이고 다음 로컬 챕터는 P3-01 MCP 재사용 adapter다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-local-web-driver-local-verification.json).

이전 [실제 이어가기 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-continuation-runner-result.md)에서 v2 checkpoint와 실제 continue/verify를 연결했다. 원 입력의 기한·누적 한도를 유지하고 부모당 하나의 후속 작업만 예약하며, 적용된 입력은 반복하지 않는다. 현재 조건을 새로 확인하는 verify는 입력 0회다. 전체 **1,930개 시험·실패 0**, 신규 77개·최종 관련 143개, 코어 타입 검사·안쪽 계층 98파일/위반 0·합성 4시나리오/22판정이 통과했다. 실제 SIGKILL 복구 6개와 정산 후 진행 장부 갱신·중복 credit 방지도 검증했다. P3-04는 부분 검증/진행 중이며 실제 GUI·모델/API·사내 서비스는 미실행이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-runner-local-verification.json).

이전 [후속 작업 계약·근거 소비 학습 결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-continuation-boundary-result.md)에서 부모당 단일 후속 claim과 CAS 계약, compact/reopen의 원본 참조 보존, 자료·공개·기억·전송의 효과 증명 검사를 연결했다. 실패 처리된 과거 증명도 검사하고, 원 업무가 소비한 기억의 개정·철회를 유한한 원출처 원장으로 재검증한다. 전체 **1,853개 시험·실패 0**, 신규 82개·최종 관련 197개, 코어 타입 검사·안쪽 계층 97파일/위반 0·합성 4시나리오/22판정이 통과했다. 실제 continue/verify 도구와 v2 runner는 미지원이며 해당 실행을 명시 거절한다. P3-04는 partially_verified/in_progress, 전체 완료 작업은 9개다. 다음은 원 시간·누적 시도 한도를 보존하는 v2 checkpoint와 실제 단일 successor 실행이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-boundary-local-verification.json). 실제 모델/API 시험은 중단 상태다.

이전 [명시 런타임 대조 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-runtime-reconciliation-result.md)에서 저장된 입력 영수증을 별도 읽기 예약·실행·정산에 연결했다. 원 입력과 결과를 보존하고, 증명이 사라지면 실행·모델·완료·압축·화면·전달 경계에서 다시 차단한다. 전체 **1,771개 시험·실패 0**, 코어 타입 검사·안쪽 계층 96파일/위반 0·합성 4시나리오/22판정이 통과했다. 신규·최종 관련 시험은 115개다. P3-04는 partially_verified/in_progress이며 전체 완료 작업은 9개다. 다음은 단일 successor의 남은 단계 이어가기와 현재 사후 조건 확인이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-runtime-reconciliation-local-verification.json). 실제 모델/API 시험은 중단 상태다.

이전 [입력 영수증 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-receipts-result.md)에서 합성 앱과 원자 저장하는 operation 영수증, 현재 권한의 읽기 조회, v1 이행·재시작·저장 실패 처리를 연결했다. 전체 **1,656개 시험·실패 0**, 코어 타입 검사·안쪽 계층 92파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 시험은 26개이고 최종 관련 시험은 120개다. P3-04는 partially_verified/in_progress이며 전체 완료 작업은 9개다. 다음은 명시 런타임 효과 대조 예약·정산, 이후 남은 단계 이어가기와 실제 로컬 Web driver다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-receipts-local-verification.json). 실제 모델/API 시험은 중단 상태다.

**구현 순서의 기준 문서는 이 파일이다.** 단계별 책임은 세부 설계 문서를 따르고, 작업 ID·선행 조건·요구 매핑·진행 상태는 [구현 작업 목록](/Users/seunghanee/Documents/secumon/design/implementation-backlog.json)에 저장한다. 31개 중 P0의 4개와 P1의 5개, 총 9개 작업을 검증 완료했다. 전체 필수 작업은 30개, 기존 운영 이관 1개는 조건부다. 이전 [전체 실행 평가 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-evaluation-result.md)와 [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-evaluation-local-verification.json)을 참고한다. 설계 문서/아카이브 검증 완료를 제품 구현 완료로 세지 않는다.

## 1. 구현 원칙과 계획의 전제

P1-06의 모델 호출·가설/계획 변경 코드를 로컬 대역으로 검증했다. [결과](/Users/seunghanee/Documents/secumon/design/chapters/P1-model-result.md)를 따르며 실제 모델 시험이 남아 작업 전체는 진행 중이다. P1-07의 재개 패킷/공통 workflow도 [로컬 결과](/Users/seunghanee/Documents/secumon/design/chapters/P1-recovery-result.md)에 따라 검증했다. P2-01/02의 저장소·기억·작업 파일, P2-03의 반복 compact·선택 재조회·현재 계약 검사 뒤 P2-04 첫 단위를 연결했다. 저장 결과 재사용·합류·목록 갱신 뒤 지침 수명·현재 원본 검사·순수 batch/page 계약을 로컬 검증했다. 이어서 [영속 조회 실행 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-durable-collections-result.md)에 따라 intent/checkpoint·원응답 replay·명시 재개·실제 종료 복구와 context 검사를 연결했다. 이번에는 [증분 저장·내부 I/O 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-internal-io-result.md)의 작은 변경 기록·복원/조회 공유·원본 검증 비용을 연결했다. 전체 934개 시험과 12개 동일 기준선 비교가 통과했고 P2-04 로컬 계약을 검증했다. 이후 [모드·진전·재시도 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-modes-result.md)의 별도 모드 제어·안전한 변경·진전/재시도 연결까지 1,078개 시험으로 검증했다. 이어서 [부모·자식 예산 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-budget-result.md)의 실제 할당/진입·전액 보류·영속 차단·누적 정산을 연결해 전체 1,168개 시험으로 검증했다. 고정 전체 실행 평가에서 194개 새 실행과 194개 기록 재생, 전체 1,278개 시험을 검증해 P2-05 local_contracts를 verified로 기록했다. 이어서 [정보 경계 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-boundary-result.md)의 목적지별 정책·등급 계승·원본 검증·공개 뷰·거절 후 재개와 12개 A/B/C 전송 비교를 전체 1,388개 시험으로 검증했다. P2-06 로컬 계약은 verified이며 조직 정책과 실제 모델 조건은 남았다. P3-02 첫 단위의 공통 업무 조회·CLI를 로컬 검증했다. 전체 1,427개 시험과 코어 타입 검사·안쪽 계층 85파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 39개는 서비스 28·CLI 7·표시 4개다. 이후 [Web 작업실 결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-web-result.md)에 따라 로컬 Web 작업실의 두 번째 단위를 검증했다. 전체 1,483개 시험·코어 타입 검사·안쪽 계층 85파일/위반 0·합성 4시나리오/22판정이 통과했고 새 시험은 제어기 24·UI 상태 21·HTTP 9·두 저장소 HTTP 통합 2개다. 실제 브라우저에서 접수/결과/질문·제어·CLI 연결·초점·읽는 위치·390/320px를 확인했다. 이전 [조회 효율·동시 편집 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-query-control-result.md)에서 사건 metadata 조회·후보 페이지·저널 검증 재사용과 목표/제어 revision의 원자적 검사를 연결했다. 전체 1,536개 시험·코어 타입 검사·안쪽 계층 86파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 시험은 저장 조회 28·원자 제어 17·공개 조회 8개다. 브라우저 변경 관측 8개와 저장소 비용을 별도 기록했다. P3-02 local_contracts는 verified, 전체 status는 in_progress다. 이전 [합성 컴퓨터 유즈 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-use-result.md)에서 관찰·입력·조건 확인과 영속 진행, 결과 증명·compact 원본 검사·강제 종료 복구를 연결했다. 전체 **1,630개 시험·실패 0**, 코어 타입 검사·안쪽 계층 90파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 시험은 94개이며 두 저장소의 동일 목표 4개 비용 관측도 통과했다. P3-04 local_contracts는 partially_verified, 전체 status는 in_progress다. 다음은 명시적 효과 대조와 남은 단계 이어가기이며 실제 로컬 Web driver와 선택 환경 검증은 그 뒤에 연결한다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-use-local-verification.json). 실제 모델/API 시험 중단과 이전 원본/검증 기록 보존을 유지한다. 실제 모델과 운영 adapter 조건은 남는다. [공통 조회 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-work-view-result.md). P1-06/07과 종속 P2 작업은 in_progress로 유지하고 실제 모델을 요구하는 완료 조건은 축소하지 않는다.

- 목표는 범용 에이전트다. 사람과 대화하는 역할은 공통 역할이며 서브넷 담당자/탐정/게시판은 활용 예시다. 공개 문서와 합성 보안 관측 두 업무군으로 처음부터 검증한다.
- 본체는 PostgreSQL에 의존하지 않는다. 업무 의미의 저장 포트와 바깥 adapter를 사용하고 SQL/DDL/ORM/DB 오류·잠금은 구현 바깥에 둔다. 원자적 커밋·중복·복구 보장은 저장소를 바꿔도 유지한다.
- P0-03에서 Python 없는 TypeScript + Node.js LTS, 작은 자체 상태 루프와 SQLite 첫 adapter를 선택했다. 정확한 버전·근거·한계는 P0 ADR을 따른다. 실제 모델 선택/적합성은 미완료이며 Rust·기존 도구는 실제 요구와 총비용에 따라 선택한다.
- 기존 도구 160개 선언을 통째로 옮기지 않는다. 테스트 40개와 비테스트 후보 120개(114개 이름)를 구분하고, 필요한 기능의 코드·계약·업무 규칙·fixture 중 가치 있는 부분을 재사용한다.
- 상태·권한·근거·예산·사용자 제어·진단은 초기 경로부터 유지한다. 모델 호출마다 가설·critic·전면 재계획·compact를 강제하지 않는다.
- 각 기능을 별도 에이전트/서비스로 만들지 않는다. 작은 주입 가능한 모듈로 시작하고 실제 데이터 경계·OS·자원·장애 격리 요구에 따라 나눈다.

## 2. 단계별 결과

| 순서 | 구현 범위 | 통과 뒤 얻는 결과 |
|---|---|---|
| P0 | 계약·합성 기준선·구현 선택 | 외부 명세 미확인은 대역과 의존 조건으로 기록하고 코어 진행을 막지 않음 |
| P1 | 저장소 독립적인 최소 코어 | 첫 요청의 접수·계획/가설·실행·근거·재개·답변을 하나로 검증 |
| P2 | 기억·컨텍스트·효율·경계 | 저장소 교체와 반복 compact 뒤에도 품질/의무/권한 유지 |
| P3 | 단일 에이전트 도구·채널·컴퓨터 유즈 | 실제 adapter 계약과 조용한 CLI/Web/Knox, 선택 GUI 경로 검증 |
| P4 | 협업·A2A·상시 임무 | 두 역할의 근거 결합·비용 통제·사건 기반 재개 |
| P5 | 범용 업무 배치·변경 관리 | 같은 코어의 두 업무 모듈과 검토된 bundle 배치 |
| P6 | 복원·시범·운영 | 보존/복구/용량/권한·효과 대조를 확인하고 제한된 도입 |

P 번호는 통합 검증의 순서다. 모든 작업에 앞 단계 전체를 일괄 선행 조건으로 걸지 않는다. 각 작업의 `depends_on`과 외부 조건이 실제 착수 기준이며, 관련 없는 연동 지연 때문에 독립 작업까지 중단하지 않는다. 단계 완료는 그 단계의 필수 작업과 해당 실제 연결 증거가 모두 충족됐을 때 기록한다.

**사내 자료 연결 조건 G-DATA:** 자료 등급·인증된 주체/업무 범위·모델/수신자 목적지·원문 접근 방식·보존/삭제 정책을 결정하고 해당 배치의 공개/차단 경로를 검증한다. 미결정일 때 합성/허용된 공개 자료 경로를 진행할 수 있지만 이를 사내 연동 통과로 표시하지 않는다. 기초 비교는 P2-06, 각 실제 연결/배치의 확인은 P3/P5에서 수행한다.

## 3. 착수 가능한 작업 단위

### P0 — 계약·합성 기준선·구현 선택

두 업무군의 합성 자료와 공통 계약을 먼저 정한다. 언어/실행 관리자/첫 adapter는 같은 작은 복구 흐름으로 비교하고 정확한 지원 버전은 착수 시 공식 자료로 확인한다. 외부 MCP 명세가 없으면 확인해야 할 항목과 대역을 남겨 코어 작업을 진행한다.

| 작업 | 선행 작업 | 산출물과 통과 기준 |
|---|---|---|
| **P0-01 대표 업무와 합성 기준선** | 없음 | 공개 문서 비교와 합성 관측 검토의 목표·완료 조건·반증·대기·실패 fixture를 정의한다. **확인:** 단순/복잡한 업무를 같은 범용 개념으로 표현; 초기 성공·잘못된 완료·비용/지연 측정 기준을 기록. |
| **P0-02 코어·저장·정책의 최소 계약** | P0-01 | 상태/근거/계획·저장 포트·모델/도구 결과·사용자 입력·예산·정보 경계의 최소 계약을 정의한다. **확인:** 상태/사건/의무의 원자적 커밋 경계와 부분 실패 의미 명시; SQL/ORM이 없는 계약, id/revision·시각·오류·부분 결과 fixture. |
| **P0-03 구현 기준과 짧은 적합성 결정** | P0-02 | 언어·실행 관리자·첫 영속 adapter·모델 adapter·지원 버전을 비교해 첫 구현의 ADR을 남긴다. **확인:** TS/Python 없는 제품 범위와 외부 서비스 의존성을 구분; 작은 복구/대기 시나리오로 후보를 평가하고 제품 경로 하나 선택. |
| **P0-04 재사용 후보와 외부 계약 목록** | P0-01 | 첫 업무에 필요한 도구·지침만 선별하고 유지/재구현/기존 MCP 연결의 근거를 기록한다. **확인:** 정적 160개 선언 중 테스트 40개와 후보 120개를 구분; Knox/SIEM/EDR/OS 계약의 확인/미확인과 대역을 기록; 명세 부재를 구현된 기능으로 표시하지 않음. |

### P1 — 저장소 독립적인 최소 코어

저장과 실행 의미를 scripted planner로 먼저 검증한 뒤 실제 모델을 붙인다. 사용자 접수·변경·취소·예산·진단과 최소 재개 packet은 이 단계부터 포함한다. 가설/별도 검토는 필요한 업무에서만 사용한다.

| 작업 | 선행 작업 | 산출물과 통과 기준 |
|---|---|---|
| **P1-01 코어 구성과 대역** | P0-02, P0-03 | 코어와 바깥 adapter의 주입 경계, schema 검증, fake model/tool/clock/sink를 만든다. **확인:** DB/ORM/채널 SDK 없이 코어 규칙 시험 가능; 두 업무군 fixture를 같은 도메인 타입으로 읽음. |
| **P1-02 영속 상태·원본·장부** | P1-01 | 첫 영속 adapter와 artifact backend에 상태/사건/실행 의도/결과·outbox를 저장한다. **확인:** 상태/사건 동시 커밋과 요청/결과 중복 방지; 원본 저장-DB 참조 사이 장애·깨진 참조·재시작 처리. |
| **P1-03 결정적인 최소 실행 루프** | P1-02 | scripted planner로 계획 검증·배정·실행·결과 수락·상태 변경·제어 분기를 연결한다. **확인:** 무효 DAG/낡은 plan revision/완료 조건 누락 거부; continue/replan/wait/blocked/complete, 예산·취소·unknown 효과를 구분. |
| **P1-04 작은 도구·지침·근거 경로** | P1-03, P0-04 | 작은 catalog와 Broker/호출 장부, 근거 ID 조회, 지침 하나의 선택 로딩을 연결한다. **확인:** 정확한 ID/제한된 검색과 schema·권한·version 검증; 단순 업무는 필요한 method만 선택; tool/skill/권한의 역할 구분. |
| **P1-05 CLI와 대화/전달 의미** | P1-04 | 접수 저장→짧은 접수 응답→상태 조회/변경/취소→최종 답변을 CLI와 가짜 채널에 연결한다. **확인:** conversation/work ID 분리, 닫기와 취소 구분; 내부 이벤트마다 새 말풍선 없음; result_ready/완료/전달 분리. |
| **P1-06 실제 모델과 가설·계획 변경** | P1-05 | 선택한 모델 adapter에서 합성 입력으로 가설·판별 질문·계획 변경을 제안하고 코어 검증에 연결한다. **확인:** 늦은 반증으로 영향받는 가설/계획 수정, 유효 계획은 continue; 단순 경로의 추가 critic/가설 생략, usage/잘림/오류와 모델 목적지 기록. |
| **P1-07 첫 전체 경로와 최소 재개 패킷** | P1-06 | 한 업무의 접수부터 결과까지와 중단/재개·사용자 변경·구조화 ContextPacket 복원을 완성한다. **확인:** 실행 전/외부 결과 수신 후 저장 전/저장 후 응답 전 장애 구간 시험; 목표·반증·의무·원본 참조 복원, fake sink 중복 효과와 잘못된 완료 없음. |

### P2 — 기억·컨텍스트·효율·경계

기억·컨텍스트·호출을 함께 최적화한다. 두 번째 저장 구현으로 교체 가능성을 확인하고, 반복 compact와 미사용 명세 정리가 판단 품질을 유지하는지 본다. 사내 원문 연결 전 정보 경계 통과 조건을 이 단계에서 준비한다.

| 작업 | 선행 작업 | 산출물과 통과 기준 |
|---|---|---|
| **P2-01 두 번째 영속 adapter 적합성** | P1-07 | 다른 종류의 영속 구현을 제한된 범위로 연결해 저장소 독립성을 확인한다. **확인:** 코어 코드 수정 없이 동일 대표 시나리오/저장 계약 시험; 각 구현에서 재시작·충돌·중복·원자적 경계 보장 확인; 대역 통과와 구분. |
| **P2-02 기억·근거 수명과 조회** | P1-07 | 개인/조직 기억·lineage·직접/조건 검색·색인 지연·정정/삭제·작업 공간 체크포인트를 구현한다. **확인:** 새 근거를 색인 전 ID로 읽고 신선도/범위 표시; 정정/권한 철회가 요약·검색·캐시·관련 의무에 반영. |
| **P2-03 컨텍스트 수명과 compact** | P2-02 | 미사용 명세/내용 정리와 검증된 snapshot/packet 교체, 선택 재로딩을 구현한다. **확인:** 반복 context 교체 후 중요한 반증·제약·대기/unknown 의무 복원; 저장 후 참조화, tool-call 쌍·revision 검증, 재로딩 진동과 실제 입력 비용 기록. |
| **P2-04 도구·지침 호출 효율** | P2-03 | 유효 결과 재사용·in-flight dedup·batch·페이지/증분·명세 예산·catalog 갱신을 최적화한다. **확인:** 권한/버전/효과에 맞는 캐시·재시도·폐기; 목록 부분 실패 구분; 모델/MCP 왕복·내부 연산·이미지·대기 비용을 구분한 비교. |
| **P2-05 모드·예산·무진전과 평가** | P2-01, P2-02, P2-03, P2-04 | 자동/빠르게/깊게와 무진전 제어를 보정하고 고정 세트로 전체 품질/비용을 비교한다. **확인:** 명시 상한·부모/자식 예약/사용액·재시도 총기한 보존; 저장 결과 replay와 새 추론 구분, 완료율/잘못된 완료/재조회/지연 비교. |
| **P2-06 정보 경계 대안과 공개 정책** | P2-02, P2-03, P1-06 | 전체 내부/외부 리드+게이트/내부 주도+자문을 합성 자료로 비교하고 실제 배치에 적용할 경계 정책을 정한다. **확인:** 원문·요약·검색 카드·로그/화면·artifact·채널·모델 목적지 권한 검증; 도구/A2A 본문이 사용자 지시/권한으로 승격되지 않음; 금지 fixture의 outbound 노출 검사. |

- P2-06 외부 조건: 실제 자료 연결 전 조직 자료 등급·주체·모델 목적지·보존 정책 결정.

### P3 — 단일 에이전트 도구·채널·컴퓨터 유즈

안정된 단일 에이전트에 실제 도구·채널·컴퓨터 유즈를 연결한다. Web/fake 채널과 합성 UI 작업은 필요한 선행 작업을 만족하면 다른 adapter의 명세를 기다리지 않고 진행할 수 있다. 실제 연결 미확인은 별도로 남긴다.

| 작업 | 선행 작업 | 산출물과 통과 기준 |
|---|---|---|
| **P3-01 기존 MCP의 실제 adapter** | P2-05, P2-06, P0-04 | 확인된 기존 MCP의 작은 기능 집합을 단일 에이전트에서 연결한다. **확인:** auth/scope·version·pagination·rate limit·취소·늦은 결과·부분/unknown 시험; 요청/결과/수집 cursor/효과 상태가 공통 장부에 반영. |
| **P3-02 Web과 CLI 업무 화면** | P1-07, P2-03 | 같은 공개 상태를 CLI/Web에 표시하고 snapshot/cursor 재접속·상세 근거·진단을 연결한다. **확인:** 접수·결과·필수 질문, 현재 상태 갱신과 상세 보기 구분; 다중 업무·변경/취소·재접속·키보드 초점·좁은 화면 검수. |
| **P3-03 Knox 대화 연결** | P3-01, P3-02 | 확인된 Knox 계약으로 수신→접수→최종 답변을 연결한다. **확인:** 인증된 사람/방/work 연결과 답변 대상 권한 확인; 불명확 발송 대조·중복 방지; 수정/스레드/버튼/읽음은 실제 지원만 사용. |
| **P3-04 컴퓨터 유즈 adapter** | P2-04, P2-06 | 로컬 합성 UI부터 관찰/행동+확인·짧은 묶음·조건 대기·세션 소유권을 구현하고 선택 환경에 연결한다. **확인:** stale 화면·창/초점 변경·부분 효과·사용자 인계·재시작 검증; 같은 목표의 성공률·왕복·이미지·총 지연을 기존 단일 행동 기준선과 비교. |
| **P3-05 단일 에이전트 연동 통합** | P3-01, P3-02, P3-03, P3-04 | CLI/Web/Knox와 선택 도구/컴퓨터 유즈를 같은 업무 상태·권한·전달 계약으로 통합 검수한다. **확인:** 모드 변경·취소·재접속·목표 변경 뒤 늦은 응답 일치; fake/실제 연결 결과를 구분하고 미확인 채널을 통과로 보고하지 않음. |

- P3-01 외부 조건: 실제 MCP 명세와 전용 연동 환경·접근 범위; 사내 자료를 쓰는 경로는 G-DATA 통과.
- P3-03 외부 조건: Knox MCP의 수신 경로·인증·메시지 ID·발송/오류/대조 계약; 전용 대상과 메시지 전달 범위.
- P3-04 외부 조건: 첫 지원 OS/앱/브라우저와 기존 driver 계약 선택; 실제 사내 화면은 G-DATA 통과.

### P4 — 협업·A2A·상시 임무

단일 에이전트의 기본 도구 연결이 검증된 다음 두 역할부터 협업을 만든다. 게시판, 독립 동료와의 A2A, 상시 임무를 같은 권한·예산·근거·대기 계약에 연결한다. Knox 완료가 협업의 기술적 선행 조건은 아니며 정확한 의존성은 작업표를 따른다.

| 작업 | 선행 작업 | 산출물과 통과 기준 |
|---|---|---|
| **P4-01 두 에이전트와 게시판** | P2-05, P2-06, P3-01 | 지속되는 역할 ID·개인 관측·공유 entity·게시판을 두 역할로 연결한다. **확인:** 같은 원본의 중복 인용을 독립 근거로 세지 않음; 의무/권한·근거 충돌·철회·대화/위임 상한·교착/무진전 처리. |
| **P4-02 A2A 업무 계약** | P4-01 | 외부 동료와 task/status/artifact·version·deadline·cancel을 교환하는 adapter를 만든다. **확인:** 상대 ID/권한·오류·부분 결과·늦은 결과·재전달 검증; 상대 메시지가 루트 목표/권한을 임의 변경하지 않음. |
| **P4-03 상시 임무와 사건 기반 재개** | P4-01, P3-01 | 예약/관측/회신 대기와 durable wake, 증분 수집·게시판 구독을 연결한다. **확인:** fake clock 장기 대기와 별도 실제 시간 재개 시험; 수집/집계와 추론 분리, 중복 wake·cursor·fan-out 예산·취소 처리. |
| **P4-04 협업 통합과 비용 검증** | P4-01, P4-02, P4-03 | 한 에이전트와 두 에이전트의 같은 문제를 비교해 협업 품질과 비용을 검증한다. **확인:** 늦은 반증·부분 자료·충돌·권한 철회·부모 취소 전파; 더 많은 메시지/역할 수를 개선으로 간주하지 않고 완료 품질·비용 비교. |

- P4-02 외부 조건: 선택한 A2A 상대의 계약과 전용 상호운용 환경.

### P5 — 범용 업무 배치·변경 관리

범용성 검증은 P0/P1부터 시작했고, 여기서는 두 업무군을 실제 배치 가능한 모듈로 묶는다. 도메인 자료·지침·판정 규칙을 추가하며 코어의 업무 전용 분기를 늘리지 않는다. 새 배치의 자료 경계도 다시 검증한다.

| 작업 | 선행 작업 | 산출물과 통과 기준 |
|---|---|---|
| **P5-01 두 업무 모듈의 배치 bundle** | P4-04, P3-02, P3-04 | 공개 문서 업무와 보안 관측 업무를 역할·도구·skill/방법·완료 기준·평가 fixture로 배치한다. **확인:** 두 번째 업무군 추가에 공통 루프/저장소/게시판 복제나 보안 전용 코어 분기 없음; 사람 대화 역할 공통 사용; 지침/도구/모델 revision 기록. |
| **P5-02 배치 정책과 변경 승격** | P5-01, P2-06 | 모듈·지침·도구 변경의 검증/제한 평가/승격/rollback과 실제 배치 정보 경계를 검수한다. **확인:** 진행 중 업무의 버전 고정/명시 이행과 긴급 권한 철회 처리; 원문/검색/trace/화면/백업/채널 목적지 정책을 실제 배치 범위로 검증. |

### P6 — 복원·시범·운영

실제 복원·용량·제한된 시범을 통과한 뒤 확대한다. 기존 운영 업무 이관은 선택 항목이며 신규 제품을 독립 도입하면 실행하지 않아도 된다. 실제 외부 효과를 과거 DB 상태만으로 판단하지 않는다.

| 작업 | 선행 작업 | 산출물과 통과 기준 |
|---|---|---|
| **P6-01 운영 복원·용량·장애** | P5-02, P3-05 | 격리 환경에서 DB/artifact/키/정책·삭제 이력 복원과 중복 효과 대조, 용량/큐/지출 한도를 검증한다. **확인:** 저장소/원본 참조 정합성·unknown 의무·삭제/철회 재적용; 정한 RPO/RTO 측정, backlog/과부하 중 사용자 취소·상태 조회. |
| **P6-02 제한된 시범과 확대** | P6-01, P4-04 | 저장 자료 replay→효과 없는 shadow→범위 있는 시범 순으로 운용하고 품질/비용 기준에 따라 확대한다. **확인:** 범위/소유권/롤백 경로가 있는 시범 결과; 완료율·잘못된 완료·개입률·비용/지연·전달/복원 증거 기록. |
| **P6-03 기존 운영 업무의 선택 이관** (조건부) | P6-02 | 기존 진행 업무를 옮기기로 결정한 경우에만 ID/근거/상태 이관과 단일 실행 소유권 전환을 수행한다. **확인:** in-flight 효과 대조와 신구 중복 배정 방지; DB 과거 덮어쓰기 없이 상태/근거 보존 후 소유권 rollback. |

- P6-02 외부 조건: 시범 업무·대상·자료/모델/메신저 권한·운영 범위 확정.

각 작업은 관련 계약·fixture·구현·검증 결과·남은 제약을 함께 남긴다. P1-07은 첫 전체 경로의 완료 지점이며 제품 전체 완료가 아니다. P2는 품질을 유지한 효율을, P3은 실제 단일 에이전트 연동을, P4는 협업의 추가 가치를 검증한다.

## 4. 전체 요구와 구현 작업의 연결

| 요구 | 설계 근거 | 구현 작업 |
|---|---|---|
| R01 범용 코어와 두 업무군 검증 | [02](/Users/seunghanee/Documents/secumon/design/02-target-design.md) · [08](/Users/seunghanee/Documents/secumon/design/08-core-framework.md) | P0-01, P1-01, P1-07, P2-05, P4-01, P5-01, P6-02 |
| R02 TypeScript 중심/Python 없는 신규 제품 비교와 선택 Rust | [06](/Users/seunghanee/Documents/secumon/design/06-language-and-migration.md) | P0-03, P1-01 |
| R03 기존 도구·계약·fixture 재사용 판정 | [01](/Users/seunghanee/Documents/secumon/design/01-current-analysis.md) · [13](/Users/seunghanee/Documents/secumon/design/13-tool-catalog.md) | P0-04, P2-04, P3-01, P3-04, P5-01, P6-03 |
| R04 저장소 독립성과 두 영속 구현의 교체 검증 | [16](/Users/seunghanee/Documents/secumon/design/16-storage-and-recovery.md) | P0-02, P0-03, P1-01, P1-02, P2-01, P2-05, P6-01 |
| R05 goal/state·planner·validator·task graph·실행·상태 갱신·완료 | [08](/Users/seunghanee/Documents/secumon/design/08-core-framework.md) | P0-01, P0-02, P1-03, P1-06, P1-07 |
| R06 가설·지지/반증·판별 질문·근거 기반 재계획 | [08](/Users/seunghanee/Documents/secumon/design/08-core-framework.md) | P0-01, P1-06, P1-07, P2-02, P4-01, P4-04 |
| R07 내구성·중복 방지·대기·취소·unknown 효과 | [08](/Users/seunghanee/Documents/secumon/design/08-core-framework.md) · [16](/Users/seunghanee/Documents/secumon/design/16-storage-and-recovery.md) | P0-02, P1-02, P1-03, P1-05, P1-07, P2-01, P3-01, P3-03, P3-04, P3-05, P4-02, P4-03, P6-01, P6-03 |
| R08 도구 호출 장부·재사용·batch·동시성·오류/비용 | [09](/Users/seunghanee/Documents/secumon/design/09-tools-memory-methods.md) | P1-04, P2-04, P2-05, P3-01 |
| R09 도구 카탈로그·검색·선택 로딩·버전·폐기 | [13](/Users/seunghanee/Documents/secumon/design/13-tool-catalog.md) | P0-04, P1-04, P2-03, P2-04, P3-01 |
| R10 개인/조직 기억·직접 조회·검색·정정/삭제 | [09](/Users/seunghanee/Documents/secumon/design/09-tools-memory-methods.md) · [16](/Users/seunghanee/Documents/secumon/design/16-storage-and-recovery.md) | P1-04, P2-02, P4-01, P4-03 |
| R11 compact·snapshot·재개 packet·필수 정보 보존 | [08](/Users/seunghanee/Documents/secumon/design/08-core-framework.md) · [15](/Users/seunghanee/Documents/secumon/design/15-context-lifecycle.md) | P1-07, P2-03, P2-05 |
| R12 미사용 도구/내용 정리·재로딩·컨텍스트 예산 | [15](/Users/seunghanee/Documents/secumon/design/15-context-lifecycle.md) | P2-03, P2-04, P2-05 |
| R13 skill·방법론·역할 배치와 버전 관리 | [09](/Users/seunghanee/Documents/secumon/design/09-tools-memory-methods.md) | P0-04, P1-04, P2-03, P2-04, P4-01, P5-01, P5-02 |
| R14 모델 gateway·자동/빠르게/깊게·예산·무진전 제어 | [11](/Users/seunghanee/Documents/secumon/design/11-execution-modes.md) · [14](/Users/seunghanee/Documents/secumon/design/14-scope-and-priorities.md) | P0-03, P1-03, P1-06, P2-05, P3-05, P4-04, P6-02 |
| R15 사람 대화 역할·조용한 CLI/Web/Knox·전달 복구 | [07](/Users/seunghanee/Documents/secumon/design/07-conversation-agent.md) · [10](/Users/seunghanee/Documents/secumon/design/10-chat-and-channels.md) | P0-04, P1-05, P1-07, P3-02, P3-03, P3-05, P5-01, P6-02 |
| R16 컴퓨터 유즈 관찰/행동/확인·세션·묶음·효율 | [12](/Users/seunghanee/Documents/secumon/design/12-computer-use-tools.md) | P0-04, P2-04, P3-04, P3-05 |
| R17 담당 에이전트·게시판·공유 근거·협업 제어 | [02](/Users/seunghanee/Documents/secumon/design/02-target-design.md) | P4-01, P4-02, P4-03, P4-04 |
| R18 A2A·예약/사건 기반 재개·상시 관찰 | [02](/Users/seunghanee/Documents/secumon/design/02-target-design.md) | P0-04, P4-02, P4-03, P4-04 |
| R19 리드 원문 접근 대안·인증·권한·목적지·자료 경계 | [05](/Users/seunghanee/Documents/secumon/design/05-data-boundary-options.md) | P0-02, P1-04, P1-06, P2-02, P2-06, P3-01, P3-03, P3-04, P3-05, P4-02, P5-02, P6-01, P6-02 |
| R20 artifact·작업 공간·저장 원자성·백업/복원 | [16](/Users/seunghanee/Documents/secumon/design/16-storage-and-recovery.md) | P0-02, P1-02, P2-01, P2-02, P2-06, P5-02, P6-01, P6-03 |
| R21 진단 manifest·replay·품질/성능/회귀 평가 | [14](/Users/seunghanee/Documents/secumon/design/14-scope-and-priorities.md) | P0-01, P0-03, P1-01, P1-06, P1-07, P2-05, P2-06, P3-02, P3-05, P4-04, P6-01, P6-02 |
| R22 배포 bundle·변경 승격·운영 용량·rollback | [14](/Users/seunghanee/Documents/secumon/design/14-scope-and-priorities.md) · [16](/Users/seunghanee/Documents/secumon/design/16-storage-and-recovery.md) | P5-01, P5-02, P6-01, P6-02, P6-03 |

세부 설계의 모든 예시/선택적 최적화를 처음부터 구현한다는 뜻은 아니다. 요구의 필수 동작과 선택 기능을 구분한다. 예를 들어 컴퓨터 유즈는 먼저 선택한 환경을 지원하고, 의미 검색·독립 critic·Rust·전용 graph DB는 기준선의 한계와 필요가 확인될 때 작업 목록에 추가한다.

## 5. 현재 구현 챕터: P3 업무 화면, 실제 모델/사내 연동 조건 대기

P0의 대표 업무/계약/기술 선택/재사용 목록은 검증 완료했다. [P1 계획](/Users/seunghanee/Documents/secumon/design/chapters/P1-plan.md)의 로컬 실행·모델 대역·재개 흐름을 검증했고 P2-01에서 같은 코어의 두 영속 구현을 확인했다. P2-02의 기억·근거 수명·작업 파일과 P2-03의 컨텍스트 수명·compact도 로컬 검증했다. P2-04의 재사용·합류·목록/지침 수명·영속 조회·증분 저장과 내부 I/O 평가를 로컬 검증했다. P2-05의 모드·진전·재시도와 부모/자식 예산, 고정 194개 실행/기록 재생도 로컬 검증했다. P2-06의 정보 공개 계약과 12개 합성 배치 전송 비교도 로컬 검증했다. P3-02의 공통 조회/CLI·로컬 Web 작업실·후보 페이지/사건 metadata·저널 재생 재사용·goal/control 원자 조건을 검증했고 로컬 계약을 verified로 기록했다. P3-04 합성 계약·runner 첫 단위를 전체 1,630개 시험과 4개 동일 목표 비교로 부분 검증했다. 다음 독립 로컬 단위는 명시 효과 대조·남은 단계 이어가기다. 이후 실제 로컬 합성 Web driver와 선택 환경을 연결한다. 실제 driver/환경·사내 화면 정책·실환경 비교는 별도 조건이다. 실제 MCP/Knox 연동 조건은 남아 있다. 실제 모델이 필요한 전체 완료 조건과 통과한 작업의 정확한 상태는 implementation-backlog.json을 기준으로 한다.

두 업무군의 fixture는 장기 제어/저장소/모델/compact/도구 효율을 비교하는 기준으로 유지한다. 각 작업은 실제 코드와 해당 범위의 검증 증거가 있을 때만 완료로 표시한다. 대역 시험과 실제 연동을 구분한다.

## 6. 미결정 사항을 결정할 시점

| 결정/외부 정보 | 필요한 시점 | 그전 진행 가능한 일 |
|---|---|---|
| 언어·실행 관리자·지원 버전·첫 영속/모델 adapter | P0-03, 제품 기반 구현 전 | 합성 업무·언어 중립 wire/상태/포트 계약 |
| 두 번째 영속 adapter | P2-01에서 파일 저널 선택·로컬 적합성 검증 | SQLite 기본 유지; 운영·전원 차단·공유 파일 시스템 보장은 미검증 |
| 기존 MCP/Knox 실제 기능과 테스트 대상 | P3의 해당 연결 전 | 작은 fake MCP/채널, CLI/Web, 코어·근거·대화 의미 |
| 지원 OS/앱·기존 컴퓨터 유즈 driver | P3-04 실제 adapter 범위 결정 전 | 관측/행동/결과/부분 효과의 합성 fixture |
| 리드 원문 접근 방식·주체·모델/수신자·보존 | 각 사내 자료 연결의 G-DATA | 합성 자료로 세 대안의 품질/비용·권한 검증 |
| 운영 RPO/RTO·용량·시범 범위 | P6-01/P6-02 전 | 작은 격리 복구 시험과 비용/용량 측정 도구 |
| 기존 진행 업무의 이관 필요 | P6-03 선택 시 | 신규 제품은 독립 업무로 도입 |

Knox 발송만 지원하면 수신 경로를 별도로 정한다. 실제 지원이 없는 버튼·수정·읽음이나 자료 접근을 가정하지 않는다. 자격증명 값은 플랜/fixture에 복사하지 않는다. 문서 작성은 실제 발송·사내 조회·배포·운영 이관 실행을 뜻하지 않는다.

## 7. 검증과 진행 상태 기록

- **계약/복구:** 무효 계획·낡은 revision·중복·필수 상태 유실·원본 누락·외부 효과 unknown을 검사한다. 외부 효과 대조 없이 재실행하지 않는다.
- **추론 품질:** 가설/반증·판별 질문·부분 관측·초기의 작은 단서·미해결 의무·잘못된 완료를 본다. 도구 성공과 목표 완료를 구분한다.
- **컨텍스트:** 예를 들어 5회 이상의 교체를 초기 합성 조건으로 고정하되 충분성 보장으로 해석하지 않는다. 직접 조회 실패, 요약 손실, 미사용 정리 뒤 재로딩·권한/버전 변화를 함께 검사한다.
- **효율:** 같은 모델/자료/성공 조건에서 완료 업무당 비용, 모델/도구 호출, 명세/이미지/재조회·대기·큐 지연, p50/p95를 비교한다. 임의 절감률을 미리 약속하지 않는다.
- **경계/대화:** 금지된 합성 자료가 허용되지 않은 목적지에 나가는지 확인하고, 접수·결과·필수 질문은 유지하면서 내부 로그의 말풍선화를 줄인다. 실제 사내 배치와 합성 검증을 구분한다.
- **저장소 교체:** DB/ORM 없는 코어 검사와 서로 다른 영속 구현의 같은 계약/장애 시험을 수행한다. 형식만 같은 인터페이스로 보장이 다른 저장소를 숨기지 않는다.
- **운영:** DB·artifact·키/버전·삭제/철회·미확정 전달 상태를 격리 복원하고 실행 소유권을 대조한 뒤 재개한다.

작업 상태는 미착수 → 진행 → 검증 완료로 기록하며 막힌 항목은 사유/필요 정보/독립 진행 가능 항목을 남긴다. 계획의 통과 기준은 시험 결과가 아니다. 작업을 완료할 때 실제 명령·fixture·trace/산출물·실행 환경·실패/미실행 항목을 기록한다. fixture/대역 성공과 실제 API·채널·운영 복구 성공을 별도 표시한다.

기존 테스트의 환경/DB 초기화 동작을 확인한 뒤 전용 환경에서 실행한다. 초기 플랜 통합 당시에는 제품 검증이나 실제 연동을 실행하지 않았다. 이후 새 runtime의 build/test/core typecheck·계층 검사·fixture와 로컬 영속 시험을 수행했으며, 실제 모델/사내 MCP/외부 채널 검증은 별도 미충족 조건이다. [현재 산출물 검증](/Users/seunghanee/Documents/secumon/design/VERIFICATION.md)

## 8. 재사용과 변경 범위

기존 engine/harness는 제어·가드·fixture의 참고, context/stash는 보존·재조회의 참고, registry/search/deferred는 도구 선택의 참고, browser 도구는 driver/관찰·검증의 참고로 사용한다. 기존 StatePort의 SQL/DDL/finding 노출은 새 범용 포트에 그대로 옮기지 않는다. 기존 TS UI/계약도 선택 재사용하며 기존 Python gateway/PG를 본체의 필수 의존성으로 만들지 않는다.

필요한 기능마다 코드 유지, TS 재구현, 기존 MCP 연결, 현재 범위 제외와 이유를 기록한다. 같은 이름의 선언을 자동 삭제하지 않고 입력/출력·권한·효과·오류·fixture를 비교한다. 아카이브와 추출 소스는 읽기 기준으로 보존하고 새 구현 작업 공간은 P0-03에서 정한다. [현재 코드 분석](/Users/seunghanee/Documents/secumon/design/01-current-analysis.md) · [도구 후보 검토](/Users/seunghanee/Documents/secumon/design/tool-catalog-review.json)

## 9. 이전 플랜과의 관계

v0.11까지의 추가 항목은 별도 부록으로 쌓아두지 않고 위 단계·작업에 통합했다. 이전 P3의 내부 협업은 P4로 옮겼고, 이전 P4의 MCP/Knox/컴퓨터 유즈는 P3에서 단일 에이전트로 먼저 검증한다. A2A와 상시 임무는 P4에 남긴다. 두 업무군의 기초 검증은 P0/P1부터, 배치 bundle은 P5에서, 원문 접근 경계는 각 실제 연결 전에 확인한다.

이전 플랜은 [v0.11 기록](/Users/seunghanee/Documents/secumon/design/history/03-migration-plan-v0.11.md)에 보존했다. 세부 문서의 단계 표는 v0.12 순서에 맞춰 정리하며, 과거 WORKLOG/검증 기록은 당시 결과로 유지한다. 전체 과정에서 결정·근거·중간 결론은 [WORKLOG](/Users/seunghanee/Documents/secumon/design/WORKLOG.md)와 해당 설계/작업 기록에 계속 저장한다.
