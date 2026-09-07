# C05 — 수집 응답 보관과 호출별 정산

이 문서는 collection 일반 입구 연결 다음의 구현 계획이다. 현재 일반 입구의 NAS 검증과 별도이며, 이 계획만으로 구현·시험 완료를 뜻하지 않는다. 기존 단순 MCP 읽기의 보관·정산, collection checkpoint와 영수증, 실행기의 정산·반환을 재사용한다. 실제 모델/API 시험 중단은 유지한다.

## 개념과 이번 결정

응답을 보관하는 일, 지금 본문을 사용하는 일, 이미 쓴 자원을 정산하는 일을 나눈다. 허용된 요청을 보낸 뒤 취소하거나 권한을 줄여도 받은 응답은 원 담당·원 요청에 보관할 수 있다. 보관 성공이 본문 공개·다음 페이지 요청·근거 채택·업무 완료를 허용하지는 않는다.

페이지별 전송 횟수를 실행 중간에 전체 호출량으로 확정하지 않는다. 원 시도의 요청 목록이 닫힌 뒤 자기 요청만 한 번씩 합산한다. 아직 응답 영수증이 없는 요청은 불명(null)으로 남기고 늦은 영수증이 도착하면 같은 요청 집합의 측정값만 정련한다. 부모가 호출한 페이지를 자식에게 다시 청구하지 않는다.

검토한 [증명·포트 후보](../../runtime/evidence/C05-mcp-collections-custody-design-candidate.md)와 [인수 재사용 지도](../../runtime/evidence/C05-mcp-collections-custody-acceptance-candidate.md)를 아래 결정으로 채택한다.

- 기존 envelope v1·도구 계약 지문·checkpoint 형식을 유지한다. 원 페이지 영수증에 선택 `custody` 표식을 넣고 returned(정상 반환), captured(해독 후 호출 실패), failure(응답 없는 확인된 호출 오류)를 구분한다. `recordedAtKind`는 새 응답의 SDK 해독 관측 시각과 응답 준비 시각을 구분한다. 과거 시각을 소급 해석하지 않는다.
- `ReadUsageRestoreInput`은 원 attemptId·task·request·dispatchedAt이다. source의 `restoreUsage`와 도구의 `restoreReadUsage`는 원 영수증·intent 참조와 사용량만 반환한다. 본문이나 가공 함수를 호출하지 않는다. 기존 plain `restoreUsage` 경계는 유지한다.
- 새 marker의 정상 반환 자료를 본문으로 복원할 때 원 lease 안에서 관측됐는지 검사한다. captured 자료는 나중에 권한을 복구해도 정상 page로 승격하지 않는다. 기존 marker 없는 자료의 정상 복원은 유지한다. 과거 failure.sent=true에는 추정이 섞여 있으므로 새 known 1로 확정하지 않는다.
- 보관 권한은 원 dispatch와 원 page intent 영수증에 묶는다. 현재 head가 합법적인 정산·후속 시도로 진전했다고 원 요청의 귀속을 잃지는 않는다. 원 영수증·소유자·자료 세대·원 요청의 손상은 거절한다. 현재 head의 실행 검사는 새 전송과 본문 사용에 계속 적용한다.
- `StoredReadUsages`의 보관 참조 검사와 사용량 확정 자격을 분리한다. 사용량은 received/종료된 시도 또는 고정된 원 leaseUntil이 지난 시도에서만 준비한다. 작업의 일시 정지나 변경 가능한 deadline만으로 요청 집합 종료를 추정하지 않는다.
- 기존 합산의 null 전파·안전한 정수 범위·`mergeToolExecution`을 재사용한다. 알려진 값에 다른 값을 덧붙이지 않는다. collection은 늦은 receipt를 놓칠 수 있는 기존 plain 정산 생략 조건을 그대로 사용하지 않는다.
- 문맥에서 제외할 수 있는 것은 실제 검증한 보관 raw와 역사적 checkpoint 참조뿐이다. normalized page/deferral 참조까지 필요하면 원 요청·원 응답 영수증과의 연결을 검증한 것만 포함한다. checkpoint.artifacts 전체나 관련 없는 비공개 파일을 일괄 숨기지 않는다. 현재 필수 head/result/evidence/모델 입력은 여전히 제외할 수 없다.

## 작은 구현 순서

| 단위 | 재사용 | 수정·추가 | 인수 |
| --- | --- | --- | --- |
| A. 요청별 응답 보관 | 실제 MCP client의 immutable capture, Broker 보관 수명, 기존 raw/영수증 저장 | collection 보관 callback·페이지 usage 포트, 원 intent 고정, 선택 marker·정상/실패 구분 | 반환 후 권한 축소, capture 후 실패, 원 소유·세대 손상, 두 요청 혼합 방지, legacy 정상 복원 |
| B. 사용량과 문맥 | checkpoint Reader·원 게시 영수증, 정산 명령·CAS·merge, ContextRecovery required 참조 | 역사적 head/자기 요청 증명, 종료된 요청 집합 합계, 정확한 보호 참조 목록, 늦은 영수증 재확인 | 부분 합계 미확정, null→known, 부모 중복 없음, 두 복구자, 필수/무관 참조 거절 |
| C. 실제 입구와 수명 | 기존 C01 profile·CLI/HTTP·SIGKILL worker·유한 cleanup | collection raw/response/usage 경계 주입, 보호 자료를 가진 일반 재개·종료 | SQLite와 file-journal, raw-only와 receipt 구분, 새 MCP/모델 호출 없음, 취소·원 결과·예산 유지 |

현재 source 동결 중에는 별도 staging에서 A를 작성한다. 일반 입구 NAS 결과 회수·최종 증거·문서 반영을 마친 뒤 정본에 통합한다. A/B는 변경에 맞는 빌드·대상 시험으로 확인하고, A/B/C가 연결된 최종 source에서 관련 회귀·필수 통합·Linux 검증을 수행한다. 중간 단계마다 전체 시험을 반복하지 않는다.

## 완료를 입증할 자료

실제 SDK 해독 관측과 SDK 반환 전 거절을 구분한다. raw만 남은 경우 영수증이나 수신을 만들어 내지 않는다. 정확한 원 request/intent/dispatch/session/bytes와 한 번의 정산을 확인하고, 사용량 보완이 checkpoint·결과·근거·업무 상태·예산을 변경하지 않는지 검사한다.

실제 강제 종료 인수는 두 저장소에서 raw-only, response receipt 뒤, usage commit 뒤를 구분한다. final/nonfinal/deferral 의미는 기존 fixture를 확장하며 모든 조합을 중복 실행하지 않는다. 일반 CLI/HTTP와 profile 종료에서 원문 보관 수명이 끝난 뒤 추가 게시가 없음을 확인한다. GET/status는 읽기 전용으로 유지한다.

A의 raw 보관만으로 이 단위를 완료하지 않는다. B의 회계와 보호 투영, C의 실제 입구 인수까지 필요하다. 실제 모델 의미 품질·사내 MCP·Knox·Windows·PostgreSQL·운영 배포는 별도 미완료 범위다. 전체 C01~C10 목표는 유지한다.

## B 연결 중 확인한 복원 분기 보완

현재 구현 검토에서 일반 재개가 본문 복원을 먼저 시도하므로 captured(해독 뒤 호출 실패) 응답의 본문 거절이 사용량 정산까지 막을 수 있음을 확인했다. 기존 `ReadResponseRestoreResult`에 엄격한 `custody_only` 분기를 추가했다. 이는 원 dispatch·intent·응답 영수증·bytes를 입증했지만 본문으로 사용할 수 없다는 결과다. 사유는 captured·failure·late_returned이며 새 callback/장부/모델 입력은 추가하지 않는다. 영수증이 없을 때만 absent이고 손상·귀속 불일치는 계속 오류다. 기존 표식 없는 자료의 해석은 유지한다. 원문 복원은 상태를 그대로 반환하고 기존 정산 pass로 이어진다.

현재 라벨로 볼 수 없는 head는 본문 복원을 시도하지 않는다. 문맥 투영은 계속 별도 보관 증명과 required 참조 검사를 수행한다. 같은 현재 목표의 running head는 비가시여도 필수로 보존하며 종료/과거 보관과 구분한다. 이 보완의 구현·시험·일반 입구 인수를 모두 마친 뒤 검증 결과를 기록한다.
