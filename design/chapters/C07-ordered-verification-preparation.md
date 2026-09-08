# C07 순차 검증 준비

2026-09-08 · checkpoint376. C06 검증과 병렬로 수행한 읽기 검토다. **새 빌드·시험 결과가 아니며 C07 통과를 뜻하지 않는다.** [V07 요구](C06-C10-verification-plan.md#c07)를 현재 코드와 연결하고 다음 로컬 인수만 좁힌다.

[초기 등록 결과](C07-registration-result.md)의 공유 원출처·archive 영수증 대조 미연결 기록은 당시 상태다. 현재 `agent-turn-profile.ts → compose-runtime.ts`에는 `workSources`, `boardWorkSource`, `ArchiveReconciliation`이 연결돼 있다. 이 연결을 미구현으로 다시 만들지 않으며, 실제 두 담당·일반 입구 시험으로 확인한다.

| 요구 | 재사용할 시험·현재 계약 | 일반 입구에서 남은 확인 |
| --- | --- | --- |
| V07-01 자연스러운 참여·응답 책임 | `board`, `board-request-runtime`, `board-write-runtime`: 허용된 참여자의 발행·읽기·답변, 일반 질문과 명시 요청 구분, 수락→답변→요청자 확인, 근거 없는 가설의 비승격 | 등록 모델의 실제 tool loop에서 관측한 글·요청 ID/revision으로 질문과 답변을 이어간다. 별도 승인·원문 가공 절차를 추가하지 않고, 글을 읽은 사실만으로 응답 의무나 목표 완료가 생기지 않는지 확인한다. |
| V07-02 상태·대상별 알림 | `board-request-runtime`, `board-wake-runtime`, `board-change-store`: 거절·취소·기한 초과·답변 철회, 비참여자 알림 제외, 중복 wake 시 모델/도구/채팅 활동 없음 | 호스트 등록된 서로 다른 담당에서 필요한 요청만 발견하고 재접속 뒤 같은 의무·알림을 유지하는지 확인한다. 현재 저장 상태는 offered/accepted/answered/satisfied/declined/cancelled, 계산 상태는 expired/needs_review다. 추가 정보·근거 부족은 대화와 미해결 의무로 확인하며 존재하지 않는 상태명을 가정하지 않는다. |
| V07-03 아카이브 공급자·영수증 | `host-archive`, `archive-service/tools/reconciliation`, `file-archive` 구현이 존재한다. **현재 tests에서 아카이브·호스트 등록 전용 시험은 찾지 못했다.** | 조회 전용 `read_only`, 조회·등록 능력 `read_register`와 별도 호스트 `allowWrites:true`의 조합을 확인한다. 일반 모델 도구의 search/get/register/revise/delete, 원 command digest·중복·출처 버전·정정/삭제, unknown의 receipt 조회를 잇는다. |
| V07-04 공유 원문·개인 기억 분리 | `board`, `board-runtime`: 원문·인용·개인 기억 의존 관계, 철회·삭제·compact·재개 검사. archive 조회는 참조 자료이며 Evidence/개인 기억을 생성하지 않는 계약 | 담당별 디렉터리·state DB·scope를 분리하고 공유 board만 연결한다. `BoardWorkSourceRegistry`로 원 owner의 work/artifact/proof를 함께 확인하며, 두 개인 기억 저장소에 자동 등록이 없는지 대조한다. |
| V07-05 선택 비활성 | profile의 board/archive feature 기본 false. false이면 등록을 열지 않고 도구를 추가하지 않으며, true+미등록은 설정 오류 | 일반 CLI에서 두 기능을 끈 채 접수·다음 작업·재접속을 확인하고 factory 호출 0회를 기록한다. C02 지속 세션·C03 개인 기억·기존 복구 시험은 해당 근거로 재사용한다. |

시험명은 `runtime/src/tests/<이름>.test.ts`다. `helpers/board-request-fixture.ts`는 역할·질문·답변·요청 도구 준비에 재사용하되, 두 역할이 **같은 state DB와 fixture scope**를 쓰므로 담당별 저장소 격리 인수로 간주하지 않는다. 현재 tests에는 `HostBoardRegistration`, `BoardWorkSourceRegistry`, `openHostArchive`의 직접 조합 시험이 없다. 기존 게시판 저장·요청·watch의 전체 행렬을 다시 복제할 필요는 없다.

다음 실행은 세 단위로 나눈다.

1. **등록과 off 경계:** 기존 `host-tool-entry-fixture.ts`의 임시 profile/registry·등록 모델 패턴으로 `runAgentTurnCli`를 호출한다. off일 때 factory/도구 0, on+미등록 거절, 허용 도구·쓰기 허가, 정상/실패/반복 close를 확인한다. CLI/Web/Knox 전체를 같은 내용으로 반복하지 않는다.
2. **두 담당의 게시판 왕복:** 실제 두 profile과 하나의 호스트 선택 board를 만들고 논리 게시판·역할은 기존 관리 API로 준비한다. 각 profile의 `boardWorkSource`를 명시 등록한다. 일반 입력→관측한 게시글 읽기→선택 답글, 명시 요청→수락→근거 답변→요청자 확인을 tool loop로 이어간다. 이어서 공유 grant 철회·source 등록 해제·동일 workId의 모호한 출처·같은 원문 반복 인용의 유한 검증을 좁게 추가한다. 다른 담당의 state/개인 기억을 복사하거나 전역 DB 검색으로 연결하지 않는다.
3. **아카이브 읽기와 변경 확인:** 로컬 파일 공급자와 작은 호스트 공급자 대역을 사용한다. 검색 목록은 본문 없이 ID/path/sourceVersion을 돌려주고 명시 get으로 원문을 읽는지, 읽은 자료가 개인 기억에 자동 복사되지 않는지 확인한다. 쓰기는 동일 명령 재조회·변경된 digest 거절·revision/출처 버전 갱신·삭제 후 조회 제외를 확인한다. 응답 유실 뒤 재개는 원 receipt만 조회하고 mutate를 재호출하지 않아야 한다. receipt 없음/null은 미확인 상태로 남기며 미실행 증명이나 목표 완료로 취급하지 않는다. 의미가 비슷한 사례의 자동 병합은 현재 중복 명령 계약과 구분한다.

첫 연결은 SQLite 담당 상태로 좁히고, 발견한 저장·복구 영향에 맞춰 file-journal/공유 file board 및 기존 관련 회귀를 선택한다. 원문, 도구 결과, 대화 기록, 개인 장기기억은 서로 다른 저장 역할이며, 원문 `path`는 파일·DB·시스템 참조를 표현하는 출처 문자열이다. 실제 모델/API·사내 게시판/아카이브 연동은 계속 중단한다. PostgreSQL 실환경, NAS/Linux·native Windows, 검색 규모와 운영 성능은 이 준비나 로컬 대역 결과로 통과 처리하지 않는다.
