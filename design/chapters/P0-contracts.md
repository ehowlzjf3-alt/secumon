# P0 최소 계약과 저장 경계

## 핵심 구분

`Goal`은 목표 revision·범위·모드·완료 기준, `WorkState`는 현재 실행 상태·예산·계획·시도·근거·가설·의무를 소유한다. `Hypothesis`는 설명/예측/반증 조건과 근거 관계를 갖는다. 가설을 저장한 것만으로 사실이 되지 않는다.

현재 완료 predicate는 스칼라 사실의 `equals`와 `present`를 지원한다. `equals`는 사용자가 명시한 제약 충족에, `present`는 답의 방향을 고정하지 않는 확인에 사용한다. `present`여도 충돌하는 현재 값이 있으면 완료하지 않는다. 복잡한 산출물/업무별 검증은 후속 계약 확장 대상이며 자연어 이해 전체를 이 판정기로 대체하지 않는다.

`Evidence`는 업무 범위, tenant, source/lineage, 관측/기록 시각, 자료 등급, 완결성, 원본 참조, 대체/파생 관계를 갖는다. 같은 lineage 반복 인용과 파생 설명은 독립 출처를 늘리지 않는다. 대체는 같은 source/lineage와 시각 관계에 한해 반영한다. 권한/범위 밖 자료는 판정에 포함하지 않는다. 이 metadata가 신뢰할 수 있는지는 P1의 intake와 실제 adapter 인증에서 별도로 집행해야 한다.

`PlanProposal`은 기반 state/goal/plan revision을 함께 보낸다. 현재 계획과 어긋난 제안을 schema 통과만으로 실행하지 않는다. DAG/도구/범위/예산의 의미 검사는 P1의 Plan Validator 책임이다. P0의 타입/형식 시험은 그 의미 검사를 완료했다는 주장이 아니다.

`ToolResult`는 success/partial/error/cancelled, 효과 none/confirmed/unknown, coverage, cursor, 원본/근거 참조를 구분한다. 오류를 관측 부재나 정상 완료로 바꾸지 않는다. 모델 포트도 refusal/truncation/error/usage 누락을 보존하며 공급자 SDK 객체를 코어에 노출하지 않는다.

## 원자적 저장 포트

`StateRepository.commit`의 한 단위는 다음과 같다.

- expectedRevision과 next revision을 비교한 상태 교체.
- 같은 revision의 사건 추가.
- 해당 업무의 응답 outbox 변경.
- commandId와 commandDigest의 처리 영수증.

네 항목은 같은 저장소의 원자적 커밋이다. 기존 commandId에 같은 digest를 보내면 원래 커밋의 결과를 반환하고 사건/메시지를 추가하지 않는다. 다른 digest면 idempotency_conflict다. 그 후 새 변경을 하려면 최신 상태를 다시 읽어야 한다. 오래된 expectedRevision은 conflict이며 덮어쓰지 않는다.

포트에는 SQL/connection/DDL/search_path/ORM이 없다. 저장소 오류·트랜잭션·migration·locking은 바깥 구현 책임이다. 실제 첫 구현은 SQLite이고, 두 번째 영속 adapter로 같은 보장을 비교하는 것은 P2-01에 남는다.

DB 커밋 안에서 모델·도구·파일 업로드·메시지 전송을 하지 않는다. ArtifactStore의 바이트 저장과 state commit은 별도 단계다. P1-02에서 원본 저장 후 DB 실패, 참조 유실, 고아 객체와 재시작을 검증한다. Outbox에 존재하는 것은 전달 의도이며 실제 사람이 메시지를 받았다는 뜻이 아니다.

모든 상태 쓰기의 정책/시도/결과 의미 검사는 application에서 맡고, 저장 구현은 commit의 구조·revision·원자성·중복 방지 보장을 맡는다. 모델과 도구에 저장소의 임의 쓰기 권한을 주지 않는다.

## 측정 기준

| 지표 | 정의 | P0에서 확인한 수준 |
|---|---|---|
| 완료 판정 정확성 | 고정 fixture의 complete/미완료와 필수 사유/근거가 일치 | 4개 시나리오·22개 checkpoint |
| 잘못된 완료 | 기준 누락/반증/권한 밖 자료/대기/불명확 효과가 있는데 complete | 고정 판정 사례에서 검사 |
| 계약 실패 | 잘못된 ID/revision/필드/부분 결과를 수락하는가 | 타입·실행 시 입력 검사 |
| 내구성/동시성 | 강제 종료 후 상태와 wake 의무 복원, CAS 충돌/중복/부분 쓰기 | 실제 로컬 SQLite/별도 프로세스로 시험 |
| 비용/지연 | 모델/도구 호출·토큰·대기·재시도·업무 완료당 비용 | P0는 모델/도구 호출 0, 토큰 자료 없음, fixture 실행 시간만 기록 |

실제 제어 분기·계획/가설 변경·추론 품질·장기 반복 compact·모델 호출 경제성은 해당 후속 작업에서 별도로 증명한다.
