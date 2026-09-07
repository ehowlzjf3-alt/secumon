# P0 학습·검증 정리

이번 챕터에서 만든 것은 에이전트의 첫 계약과 검증 기준선이다. 실행할 과제를 나열하기 전에 어떤 근거가 있어야 완료인지 표현했다.

## 같이 볼 예제

문서 A는 보존기간 90일, B는 30일이라고 쓴다. 먼저 읽은 A만으로 확정하지 않는다. 같은 문서를 복사해 세 번 인용해도 독립 출처는 하나다. A의 현행 개정문이 30일로 정정하면 같은 원본의 구버전 근거를 대체하고 B와 대조할 수 있다. 사용자에게서 ‘내보내기 허용 여부도 포함해줘’라는 변경이 오면 기존 비교가 끝났더라도 새 기준의 근거를 더 확보해야 한다.

관측 검토에서는 ‘승인 여부를 확인하라’는 목표를 `present` 기준으로 표현했다. 승인됨/승인되지 않음 양쪽 답이 근거를 갖추면 완료할 수 있다. 반면 ‘수집 범위가 완전한가’처럼 명시 제약은 `equals: true`를 쓴다. 조회 오류나 일부 페이지만 확보한 결과는 완전한 수집을 증명하지 못한다.

이 예제는 고정된 합성 자료와 코드 판정이다. 모델이 문서를 이해하거나 가설을 스스로 바꾼 결과는 아니다. fixture의 제어 분기 기대값은 P1에서 실제 루프와 연결한다.

## 저장에서 배운 점

상태, 사건, 응답 의도, 처리 영수증을 같이 커밋해야 한다. 상태만 바뀌고 사건이 빠지면 복원이 모호해진다. 그래서 사건 삽입에 실패를 주입했을 때 상태 변경도 되돌아가는지 확인했다. 저장 후 프로세스를 SIGKILL로 종료하고 다른 프로세스에서 대기 조건을 복원했다. 두 프로세스가 같은 revision을 갱신하면 하나는 conflict를 받는다.

이는 로컬 저장소의 적합성 증거다. 메시지를 이미 보냈는지, 모델이 생성한 계획이 타당한지, 장기 업무가 끝까지 성공하는지까지 증명하지 않는다.

## 확인 결과

- `npm run verify`: TypeScript 빌드, 시험 17개, domain/application 의존성 검사 통과.
- 합성 시나리오 4개, 판정 checkpoint 22개 통과.
- 실제 API/모델/사내 서비스 호출 0회.
- [계약 기준](/Users/seunghanee/Documents/secumon/design/chapters/P0-contracts.md), [기술 선택](/Users/seunghanee/Documents/secumon/design/chapters/P0-adr.md), [재사용/외부 계약](/Users/seunghanee/Documents/secumon/design/chapters/P0-reuse.md).
- [fixture 실행 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/fixture-baseline.json). 챕터별 검증 명령/원본 보존 결과는 별도 P0 verification 기록에 저장한다.

다음 챕터 P1은 이 계약을 실제 실행 루프로 연결한다. 먼저 대역과 artifact 저장을 준비하고, 계획 검증·도구 실행·근거 수락·continue/replan/wait/complete·CLI 접수/결과·복구를 순서대로 구현한다. 실제 모델이 필요한 통과 기준은 명시적으로 남겨둔다.
