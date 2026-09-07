# C01 새 담당 복제와 중단 후 재개

2026-09-07 · 복제 구현·macOS 관련 시험·Linux 전체 검증 완료 · C01 전체는 진행 중

## 사용자가 얻는 동작

같은 담당을 다른 디렉터리로 이동하면 ID와 기록이 유지된다. `clone`은 기존 담당의 설정·스킬을 바탕으로 새 ID를 가진 담당을 만든다. 새 담당의 기억·대화·진행 작업은 빈 상태로 시작한다. 한 담당의 대화가 다른 담당에게 섞이는 문제를 막기 위해 기존 저장소를 통째로 복사하지 않는다.

| 동작 | 담당 ID | 설정·스킬 | 기억·대화·작업 |
| --- | --- | --- | --- |
| 기존 담당 재호출·디렉터리 이동 | 유지 | 유지 | 유지 |
| 새 경로로 clone | 새 ID·생성 시각 | 설정과 스킬 복사, 이름 지정 가능 | 빈 저장 영역 |
| 중단된 clone의 명시 재개 | 처음 발급한 새 ID 유지 | 같은 원본 목록·해시인지 확인하고 누락 파일만 복사 | 빈 저장 영역 확인 |
| 완료된 clone의 재호출 | 유지 | 이후 독립적으로 수정한 내용 유지 | 새 담당의 기록 유지 |

CLI는 빌드한 runtime에서 다음처럼 실행한다. 전역 설치/버전 교체는 C06의 후속 작업이다.

```sh
node dist/presentation/agent-cli.js clone --directory /path/to/source --destination /path/to/new-agent --name "새 담당"
node dist/presentation/agent-cli.js clone --directory /path/to/source --destination /path/to/new-agent --resume
```

기존 대상 디렉터리는 비어 있어도 일반 clone으로 덮어쓰지 않는다. 중단된 clone만 `--resume`으로 이어간다. `status`는 미완료 복제와 일반 설정 복구를 구분하고, `init`/`repair`로 복제를 우회 완료하지 않는다.

## 재사용한 구성과 추가한 부분

- 기존 담당 설정·Zod 계약·CLI와 SQLite 상태/기억·채널·파일 저장 어댑터를 재사용했다. DB를 여는 단계는 `openAgentStores` 그대로다.
- 기존 파일 읽기와 덮어쓰기 없는 게시를 `agent-profile-files.ts`로 추출했다. 크기가 제한된 읽기, 읽기 전후 파일 확인, 임시 파일 동기화와 원자 게시를 공통으로 사용한다.
- `agent-clone-files.ts`가 스킬 목록·해시·빈 디렉터리·실행 여부를 수집하고 검증한다. 현재 원본과 목록이 달라지거나 대상 파일이 충돌하면 보존하고 오류를 낸다.
- `setup-operation.json`은 일반 초기화와 복제를 구분하는 작업 표식이다. 같은 일반 초기화는 기존처럼 ID 하나로 합류한다. 기존 v1 담당의 정상 재호출은 새 표식을 쓰지 않고 그대로 연다.
- clone은 `setup.json` v2 가드를 먼저 게시하고 identity/config·스킬을 준비한 뒤 `clone-complete.json`을 마지막에 게시한다. v1 전용 엔진은 v2 가드를 거절한다. 여러 엔진 버전의 동시 관리 실행 조정과 설치 버전 선택은 C06에 남아 있다.

완료 표식은 **복사와 검증의 완료**다. CLI의 `storageInitialized`는 이후 저장소를 열고 닫은 결과다. DB 준비가 실패해도 clone을 새 ID로 다시 만들지 않는다. 다시 열어 같은 담당의 저장소 준비를 이어간다. 모델/일반 대화 실행 연결은 아직 별도이며 `runtimeConnected: false`를 유지한다.

현재 대화 저장 검증은 기존 LocalChannel의 저장된 전달 메시지를 대상으로 한다. 사용자 입력을 포함한 전체 대화 이력과 작업 간 세션 연속성은 C02에서 연결하며, 이번 clone 시험으로 그 구현이 끝났다고 표시하지 않는다.

## 복사 범위와 충돌 처리

설정의 목적·저장 방식·기능 활성 여부·스킬 호출 모드와 모델 profile 참조를 유지한다. identity와 담당 이름은 새 담당에 맞춘다. 원본 DB, 장기기억 문서, 대화, workspace, 산출물, 자격증명 디렉터리와 `.env`는 복사 대상이 아니다. 스킬 본문에 사용자가 직접 넣은 내용까지 비밀 탐지·제거한다는 의미는 아니다.

스킬은 최대 512개 파일/디렉터리, 파일당 4 MiB, 총 32 MiB, 깊이 16을 지원한다. 초과하면 일부를 조용히 빠뜨리지 않고 오류를 낸다. 심볼릭 링크·외부 hard link·특수파일·위험 경로와 이름 충돌을 거절한다. 소유자만 수정 가능한 원본 일반 파일을 새 0600/0700 파일로 복사하며 실행 여부를 보존한다.

정상 중단으로 남은 내부 임시파일은 별도 512개/32 MiB 한도에서 검증하고 보존한다. 정식 스킬의 한도를 잠식하지 않는다. 기억·workspace·산출물 디렉터리는 복제 중 파일이 생성될 이유가 없어 엄격히 비어 있어야 한다. 임시파일과 같은 이름으로 자료를 숨겨도 충돌로 거절한다. 내부 임시파일 자동 정리는 이번 범위에 없다.

## 현재 검증

- macOS / Node 24.20.0: 빌드 성공, 기존 담당·저장·CLI와 새 복제/복구 **56/56 통과**, 실패/취소/skip/todo 0. 신규 시험은 32개다. 로그: `runtime/evidence/C01-clone-build2.log`, `C01-clone-targeted2.log`.
- 새 시험은 실제 DB의 작업·기억·채널 기록과 파일 산출물을 채운 원본에서 새 담당의 빈 저장소·독립 쓰기를 확인한다. 원본 파일의 내용·권한이 변하지 않는지도 확인한다.
- 실제 프로세스 강제 종료 후 재개는 10개다. 작업 표식·가드·identity·config·스킬·완료 직전·완료 직후·일반 init 표식과 항목/용량 최대 경계를 포함한다. 파일 복사의 완료와 DB 준비, 독립적인 사후 스킬 수정도 구분한다.
- NAS Debian 12 / Linux 6.12.30+ / x64 / ext4 / Node 24.20.0: **전체 2,523/2,523**, 관련 **138/138**, 실패/취소/skip/todo 0으로 통과했다. 빌드·코어 타입·계층 125파일/위반 0·계층 CLI 사례 4개·합성 4시나리오/22판정도 통과했다. 전체 시험은 파일 병렬 2/nice 10으로 실행했고 lint는 미설정이다. 종료 시각은 2026-09-07 00:27 KST(2026-09-06T15:27:42.654Z)다.
- 검증 중 소스/빌드를 고정했다. sourceDigest(소스 내용으로 계산한 해시)는 `fee85e7d0de7caa73c40491b231b1c65edbe2250c029ec23a95254b493a5da1a`, build filesDigest(빌드 파일 내용 해시)는 `c645b1ac1df1d3612df294e2fc20a43f535908d66047a9de36a4c15fcb7a504e`(1,035파일)이다. 로그 회수 후 로컬과 같은 소스/빌드인지, 별도 정적 자산 7개의 해시가 맞는지 재확인했다. 현재 수정본의 macOS 전체 시험을 따로 실행한 것은 아니다.

[확정 검증 JSON](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-clone-verification.json) · [Linux 전체 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-clone-linux-nas-20260907/final/all-tests.log).

NAS 테스트 시작에서 개인 PATH의 env 명령 때문에 실행기가 시작되지 않은 것을 확인하고 `/usr/bin/env`와 `/usr/bin/nice`를 명시했다. 사용자 명령/설정은 바꾸지 않았다. 종료 후 시험 프로세스 잔여 0, 기본 Node v18.20.4 유지, 시험 폴더 0700을 확인하고 SSH 연결을 닫았다. 전용 복사본과 Node 24/캐시는 다음 시험용으로 보존했다. [정리 관측](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-clone-linux-nas-20260907/cleanup.json).

## 남은 범위

네이티브 Windows의 ACL·핸들·저장 경계는 아직 구현/실제 검증이 남아 있다. POSIX FIFO 시험은 Windows에서 명시적으로 제외되며 Windows 특수파일 검증으로 계산하지 않는다. 같은 OS 계정의 임의 네이티브 코드에 대한 전체 샌드박스나 전원 장애 내구성을 증명하지 않는다.

수동 폴더 복사에 따른 동일 ID의 중복 실행 감지, file-journal의 담당 소유 연결도 C01의 남은 작업이다. 작업을 가로지르는 지속 세션·compact는 C02에서 기존 코어와 연결한다. 실제 모델/API·사내 MCP·Knox·운영 배포는 이번에 실행하지 않았다.

다음 작은 단위는 [기존 파일 저널의 담당 소유 연결](/Users/seunghanee/Documents/secumon/design/chapters/C01-file-journal-binding-plan.md)이다. Windows 파일 어댑터와 실제 검증도 남겨두며 이 결과를 C01 전체 완료로 표시하지 않는다.
