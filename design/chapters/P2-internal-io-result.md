# P2-04 학습·결과 — 증분 저장과 내부 조회 비용

2026-09-05 · v0.25 로컬 계약 검증 · 실제 모델/API·사내 서비스 미실행

이 단위는 [전체 도구 효율 계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-efficiency-plan.md)의 마지막 내부 비용 평가와 [상세 계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-internal-io-plan.md)을 따른다. 최종 [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-internal-io-local-verification.json)은 전체 934/934·실패 0, 코어 타입 검사·안쪽 계층 67파일/위반 0·합성 4시나리오/22판정 통과다. 추가 92개는 파일 계측 13, codec 16, checkpoint store 27, resource/context 24, 고정 기준선 비용 비교 12개다. P2-04 로컬 계약은 verified, 전체 작업은 실제 모델 조건이 남아 in_progress다.

## 먼저 이해할 문제

페이지가 늘 때마다 이전 전체 본문을 포함한 checkpoint를 새로 저장하면 같은 자료를 여러 번 저장하고 다시 읽는다. 모델에 보내는 context가 작아도 내부 저장·복원 비용은 커질 수 있다. v0.24는 중단/재개와 원본 검증을 먼저 연결했으며 이번에는 그 보장을 유지한 채 비용을 비교했다.

이제 저장 형식 v2는 작은 변경 기록이고, 외부에 제공하는 논리 ReadCheckpoint는 v1 상태다. 시작 상태를 기록한 뒤 재개·호출 의도·응답 반영·정지 기록이 직전 head를 가리킨다. 원 페이지 본문은 raw artifact에 저장하며, 복원 시 실제 본문과 변경 기록을 대조해 논리 상태 digest를 확인한다. 기존 v1 전체 snapshot도 읽고 v2로 이어갈 수 있다.

## 코드와 동작을 함께 읽기

1. [변경 계약](/Users/seunghanee/Documents/secumon/runtime/src/domain/read-checkpoint-record.ts)과 [codec](/Users/seunghanee/Documents/secumon/runtime/src/application/read-checkpoint-record.ts): 어떤 변경이 합법적인지, 상태의 어느 부분을 이전 기록에서 복원하는지 읽는다. 응답의 raw artifact와 맞지 않으면 복원을 거부한다.
2. [저장·복원](/Users/seunghanee/Documents/secumon/runtime/src/application/read-checkpoint-store.ts): head에서 이전 기록을 따라가고 순서대로 적용한다. record 16MiB, chain 64MiB/10,000개 상한을 두며 논리 상태의 기존 상한도 유지한다. warm cache도 생략된 이전 chain을 상한에 포함한다.
3. [조회 실행](/Users/seunghanee/Documents/secumon/runtime/src/application/read-collections.ts): 외부 읽기 전에 intent를 저장하고, 응답을 받은 뒤 검증된 진행 지점을 게시한다. 저장 형식 변경은 실패·unknown 호출의 예산이나 재개의 소유권을 바꾸지 않는다.
4. [checkpoint 검증](/Users/seunghanee/Documents/secumon/runtime/src/application/read-checkpoints.ts): decoder의 계산 결과와 현재 실행 권한을 별도로 검사한다. 원 dispatch·부모 소유권·현재 목표/정책/도구 계약·기억 출처와 원 페이지 replay 검증을 유지한다.
5. [조회 서비스](/Users/seunghanee/Documents/secumon/runtime/src/application/work-resources.ts)와 [context 구성](/Users/seunghanee/Documents/secumon/runtime/src/application/context-compiler.ts): 한 번 검증한 결과/dispatch/원본 참조를 내부에서 재사용한다. 이 관리 정보는 모델/도구 출력에 넣지 않으며, 저장 대기 뒤 원본과 현재 권한을 다시 검사한다.

## 캐시에 맡기는 것

한 검증 안의 source bytes/JSON/page 파싱을 최대 source bytes 16MiB/10,000개 범위에서 공유한다. 같은 ArtifactStore 인스턴스에는 decoder가 확인한 논리 복원 결과만 최대 64개 head/직렬화 상태와 chain metadata 합계 16MiB로 보관한다. writer가 주장한 상태를 바로 넣지 않는다.

캐시가 있어도 head와 입력 원본을 현재 인덱스/정책으로 읽고 무결성을 확인한다. 새 ArtifactStore를 만들거나 프로세스를 재시작하면 다시 계산하며 결과는 같아야 한다. 원본의 존재/권한이 계속 유효하다는 판단은 저장하지 않는다. 이 용량은 직렬화 자료 기준이며 JavaScript heap 전체의 엄밀한 상한은 아니다.

원본 파일을 한 번만 get하는 개선과 get 대신 exists를 부르는 변화는 다르다. 실제 FileArtifactStore의 exists도 파일을 읽고 hash를 계산한다. [파일 계측](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-artifacts.ts)은 상위 get/exists/put 횟수와 실제 readFile/writeFile의 성공 bytes, hash 입력 bytes를 따로 남긴다. 새 put의 기존 파일 확인 실패도 계수하며, OS 캐시·물리 디스크 접근·모델 과금을 측정한 것으로 해석하지 않는다.

## 동일 조건의 비교

v0.24 빌드/fixture의 430개 hash를 고정하고 [기준선 압축](/Users/seunghanee/Documents/secumon/runtime/evidence/internal-io/v024-baseline.tar.gz)을 재추출해 확인했다. 원 기준선, 같은 FileArtifactStore 계측만 적용한 legacy, 증분 저장의 초기 구현, 논리 캐시 추가 구현, 최종 구현의 결과를 구분해 보존한다.

공개 문서와 합성 관측의 두 업무군 × SQLite/파일 저널 × 4/8/16페이지를 쓴다. 각 항목 본문은 1,536bytes이며 collect → checkpoint 읽기 → 실제 core.calls.get → context 준비 → 닫기/재열기와 context 준비의 비용을 따로 기록한다. source 호출·정규화한 source/result/core state·근거 ID/lineage·관측/기록 시각·보고 usage·복사 표현을 원 기준선과 정확히 비교한다. 저장 형식에 종속적인 head/call ID는 정규화 범위를 명시한다.

처음 비교에서는 문서 16페이지의 본문 읽기가 57,005,439→7,924,514bytes로 줄었지만 반복 복원 때문에 실행 시간은 대부분 증가했다. 논리 계산 재사용을 추가한 이유다. 중간 프로필의 실행 시간은 부하가 겹친 단회 관측이므로 안정적인 속도 향상·CPU 감소·p50/p95로 표시하지 않는다. 최종 값과 한계는 별도 비교 기록을 기준으로 한다.

최종 문서 업무의 다음 값은 두 backend에서 동일했다. 원 계측 legacy→최종 구현 순서이며 단위는 bytes다. 전체 12개 결과와 단계별 계수/경과 시간은 [최종 비교](/Users/seunghanee/Documents/secumon/runtime/evidence/internal-io/final-comparison.json), [실행별 원 계수](/Users/seunghanee/Documents/secumon/runtime/evidence/internal-io/final-metrics.json)에 있다.

| 페이지 수 | 본문 readFile | hash 입력 | 본문 writeFile |
|---|---:|---:|---:|
| 4 | 3,534,401 → 1,447,742 | 3,728,518 → 1,574,203 | 191,380 → 123,724 |
| 8 | 12,847,911 → 3,198,685 | 13,331,825 → 3,424,055 | 479,245 → 220,701 |
| 16 | 57,005,439 → 7,924,514 | 58,439,868 → 8,348,267 | 1,425,896 → 415,220 |

고정 기준선 기대값은 [회귀 fixture](/Users/seunghanee/Documents/secumon/runtime/fixtures/internal-io/legacy-v024.json)에 저장했다. 전체 test는 원 기준선의 의미/근거/시각/usage와 정확한 일치, 동일 계측 legacy보다 작은 읽기/hash/쓰기 총 bytes, 기준선 출처 hash를 검사한다. 경과 시간 임계값은 두지 않는다.

최종 문서 16page 경과 시간은 SQLite 약 1.96초, 파일 저널 약 4.13초였다. 계측 legacy의 약 1.63초/4.42초와 비교하면 SQLite는 이번 관측에서도 느리다. 이전 프로필의 동시 부하와 단회 실행 때문에 이 값을 안정적인 성능 차이로 확정하지 않으며, 파일 bytes 절감과 전체 응답 시간의 개선을 따로 평가한다.

## 검증하며 발견한 경계

- await 중 caller가 head/ref를 바꾸어 다른 ID로 캐시를 저장하거나 재검사하지 못하도록 입력을 고정했다.
- warm cache가 이전 chain의 깊이/bytes를 생략하지 않도록 전체 chain metadata와 순환을 검사했다.
- 원본 재검사 대기 중 다른 reader가 entry를 퇴거시켰다면 무조건 다시 넣지 않는다. 동시 작업 때문에 캐시 bytes 계수가 틀어지는 경계를 시험했다.
- 일반 context source 재사용과 호출 복사 정보 재사용 모두 stage 뒤 실제 원본 재검사 대상에 넣었다. 원본 삭제·변조·현재 권한/계약/기억 변경·재시작을 별도로 시험한다.
- 첫 계수 시험에서 ContextFrame stage readback 1회를 기대에서 빠뜨렸다. 이 읽기는 필요한 검증이므로 유지하고 정확한 계수로 시험을 고쳤다.

로컬 시험은 기존 v1→v2 재개, base/raw 유실·손상, logical digest/출처 불일치, byte/depth/LRU 상한, 데이터/포트/반환값 변경, 실제 두 backend 재시작, 모델 요청의 내부 metadata 제외를 포함한다. 이전 챕터의 실제 자식프로세스 종료와 partial/완료 orphan 재개 회귀도 전체 검증에 유지한다.

## 남는 비용과 다음 학습

원본 재검사와 전체 업무 CAS 인덱스, 누적 참조 목록, cold decode/replay 비용은 남는다. 전체 원본 삭제·보존/백업, 분산 source-to-effect 원자성, 실제 모델의 판단 품질과 MCP/Knox/컴퓨터 유즈 운용 성능은 이 비교가 검증하지 않는다.

P2-04의 로컬 조건과 실제 모델/연동 조건을 따로 기록한다. 다음 독립 로컬 단위는 P2-05의 자동/빠르게/깊게, 예산 보존, 재시도 총기한과 무진전 제어다. 같은 근거의 재사용과 새로운 진전을 어떻게 구분하고, 빠른 경로에서 깊은 경로로 전환해도 이미 사용한 비용이 왜 사라지면 안 되는지 고정 fixture로 공부한다.

질문: 이미 읽은 파일이 지워졌는데 캐시에 계산 결과만 남아 있다면 답변에 계속 사용해도 될까? 이번 구현은 현재 원본 검증에 실패하면 그 파생 결과를 반환하지 않는다. 논리 계산을 기억하는 것과 현재 사용할 수 있다는 판단을 기억하는 것은 다른 책임이다.
