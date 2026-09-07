# C01 첫 구현 — 담당 등록과 기본 저장소 연결

2026-09-06 · 부분 구현/로컬 검증 · C01 전체 진행 중

후속으로 NAS Debian 12/x64에서 경로·파일 읽기 수정본의 **전체 2,491/2,491** 검증을 완료했다. 아래 macOS 2,479개는 첫 단위의 당시 소스 결과이며 최신 Linux 수정본과 구분한다. [후속 수정과 Linux 결과](/Users/seunghanee/Documents/secumon/design/chapters/C01-portability-result.md).

2026-09-07 추가로 [새 담당 복제와 명시 재개](/Users/seunghanee/Documents/secumon/design/chapters/C01-clone-result.md)를 구현하고 NAS 전체 **2,523/2,523** 검증을 완료했다. 아래 구현 설명은 첫 단위의 당시 범위이며 최신 복제 동작은 후속 문서를 따른다.

## 구현된 사용자 경험

새 `secumon-agent` 진입점은 현재 디렉터리에서 담당 ID와 설정을 준비한다. 명령 없이 호출하면 신규 설정 또는 정상 재호출을 처리하고, `status`는 쓰기 없이 상태를 보여준다. `repair`는 복구 가능한 기록을 기존 ID로 연결한다. `version`은 엔진/설정 버전을 보여준다. 모델과 대화 실행은 아직 연결하지 않았으므로 출력에 `modelReady: false`, `runtimeConnected: false`를 명시한다.

기본 생성 영역은 `config.json`, `.secumon/identity.json`, `.secumon/setup.json`, `.secumon/runtime.sqlite`, `.secumon/channel.sqlite`, `memory/memory.sqlite`, `skills/`, `workspace/`, `.secumon/artifacts/`다. SQLite/파일 구현을 새로 만들지 않고 기존 어댑터를 담당 경로로 조합했다. 새 저장소의 소유 담당 ID를 DB 내부에 기록해 다른 담당의 DB가 잘못 연결되는 것을 거절한다.

## 재사용과 수정

- 재사용: SqliteStateRepository, SqliteKnowledgeRepository, LocalChannel, FileArtifactStore, FileWorkspaceStore.
- 신규: agent-profile-contracts.ts, file-agent-profile.ts, agent-stores.ts, agent-cli.ts, 관련 두 시험 파일.
- 패키지: `secumon-agent` bin 진입점과 대응 lock metadata를 추가했다. 전역 설치/공개 배포는 실행하지 않았다.
- 기존 수정: LocalChannel에서 busy_timeout을 WAL 설정보다 먼저 적용하고 생성 실패 시 연결을 닫는다. 8개 프로세스의 동시 최초 실행에서 재현한 DB 잠금 오류를 수정했다.

## 확인한 동작과 실패

- 담당별 생성·재호출·경로 이동과 서로 다른 ID, 일반 기존 파일 보존.
- 초기화 중 일부 metadata만 게시된 경우 같은 ID로 이어서 완료. 이미 완료된 담당의 ID 누락은 명시 복구, 완료 후 config 유실은 복원 자료가 필요하므로 기본값으로 덮어쓰지 않음.
- 신원 충돌·손상 JSON·미지원 schema·심볼릭 링크/외부 hard link·공개된 metadata·엔진/중첩 담당 영역 거절.
- 8개 별도 프로세스의 동시 초기화에서 ID 하나 유지.
- 같은 사용자/namespace/work ID/기억 ID를 쓰는 두 담당의 물리 저장 분리, 닫은 뒤 재호출 시 값 보존.
- 다른 담당의 DB 복사, 기존 소유 정보 없는 DB, DB/sidecar 링크를 통한 다른 파일 수정 거절.
- 담당 작업 파일의 상대 경로 탈출/절대 경로 거절, 다른 담당의 파일/원본 미노출.

첫 시험에서는 macOS `/var` 별칭의 정규 경로 차이로 두 assertion이 실패해 시험 경로를 정규화했다. 후속 저장 시험에서는 근거가 없는 기억 fixture가 기존 계약에 거절돼 출처를 가진 fixture로 수정했다. 동시 실행 실패 때 다른 프로세스가 끝나기 전에 정리하던 시험도 allSettled 후 결과 확인으로 수정했다. 실패 로그를 보존하고 마지막 통과 결과와 구분한다.

## 검증 상태

- 빌드 성공, 관련 시험 **24/24** 통과(신규 19개와 기존 CLI 5개), 코어 타입 검사 성공, 안쪽 계층 125파일/위반 0.
- 실행 환경: macOS, Node 24.20.0. 실제 모델/API/사내 MCP/Knox는 실행하지 않았다.
- 필수 전체 검증: 2026-09-06 22:53 KST 종료, **2,479/2,479 통과·실패/취소/skip/todo 0**, exit 0. 코어 타입 검사·계층 검사·4개 fixture/22판정도 통과했다. 현재 소스와 빌드 manifest를 재대조했다. lint 명령은 설정되어 있지 않다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-workspace-local-verification.json). [실행 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-setup-verify.log).

## 남은 C01과 다음 행동

1. 사용자가 지정한 **Linux와 네이티브 Windows** 지원을 완성한다. 현재 POSIX 권한/UID·디렉터리 fsync에 의존하는 부분은 Windows 지원 완료가 아니다. [OS 지원 계획](/Users/seunghanee/Documents/secumon/design/chapters/platform-support-plan.md).
2. 명시 clone과 중단 후 재개는 후속 단위에서 구현·검증했다. 수동으로 디렉터리를 통째로 복사했을 때의 중복 ID 실행 감지는 별도 남은 경계다.
3. 설정된 파일 저널/추가 저장소의 담당 소유 연결과 실제 작업 도구/세션 조합을 이어간다. 현재 agent-stores는 SQLite 기본 연결이고 file-journal 설정은 조용히 SQLite로 대체하지 않고 미연결 오류를 반환한다.
4. 본체/다른 담당의 보호는 제공된 저장 포트와 경로 경계의 검증이다. 동일 OS 계정의 임의 셸/네이티브 코드나 모든 Windows ACL에 대한 강한 격리를 증명한 것은 아니다.

상태/세션·기억 검색/요약/캐시의 전체 자동 격리와 X→Y 대화 연속성은 C02/C03에서 연결한다. 이 첫 단위의 통과를 C01 전체 또는 범용 대화 에이전트 완성으로 표시하지 않는다.
