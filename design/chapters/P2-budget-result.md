# P2-05 부모·자식 예산 연결: 구현과 학습

2026-09-05 · v0.27 · 부모·자식 예산 단위 로컬 검증

이 문서는 [예산 연결 계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-budget-plan.md)의 구현 결과를 정리한다. 새 예산 시험 90개를 포함한 전체 **1,168/1,168**이 통과했다. 전체 P2-05와 P0–P6의 완료 기록은 아니다.

## 이번에 해결한 문제

부모와 자식이 독립적인 예산 사본을 쓰면 같은 예산을 두 번 쓸 수 있다. 부모에 자식 할당 전액을 잡아 두는 장부를 추가하고, 실제 tool/model 예약·진입과 재계획에 연결했다. 부모는 자식의 사용량 숫자와 정산 상태를 받는다. 자식의 근거 본문은 부모 evidence/artifacts에 자동 복제되지 않는다.

예를 들어 부모의 도구 호출 한도가 10이고 직접 2회를 썼으며 자식에 5회를 배정했다면 부모의 가용량은 3회다. 자식이 3회 사용했어도 활성 상태에서는 5회를 계속 잡는다. 자식의 추가 실행을 차단하고 정산을 마치면 자식 사용 3회만 남으므로 부모 가용량은 5회가 된다. 정산을 반복해도 다시 늘어나지 않는다.

## 상태가 바뀌는 순서

1. 자식을 `pending` 연결이 있는 genesis로 만든다. 이 단계에서는 모델·도구·계획 배정을 할 수 없다.
2. 부모의 한 work CAS에서 네 차원의 할당액과 `budget_reconciliation` 의무를 함께 저장한다.
3. 부모 grant가 여전히 유효하고 자식이 원래 pending genesis일 때 자식을 `active`로 바꾼다. 같은 생성 명령의 재전송은 저장된 영수증으로 이어간다.
4. 회수할 때 부모 grant를 `draining`으로 바꾸고, 자식에도 새 배정을 금지하는 영속 fence를 저장한다. 아직 호출하지 않은 예약은 취소한다. 이미 호출한 모델/도구의 결과와 사용량은 정산한다.
5. 진행 중인 호출, 저장된 미채택 응답, 알 수 없는 모델 사용량, 쓰기 효과 확인 의무, 미정산 하위 grant가 모두 정리된 뒤 `settled`로 바꾼다. 알려진 비용은 남기고 미사용 배정액만 반환한다.

여러 work를 한 번에 원자적으로 저장한다고 가정하지 않았다. 아직 끝나지 않은 생성과 회수는 pending 또는 draining으로 남아 같은 명령과 정산을 재개할 수 있다. 활성화나 정산이 이미 커밋됐다면 active 또는 settled가 보존된다. 부족한 예산 때문에 생성이 멈춘 pending 자식은 무담보로 실행되지 않는다. 필요하면 동일 명령을 재시도하거나 그 자식을 명시적으로 취소한다.

## 실제 실행 경계

- 도구 호출 수·모델 호출 수·토큰·재계획 횟수를 각각 계산한다. 기간은 더하지 않고 부모의 고정 기한을 계승한다.
- 부모의 새 할당은 직접 사용/예약과 자식의 전액 보류를 함께 계산한다. 자식도 현재 grant, 부모 목표 revision·정책·상태·기한·예산을 확인한다.
- 예약 게시 직전에는 새로 추가할 양도 검사한다. 모델이 같은 계획의 가설만 평가하면 재계획을 추가로 차감하지 않는다.
- 실제 adapter 진입 직전에는 열린 자식들의 현재 장부도 읽는다. 형제의 초과 사용량이 부모의 저장 집계에 아직 반영되지 않은 경우를 놓치지 않기 위해서다. 이 마지막 검사는 상태를 쓰지 않는다.
- 이미 받은 응답과 만료 호출의 정산은 새 할당 금지와 구분한다. 늦게 온 모델 응답의 사용량도 한 번만 보존한다.
- 부모 취소/목표 변경은 기존 grant를 정리한다. 한도를 낮춰 이미 배정한 양이 초과하면 열린 grant를 drain한다. 이전 사용액이나 기한은 초기화하지 않는다.

최초 전체 회귀에서 부모 장부가 갱신된 뒤 이전 revision으로 제출한 계획이 거부됐다. 시험 호출자가 장부를 준비한 뒤 최신 상태로 계획을 만들도록 바꿨다. 저장된 오래된 계획을 몰래 새 상태로 치환하지 않는다.

## 컨텍스트와 저장소

상세 grant와 누적 childStateRevision은 WorkState가 보존한다. ContextPacket·재개 패킷·상태 조회에는 열린/정산 중/정산 완료 수, 보류/전체 노출액, 자식 사용량 불명 수와 부모 연결 단계만 넣는다. `stored_snapshot`은 조회 시점의 저장 집계임을 나타낸다. 상태 조회가 자식들을 실행하거나 정산하지 않는다. 실행 준비와 최종 진입 검사가 현재 원장을 다시 확인한다.

중첩 위임은 최대 8개 연결 깊이로 제한한다. 마지막 현재 장부 검사는 열린 노드 1,024개를 상한으로 두고 초과·순환·누락·정수 overflow에서 새 실행을 거부한다. 저장소 포트에는 특정 DB의 SQL이나 다중 work transaction을 추가하지 않았다. 같은 코드를 SQLite와 파일 저널에서 실행했다.

## 코드와 시험 읽기

| 책임 | 파일 |
| --- | --- |
| 네 차원, 전액 보류/실제 사용 노출액, 작은 집계 | [budget-delegation.ts](/Users/seunghanee/Documents/secumon/runtime/src/domain/budget-delegation.ts) |
| genesis·grant·활성화·fence·정산·현재 장부 검사 | [budget-delegation.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/budget-delegation.ts) |
| 실행과 모드/목표 명령에 연결 | [execution-runtime.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts) |
| 모델 예약·진입·사용량·계획 채택 | [planning-runtime.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/planning-runtime.ts) |
| 실제 도구 진입 직전 검사 | [tool-broker.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-broker.ts) |
| 순수 장부 14개 / 두 backend 실행·경합 58개 | [순수 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/budget-delegation.test.ts), [실행 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/budget-delegation-runtime.test.ts) |
| 별도 프로세스 강제 종료·재개 18개 | [강제 종료 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/budget-delegation-crash.test.ts), [worker](/Users/seunghanee/Documents/secumon/runtime/src/tests/budget-delegation-crash-worker.ts) |

## 실행에서 확인한 것

새 예산 targeted는 90/90 통과했다. 정상 child tool/model, 부모 잔여 예산, 형제 동시 배정, child 재계획, 중첩 정산, 생성/활성화 ACK 유실, 활성화 중 회수, 진입 전 회수, 부분·알 수 없는·초과 토큰, 부모 목표/정책/기한 변경, 미승인 자식의 resume/goal 우회를 포함한다. 생성 세 단계와 회수 세 단계의 실제 SIGKILL 후 재시작도 두 저장소에서 실행했다. 재시작 후 같은 명령을 반복해도 추가 물리 호출이나 중복 차감/반환이 없음을 확인했다.

중간 결과와 실패를 보존했다. 첫 build는 타입 오류였고 수정 후 첫 targeted는 42/44, 첫 전체 실행 회귀는 1,120/1,122였다. 두 실패는 위의 오래된 부모 계획 사례다. 최신 상태로 계획을 만드는 수정 후 68/68이 통과했고, 형제 초과 사용량과 실제 프로세스 종료 시험을 더해 90/90을 통과했다.

마지막 모델 재계획 검사 보완을 포함한 고정 Node 24.20.0 `npm run verify`는 exit 0, **1,168/1,168·실패 0**이다. 코어 별도 타입 검사, 안쪽 계층 77파일/의존 위반 0, 합성 4시나리오/22판정도 통과했다. 별도의 lint 명령은 구성되어 있지 않다. [검증 JSON](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-budget-local-verification.json)과 [전체 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-budget-verify.log)에 현재 소스 183개 hash와 결과를 남겼다. 원본 1,973파일·dependency lock·이전 1,078개 검증 JSON/로그는 보존했다. Git 저장소를 초기화하지 않았다.

## 한계와 다음 단위

이번 위임은 같은 tenant/principal과 더 좁은 도구·자료 label·destination·write 정책을 사용한다. grant ID만으로 권한을 주지 않는다. 실제로 다른 주체를 발급하는 A2A 위임과 리드 에이전트의 원문 차단 대안은 이후 정보 경계/협업 단계에서 검증한다. scope 문자열만으로 조직의 자산 권한 범위를 증명하지 않는다. StateRepository를 직접 변조하는 비신뢰 코드로부터 보호하는 기능도 이 application API의 보장에 포함되지 않는다.

도구 예산은 논리 dispatch 횟수다. 페이지 내부 transport 수나 외부 청구 금액의 상한이 아니다. 토큰은 estimate+최대 출력으로 예약하지만 provider가 더 많이 보고하면 실제 초과분을 남긴다. 일부만 보고하면 알려진 토큰과 알 수 없는 예약을 함께 보수적으로 보류한다. 상한 검사만으로 실제 provider 청구액이 절대 초과하지 않는다고 보장할 수 없다.

P2-05의 다음 필수 단위는 두 업무군·두 저장소의 고정 fresh/replay 전체 실행 평가다. 작은 예산 시험의 성공을 실제 모델의 장기 추론 품질이나 서비스 지연 개선으로 해석하지 않는다. P1-06/07의 실제 모델 조건, MCP/Knox/컴퓨터 유즈 실제 연동은 여전히 미검증이다. 중단한 외부 모델/API 시험은 재개하지 않았다.

같이 확인할 질문은 두 가지다. “취소 요청 저장”과 “더 이상 실행되지 않도록 저장”은 어떻게 다른가? “사용량을 모른다”는 사실을 어떻게 보존해야 다음 에이전트가 같은 예산을 다시 쓰지 않는가? 위 상태 전이와 장애 시험이 이번 단위의 답이다.
