# C03 D2 — 동시 문서 owner 등록의 낡은 목록 재관찰

2026-09-07 · 수정 후 공통 빌드/시험 대기

## 원 실행과 확정한 재현

[attempt-3 원 로그](C03-drafts-linux-nas-20260907/attempt-3/drafts-targeted.log)의 targeted #55는 4개 첫 열기 worker 중 하나가 `document_knowledge_registration_cleanup_required`로 끝났다. stack은 owner가 없다고 관측한 `readRootView` 분기의 후보 검증 catch를 가리킨다. 당시 worker가 nested cause를 출력하지 않았으므로 **원 NAS 실행의 내부 예외가 JSON 부분 작성인지, 낡은 목록의 link 거절인지는 확정되지 않았다.** 전체 시험은 이 targeted 실패 뒤 실행되지 않았다.

기존 build3 `dist`를 다시 빌드하지 않고 읽는 [결정적 probe](C03-drafts-owner-registration-probe.mjs)를 한정 실행했다. 실제 `readStableRegularFile()`의 첫 후보 읽기가 반환한 직후, 그 후보와 같은 inode를 `owner.json`에 `linkSync()`로 게시했다. 읽은 bytes나 메타데이터 결과를 가짜 성공으로 바꾸지 않았다. 기존 호출이 보관한 sibling names만 게시 전 목록이다.

[유효 baseline2](C03-drafts-owner-registration-baseline2.json)에서 두 게시 사례 모두 **cleanup_required → cause unsafe/metadata_read_unsafe**로 거절됐다. 안정된 partial은 SyntaxError, foreign owner는 owner_candidate_mismatch로 거절됐으며 모든 후보와 게시된 owner의 bytes는 보존됐다. 따라서 기존 코드에 존재하는 같은 외부 오류의 경합 경로를 재현했지만, 원 NAS 실행의 유일한 원인을 증명한 것은 아니다.

[첫 probe 기록](C03-drafts-owner-registration-baseline.json)은 macOS `/var` 별칭을 canonical root로 정리하기 전에 실행되어 모든 `injected=false`, 후보 읽기 0회, `metadata_directory_changed`였다. 이는 주입 전 fixture 준비 실패이며 등록 경합의 재현으로 세지 않는다. probe의 임시 root를 `realpathSync()`로 고친 뒤 얻은 baseline2가 위의 유효 재현이다. 둘 다 자기 임시 디렉터리를 정리했다.

## 최소 변경

`DocumentFiles.read()`는 stable read의 **unsafe/read**를 만났을 때만 같은 디렉터리 참조 아래 파일 목록을 기존 한도로 다시 읽는다. 목록이 실제로 달라졌다면 원 unsafe 객체를 cause로 가진 **changed/read**를 던진다. 기존 root의 `rootPendingObservation/rootView`와 namespace의 `#snapshot`이 원래 검증을 다시 시작한다.

새로 발견한 peer를 현재 읽기에 추가 허용하거나 새 bytes를 반환하지 않는다. 같은 목록의 위험 파일은 원 예외 객체 그대로 거절한다. 목록이 바뀌었어도 이후 검증에서 외부 hardlink·권한·owner·형식이 잘못되어 있으면 계속 거절한다. 안정된 partial/foreign JSON에 대한 무조건 retry는 추가하지 않았다. 추가 I/O는 unsafe/read 실패 경로의 bounded 재열거뿐이다.

수정 파일:

- `src/infrastructure/document-knowledge-owner.ts`: 위의 오류 경계만 변경.
- `src/tests/document-owner-registration-races.test.ts`: 5개 focused 회귀. 실제 hardlink 게시와 원 cause identity, 완성된 partial 후보의 게시 경합, 안정 외부 link 거절, 무관한 이름 추가가 외부 link를 허용하지 않음을 검증한다.
- `src/tests/helpers/agent-memory-profile-race-worker.ts`: 후속 자연 경합이 실패할 때 nested cause를 최대 3단계로 남기도록 진단만 보강. 메시지·stack 길이는 제한한다.

namespace의 별도 결정적 회귀와 worker 진단은 다른 담당이 준비한다. 이 문서 저장 시점에는 수정 후 빌드·회귀·NAS 실행을 하지 않았다. 기존 정상 결과를 수정본의 검증으로 대체하지 않으며, root가 두 변경을 합친 공통 빌드와 관련 회귀를 진행한다.
