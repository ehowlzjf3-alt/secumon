# C05 페이지 응답 보관·정산 — A/B 로컬 결과

응답을 받은 사실과 본문을 현재 사용할 권한을 구분했다. 원 요청이 허용돼 전송된 뒤 취소하거나 권한을 줄여도, 받은 응답은 원 담당·원 요청에 보관한다. 본문·근거 채택·다음 요청은 현재 실행 권한을 계속 요구한다. 실패·늦은 응답의 보관은 업무 성공이 아니다.

페이지별 정산은 원 시도의 요청 목록이 닫힌 뒤 자기 요청만 합산한다. 살아 있는 시도에서 일부 응답만 있으면 합계를 확정하지 않으며 작업 pause나 변경된 deadline만으로 원 lease(그 시도의 고정 실행 기한)가 끝났다고 판단하지 않는다. 영수증이 없는 요청은 null(알 수 없음)이고, 같은 요청 목록에 늦은 영수증이 오면 기존 사용량을 보완한다. 부모 호출을 자식에게 다시 청구하지 않는다.

## 재사용과 변경

기존 MCP client의 요청별 decoded capture, collection checkpoint/Reader, artifact store, 기존 정산 명령·CAS·mergeToolExecution을 재사용했다. 별도 장부나 DB를 추가하지 않았다.

- collection source/Tool에 원 요청별 usage 복원과 원 dispatch·intent 보관 검사를 연결했다. 새 receipt의 custody 표식만 추가했고 envelope/checkpoint/도구 계약 지문 형식과 표식 없는 기존 자료의 의미를 유지했다.
- StoredReadUsages가 실제 과거 head/요청/영수증/원문을 검증한다. 실행기는 발급된 증명으로 기존 attempt.execution 사용량만 정련한다. collection은 같은 attempt라도 새 영수증이 올 수 있어 과거 정산만 보고 조회를 건너뛰지 않는다.
- ContextRecovery는 검증한 보관 raw·실제 방문한 과거 checkpoint/응답 참조만 제외 후보로 받는다. 현재 목표의 running head와 현재 result/evidence/input 등 필수 참조, 관계없는 보호 자료는 계속 거절한다. 원본 파일을 삭제하거나 다른 라벨로 복사하지 않는다.
- 정상 본문으로 복원할 수 없는 새 응답은 검증 후 custody_only(captured/failure/late_returned)로 반환한다. 일반 재개는 본문을 만들지 않고 기존 정산 pass로 이어진다. absent는 실제 영수증 없음에만 사용하고 손상·귀속 불일치는 오류다.

## 검증한 범위

같은 source에서 macOS Node24 빌드, 신규 **54/54**, 관련 **113/113**, 코어 타입 검사·아키텍처 검사가 실제 exit0으로 끝났다. [원로그·실행 핸들·SHA 증거](../../runtime/evidence/C05-mcp-collections-custody-AB-local-result1.json)에 명령과 결과를 기록했다. source SHA는 `b294fd811c503402f54f65ecb5bc9d2a3facae9655368fd77e3c783245c5bc2d`다. SQLite/file-journal, 실제 로컬 stdio capture 1건, 고정 전송 fixture의 동시 요청/정산·원문 경합, 저장소 재열기 후 일반 Workflow를 확인했다. 모의 모델이나 정형 응답 시험을 실제 모델 품질로 해석하지 않는다.

첫 관련 시험의 기존 no-receipt 기대 4개, 시험 코드 타입 오류, raw 손상이 만료 commit보다 먼저 거절되는 기대 1개를 수정했다. 원 실패와 사본은 보존했다. 마지막 원문 재검증을 추가했으므로 새 처리의 속도 향상을 측정했다고 주장하지 않는다.

## 다음

C 실제 SIGKILL(raw-only/response receipt/usage commit), 실제 profile close·보관 수명 종료, 일반 CLI/HTTP와 최종 통합/Linux 검증이 남아 있다. 두 독립 담당은 C 시험을 별도 staging에 작성 중이며 정본 적용·통과로 표시하지 않는다. 이전 v0.67 Linux 성공은 이전 source에 대한 증거다. 실제 모델/API 시험 중단은 유지하며 사내 MCP/Knox·Windows·PostgreSQL·운영 배포와 전체 C01~C10 목표도 미완료다. [전체 계획](C05-mcp-collections-custody-plan.md).
