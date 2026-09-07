# C04 모델 문맥 창 관리 — 구현 결과

2026-09-07 · **같은 최종 소스에서 로컬 신규 71/71·관련 704/704, Linux NAS 전체 3,209/3,209 통과**. [확정 증거](../../runtime/evidence/C04-window-linux-nas-20260907/verification.json)는 원로그 회수·프로세스 감사·SSH 종료까지 포함한다. 이 문서는 [창 관리 계획](C04-context-window-plan.md)의 구현 단위를 설명하며 C04 전체나 프로젝트 전체의 완료 선언은 아니다. 설정과 호출 방법은 [사용 안내](C04-context-window-usage.md)에 정리했다.

현재 요청에 필요한 입력과 답변 공간을 먼저 계산하고, 과거 대화 때문에 공간이 부족할 때 들어가는 크기의 구간을 요약한 뒤 같은 작업을 이어가도록 연결했다. 현재 사용자 원문·필수 상태 자체가 너무 크면 그것을 버려서 진행하지 않고 명시적으로 멈춘다. 이미 실행할 도구나 전달할 답변이 정해진 단계는 새 모델 입력 한도만으로 막지 않는다.

## 구현한 흐름

1. 등록된 **입력 한도**, **입력·출력의 총 창**, **이번 출력 예약**, **요청 바이트 한도**를 구분한다. 총 창이 있으면 허용 입력은 `min(입력 한도, 총 창 - 출력 예약)`이다. 출력 예약이나 작업 예산을 몰래 줄이지 않는다.
2. 기존 ContextCompiler의 필수·선택 항목 조립을 재사용한다. 목표·가설·반론·의무·필수 도구·현재 원문·선택된 개인 기억·이전 답변 초안을 포함한 최소 입력을 측정한다. 도구나 결과 본문의 full/reference/omitted 선택도 기존 규칙을 따른다.
3. 읽기 전용 검사 결과를 `fits`(들어감), `needs_session_compact`(과거 대화 정리 필요), `required_overflow`(필수 부분부터 초과)로 나눈다. 이때 세션 head, 문맥 frame, 작업 상태를 게시하지 않는다. 미게시 preview는 측정 자료이며 모델에 보낼 정상 입력이 아니다.
4. 과거 대화가 원인이면 기존 compact 장부로 진행한다. 완전한 원문 항목으로 만든 prefix를 최초 포함 최대 9회 반감하며 로컬 추정한다. 선택한 후보 하나만 모델 호출과 토큰을 예약한다. 현재 입력은 남기며, 원문 한 항목이나 보호 요약도 들어가지 않으면 용량 오류를 반환한다.
5. 요약을 검증·게시·채택한 뒤 실제 답변 입력을 다시 조립한다. 실제 head가 포함된 최종 요청을 재측정한 후에만 예약한다. 여전히 과거 대화가 넘으면 다음 구간으로 진행하며 기존 단계·자원·재시도 경계를 따른다.

세션을 읽다가 저장소 문맥 상한에 도달해도 잘린 대화를 정상 문맥처럼 반환하지 않는다. capacity draft는 현재 원문, 이전 요약, 전체 대상 원문 manifest를 검증한 진단 결과이며 게시할 수 없다. complete draft만 기존 세션 head 게시 경로를 사용할 수 있다. 관련 코드는 [session-compactor.ts](../../runtime/src/application/session-compactor.ts), [context-compiler.ts](../../runtime/src/application/context-compiler.ts), [planning-runtime.ts](../../runtime/src/application/planning-runtime.ts)다.

PlanningRuntime은 최근 `fits` 준비 한 개만 보관한다. 같은 작업 전체 상태·모델 설정·프롬프트 지문일 때 재사용하고, 소비·변경·compact 예약·오류 때 폐기한다. 최종 게시 시 출처를 다시 검사한다. 다른 작업이 정상 요약을 먼저 게시한 경우에도 현재 입력과 전체 원문 manifest가 같다는 확인이 있어야 일시적인 재준비로 처리한다. 일반적인 장기 캐시나 출처 검사 생략을 추가한 것은 아니다.

새 호출에는 입력 설정 지문을 저장한다. 송신 전 한도나 추정기 등록이 바뀌면 낡은 예약을 취소·반환하고 다시 준비한다. 이미 받은 응답은 용량 설정만 바뀌었다는 이유로 버리거나 재호출하지 않는다. 지문 없는 과거 호출은 원래 고정 입력과 기존 예약 안에서 재측정하며, 과거 직렬화와 의미 지문은 그대로 유지한다. [설정 지문](../../runtime/src/application/model-input-profile.ts), [회귀](../../runtime/src/tests/model-input-profile-runtime.test.ts).

## 기억과 기록의 구분

| 구분 | 이번 동작 |
|---|---|
| 현재 모델 입력 | 현재 작업에 필요한 상태·원문·선택 자료를 조립한다. 입력 창을 넘는지 검사한다. |
| 대화 원문 이력 | compact 후에도 그대로 조회할 수 있다. 실제 사용자 입력과 응답 이력을 요약으로 대체하지 않는다. |
| 세션 요약 | 원문 인용과 이전 요약 참조를 가진 파생 기록이다. 현재 원문과 함께 다음 입력에 사용한다. 사실 검증이 끝난 Evidence를 뜻하지 않는다. |
| 개인 장기기억 | C03의 명시 기억·선택·정정·잊기 계약을 유지한다. 이번 창 관리 때문에 자동 삭제하거나 세션 요약을 개인 기억으로 저장하지 않는다. |
| 도구 목록·결과의 문맥 선택 | 기존 full/reference/omitted 선택을 재사용한다. 도구 원본·결과 산출물의 삭제와 다르다. |
| 작업 장부·출처·게시판·아카이브 | 이번 단위에서 저장 구조나 의미를 바꾸지 않았다. 작업별 자원 장부와 모델 한도는 서로 다른 제한이다. |

SQLite와 file-journal은 작업 상태 저장 방식이다. 두 방식의 실제 담당 프로필을 열어 반복 자동 compact와 재시작을 시험했으며, file-journal을 선택해도 채널의 대화·요약 저장은 기존 소유 등록된 SQLite를 사용한다. PostgreSQL이나 개인 기억의 새 backend를 추가한 단위는 아니다.

## 로컬 검증과 소스 기준

최종 로컬 기준은 [build2 pin](../../runtime/evidence/C04-window-local-build2-pin.json)이다.

```text
sourceDigest: fe041beb923c764099302efda684399933a39ea076fc3f75a39509ae9bf79357
filesDigest:  48cc235bca0faf0be804deef570319fde24ab5ad3948a406f076a2a41a5985c4
build files:  1572
```

| 검사 | 확인된 결과 | 소스·시점 |
|---|---|---|
| build2 | `npm run build` 성공 | 위 최종 pin, [실행 기록](../../runtime/evidence/C04-window-build2.json) |
| 신규 12개 시험 파일 | **71/71 통과**, 실패·취소·건너뜀 0 | 최종 pin, new3, 파일 동시 실행 수 2, Node 24.20.0. [확정 기록](../../runtime/evidence/C04-window-new-result.json), [원로그](../../runtime/evidence/C04-window-new3.log) |
| 관련 기존 회귀 | **704/704 통과**, 실패·취소·건너뜀 0 | 최종 pin, related1, Node 24.20.0. [확정 기록](../../runtime/evidence/C04-window-related-result.json), [원로그](../../runtime/evidence/C04-window-related1.log) |
| 코어 타입 검사 core1 | 성공 | 최종 fixture 수정 **전** 소스 `62dc4a92…`, 05:47 UTC. [기록](../../runtime/evidence/C04-window-core1.json) |
| 계층 검사 architecture1 | 158개 검사, 위반 0 | 같은 수정 전 소스 `62dc4a92…`. [기록](../../runtime/evidence/C04-window-architecture1.json), [원로그](../../runtime/evidence/C04-window-architecture1.log) |
| 로컬 전체 시험 | 이번 단위에서 미실행 | 관련 704개를 전체 시험 수로 표시하지 않는다. |
| Linux NAS 최종 소스 검증 | **전체 3,209/3,209 통과**, 실패·취소·건너뜀 0 | 위 최종 pin, Node 24.20.0. [확정 증거](../../runtime/evidence/C04-window-linux-nas-20260907/verification.json), 아래 별도 결과 참조. |

71개에는 전체 요청 포장과 지시문·도구 schema의 추정, 입력·출력 경계, 잘못된 추정값, 읽기 전용 검사, 필수 항목 보존, 요약 경합, 기존 예약과 설정 변경, 비모델 단계, compact 전용 배치가 포함된다. [반복 자동 흐름 시험](../../runtime/src/tests/agent-turn-window-flow.test.ts)은 두 상태 backend에서 출력 예약을 포함한 합성 창으로 최소 두 번 자동 compact한 뒤 실제 저장된 답변 입력·원문 인용·사용량 정산·프로필 재열기·다음 작업을 확인한다. 수동 compact만 수행하거나 토큰 추정값 1로 해당 흐름을 통과시키지 않는다.

## 실패 기록과 수정 범위

첫 new1은 **62/71 통과, 9개 실패**였다. [원로그](../../runtime/evidence/C04-window-new1.log)를 보존했다.

- 공통 fixture가 `LocalChannel(':memory:')`를 열면서 채널 DB 소유 등록을 빠뜨렸다. 실제 요약 후보는 정상 응답이었지만 게시가 `agent_storage_owner_missing`으로 거절됐다. [한정 진단](../../runtime/evidence/C04-window-fixture-diagnostic.json)에 실제 호출·예외 stack·사용한 dist 지문·정리 완료를 기록했다. helper를 기존 `bindAgentDatabase`로 등록한 전용 임시 SQLite에 연결했다. 요약 검증이나 제품 소유 검사를 완화하지 않았다.
- 일반 후속 입력을 시험이 `command`로 기대했으나 실제 계약은 `input`이었다. 두 backend 시험을 원문·입력 종류·sequence와 실제 이력의 동일성을 확인하도록 수정했다.
- 전달 완료를 시험이 `sent`로 기대했으나 기존 상태값은 `delivered`였다. 기대값을 고쳤다.

그다음 new2는 최종 pin에서 **70개 통과, 1개 취소**였다. file-journal 반복 흐름이 개별 60초 제한으로 취소됐고, 신규·관련 시험 묶음을 동시에 실행하고 있었다. 같은 소스·빌드와 같은 60초 제한을 유지한 new3에서 파일 동시 실행 수를 2로 제한해 71개가 약 12.9초에 통과했다. **앞선 시간 초과의 원인을 확정한 결과나 성능 개선 측정은 아니다.** new2를 성공으로 바꾸거나 원로그를 삭제하지 않았다. [new2 기록](../../runtime/evidence/C04-window-new2.json), [new2 원로그](../../runtime/evidence/C04-window-new2.log), [new3 기록](../../runtime/evidence/C04-window-new3.json).

그보다 앞선 evidence runner 구문 오류는 타입 검사 프로세스가 시작되기 전에 발생했다. 첫 실제 타입 검사는 fixture 요청의 `completionRequiresDelivery` 누락을 발견했다. 각각 시험 미실행과 타입 오류를 구분해 보존했고, 이후 build2 성공을 기록했다. [runner 진단](../../runtime/evidence/C04-window-runner-diagnosis.json), [타입 검사 원로그](../../runtime/evidence/C04-window-typecheck1.log).

## Linux 확정 결과

NAS Linux x64의 전용 디렉터리에서 별도 Node **24.20.0**으로 실행했다. 시스템 기본 Node **18.20.4**와 기존 의존성 잠금 파일은 바꾸지 않았다. 최종 종료는 **2026-09-07 06:16:53 UTC**, 실행 관측 세션은 13419이며 exit 0이다. 같은 source/build 지문의 다음 8단계가 통과했다.

| 검사 | 확정 결과 |
|---|---|
| 통합 빌드 | 성공, 로컬과 컴파일 파일 1,572개의 지문 일치 |
| 신규 집중 회귀 | 71/71 |
| 관련 기존 회귀 | 704/704 |
| 코어 타입 검사 | 성공 |
| 계층 검사 | 158개 검사, 위반 0 |
| 계층 CLI fixture | 정상 입력 허용, 세 가지 위반 입력의 예상 거절 확인 |
| 전체 시험 | 3,209/3,209, 실패·취소·건너뜀·시간 초과 0 |
| 결정적 fixture | 4개 시나리오, 22개 checkpoint 통과 |

[원 결과](../../runtime/evidence/C04-window-linux-nas-20260907/final/result.json)와 8개 원로그를 회수하고 지문을 대조했다. 각 직접 실행 프로세스 그룹의 종료, 감사에서 관측 가능한 전용 디렉터리 프로세스 0개, SSH 제어 연결과 임시 제어 디렉터리 제거를 확인했다. 접근 불가능한 같은 사용자 프로세스 2개는 범위를 확인하지 못한 상태로 기록하고 건드리지 않았다. 전역 프로세스 부재나 전원 손실 내구성을 증명한 결과는 아니다. [정리 기록](../../runtime/evidence/C04-window-linux-nas-20260907/cleanup.json).

이전 C04 첫 흐름의 3,138개 결과와 실패 기록은 별도 역사 증거로 보존한다. 이 단위의 다음 검토는 [등록 모델과 일반 입구 연결](C04-after-window-review.md)이다.

## 남은 경계

실제 모델·API 호출, 실제 모델별 tokenizer 정확도, 임의 대화의 요약 의미 보존이나 답변 품질은 검증하지 않았다. UTF-8 바이트 추정과 명시 합성 규칙은 수명·한도·출처·정산 경계를 시험하기 위한 도구다. 실제 CLI/Web의 임의 모델 설정 UI, 이번 변경의 브라우저 화면 검증, 사내 Knox/MCP 통합, Windows native, PostgreSQL도 이번 결과에 포함하지 않는다.

선택 자료를 덜 읽거나 반복 조립을 피하는 좁은 경로는 추가했지만 전체 도구 지연·토큰 비용이 개선됐다고 측정하지 않았다. C03에서 관찰한 개인 기억 출처 재검증 비용과 C05의 도구 목록·메모리 조회 최적화는 별도 후속 범위로 남는다.
