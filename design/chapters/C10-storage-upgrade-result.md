# C10 저장 형식 이행과 최초 재열기 결과

2026-09-08 · checkpoint389 · 기준선 `53019cf4625f7f95b11995fa32fce0c9a0e90fe6`

일반 담당을 열 때, 쓰기 가능한 저장소를 만들기 전에 로컬 저장 형식을 먼저 확인하도록 연결했다. 뒤쪽 기억·대화 저장소에 알려진 미지원 형식이 있으면 앞쪽 업무 DB의 이행을 시작하지 않는다. 기존 상태·지식 저장소의 트랜잭션 이행 코드를 재사용했으며 새 이행 엔진이나 DB 간 트랜잭션을 만들지 않았다.

[계획](C10-storage-upgrade-plan.md) · [사용법](C10-storage-upgrade-usage.md) · [체크포인트](../../runtime/evidence/checkpoint389.json)

## 구현과 실행으로 확인한 범위

- lifecycle의 로컬 호환 검사를 공통 모듈로 추출하고 기존 공개 API를 유지했다. 일반 open은 실행 lease 획득 뒤 저장 방식 등록·쓰기 가능한 저장소 생성 전에 이 검사를 거친다. 각 저장소의 소유 확인·트랜잭션·본문 검증도 유지한다.
- 버전 숫자뿐 아니라 정확한 버전 행 수와 singleton을 확인한다. compact 요약의 네 테이블은 전부 없으면 정상 지연 초기화이고, 일부만 있거나 지원하지 않는 형식이면 거절한다. 새 release의 `sessionCompact`는 지원 형식을 명시하며 이전 manifest의 생략은 기존 형식1로 해석한다.
- 없는 DB, 할당 후 소유자만 기록한 DB, `local_messages`만 만든 대화 DB, format 없는 문서 등록 중단은 기존 초기화 절차로 이어간다. 완료된 문서 기억이 사라진 경우의 기존 공개 오류 코드도 유지했다.
- 신규 경계 시험 9개에서 미지원 knowledge/session/compact/Documents·모호한 버전 행·불완전 compact를 거절하며 구형 상태 DB의 실제 본문 바이트와 스키마를 보존하는지 확인했다. 정상 owner-only 세 DB와 이전 대화 테이블 재열기도 확인했다.

실제 설치 A/B 한 세트에서 두 담당을 따로 준비해 상태 형식1과2, work 구획의 지식 형식1을 확인했다. 자료는 실제 합성 도구 조회와 지식 서비스가 생성한 관측·원 세션·업무·영수증에서 가져왔다. 개인 기억을 구형 지식으로 낮추거나 다른 담당 자료를 섞지 않았다.

두 경우 모두 check→backup→pin 단계에서는 구형 스키마와 원 셀 값이 그대로였다. A의 CLI 입구가 등록된 B를 선택해 처음 열었을 때 기존 코드가 상태3·지식2로 이행했다. 원 업무·이벤트·영수증·전달·지식 JSON과 출처·색인 지연·대화 테이블·담당/세션 ID·원 백업을 보존했다. 반복 open은 이행과 업무를 반복하지 않았다. 같은 업무를 재개한 결과는 B의 실제 응답 표시를 포함했으며 전체 도구1회·시험용 모델2회로 이미 채택한 조회를 재실행하지 않았다.

이전 물리 테이블 배치는 원자료를 보존해 만든 통제된 시험 자료다. 역사적인 구버전 바이너리 자체를 실행한 검증은 아니다. 시험용 compact 저장은 실제 모델의 요약 품질·의미 보존을 평가하지 않는다.

## 검증 기록

| 기록 | 소스 | 결과 |
| --- | --- | --- |
| [build1](../../runtime/evidence/C10-storage-upgrade-build1.log) | build1 | 빌드 exit 0 |
| [첫 경계 시험](../../runtime/evidence/C10-storage-upgrade-preflight1.log) | build1 | 6 통과·3 실패. 새 호환 항목의 선언 순서가 schema 파싱 순서와 달라 release 지문이 불일치했다. 기존 직렬화 규칙에 맞게 순서를 교정했다. 실패한 lifecycle 항목은 당시 목표 검사까지 도달하지 못했다. |
| [코어 타입](../../runtime/evidence/C10-storage-upgrade-core1.log) / [계층 검사](../../runtime/evidence/C10-storage-upgrade-architecture1.log) | build1 | exit 0 / 199개 검사·위반 0 |
| [build2](../../runtime/evidence/C10-storage-upgrade-build2.log) / [경계 재시험](../../runtime/evidence/C10-storage-upgrade-preflight2.log) | build2 | 빌드 exit 0 / 9 통과 |
| [실제 설치 이행](../../runtime/evidence/C10-storage-upgrade-integration1.log) | build2 | 두 시나리오 통과. Node 집계는 상위 시험1 포함 3 통과, 약94초 |
| [관련 회귀](../../runtime/evidence/C10-storage-upgrade-regression1.log) | build2 | 108 통과·1 실패. 완료된 문서 저장소가 사라졌을 때 새 선검사가 하위 오류 이름을 노출했다. 기존 공개 오류 계약을 보존하도록 교정했다. |
| [build3](../../runtime/evidence/C10-storage-upgrade-build3.log) / [최종 좁은 재시험](../../runtime/evidence/C10-storage-upgrade-target3.log) | build3 | 빌드 exit 0 / 경계9·문서 기억8, 합계17 통과 |

최종 확보한 범위는 **신규 경계9개·설치 이행2시나리오·관련 회귀109개**다. Node의 상위 통합 시험1을 포함한 중복 제거 집계는121이다. 관련 회귀 중 문서 기억8개는 최종 build3, 나머지101개와 실제 설치 통합은 build2 기록이다. 모든 최종 채택 시험의 실패·취소·건너뜀은0이다. 전체121개를 최종 소스에서 다시 실행한 것은 아니다. 코어·계층은 build1 기록이며 이후 내부 코어 변경은 없었다.

회귀는 일반 저장소·문서 기억·문서 할당 동시성·상태 할당 중단 복구·상태 조회/이행·지식 이행/실제 강제 종료·세션·compact·lifecycle을 다뤘다. 실제 모델/API나 외부 서비스를 호출하지 않았으며 관련 시험의 기본 home은 OS 임시 공간으로 격리했다. 첫 회귀 실행 요청은 셸의 재귀 정리 구문 때문에 실행 전에 거절되어, 정리 구문을 제거한 명령으로 실행했다.

최종 환경은 Node v24.20.0, macOS arm64다. [최종 소스 대조](../../runtime/evidence/checkpoint389-final-source.json)는 2,433파일 일치, sourceDigest `ff49b6e744418aecc40c4fd655f2c283dd616f54c4b7da78b0657b606c7413a1`, filesDigest `48d0d70a45c114578d31ab5381bfb7a149875ae8a02235181c81d8f87898b5a1`이다. [build2 지문](../../runtime/evidence/checkpoint389-build2-source.json)도 보존했다.

## 남은 범위

선검사는 metadata와 알려진 저장 형식을 확인한다. 전체 본문의 무결성, 검사 이후 변경이나 모든 I/O 오류, 여러 DB의 원자적 이행을 보장하지 않는다. SQLite의 읽기 연결도 조정용 sidecar 파일을 만들 수 있다. 실제 원문 비교는 writer를 닫은 시험 자료에서 수행했다.

이번 소스의 Linux/native Windows·실제 PostgreSQL·사내 MCP/Knox·외부 A2A·운영 설치·최종 통합은 미실행이다. 실제 모델/API 시험 중단을 유지한다. 백업 복원 뒤 미확정 외부 효과를 대조하는 경로, C09 취소/목표 변경/일시정지·저널/이력 비용, C05 권한 재허용 완주, C06 기억 HTTP/권한/브라우저 인수도 남는다.

다음은 기존 lifecycle 복원·호스트 신원 복구·workflow/computer reconciliation을 읽고, 복원한 기록보다 외부 동작이 앞서 있을 때 새 실행 전에 필요한 대조에서 빠진 연결을 정하는 일이다. 이번에 확인한 저장 형식 이행을 다시 만들지 않는다. 전체 C10과 goal은 미완료다.
