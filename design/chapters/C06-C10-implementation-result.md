# C06~C10 구현 연결 결과

2026-09-08. 사용자의 구현 우선 방침에 따라 기존 기반을 재사용해 아래 실행 경로를 연결했다. **통합 빌드 통과와 실제 기능 인수·운영 검증은 구분한다.**

checkpoint367: PostgreSQL 담당의 엔진 호환 검사·최초 버전 고정·명시 업데이트를 추가로 연결했다. [후속 구현](C10-postgres-engine-implementation.md). 최종 통합 build2(session12407)와 호스트 예제 syntax check가 exit0이다. [현재 소스·빌드 증거](../../runtime/evidence/implementation-handoff-checkpoint.json). 상세 검증은 실행하지 않았고 [별도 목록](C06-C10-verification-plan.md)의 V10-18에 추가했다. C01 시험 준비 코드도 보존했으며 실행은 후속이다.

checkpoint363 당시 상태: **C06~C10의 채택한 지원 범위 내 기능 연결을 마쳤다.** C10 작업공간 원문 복구와 host API를 추가했고 [최종 통합 build2](../../runtime/evidence/C10-workspace-recovery-build2.log)가 exit0이다. [현재 증거](../../runtime/evidence/C10-workspace-recovery-checkpoint.json). 상세 검증과 실제 연동은 미실행이며 C01~C05 잔여·전체 goal은 별개로 유지한다.

checkpoint362 보완: Windows 공유 저장소와 관리 이관·복원 재개를 연결하고 TS 최종 build2 및 Windows target cargo check1이 exit0이다. [결과](C01-windows-administrative-implementation.md). 당시 잔여였던 C10 작업공간 복구는 checkpoint363에서 아래 지원 범위로 연결했다. 상세 시험은 실행하지 않았다.

checkpoint360 보완: PostgreSQL 저장 어댑터·기존 자료 이관과 snapshot+로컬 원문 C10 백업/복원도 연결했고 새 통합 build2가 exit0이다. [현재 결과·잔여 구현](C01-C03-migration-backup-result.md). 아래 주 기능 연결과 checkpoint357의 빌드 기록은 보존한다.

| 챕터 | 이번에 연결한 기능 | 확인 상태 |
| --- | --- | --- |
| C06 | CLI/Web 접수·진행·결과·재접속·취소, Knox 등록 전송/전달 확인, 초기 저장 방식과 설치 자산 | 기존 구현분 보존, 이번 통합 빌드 포함 |
| C07 | 선택 게시판/아카이브, 담당별 원저장소를 통한 공유 근거 조회, 아카이브 등록·정정·삭제와 원 명령 영수증 확인 | 코드 연결·빌드 통과, 상세 시험 대기 |
| C08 | 직접 동료·임시 역할·별도 문맥의 반론, 동일 요청 재사용, 자원 배정/추가 요청/증액/반환/회수/정산, 다른 담당 DB의 명시 후원 | 코드 연결·빌드 통과, 상세 시험 대기 |
| C09 | A2A 발신/수신의 지원 부분, 사건·커서 저장과 업무 재개, 지속 세션의 사건별 새 업무와 실제 대기 루프, 단독/협업 평가 집계 | 코드 연결·빌드 통과, 실제 통신·장기 실행 미검증 |
| C10 | 오프라인 엔진 묶음·설치, 지문으로 버전 고정/명시 전환, 호환 검사와 실행/유지보수 잠금, 로컬 및 PostgreSQL snapshot 결합 백업/원경로 복원, PG 담당의 호환 검사·pin/update, 확정 checkpoint 원문의 별도 작업공간 복구 | 코드 연결·빌드 통과, 설치·복원·플랫폼 인수 대기 |

## 구현을 확인할 입구

아래는 호출할 코드의 위치다. 구현 연결과 실제 시험 결과를 분리해 볼 수 있도록 검증 항목을 함께 연결했다.

| 챕터 | 코드 입구 | 별도 검증 |
| --- | --- | --- |
| C06 | [CLI](../../runtime/src/presentation/agent-turn-cli.ts), [Web](../../runtime/src/presentation/agent-web.ts), [Knox](../../runtime/src/presentation/agent-knox.ts) | [V06](C06-C10-verification-plan.md#c06) |
| C07 | [게시판 등록](../../runtime/src/presentation/host-board.ts), [아카이브 등록](../../runtime/src/presentation/host-archive.ts) | [V07](C06-C10-verification-plan.md#c07) |
| C08 | [일반 담당의 동료·반론·자원 조립](../../runtime/src/presentation/agent-turn-profile.ts) | [V08](C06-C10-verification-plan.md#c08) |
| C09 | [A2A](../../runtime/src/infrastructure/a2a-json-rpc.ts), [사건 재개](../../runtime/src/application/mission-runtime.ts), [상시 담당](../../runtime/src/application/resident-missions.ts) | [V09](C06-C10-verification-plan.md#c09) |
| C10 | [관리 CLI](../../runtime/src/presentation/agent-lifecycle-cli.ts), [PG 호스트](../../runtime/examples/postgres-host.mjs), [작업공간 복구](../../runtime/src/infrastructure/agent-workspace-recovery.ts) | [V10](C06-C10-verification-plan.md#c10) |

## 유지한 구조

담당은 디렉터리별 식별·설정·개인 기억·대화를 유지한다. 동료 협업이나 자원 후원을 켜도 일반 DB와 대화/메모리를 합치지 않는다. 다른 담당의 예산 장부는 호스트가 등록한 소유자 주소(tenant, principal, scope)를 통해 예산 서비스 내부에서만 접근한다. `scope`는 여기서 담당의 작업 공간을 구분하는 값이다.

자원 배정은 특정 업무에 쓸 몫을 정하는 일이다. 담당의 세션 수명과는 별개다. 상대의 배정 수락 권한과 실제 수행 권한도 별도로 검사한다. 미확인 사용량이나 외부 효과가 남으면 미사용 자원을 먼저 돌려주지 않는다.

일반 동료 대화는 수신자 쪽 지속 세션을 사용한다. 반론과 임시 검토는 요청마다 분리된 문맥을 사용한다. 결과에는 검토 대상 버전·대안·근거 참조 또는 근거 없음·판별 질문이 남으며, 같은 모델의 여러 의견을 독립 관측 증거로 바꾸지 않는다. 변하지 않은 동일 질문의 재전달은 기존 요청과 업무를 재사용한다.

상시 담당은 별도 내부 제어 세션에서 사건 커서를 관리한다. 실제 사건은 같은 사용자 세션의 새 업무로 접수하므로 문맥은 이어가되 목표·근거·사용량은 사건별로 분리된다. 최근 중복 목록은 제한된 크기로 관리하고 오래된 중복은 원 접수 영수증을 조회한다. 이력 원문은 삭제하지 않는다. 종료 시 대기/호출 정리를 기다리고 모델의 지연 수신도 기존 settlePending 경로로 정리한 뒤 저장소를 닫는다.

## 빌드와 미실행 검증

- `npm run build`는 TypeScript 컴파일과 기존 build 기록 생성을 수행한다.
- 통합 build1(세션 97404)은 타입 오류 4곳으로 exit2였다. 소유 원장 optional 타입, 사건 지문의 잘못된 필드, 두 저장 명령의 JSON 변환을 교정했다.
- 통합 build2(세션 67373)는 **exit0**이다. [실행 로그](../../runtime/evidence/C06-C10-integration-build2.log).
- 이번 단계에서 상세 테스트, 브라우저 시험, 설치/복원 실행, SSH/NAS/native Windows, 실제 모델/API, 사내 MCP/Knox, 실제 A2A 통신 및 외부 배포는 실행하지 않았다.

[후속 검증 목록](C06-C10-verification-plan.md)을 별도로 저장했다. C01~C05의 실제 미구현 사항은 시험만 미룬 것으로 바꾸지 않았다. PostgreSQL 저장/이관/외부 백업은 checkpoint359~360에서 연결했으며 Windows 일반·공유·관리 소비자와 C10 작업공간 원문 복구도 checkpoint361~363에서 연결했다. C01~C05의 다른 기존 잔여는 보존하며 실제 미구현을 완성한 뒤 전체 C01~C10 순서로 검증·수정한다. 이미 통과한 과거 시험을 이유 없이 다시 실행하지 않는다. 전체 goal은 완료 처리하지 않았다.

## 지원 범위와 배치 문서

현재 A2A는 1.0 JSON-RPC SendMessage/GetTask/CancelTask와 text/data·상태·산출물의 제한된 부분이다. 수신은 호스트 인증 후 만든 caller별 handler를 사용하고 명시 nonblocking 접수를 지원한다. listener·인증 서비스·streaming·push·file 전송과 실제 상호운용을 완료한 것으로 표시하지 않는다.

현재 설치 묶음은 제작한 OS/CPU에 맞춘 Node24 환경용이며, 로컬 SQLite/file-journal/문서 기억의 오프라인 백업과 같은 정본 경로 복원을 구현했다. PostgreSQL도 별도 호스트 API로 DB snapshot과 로컬 원문을 함께 복구하도록 연결했다. 실제 지원 판정은 후속 인수가 필요하며 임의 외부 시스템의 복원을 포함하지 않는다. 배포 서명, live 백업, 별도 제거 프로그램 같은 추가 운영 기능은 이번 구현의 완료 항목이 아니다.

- [협업·자원 배치 예제](../../runtime/examples/collaboration.md)
- [사건 대기·A2A 배치 예제](../../runtime/examples/missions-a2a.md)
- [C08 상세 연결](C08-direct-peers-progress.md)
- [C09 A2A·사건 연결](C09-a2a-missions-progress.md) / [상시 담당](C09-resident-driver-implementation.md)
- [C10 설치·버전·복원 지원 범위](C10-installation-lifecycle-implementation.md)

작업공간 복구의 지원 범위는 현재 권한과 원 command receipt로 확정된 checkpoint 원문을 새 private 디렉터리에 재구성하고, 완료 manifest로 읽기/동일 복원용 WorkspaceStore를 여는 것이다. 미확정 파일 자동 수리, 기존 잠금 해제, 새 실행 scratch·기본 경로 전환이나 업무 재실행은 포함하지 않는다. [복구 구현](C10-workspace-recovery-implementation.md) · [호스트 사용법](../../runtime/examples/workspace-recovery.md).
