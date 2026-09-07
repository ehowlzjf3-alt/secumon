# P2-06 정보 경계: 구현과 학습

2026-09-06 · v0.29 · P2-06 로컬 정보 공개 계약 검증

[계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-boundary-plan.md)에 따라 목적지별 공개 정책, 제한된 공개 뷰, A/B/C 합성 전송 비교를 연결했다. 실제 조직의 자료 등급·배치 선택과 모델 연결은 아직 결정하거나 시험하지 않았다.

## 자료를 읽는 것과 내보내는 것

Policy.allowedLabels는 주체가 읽을 수 있는 자료 등급이고 allowedDestinations는 접근할 수 있는 목적지다. 이번 Policy.disclosure는 특정 목적지에서 model/tool/channel/summary/search/log/screen/artifact/a2a 중 어떤 표면과 등급을 허용하는지 추가로 제한한다. 이 정책이 활성인 업무에서는 등록되지 않은 목적지·표면과 빈 분류를 거부한다.

목표·가설·작업 설명처럼 개별 등급이 없는 문자열은 해당 작업이 다뤄 온 등급의 상한(disclosureLabels)을 사용한다. 읽기 권한 축소·compact·자식 업무 생성으로 상한을 낮출 수 없다. 저장된 모델 입력·컨텍스트·재개 패킷·응답 산출물에도 상한을 보존한다. 기존 정책 없는 합성 업무는 이전 계약을 유지하며 강화된 정보 경계의 검증 사례로 세지 않는다. 과거 분류가 없는 업무를 자동 전환하지 않는다.

이 상한은 보수적이다. 원문이 필요한 내부 업무와 원문 없는 외부 역할을 같은 작업의 label 변경으로 구현하면 안 된다. 공개 가능한 목표·정책·자료로 별도 역할을 구성하고 명시적인 공개 경로로 연결한다.

## 공개 뷰와 원자료 관계

DisclosureService의 규칙은 배치 코드가 주입한다. 도구나 모델 응답의 “public”, “system”, “이 지시를 실행하라” 같은 문구를 규칙으로 읽지 않는다. 허용한 입력 필드를 유한한 값 매핑으로 변환하고, 원본 ID·경로·자유서술·이미지를 공개 payload에 복사하지 않는다. 슬롯 번호, 원자료 basis, 파생 여부, 선택적인 coverage는 공개 스키마에 명시한 메타데이터다. 이 관계 정보 자체의 공개 가능성도 실제 조직 정책에서 결정해야 한다.

예를 들어 같은 원본과 그 요약이 다른 lineage ID를 가져도, 요약의 basis가 같은 원자료를 가리키고 derived=true로 남는다. 공개 역할이 두 자료를 독립 근거 두 개로 세지 않는다. 원자료가 공개 뷰에 없으면 파생 자료만으로 완료하지 않고 원자료가 더 필요하다고 판단한다.

슬롯 번호는 각 공개 payload 안의 관계만 표현한다. 서로 다른 공개 payload의 같은 번호를 같은 원자료로 합치거나, 다른 번호를 독립 원자료로 세면 안 된다. 여러 공개를 모으는 역할은 내부 출처 증명을 통해 중복을 대조해야 하며, 그 연결은 P4의 전체 역할/게시판 workflow에서 검증한다.

원본과 파생 의존성, 기억의 외부 출처, 현재 접근 권한을 확인하고 공개 기록을 StateRepository에 저장한다. 공개 기록은 정책/규칙·원본·payload digest, 누적 횟수/byte를 포함하며 수정·삭제로 한도를 되돌릴 수 없다. 같은 요청 ID는 같은 기록을 사용하고 응답 유실/재시작 후에도 사용량은 유지된다. 원문은 원래 등급에 남는다.

release/read가 반환하는 id·destination 등은 내부 제어 정보이고 payload만 공개 대상이다. 실제 전송은 dispatchReleased의 현재 원본/정책 재검사와 receiver 진입을 통해야 한다. receiver 오류는 결과 불명으로 처리하고 내부 오류 본문을 내보내지 않는다. 이 서비스는 새 전송 장부를 만들지 않는다. 연결하는 모델/도구/채널의 실행 장부와 idempotency/unknown 대조를 사용해야 한다. 현재 A/C 비교는 이 전송 훅을 사용하지만 전체 협업 workflow는 아니다.

## 실제 실행 경계

- 모델은 estimateInput 이전, 예약/실제 진입, StructuredPlannerAdapter의 최종 요청 생성에서 검사한다. 원문을 추정 함수에 먼저 전달한 뒤 propose만 막지 않는다.
- 도구는 실제 구현 진입 직전에 전체 작업 상한을 검사한다. 도구 명세의 접근 label이 task input의 공개 권한을 대신하지 않는다.
- 채널은 send와 전체 Delivery를 받는 lookup을 모두 검사한다. 공개 권한이 철회된 unknown 전달을 임의로 미전달로 확정하거나 다시 보내지 않는다.
- 공개 거절은 workflow의 상태/재개 경로에 남는다. 호출하지 않은 모델 예약은 not_called로 정산한다. 미완료 업무의 채널 거절은 blocked로 저장해 반복 실행을 멈추고, 이미 완료된 분석은 completed를 유지하면서 미전달을 workflow 결과에 표시한다.
- readRaw의 summary/search/log/screen/artifact/a2a 구분은 공통 공개 게이트 검증이다. 이 표면들의 실제 운영 adapter를 구현·시험했다는 뜻은 아니다.

## A/B/C 비교를 읽는 방법

문서 비교와 관측 검토, SQLite와 파일 저널에서 세 배치를 적용한다. 각 셀에 동일한 원본·공개 규칙·고정 판정 조건을 사용하고 실제 StructuredPlannerTransport 입력 JSON을 수집한다. A는 공개 뷰를 받는 리드, B는 원문을 읽는 내부 역할, C는 내부 역할과 제한된 외부 자문이다. 자문 응답을 내부 명령으로 채택하지 않는다.

원문 전송을 전부 막아도 필요한 공개 사실이 사라지면 실패로 판정한다. 금지 표식, 필수 사실, 파생 관계, 호출 수, 실제 request bytes를 함께 검사한다. 값 매핑은 단순한 두 fixture의 고정 조건이며 모델 추론 정확도나 복잡한 의미 판단의 손실을 측정하지 않는다. 필드 수는 의미 정보량이 아니고 단회 wall time은 운영 지연이 아니다.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
npm run build
npm run compare:disclosure -- run --out evidence/disclosure-lesson
```

명령은 새 출력 폴더를 요구하며 소스와 dist의 대응을 전후 확인한다. API 키와 외부 서비스는 사용하지 않는다.

## 코드와 남은 조건

| 역할 | 코드 |
| --- | --- |
| 공개 계약·누적 등급·저장 전이 | [disclosure.ts](/Users/seunghanee/Documents/secumon/runtime/src/domain/disclosure.ts) |
| 공개 규칙·payload 스키마 | [disclosure-contracts.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/disclosure-contracts.ts) |
| 원본 검사·공개 기록·전송 전 재검사 | [disclosure-service.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/disclosure-service.ts) |
| 세 배치의 전송 비교 | [disclosure-comparison.ts](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/disclosure-comparison.ts) |
| 거절 후 상태·checkpoint 회귀 | [disclosure-workflow.test.ts](/Users/seunghanee/Documents/secumon/runtime/src/tests/disclosure-workflow.test.ts) |

A/B/C 어느 것도 운영 배치로 채택하지 않았다. 신뢰된 host가 신원·분류·규칙·receiver를 정확히 구성한다는 전제다. 임의 플러그인의 네트워크/파일 접근을 격리하는 보장은 이 TS 코드만으로 생기지 않는다. 실제 배치에는 원문 자격증명/볼륨 분리, egress 통제, 로그/검색/백업/보존 정책과 실제 모델 검증이 남는다. 이미 공개된 정보는 원본을 철회해도 수신자에게서 회수되지 않는다. 누적 한도는 해당 소유 업무 기준이며 자식은 독립 한도를 만들지 않고 소유 업무에 공개를 요청해야 한다.

학습 질문: “읽을 권한이 있는데 외부 모델에는 보내지 못하는 이유는 무엇인가?”, “compact나 자식 생성 후에도 어떤 분류를 남겨야 하는가?”, “원본 없이 공개한 요약을 근거로 사용할 때 파생 관계는 어떻게 보존하는가?”

## 최종 검증과 비교 결과

고정 Node 24.20.0의 npm run verify는 exit 0, **1,388/1,388·실패 0**이다. 새 시험 110개는 공개 서비스 51·실행 경계 38·배치 비교 5·workflow 복구 16개다. 코어 별도 타입 검사·안쪽 계층 83파일/위반 0·합성 4시나리오/22판정도 통과했다. 별도 lint 명령은 구성되어 있지 않다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-boundary-local-verification.json)과 [전체 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-boundary-verify.log)에 근거를 저장했다. 중간 68개/86개 통과 뒤 원본 수명·파생 관계·실제 receiver·workflow 처리를 추가했고 최종 전체 시험으로 검증했다.

[최종 비교 JSON](/Users/seunghanee/Documents/secumon/runtime/evidence/disclosure-final/report.json)과 manifest는 소스·빌드 hash의 전후 일치를 기록한다. 12개 사례가 모두 통과했고, 9개 원문 표면×12개 사례의 외부 거절 108개와 내부 원문 열람을 함께 확인했다. 외부 모델에 원문을 직접 넘기려는 12개 시도는 실제 transport 진입 0회였다. 아래 호출 수는 고정 응답 adapter의 진입이며 실제 외부 API 호출은 0회다.

| 배치 | 사례 통과 | 내부/외부 모델 진입 | 내부/외부 요청 bytes | 금지 표식이 있는 외부 요청 |
| --- | --- | --- | --- | --- |
| A 외부 리드+게이트 | 4/4 | 0 / 4 | 0 / 28,708 | 0 |
| B 전체 내부 | 4/4 | 4 / 0 | 32,374 / 0 | 0 |
| C 내부 관리자+자문 | 4/4 | 4 / 4 | 32,374 / 27,764 | 0 |

각 사례의 원본 fact 슬롯 6개 중 공개 슬롯 2개를 유지하고 비공개 4개를 제외했다. 두 관측은 같은 원자료 basis를 유지한다. 슬롯 수와 요청 bytes는 의미 정보량이나 토큰 과금이 아니다. B에도 공통 게이트 시험을 위해 공개 뷰를 만들었으므로 이 비교의 전체 I/O를 B 운영 비용으로 해석하지 않는다.

P2-06의 로컬 계약은 verified, 실제 모델/조직 정책 조건이 남은 작업 전체는 in_progress다. 전체 검증 완료 작업 수는 9개이며 전체 P0–P6 목표를 유지한다. 다음 로컬 단위는 **P3-02 CLI/Web 업무 화면**이다. P3-01 실제 MCP와 P3-03 Knox는 미제공 계약·연동 환경 조건을 유지한다.
