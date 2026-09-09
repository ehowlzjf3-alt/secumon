# 기존 요구와 현재 증거 대조

2026-09-09 · checkpoint404. 대상은 `03-migration-plan.md`와 `implementation-backlog.json`의 C01–C10 명시 요구 및 이미 이름 붙인 로컬 인수다. 현재 연결 코드와 해당 결과·후속 체크포인트를 대조했다. 새 가정으로 시험을 추가하거나 전체 회귀를 반복하지 않았다. 전체 소스 감사나 실제 모델 품질 검증을 뜻하지 않는다.

| 요구 | 현재 연결 코드 (`runtime/src/` 아래) | 기존 확인과 후속 결과 | 현재 남는 범위 |
| --- | --- | --- | --- |
| C01 담당 ID·setup·rename/clone·저장 경계 | `infrastructure/file-agent-profile.ts`, `agent-host-identities.ts`, `agent-stores.ts` | [C01 결과](C01-ordered-verification-result.md), [403 설치/복원](C10-completion-result.md) | native Windows. 제공 포트의 격리는 동일 OS 계정 전체 sandbox를 뜻하지 않음 |
| C02 작업 간 세션·compact·재시작·격리 | `application/session-service.ts`, `session-compact-runtime.ts` | [C02 결과](C02-ordered-verification-result.md), [404 원문 연결](final-integration-result.md) | 실제 모델의 요약 의미 보존·대화 품질과 배치별 장기 비용 |
| C03 기억 원문·정정/잊기·격리·저장/복구 | `application/personal-memory-service.ts`, `infrastructure/agent-stores.ts`, `agent-sqlite-recovery.ts` | [R01–08 잔여표](C03-remaining-acceptance.md), [403](C10-completion-result.md), [404](final-integration-result.md) | 실제 PostgreSQL·native Windows. 주입 오류는 실제 OS 장애 증거가 아님 |
| C04 범용 요청·가설·계획·반론·부분 재계획·목표 변경 | `application/agent-turn-runtime.ts`, `workflow-runtime.ts` | [C04 결과](C04-ordered-verification-result.md) | 실제 모델 판단·usage·취소·tokenizer 적합성. API 시험 중단 유지 |
| C05 도구/스킬/기억 선택 로딩·재사용·MCP 복구·컴퓨터 유즈 | `application/knowledge-service.ts`, `execution-runtime.ts`, `presentation/host-computer-tools.ts` | [C05 결과](C05-ordered-verification-result.md), [402 재허용 완주](C05-C06-completion-result.md), [계측 Web 결과](P3-local-web-driver-result.md), [404 비용](final-integration-result.md) | 비계측 사내 앱/native 입력·이미지 효율·실서비스·운영 성능. 계측 localhost Chrome 범위와 구분 |
| C06 채널 접수·진행·결과·중복 방지·개별 배치 | `presentation/agent-cli.ts`, `agent-web.ts`, `agent-knox.ts`, `web/personal-memory.ts` | [C06 결과](C06-ordered-verification-result.md), [402](C05-C06-completion-result.md), [404 화면 복구](final-integration-result.md) | 실제 Knox 및 선택한 배치의 채널 인수 |
| C07 선택 게시판·아카이브·개인기억과 분리 | `application/board-service.ts`, `board-commands.ts`, `archive-service.ts` | [C07 결과](C07-ordered-verification-result.md) | 실제 공유 공급자·운영 검색 규모 |
| C08 동적 동료·반론·독립 예산·배정/반환/정산 | `application/peer-agents.ts`, `budget-tools.ts`, `budget-runtime-router.ts` | [C08 결과](C08-ordered-verification-result.md), [후속 완주](C08-remaining-boundaries-result.md) | 실제 모델의 반론·협업 판단 품질 |
| C09 A2A·상시 임무·제어 복구·원문 이력·중복 방지 | `application/mission-runtime.ts`, `resident-missions.ts`, `infrastructure/a2a-json-rpc.ts` | [통합 비교](C09-integrated-trials-result.md), [보존 이력](C09-retained-history-result.md), cp398–400 후속 결과 | 실제 peer/서비스·운영 규모. 단독/협업 비교는 고정 합성 모델 범위 |
| C10 설치·버전·업데이트·백업·복원·재연결 | `presentation/agent-engine-launcher.ts`, `infrastructure/agent-storage-compatibility.ts`, `agent-restore-recovery-apply.ts` | [저장소 업데이트](C10-storage-upgrade-result.md), [403 설치/복원](C10-completion-result.md) | native Windows·실제 PG·운영 보관/용량/복원 목표·파일럿. 운영 이행은 선택 시 진행 |

명명된 로컬 인수의 추가 누락은 이 대조 범위에서 찾지 못했다. 오래된 `compact 미구현`, `SQLite 명시 복구 미검증`, `collection 재허용 완주 미검증`은 후속 결과를 우선한다. 서로 다른 소스·시점의 누적 시험 수를 현재 최종 빌드 전체의 통과 수로 합산하지 않는다.

과거 concurrent-open 실패와 NAS MCP 정체의 정확한 원인 미확정은 backlog의 `bounded_limitation` 기록으로 보존한다. 이후 관련 통과와 별개이며, 원인이 해결됐다고 표시하거나 새 필수 시험으로 바꾸지 않았다. 문서형 업무의 남은 13.3초 비용, 파일 저널의 누적 원문 검증·저장량도 제한으로 유지한다.

R17/R22/R24/R26의 `not_started`는 실제 구현과 맞지 않아 `in_progress`와 근거로 교정했다. 전체 요구 `verified`로 올리지 않았다. 현재 로컬 세 묶음 완료는 [404 결과](final-integration-result.md), 실제 환경에 필요한 입력·확인은 [남은 확인 목록](../REMAINING-ACCEPTANCE.md)을 따른다. 전체 goal 완료는 선언하지 않는다.
