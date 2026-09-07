# P3-04 명시 런타임 효과 대조 계획

2026-09-06 · 기준 v0.34 / 전체 1,656개 시험

이전 단위의 영속 영수증을 실제 런타임 대조에 연결한다. 원 입력 시도의 결과와 checkpoint를 수정하지 않고, 별도 읽기 의도·원 응답·정산 증명을 현재 업무 상태에 연결한다. applied는 입력 사실이며 현재 사후 조건이나 업무 완료 증거가 아니다. 앞 단계가 적용됐다면 마지막 단계가 not_applied여도 묶음 전체 효과는 confirmed다.

## 구현 계약

- 명시 source attempt/head와 command ID를 받는다. 내부 등록 binding과 저장된 step/before observation에서 operation identity를 재구성한다. caller의 action/endpoint를 받지 않는다. 일반 도구·계획의 unknown 차단과 resolve 금지는 유지한다.
- WorkState에 optional bounded computerReconciliations 색인을 추가한다. 상세 요청/응답은 ArtifactStore, 상태·사용량·원본 참조는 색인, 사건은 기존 event/CAS/command receipt로 저장한다. 구 schemaVersion 1의 없는 필드는 계속 읽으며 구 reader와 양방향 호환을 주장하지 않는다.
- reserve→dispatch→response stored→settled/failed를 분리한다. 같은 command ID는 저장된 수명 상태를 이어 보고 자동 재조회하지 않는다. 이미 dispatch 후 응답이 없으면 만료 시 unknown/failed로 보존하고 새 명시 명령에 새 예산이 필요하다.
- 조회도 toolCalls를 예약하고 dispatch에서 소비하며 실제 usage/미보고를 구분한다. 원 실행 deadline은 불변이다. 조사 읽기에는 현재 work·부모 grant 안의 별도 고정 lease를 부여한다. revoke/draining 이후 새 읽기 권한은 부여하지 않는다.
- 원 source가 terminal이어야 claim할 수 있다. 원 head/result identity를 영속 fence로 고정해 늦은 publish/receive가 원 기록을 바꾸지 못하게 한다. 조회는 새 현재 driver lease를 취득하며 stable receipt와 exact original identity를 검증한다.
- current actor/정책·자료세대·knowledge·원본·등록 도구·현재 read lease를 await 전후 검사한다. 결과가 원 입력의 전체 미확정 부분을 해소할 때만 해당 effect obligation을 satisfied로 바꾼다. 다른 의무·원 Attempt의 성공/채택·Evidence는 바꾸지 않는다.
- 정산 proof가 유실·변조·차단되거나 계약이 바뀌면 실행/계획/모델/답변 경계에서 실패한다. 가능한 현재 상태 변경으로 원 의무를 다시 pending으로 만들며, 원본 저장소 자체가 손상되어 커밋할 수 없으면 오류로 차단한다. 보호된 원본 없이 완료를 커밋하지 않는다.
- compact/restore에는 visible metadata와 원본 참조만 보존하고 원문 action/response를 자동 복사하지 않는다. 현재 proof 검증기를 사용할 수 없으면 settled 표시만으로 계속하지 않는다.

## 검증과 다음 작업

두 영속 backend에서 positive/negative/unknown, 동일 명령 동시 호출, 예약/dispatch/response 이후 재시작, 원본 유실·정책/목표 변경·부모 예산 회수·만료, 원 실행의 늦은 결과, compact/restore를 확인한다. 실제 SIGKILL을 별도 child에 적용한다. 원 입력 횟수와 원 결과/head/예산의 불변성을 검증하고 전체 verify·코어 타입·계층·fixture와 source/build·원본 1,973개 보존을 기록한다.

후속은 이 proof를 소비하는 단일 successor continuation과 현재 사후 조건 재확인, 실제 로컬 합성 Web driver다. P3-04 전체는 계속 진행 중이고 실제 모델/API 시험은 중단 상태다. 이번 구현은 runtime 대조 경계까지 완성하며 continuation 완료로 세지 않는다.

## 구현 결과

[학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-runtime-reconciliation-result.md)와 [검증 정본](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-runtime-reconciliation-local-verification.json)에 정상·실패·복구 관측을 저장했다. 최종 전체 1,771/1,771·실패 0, 신규 115개다. P3-04 전체와 전체 P0–P6 목표는 진행 중이다.
