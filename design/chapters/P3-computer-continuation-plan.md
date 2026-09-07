# P3-04 단일 후속 작업과 현재 조건 확인

2026-09-06 · 기준 v0.35 / 전체 1,771개 시험 · 개념→계획→구현→정상/실패/복구 검증→학습 저장

앞 단위는 원 입력이 적용됐는지 확인했다. 이번에는 같은 작업의 남은 단계만 새 시도로 이어가고, 입력이 모두 끝났다면 현재 관찰만으로 조건을 확인한다. 원 시도의 result/head/operation identity는 그대로 보존한다.

## 구현 단위의 분리

구현 경계를 확인한 뒤 다음 두 종속 단위로 나눴다. 첫 단위의 통과를 실제 이어가기 지원으로 표시하지 않는다. 첫 단위는 [후속 작업 계약·근거 소비 학습 결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-continuation-boundary-result.md)에 따라 전체 1,853개 시험으로 검증했고, 두 번째 runner 단위도 [실제 이어가기 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-continuation-runner-result.md)에서 실제 실행·복구를 검증했다. 아래의 지원 전 거절 설명은 첫 단위 당시 경계이며 현재 실행 지원 여부는 v0.37 결과를 따른다.

1. **계약·근거 소비 경계:** immutable claim/단일 successor/CAS/도구 metadata 계약, context·compact·restore의 기록 보존, 리소스·공개·기억에서 원 효과 증명 재검증을 구현한다. 효과 원본 검사는 knowledge 검사와 분리해 같은 업무에서 만든 기억을 다시 읽을 때 순환하지 않게 한다. `.continue/.verify`는 등록하지 않고, `computerResume`는 계획 제출·예약·dispatch·broker 진입에서 명시적으로 거절한다. 합성 저장 계약 fixture는 실행 지원의 증거가 아니다.
2. **v2 checkpoint·실행:** 아래의 원 deadline/누적 카운터와 단일 successor 예약을 실제 runner에 연결한다. 직접 입력과 현재 조건 확인, 강제 종료·재시작의 검증까지 완료한 뒤 실행 차단을 해제한다. 아직 없는 v2 필드를 첫 단위에서 추정해 읽지 않는다.

이 순서는 공통 자료 소비 경계를 먼저 검증하고 실행 권한을 다음 단계에서 붙이기 위한 것이다. 전체 P3-04 상태는 계속 부분 검증/진행 중이다.

원 효과 검사를 분리할 때 원출처 업무가 소비했던 기억의 유효성도 독립적으로 유지해야 한다. 업무 W가 외부 기억 K를 읽은 뒤 생성한 M은 K의 개정/철회가 W에 아직 반영되지 않아도 그 변경을 재검증해야 한다. 방문 집합과 전체 크기 제한을 가진 custody graph로 기억·원본 업무·보존된 의존성을 수집하고 안정된 원장 버전을 비교한다. W에서 만든 M을 W가 다시 읽는 참조는 무한 재귀를 만들지 않으며, 데이터 자체의 derivedFrom 순환은 거절한다. 현재 독자의 권한과 내부 원본 정합성 검사는 구분한다. 기존 actorDigest만으로 다른 원작성자의 최신 namespace/reviewer 권한을 재인증할 수 있다고 가정하지 않는다.

## 선택한 구조

- 기존 observe/act와 driver·예산·CAS·원본 검증을 재사용한다. 새 기능은 명시적인 continue(쓰기)와 verify(읽기) 도구로 구분한다. 입력이 0회인 확인을 새 쓰기 성공으로 계산하지 않는다. 배치 설정에서 해당 도구 권한을 명시한다.
- TaskSpec.computerResume에는 원 attempt/head와 필요한 정산 id/proof id만 넣는다. readResume와 동시 사용하지 않는다. 실제 원 typed steps는 저장된 dispatch에서 읽고 서버가 남은 단계의 시작 위치를 계산한다. caller는 action·offset·상속 상태를 정하지 않는다.
- 별도 WorkState.computerContinuations 색인은 parent attempt마다 단 하나의 successor를 가리킨다. exact source head/result와 정산 proof, root identity, 원 시간/관찰/입력 상한을 고정한다. 새 Attempt와 도구 예산 예약을 같은 CAS에서 게시한다. 취소·만료·오류 뒤에도 claim을 지우거나 다른 형제로 교체하지 않는다.
- 부모는 terminal이어야 한다. known applied는 반복하지 않고, 마지막 적용 단계의 현재 조건을 새 관찰에서 확인한다. 앞 단계의 조건은 뒤 단계가 정상적으로 덮어쓸 수 있으므로 과거 조건 전부를 동시에 요구하지 않는다. 현재 경계 조건이 거짓이면 제한된 관찰 후 중단하며 applied action을 다시 보내지 않는다.
- unknown/intent는 정확히 해당 입력의 현재 유효한 settled proof가 필요하다. proof가 applied면 건너뛰고, not_applied면 새 operation ID로 실행할 수 있다. 부재/불명/다른 proof는 후속 입력 권한이 아니다.
- continue는 실제 남은 입력이 있을 때만 허용한다. verify는 모든 원 입력이 applied임이 확인된 경우에만 현재 조건을 조회한다. 최종 Evidence는 새 observation에서 만들며 parent 영수증을 독립 근거로 늘리지 않는다.

## checkpoint와 예산

신규 checkpoint v2에는 root action deadline, 최초 한도, 계보의 누적 관찰·입력 시도 수, 후속 깊이를 저장한다. 부모의 원 before/after/epoch를 자식이 실행한 것처럼 복사하지 않는다. 자식 steps는 실제 새 입력만 기록하고 원 단계와의 대응/상속 확인 관찰은 별도 metadata로 둔다. ToolResult.effectState와 usage는 이번 attempt만 나타낸다.

원 입력의 action deadline은 증가하지 않는다. 후속 쓰기 deadline은 원 root deadline·현재 attempt/work/grant의 최솟값이다. 이미 만료되면 입력 0회로 거절한다. 모든 입력이 확인된 뒤의 verify는 별도 읽기 lease를 사용할 수 있지만 원 입력 창을 되살리지 않는다. 관찰/입력 카운터를 호출 진입 전에 영속화하여 응답 유실이나 재시작으로 한도가 초기화되지 않게 한다. root 한도는 관찰 12 이내, 입력 시도는 binding.maxSteps의 두 배 이내, 후속 깊이는 8 이내이며 현재 work의 도구/모드/부모 예산 한도도 함께 적용한다.

구 v1 checkpoint는 조회·대조·복원 호환을 유지한다. 정확한 관찰 시도 카운터가 없는 v1을 0회 사용으로 가정해 새 입력을 허용하지 않는다. 자동 v2 전환/시간 초기화는 하지 않으며 continuation의 legacy 한계로 기록한다.

## 검증과 소비 경계

등록 도구·현재 주체/정책·목표/자료 세대·knowledge·원 parent/head/proof·단일 claim을 예약 전, dispatch, driver 입력 직전 callback, 결과 수신/채택 직전에 검사한다. claim이 생긴 parent는 정산 기록이 없더라도 late publish/receive로 원본이 바뀌지 않는다.

후속 결과와 파생 근거는 원 계보의 증명에 계속 의존한다. 효과 검사기를 공통으로 구성해 계획/모델/실행/완료/compact/restore/화면/전달 및 근거·메모리·공개 전송의 원출처 소비에서 재검증한다. 원문은 작업 원본 저장소에 남기고 context에는 허용된 metadata와 참조만 보존한다. 증명 유실 시 근거를 그대로 완료 근거로 사용하지 않는다.

양 영속 backend에서 applied prefix→suffix, not_applied retry, all-applied verify의 입력 0회, A→B 조건 갱신, 현재 조건 불일치, unknown/proof 변조·유실, 같은 parent 동시 예약, 취소·owner·정책·goal·부모 grant 변경, claim/관찰/입력 뒤 SIGKILL, 원 deadline·카운터 보존, 5회 compact/재시작, 수신·채택·전달·메모리의 증명 수명을 확인한다. 최종 전체 verify와 원본 1,973개·lock·이전 기록·source/build 연결을 검증한다.

이번 단위의 완료는 continuation과 verify의 로컬 실행·복구까지다. 실제 로컬 합성 Web driver는 다음 종속 단위다. P3-04 부분 검증/전체 진행 중과 전체 P0–P6 목표를 유지하며, 중단한 실제 모델/API·사내 서비스 시험을 재개하지 않는다. 루트만 emitting build를 수행한다.
