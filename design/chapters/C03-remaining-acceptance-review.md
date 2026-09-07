# C03 잔여 인수 조건 검토

2026-09-07 · 현재 계획·소스·저장된 로컬 결과의 읽기 검토 · NAS 실행/시험/제품 변경 없음

**D3가 같은 최종 소스로 Linux 검증까지 통과하면, 지원 POSIX에서의 SQLite 개인 기억·문서 저장·초안 적용·명시 이관이라는 구현 단위는 닫을 수 있다. C03 전체는 계속 진행 중이다.** 등록형 PostgreSQL이 아직 구현되지 않았고, Windows는 실제 시험뿐 아니라 런타임 연결과 일부 파일 경계 구현도 남아 있다. 따라서 “C03 구현 완료, Windows 시험만 남음”도 현재 코드와 맞지 않는다.

## 현재 증거와 완료 표기

[전체 계획의 C03](../03-migration-plan.md#c03--개인-기억이력-분리와-저장-어댑터)와 [백로그 C03](../implementation-backlog.json)은 등록된 PostgreSQL 적합성, 담당·사용자 격리, 정정/삭제 현재성, Linux 및 네이티브 Windows 검증을 인수 조건으로 둔다. D3 성공을 그 전체 조건의 성공으로 확대하지 않는다.

| 범위 | 이 검토 시점에 확인한 사실 | D3 Linux 성공 후 허용되는 표기 |
|---|---|---|
| 기본 SQLite의 명시 기억·회상·정정·잊기 | [개인 기억 결과](C03-personal-memory-result.md)에 해당 소스의 Linux 검증과 실제 문맥 연결이 있다. | 기존 단위 완료 유지. 새 모델의 기억 선별 품질까지 검증했다는 뜻은 아니다. |
| D1 문서 정본 / D2 편집 초안 | [D1](C03-document-memory-result.md), [D2](C03-document-draft-result.md)의 독립 최종 결과가 있다. | 완료 단위를 재구현하지 않는다. 초안과 정본, 대화와 기억의 분리는 유지한다. |
| D3 SQLite→문서 이관 | [new3](../../runtime/evidence/C03-migration-new3-result.json)와 [related2](../../runtime/evidence/C03-migration-related2-result.json)는 모두 exit 0. TAP은 신규 **38/38**, 기존 관련 **315/315**, 실패·취소·생략 0이다. 두 결과와 [NAS 전달 pin](../../runtime/evidence/C03-migration-linux-nas-20260907/build-pin.json)은 같은 source/build다. NAS 결과는 이 문서에서 확인하지 않았다. | 해당 pin의 Linux 관련·전체·필수 검사, 원본 회수와 환경 정리까지 확인한 뒤 **D3 지원 POSIX 검증 완료**로 기록한다. |
| C03 전체 | 백로그 status는 `in_progress`이며 아래 항목이 남아 있다. | PostgreSQL·Windows 잔여를 유지한다. 전체 goal 완료로 바꾸지 않는다. |

확인한 pin은 source `ec05dcfed7b088acb215327038a0f5fe98a9a7191f4f306274872c0252b1cfa7`, build `b2121d43b479389f3541dbcbfea5b7f79e12480ef3bac9a1719ebe258a5f46ef`, 1,437파일이다. [D3 결과 초안](C03-personal-memory-migration-result.md)의 “기존 관련 35개 파일 확정 전”은 related2 이전 상태이므로 최종 결과 정리 때 갱신할 부분이다. 이 검토는 결과 문서나 백로그를 수정하지 않았다.

## C03에 남은 실제 작업

1. **명시 등록형 PostgreSQL 기억 저장.** 현재 [설정 계약](../../runtime/src/application/agent-profile-contracts.ts)은 개인 저장을 SQLite/문서로만 선택하고, [저장소 조립](../../runtime/src/infrastructure/agent-stores.ts)은 두 구현만 연결한다. [package.json](../../runtime/package.json)에도 PostgreSQL driver가 없다. “등록하지 않았으므로 필요 없음”으로 PostgreSQL 지원 조건을 충족했다고 볼 수 없다. [후속 메모](C03-postgres-adapter-notes.md)의 기존 `KnowledgeRepository` 재사용 방향에서 등록·소유/용도 배정·기본 SQLite·명시 장애·범위별 정본/receipt/index/CAS·같은 기억 사용자 흐름을 연결해야 한다. 실제 지원 서버의 독립 연결 경합, commit 응답 유실, 재개·정정·잊기와 등록 실패 시 로컬 정본을 생성하지 않는 동작까지 시험해야 해당 용도를 지원으로 표시할 수 있다. 가짜 client 통과는 실제 PostgreSQL 인수가 아니다. 실행 상태·세션·게시판까지 모두 PostgreSQL로 옮기는 것은 별도 용도 결정이며 첫 기억 단위의 필수 재작성으로 확대하지 않는다.
2. **네이티브 Windows 연결과 실제 인수.** 아래의 C01 공통 경계와 C03 소비자를 연결한 뒤 같은 저장 생애를 실제 Windows에서 확인해야 한다. Linux·macOS 결과나 Windows 대상 컴파일만으로 대체하지 않는다.
3. **실제 지원 구성의 결과 마감.** D3 최종 Linux pin/로그/중단 복구·정리 결과를 확정하고, 남은 어댑터와 플랫폼은 각각 별도 상태로 유지한다. 이미 검증한 개인 격리·현재성·단일 정본 기준은 이후 어댑터에서도 유지할 계약이지 새 기억 엔진을 다시 만드는 항목이 아니다.

파일 저널은 이미 실행 복구 상태를 위한 어댑터다. 이를 개인 기억 Markdown 저장과 혼동하여 또 다른 “파일 저널 기억 DB”를 만들 필요는 없다. 대화 원문/compact와 개인 기억도 그대로 별도 포트·정본이다.

## Windows는 무엇이 아직 없는가

| 현재 소스 근거 | 남은 구현·검증 경계 |
|---|---|
| [hostMetadataFiles](../../runtime/src/infrastructure/host-metadata-files.ts), [hostFileMutations](../../runtime/src/infrastructure/host-file-mutations.ts)는 Linux/darwin 외에서 `unsupported_platform`을 던진다. 문서·초안·프로필은 이 경로를 사용한다. | Windows의 실제 metadata/mutation 구현과 호스트 dispatch 연결이 필요하다. 거절 분기를 제거하거나 mode/UID 검사를 생략하는 것으로 연결할 수 없다. |
| [독립 Rust 선행 기록](C01-windows-native-progress.md)은 setup 파일 하나의 생성·검사·게시 실험이다. TS 연결, Windows DLL 링크와 실기 실행은 완료하지 않았다. | C01의 root/engine 허용 범위와 프로필/저장 owner를 묶고 ACL, reparse point/junction, 기존 객체 재검사, no-overwrite 게시, 실패·handle 정리를 실제로 검증해야 한다. addon 로드만으로 C03 지원이 생기지 않는다. |
| [백업 구현](../../runtime/src/infrastructure/personal-memory-backup.ts)은 UID/private mode, `O_NOFOLLOW`, raw 후보 생성, hardlink 게시·unlink, 파일/디렉터리 fsync를 직접 사용한다. `backupFileIdentity`는 `process.getuid`가 없으면 거절한다. | 공통 경계 연결 외에도 **SQLite 백업 후보의 파일 수명**을 Windows에 맞춰 연결해야 한다. 현재 setup addon의 bounded byte 게시를 256MiB DB 전체 복사로 대체하지 않는다. 원 SQLite의 owner/연결·잠금·WAL/복구 적합성도 실제 환경에서 확인한다. |
| Rust 선행 구현은 `strict-namespace`를 생성 전에 거절하며 `process-crash` 모드도 namespace barrier 미지원을 표시한다. | 파일 flush와 이름/디렉터리 내구성의 계약을 먼저 확정해야 한다. 현재 POSIX 디렉터리 fsync 요구를 Windows에서 조용히 성공시킬 수 없다. 프로세스 중단 시험과 전원 장애 보장은 별도다. |
| [백업 worker](../../runtime/src/infrastructure/personal-memory-backup-worker.ts)와 부모는 IPC disconnect·deadline·SIGTERM/SIGKILL·종료 관측을 사용한다. | 실제 Windows에서 부모/자식 강제 종료, 후보를 더 쓰는 잔여 프로세스 부재, close/lock·게시 상태·같은 작업 재개를 확인한다. POSIX 신호 시험만으로 이 인수를 대신하지 않는다. |

Windows 인수의 사용자 흐름은 신규 SQLite/문서 담당 → 기억 저장/회상 → 초안 적용 → 이관 preview/apply/resume → 재시작·이동·새 ID 복제 → 정정/잊기다. 지원할 Windows/Node/파일시스템/계정을 명시하고, 링크·권한·동시 게시·게시 중 종료·원인/불확실성 보존을 같은 소스에서 확인한다. C01/C10의 설치·서비스 전체를 이번 D3에 새로 구현하자는 뜻은 아니며, C03이 의존하는 호스트 기능의 완료 여부를 별도 배포 조건으로 연결한다.

## 결과 초안에 보완할 실질적 한계

- **가져올 수 있는 자료 범위:** D3는 현재 개인 서비스의 소문자 64hex receipt와 알려진 audit 구조, 정상 head/index를 지원한다. 기억 하나의 최신 본문과 모든 영수증이 **한 seed 파일 256KiB** 안에 들어야 하며 namespace는 4,096기록/64MiB 한도를 사용하고 다음 일반 변경 여유를 남긴다. 따라서 “DB가 256MiB 이하면 무엇이든 이관 가능”은 아니다. [SQL 검사](../../runtime/src/infrastructure/sqlite-personal-memory-migration.ts), [seed codec](../../runtime/src/infrastructure/document-knowledge-import-codec.ts), [preview](../../runtime/src/infrastructure/document-knowledge-import.ts)가 초과·미지원 자료를 잘라내지 않고 거절한다.
- **조회 비용:** 활성화된 담당의 [선택 확인](../../runtime/src/infrastructure/personal-memory-migration-profile.ts)은 `inspectDocumentKnowledgeImport`를 호출하고, 이는 모든 초기 namespace의 seed·witness를 읽어 검사하고 barrier를 수행한다. 이후 일반 이벤트는 이 초기 prefix 검사와 구분한다. 이관 자료가 커질 때 상태 조회/열기의 추가 비용은 아직 측정하지 않았으며 C05의 실제 호출·읽기 계측 대상으로 남겨야 한다. 소스에서 반복 검사를 확인했다는 뜻이지 운영 지연을 측정한 결과는 아니다.
- **재개 한도:** 백업 후보 네 개가 모두 미완료로 남으면 `reserveAttempt`는 명시적으로 `attempt_limit`을 반환한다. 같은 operation 재개는 무제한 자동 복구가 아니다. 고아 후보를 무조건 삭제하거나 검증되지 않은 백업을 인수하는 해결책은 현재 없다. 초안의 후보 한도와 중단 복구 설명을 함께 읽을 수 있게 표시하면 된다.

동일 OS 계정이 정본·witness·manifest·activation까지 함께 되돌리는 경우, 원 DB에 없는 과거 본문, 물리적인 개인정보 완전 삭제, 사내 운영 인증·실제 모델 품질은 D3 시험이 증명하지 않는다. 기존 결과/계획의 한계를 유지하며 이번 읽기 검토에서 새 제품 결함으로 확정하지는 않았다.

## 다음 챕터로 넘어가는 조건

[C04 연결 메모](C04-next-implementation-notes.md#4-c03-잔여-중-실제-선행조건)와 전체 계획은 지원 POSIX의 담당/세션/기억 계약을 재사용하는 독립 개발을 허용한다. D3 Linux 결과를 확정한 뒤 해당 pin·미해결 진단·현재성 계약을 인계하여 C04를 시작할 수 있다. PostgreSQL이나 Windows 대기를 이유로 단일 범용 실행 루프의 독립 구현을 계속 미룰 필요는 없다. 다만 이것은 **C03을 완료로 닫는 결정과 다르며**, 실제 모델/API 시험 중단도 자동으로 해제하지 않는다.

권장 상태 문구: **“C03 로컬 기억과 D1~D3는 지원 POSIX 범위에서 검증 완료. PostgreSQL 등록/적합성 및 Windows 구현·실기 인수는 진행 중. C04는 검증된 공통 계약을 재사용해 착수 가능.”** 이 문구의 첫 문장은 D3 Linux 최종 성공과 증거 마감이 실제로 확인된 뒤에만 사용한다.
