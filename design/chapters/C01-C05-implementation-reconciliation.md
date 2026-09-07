# C01~C05 실제 잔여 정리

2026-09-08 · checkpoint366. C06~C10 연결 이후 기존 backlog의 남은 항목을 해당 최신 코드/결과와 좁게 대조했다. 전체 기능 검증이나 새 감사 결과가 아니다. 과거 작은 단위의 `not_implemented_in_this_unit`를 현재 미구현으로 옮기지 않는다.

| 챕터 | 재사용하는 구현 | 실제 제품 잔여 / 후속 검증 |
| --- | --- | --- |
| C01 | 디렉터리 ID·setup·clone·저장 포트 경계, file-journal 연결. Windows 일반·공유·관리 소비자는 checkpoint361~362에서 연결 | 폴더 전체 수동 복사의 중복 ID 감지·호스트 등록·명시 복원 재등록을 checkpoint365에서 연결했고 build2 exit0. [구현 결과](C01-host-identity-registration-implementation.md). native Windows 실행·링크·설치 인수는 검증 대기 |
| C02 | 지속 세션과 작업 분리, 원 발언 보존, 여러 작업/compact/재시작 연결 | 이 범위의 추가 기본 미구현은 찾지 못했다. 이번 소스의 순차 회귀·실제 모델 적합성은 별도 |
| C03 | 기본 SQLite, 문서 기억, file-journal와 등록 PostgreSQL, 로컬→PostgreSQL 이관 및 백업/복원, Windows 개인 기억 이관 | 원 DB/journal 보존·후보 rollback·명시 적용의 SQLite 회복 입구를 checkpoint366에서 연결했고 최종 build3 exit0. [구현 결과](C03-sqlite-recovery-implementation.md). PostgreSQL 역이관은 현재 지원 밖이며 모든 방향 이관을 새 필수 범위로 추가하지 않음 |
| C04 | 범용 주턴/compact 프롬프트, 등록 모델, 가설·계획·실행·검증·재계획, 직접 답변/모드/명시 목표 변경 | 이 범위의 추가 기본 미구현은 찾지 못했다. 실제 모델 판단·토큰/usage·취소·한도 적합성은 미검증, API 시험 중단 유지 |
| C05 | 카탈로그/정확한 도구 계약, 선택 기억/스킬·컨텍스트 관리, MCP 단순/collection 원응답 보관·재개·정산 | 일반 쓰기/컴퓨터 binding의 호스트 입구 누락은 checkpoint364에서 연결했고 build1 exit0. C05 crash/drain 후보와 일반 CLI/HTTP·새 소스 회귀는 상세 검증 단계. 효율은 기존 측정 후보를 같은 업무로 비교한 뒤 필요한 부분을 revision |

## 구현 순서

1. C05 일반 쓰기·컴퓨터 호스트 등록과 provider별 효과 확인을 기존 코어에 연결하고 통합 컴파일한다. [해당 단위](C05-write-computer-host-implementation.md).
2. C01 호스트 등록표의 같은 담당 ID/다른 폴더 객체 감지와 C10 복원 후 명시 재등록은 checkpoint365에서 연결했다. 상세 검증은 미실행이다.
3. C03 명시 관리 회복을 checkpoint366에서 연결했다. [결과](C03-sqlite-recovery-implementation.md)의 세부 검증은 미실행이다. 기존 [agent-database-owner.ts](../../runtime/src/infrastructure/agent-database-owner.ts)의 `agent_storage_recovery_required` 거절과 CLI 설정 `repair`를 DB 회복 완료로 설명하지 않는다.
4. 다음은 [C01~C10 순차 검증·수정](C01-C10-ordered-verification.md)이다. 이미 보유한 시험과 원로그를 재사용하며 실제 연결 조건이 없는 항목은 미검증으로 유지한다.

## 범위를 혼동하지 않을 항목

제공된 파일·DB·workspace 포트는 엔진 중첩, 경로 이탈, 다른 담당 소유자를 검사한다. 등록 callback이나 별도 MCP 프로세스는 신뢰된 호스트 실행 코드이며 같은 OS 계정의 임의 셸/네이티브 코드 전체를 격리하는 sandbox는 아니다. 기존 C01 계획의 포트 경계와 강한 OS 격리를 같은 완료 조건으로 합치거나, 경로 검사만으로 OS sandbox를 구현했다고 표시하지 않는다.

PostgreSQL·Windows가 없다는 과거 문구, C02 초기 단위에 compact가 없다는 문구, C05의 이미 연결된 offline/collection 후속 문구는 각 당시 이력이다. 최신 checkpoint의 구현 연결을 우선하고 과거 증거 자체는 보존한다. C05 원문 조회 비용 후보는 [기존 비용 검토](C05-context-cost-review.md)에서 다시 측정할 항목이며, 새 성능 개선이나 토큰 절감률로 발표하지 않는다.

전체 goal은 미완료다. 이 문서의 좁은 코드 대조는 구현 잔여를 정리한 것이며 C01~C10 요구 전체의 완료 감사나 실제 운영 검증이 아니다.
