# C10 복원 불일치 회복 준비 · checkpoint391 결과

2026-09-08 · 기준선 `644c7f2bf7fd14dd174b19d5a16cd29d8340a426`. **원본 보존과 선택 백업의 회복 패키지 준비·검사를 구현하고 로컬에서 검증했다.** 같은 최종 build2의 신규11개·관련26개, 합계37개가 모두 통과했다. 실제 적용·교체·신원 재등록·새 외부 기록 대조는 다음 필수 단계이며 C10과 전체 goal은 미완료다.

과거 백업에 원 실행 기록이 없는데 외부 동작은 남아 있는 경우, 실패 복원본과 선택한 완전한 담당 백업을 함께 보존하도록 했다. 백업의 일부 상태를 현재 DB에 덮어쓰거나 두 이력을 임의로 병합하지 않는다. 패키지 생성 후에도 일반 실행은 기존 복원 대조 경계에서 계속 차단된다.

## 구현된 내용

- `prepareAgentRestoreRecovery`는 정확한 현재 호스트 신원 지문, 선택 백업 지문, 동일한 담당 신원·원경로와 엔진 고정 정보를 확인한다. 현재 복원본과 원백업을 서로 분리된 새 출력 경로에 복사한다.
- `preserved/`는 실패 복원본의 원자료와 복원·대조·임시 게시 표식을 유지한다. 살아 있는 runtime lease와 이번 준비의 유지보수 기록만 제외한다. `selected-backup/`에는 선택 백업 전체와 원 `backup.json`을 보존한다.
- `recovery.json`은 원자료 복사와 지문 검사가 끝난 뒤 마지막에 게시한다. 양쪽 자료와 현재 신원·복원 기준, 파일 차이, `activation: "not_applied"`를 묶는다.
- `inspectAgentRestoreRecovery`는 준비 패키지의 원문·명세·백업을 다시 검사한다. 현재 담당의 상태나 외부 효과가 바뀌지 않았다는 확인을 대신하지 않는다.
- 공개 `runAgentCli`에 `restore-recovery-prepare`와 `restore-recovery-status`를 연결했다. 화면 출력은 경로·지문·변경 개수 요약이며 상세 파일 명세는 디스크에 둔다.

기존 백업 검사, lifecycle 복사·지문·용량 제한, 호스트 신원 claim과 유지보수 잠금, 파일 경계와 새 파일 게시를 재사용했다. 선택 백업은 명시한 후보이며 생성 시각으로 최신·정답 또는 이력의 선후 관계를 추정하지 않는다. 이번 원자료 보존 범위는 로컬 저장소이며 PostgreSQL 담당의 전체 원격 snapshot을 로컬 폴더로 대체하지 않는다.

## 검증 결과

| 실행 | 확인한 결과 | 기록 |
| --- | --- | --- |
| 최초 build1 | exit2. 시험 한 곳의 TypeScript 타입 좁히기 오류 | [원로그](../../runtime/evidence/C10-restore-recovery-build1.log) |
| 최종 build2 | exit0 | [원로그](../../runtime/evidence/C10-restore-recovery-build2.log) |
| 신규 target1 | API8개·CLI3개, **11/11**, 실패·취소·skip0. 20,154.985333ms | [원로그](../../runtime/evidence/C10-restore-recovery-target1.log) |
| 관련 regression1 | **26/26**, 실패·취소·skip0. 14,565.864583ms | [원로그](../../runtime/evidence/C10-restore-recovery-regression1.log) |
| 코어 타입 core1 | exit0. 이후 교정은 시험에만 있었으며 최종 제품 코드와 동일 | [원로그](../../runtime/evidence/C10-restore-recovery-core1.log) |
| 계층 architecture1 | 검사201개·위반0 | [원로그](../../runtime/evidence/C10-restore-recovery-architecture1.log) |
| 별도 file-journal·documents 공개 CLI 흐름 | 통과·exit0. 원백업·현재 복원본 보존, 준비 후에도 실행 차단 | [실행 코드](../../runtime/evidence/C10-restore-recovery-journal-cli.mjs) · [결과](../../runtime/evidence/C10-restore-recovery-journal-cli.log) |

Node 시험 고유37개는 같은 최종 build2에서 실행했다. 별도 공개 CLI 흐름은 이 숫자에 더하지 않는다. 최종 파일·소스 대조는 [checkpoint391-final-source.json](../../runtime/evidence/checkpoint391-final-source.json)을 따른다. [체크포인트](../../runtime/evidence/checkpoint391.json)에서 전체 실행 기록을 함께 관리한다.

최초 빌드 실패는 바깥에서 `ready`로 확인한 `AgentProfileStatus`의 타입 정보가 시험의 내부 함수까지 유지되지 않아 신원 조회 인수 타입과 맞지 않았기 때문이다. 해당 조회 앞에서 상태를 다시 읽고 `ready`를 확인하도록 시험만 고쳤다. 제품 검사나 인수 범위를 약화하지 않았으며 실패 원로그를 보존했다. 교정 뒤 build2와 위37개 시험이 통과했다.

## 실제로 확인한 범위

신규 API 시험은 실제 로컬 파일을 쓰기 전·후의 담당 백업을 사용한다. 과거 백업 복원에서 사라진 원 dispatch·효과 영수증·결과 산출물·세션·사용량이 선택 백업에 보존되고, 생성한 패키지에도 그대로 들어가는지 확인했다. 패키지 준비가 이 기록들을 현재 담당에 적용하거나 실행 차단을 해제하지 않는지도 확인했다.

다른 담당·다른 원경로·잘못된 백업/신원 지문, offline 누락, 이미 존재하거나 원본과 겹치는 출력 경로를 거절한다. 준비 패키지의 원문 훼손, 없거나 바뀐 명세도 거절한다. 두 복사가 끝난 뒤 현재 복원본이나 원백업이 바뀌면 명세를 게시하지 않고 미완료 출력과 원자료를 보존했다. 관련26개는 기존 신원 복구9개와 복원 대조·실제 외부 효과·CLI 경계17개다.

별도 공개 CLI 흐름은 **file-journal 상태와 documents 개인 기억 저장방식**을 선택한 담당으로 수행했다. 전체 저널과 문서 저장 구조, 선택 백업을 준비·조회하며 원백업과 현재 복원본이 바뀌지 않는지 확인했다. 실제 로컬 외부 파일 쓰기1회·합성 모델 호출1회가 유지됐고 준비 과정의 추가 실행은0회였다. 결과는 `activation: "not_applied"`, 일반 실행은 `still_blocked`다. 문서 기억은 저장 구조 보존을 확인했으며 실제 기억 검색·회상 품질을 검증한 결과는 아니다.

현재 단위는 macOS 로컬 구현 경계의 확인이다. 실제 모델/API, 사내 서비스, 현재 Linux/native Windows, PostgreSQL, 설치된 별도 binary 실행은 이번에 수행하지 않았다. 공개 CLI 검증은 현재 빌드의 `runAgentCli` 진입점을 사용한 결과다. 합성 모델의 정해진 응답을 실제 모델의 회복 판단 품질로 해석하지 않는다.

## 다음 필수 단계

회복 준비 이후 **호스트별 실제 적용과 중단 복구**를 연결해야 한다. 준비한 패키지가 유효한지, 현재 원자료가 준비 당시 기준과 여전히 같은지 확인하고 원 담당을 정확한 객체 기준으로 보존 이동한다. 비어 있는 원경로에 선택 백업을 복원한 뒤 신원을 재등록하고, 새 복원 고유 번호를 기준으로 외부 기록을 다시 대조해야 일반 실행을 재개할 수 있다.

이 단계는 아직 구현되지 않았다. 원자적 폴더 교체를 전제로 삼거나 단순 `rename` 호출만으로 native Windows까지 지원했다고 주장하지 않는다. 두 이력의 교체·충돌 의미도 적용 단계에서 다룬다. 성공 상태·누락 영수증·자원 정산을 추정하거나 임시 표식을 삭제해 차단을 우회하지 않는다.

실제 적용을 마친 뒤 C09 취소·목표 변경·일시정지·저널 응답 불명·이력 비용, C05/C06 후속, 현재 Linux/native Windows·실제 PostgreSQL·사내 연동·운영 배포·최종통합을 이어간다. 실제 모델/API 시험 중단은 유지한다. [사용법](C10-restore-recovery-usage.md) · [계획과 남은 단계](C10-restore-recovery-plan.md).
