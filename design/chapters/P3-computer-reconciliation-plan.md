# P3-04 효과 대조·단계 이어가기 계획

2026-09-06 · 기준 v0.33 / 전체 1,630개 시험 · 개념→작은 계획→구현→정상/실패/복구 검증→학습 저장

입력이 실행됐는지 확인하는 것, 요청한 결과가 현재도 맞는지 확인하는 것, 다음 입력을 허용하는 것을 분리한다. 화면 값이 같다는 이유나 작업 영수증이 없다는 이유만으로 미확정 효과를 해소하지 않는다. 기존 checkpoint/result를 수정하면 과거 조회·복사본의 증명이 깨지므로 대조 기록은 별도로 연결하고 남은 작업은 새 attempt로 실행한다.

## 조사 결과와 구현 순서

1. **driver의 영속 증명부터 구현한다.** 현재 합성 앱 파일은 epoch와 내용/계수만 보존하고 operationId Map은 메모리다. 새 파일은 입력 identity와 확정 영수증을 앱 내용과 같은 원자 저장 단위로 보존한다. 구 v1 앱 파일도 읽지만 없는 과거 영수증을 생성하지 않는다. bounded lookup은 입력하지 않으며 work/attempt/session/epoch/surface/operation/action을 정확히 비교한다. applied 응답이 유실돼도 영수증이 있으면 조회하고, 영수증 부재·충돌·보관 범위 미확인은 unknown이다. 명시 not_applied 영수증만 none의 근거가 된다.
2. **런타임 대조 예약·실행·정산을 연결한다.** 일반 도구/계획의 unknown 차단과 사용자 resolve 금지는 유지한다. 신뢰된 별도 진입이 명시 대상만 읽으며 현재 주체/정책·driver 계약·원본·자료/기억 수명·남은 업무 예산을 검사한다. 원 입력이 아직 진행 중이거나 늦게 실행될 수 있으면 not_applied를 인정하지 않는다. 조회 intent와 응답 원본을 저장하고 동일 명령 재시도는 receipt로 대조한다. 기존 효과/결과 이력과 정산 proof를 분리한다.
3. **명시 continuation을 연결한다.** 현재 원본/대조 proof, 정확한 parent head와 단일 successor CAS를 사용한다. confirmed 단계는 반복하지 않으며 not_applied가 증명된 단계 또는 미수행 단계만 새 관찰/대상으로 실행한다. 부모가 소비한 사용량과 원 시간 상한을 초기화하지 않는다. applied 영수증만으로 완료하지 않고 현재 사후 조건을 다시 확인한다.
4. **실제 로컬 Web driver를 연결한다.** 위 계약을 합성 실제 DOM/UI에서 검증하고 단일 행동 기준선과 비교한다. 선택 OS/앱과 조직 G-DATA·운영 소유권은 전체 계획의 별도 조건으로 유지한다.

첫 구현은 1번의 영속 증명·조회 경계다. 2/3번은 이를 소비하는 다음 종속 단위이며 이번 영수증 시험을 전체 정산·이어가기 완료로 표시하지 않는다. 기존 observe/act/wait/Broker/예산/CAS/ArtifactStore를 재사용하고 영수증 조회를 일반 모델의 우회 호출로 등록하지 않는다. driver에 영수증 기능이 없으면 미지원 또는 unknown을 유지한다.

## 첫 구현의 세부 계약

- operation identity는 원 work/attempt/session/epoch/surface/operationId/action에 결합한다. 조회용 현재 lease와 입력 당시 epoch는 다를 수 있다.
- 실제 적용과 영수증은 같은 합성 앱 파일에 fsync+rename으로 보존한다. 응답·host crash hook은 그 다음이다. 영수증은 가능한 범위의 사실을 기록하며 UI 전체 실행 trace가 아니다.
- not_applied는 driver가 입력 전 종료를 확정한 뒤 기록한다. 같은 identity가 이미 applied면 뒤늦은 실패 경로가 덮어쓰지 못한다. 진행 중 호출의 부재는 unknown이다.
- 저장 한도 초과 시 오래된 영수증을 조용히 버리지 않는다. 새로운 입력을 시작하기 전에 거절하며 기존 영수증은 조회할 수 있어야 한다. 명시 보관/정리 정책은 후속 운영 범위다.
- lookup의 callback/현재 lease/기한은 조회 경계에서 검사하고, 실패한 권한의 내부 메시지는 결과에 복사하지 않는다. 사용량과 조회 실패를 구분하며 조회가 새 입력·새 효과 영수증을 생성하지 않는다.
- 기존 앱 파일 v1은 v2의 빈 원장으로 이행하되 과거 operation은 unknown이다. 원본 시큐몬 파일과 기존 검증 기록은 변경하지 않는다.

## 검증 기준

직접 driver 시험은 applied / 명시 not_applied / 응답 unknown 뒤 확정 영수증 / 부재 / identity 각 필드 불일치 / 현재 화면만 일치 / 지연 중 lookup / 권한·초점·인계·기한 / 한도 초과 / 구 파일 이행을 다룬다. 실제 child SIGKILL을 앱+영수증 저장 직후 수행하고 새 인스턴스 조회로 inputCount/saveCount가 늘지 않는지 확인한다. 저장 또는 decode 실패도 사실을 만들어내지 않아야 한다.

루트만 emitting build를 수행한다. targeted 이후 전체 verify·코어 타입·계층·fixture, 이전 1,630개 검증/source parent 보존·원본 1,973개·lock·새 source/build 대응을 확인한다. 실제 모델/API 시험은 계속 중단이며 사내 서비스·MCP·Knox·운영 GUI를 실행하지 않는다. P3-04 local_contracts=partially_verified / 전체=in_progress와 전체 P0–P6 목표를 유지한다.

## 첫 종속 단위 결과

v0.34에서 1번의 영수증·조회 경계를 [구현·검증](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-receipts-result.md)했다. 전체 1,656/1,656·실패 0, 신규 26개다. 2번 런타임 대조 예약·정산이 다음이며 3번 continuation과 4번 실제 로컬 Web driver는 아직 남아 있다.

## 두 번째 종속 단위 결과

v0.35에서 2번 런타임 대조 예약·실행·정산을 [구현·검증](/Users/seunghanee/Documents/secumon/design/chapters/P3-runtime-reconciliation-result.md)했다. 전체 1,771/1,771·실패 0, 신규 115개다. 3번의 단일 successor continuation과 현재 사후 조건 확인이 다음이며 4번 실제 로컬 Web driver는 후속이다.
