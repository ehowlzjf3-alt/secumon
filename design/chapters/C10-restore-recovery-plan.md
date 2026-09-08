# C10 복원 불일치 회복 · checkpoint391 착수 계획

2026-09-08 현재 상태: **준비 패키지 생성·검사와 CLI 연결을 구현하고 로컬 검증했다.** 같은 최종 build2에서 신규11개·관련26개, 고유37개가 통과했고 별도 file-journal·documents 공개 CLI 흐름도 확인했다. 최초 build1의 시험 타입 오류와 교정 이력은 보존했다. [구현·검증 결과](C10-restore-recovery-result.md) · [사용법](C10-restore-recovery-usage.md) · [최종 소스 대조](../../runtime/evidence/checkpoint391-final-source.json).

실제 적용·현재 담당의 보존 이동/교체·신원 재등록·새 외부 대조는 다음 필수 미완료 단계다. 준비를 전체 회복 완료로 보지 않는다. 아래는 이번 단위의 착수 시점 근거와 후속 적용 요구를 보존한 기록이다.

2026-09-08 · 기준선 `644c7f2bf7fd14dd174b19d5a16cd29d8340a426`

직전 checkpoint390은 복원 대조와 재개를 구현하고 같은 소스의72개 시험 및 공개 관리 CLI 흐름을 통과했다. 코드·문서·증거를 커밋/푸시했고 origin/main과 `644c7f2`가 일치함을 확인했다. 직전 goal turn은 progress다. 현재 worktree는 그 커밋에서 시작했다.

## 개념

외부에 실행 결과가 남아 있고 복원본에서 원 시도가 사라졌다면, 외부 영수증 하나만으로는 그 사이의 세션·명령·권한·사용량 기록을 복원할 수 없다. 원 기록이 들어 있는 완전한 담당 백업을 선택해 회복할 수 있어야 한다. 현재 실패 복원본도 별도로 보존해야 검토·되돌림·충돌 확인이 가능하다.

현재 StateRepository에는 최신 업무 상태를 원 이력으로 가져오는 API가 없다. file-journal은 원 CommitRequest/hash chain을 재생하고 PG transfer는 빈 대상에 전체 원자료를 이관하지만, 두 이력을 병합하는 기능은 없다. 임의의 최신 state 하나를 덮어쓰는 방식을 추가하지 않는다.

## 구현 단위와 재사용

회복은 **준비 → 적용 → 새 복원에 대한 외부 대조 → 일반 재개**로 연결한다. 이번 단위는 준비와 준비 결과 검증이다. 이후 적용 단계는 전체 goal의 필수 미완료 작업으로 유지한다.

- 기존 `inspectAgentBackup`, `captureLifecycleTree`/`copyLifecycleTree`, 파일 소유·원문 SHA·새 경로 게시, maintenance 및 host identity claim을 재사용한다.
- 신규 `prepareAgentRestoreRecovery`: 현재 복원본과 선택한 같은 담당·같은 원경로 백업을 새 회복 패키지에 실제 원문으로 보존한다.
- `preserved/`는 실패 복원본의 자료와 복원/대조/pending 표식을 보관한다. 살아 있는 runtime lease와 이 준비 작업의 maintenance 기록만 제외한다. 기존 일반 backup은 복원 표식을 제외하므로 실패 증거 보존용으로 그대로 쓰지 않는다.
- `selected-backup/`는 선택한 원백업 전체다. DB·세션·기억·artifacts·원 manifest를 함께 가져오고 기존 백업 검사로 읽을 수 있게 한다.
- `recovery.json`은 원 신원 head, 복원 표식, 양쪽 자료 지문, 선택 백업 지문, 파일 차이 개수와 아직 적용하지 않았다는 상태를 묶는다. 준비 명세는 원문 복사가 검증된 뒤 마지막에 게시한다.
- 신규 `restore-recovery-prepare`와 `restore-recovery-status` 관리 명령을 연결한다. 프로필/모델/툴 실행을 여는 입구는 사용하지 않는다.

현재 단위는 로컬 전체 백업(SQLite 또는 file-journal, 로컬 문서 포함)을 대상으로 한다. PG 선택 담당의 전체 원자료를 로컬 폴더만으로 보존했다고 주장하지 않으며 기존 원격 전체 snapshot 경로와 후속 연결을 유지한다.

## 정합성과 비용

선택한 백업의 생성 시각만으로 최신/정답이라고 판정하지 않는다. 실제 백업 SHA·전체 담당 신원·원경로·config identity·engine pin을 확인한다. 준비 명세의 파일 차이는 교체 후보 비교이며 두 업무 이력이 선후 관계라는 증명이 아니다. 적용 시에는 현재 복원본이 여전히 준비 기준과 일치하는지와 이력 충돌/교체의 의미를 별도로 확인한다. 새 복원 후에는 checkpoint390의 전체 외부 대조가 여전히 필요하다.

모든 폴더는 담당·원백업·엔진·호스트 등록표와 분리한다. destination은 새 경로만 허용한다. 원본을 바꾸거나 실패한 출력을 지워 재사용하지 않는다. 기존 bounded capture/copy의 파일·전체 용량 제한을 재사용한다. 실제 읽기·복사·대조 비용을 숨기지 않으며 메인 에이전트 문맥에 원문 전체를 넣지 않는다.

## 검증과 다음 적용 단계

실제 로컬 도구 쓰기 전/후 백업을 준비한다. 과거 백업 복원에서 외부 효과 불일치를 확인한 뒤, 뒤 백업의 원 attempt/dispatch/result/artifacts/usage/session을 포함한 패키지를 생성한다. 현재 복원본·외부 파일·원백업은 그대로이고 일반 실행은 계속 차단돼야 한다. 패키지의 원문 훼손·잘못된 신원/지문/경로·유지보수 충돌을 거절한다. CLI 필수 인수와 결과 조회도 검증한다.

현재 host file mutation API는 일반 파일의 no-replace 이동만 제공한다. 전체 담당 폴더를 정확한 객체 기준으로 보존 이동하는 공개 API는 없다. 이후 적용 단계에는 좁은 호스트 디렉터리 보존 이동 기능, 중단 후 원 root/보존 root 식별, 기존 maintenance 종료 순서가 필요하다. 원자적 swap은 필수가 아니다. 원 자료를 보존한 후 비어 있는 원경로에 기존 restore → exact rebind → 새 reconciliation을 연결한다.

단순 Node rename을 붙인 뒤 native Windows까지 구현/검증했다고 표시하지 않는다. 새 원기록을 병합하지 않고 교체하는 경우의 충돌 설명도 다음 적용 계획에서 명시한다. 실제 모델/API·사내 서비스·외부 배포 시험 중단은 유지한다.
