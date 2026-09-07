# P2-05 고정 전체 실행 평가: 구현과 학습

2026-09-06 · v0.28 · P2-05 로컬 전체 실행 평가 검증

[평가 계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-evaluation-plan.md)에 따라 새 실행·저장 상태 재개·기록 재생을 별도 경로로 만들었다. 최종 전체 1,278개 시험과 고정 192개 새 실행·192개 기록 재생이 통과했다. P2-05 로컬 계약을 검증했고 실제 모델 조건이 남은 전체 작업은 in_progress다. 아래 중간 실패도 보존하며 전체 P0–P6 목표와 실제 모델 시험 중단을 유지한다.

## 무엇을 비교하는가

문서 비교와 관측 검토의 두 업무군을 SQLite·파일 저널, auto·fast·deep 모드로 실행한다. 단순/복잡 조사·늦은 반증·부분 결과·원본 결손·권한 철회·도구/모델 오류·다음 날 회신·모드 변경·실행 중 취소·저장 모델/도구 응답 재개·compact·전달 불명·상태 조회의 16개 변형을 사용한다. 전체는 16×2×2×3=192개 실행이며, 각 실행의 기록 재생을 추가한다.

일반 코어가 문서/보안 관측별로 분기하지 않는다. 업무별 고정 스크립트와 독립 정답 조건은 평가 adapter에 둔다. 기존 네 fixture의 원자료를 재사용했다. 부분 결과/원본 결손/오류에서 기대하는 안전한 중단은 계약 준수이며, 답을 완료한 성공과는 별도로 센다.

## 실행·재개·재생의 차이

- 새 실행은 새 work에서 실제 workflow·planner·도구·저장·전달 경로를 수행한다. 모델은 고정 응답을 내는 scripted adapter이며 실제 LLM 추론이 아니다.
- 실행 재개는 `received` 상태의 모델/도구 응답을 저장한 뒤 저장소를 닫고 다시 열어 채택한다. 저장된 응답을 받기 위해 재호출하지 않는다. 이후 필요한 새 호출은 정상적으로 기록한다. compact 사례의 auto/deep에서는 재개한 뒤 추가 모델 평가가 실제로 이어진다. fast가 범위 제한에서 멈춘 경우 해당 후속 구간을 검증했다고 주장하지 않는다.
- 기록 재생은 모든 커밋 revision의 command receipt와 평가 관측, 원본 artifact, 현재 상태·전달 projection·재개 패킷을 읽어 판정을 대조한다. workflow를 실행하지 않는다. 저장 commit/put에는 호출 시 실패하는 계수기를 두며 model/tool/sink 실행 capability는 제공하지 않는다. 기존 adapter 생성자의 DB metadata 접근까지 디스크 쓰기 0이라고 주장하지 않는다.

현재 이벤트만으로 모든 상태를 재구성하는 범용 reducer는 없다. 기록 재생은 저장된 영수증 snapshot을 검증하는 방식이다. 입력·완료 oracle·코드·환경·설정 pin이 다르거나 자료가 삭제/손상/권한 철회된 경우 재생 불가로 반환한다. 로컬 hash는 일관성 근거이며 외부 서명이나 독립 보관 증명이 아니다.

## 독립적인 판정과 비용

실행 전에 필요한 원본 ID·source/lineage·관측 시각·사실·최종 가설·완료 허용 시각을 고정한다. 실행기의 완료 함수가 true인지만 보지 않는다. 모든 중간 completed 상태와 처음 전달된 결과까지 검사한다. 완료 가능 업무 수, 전체 업무 수, 실제 완료 수, 계약 준수 수를 분리한다.

접수 지연, 내부 첫 검증 근거, 첫 유용한 전달 답변, 검증 완료를 별도로 측정한다. 질문·접수 문구·내부 근거는 유용한 최종 답변으로 세지 않는다. 답변이 없으면 지연은 null이다. 가상 시계의 고정 지연과 실제 로컬 파일 I/O를 포함한 wall time을 구분하고 p50/p95에 표본 수를 붙인다. 다음 날 회신의 가상 대기 시간을 모델의 처리 시간으로 해석하지 않는다.

도구의 논리 예산 차감은 dispatch 커밋으로 계산한다. 그 뒤 adapter가 호출되기 전에 막혀도 이미 차감한 논리 사용량과 실제 진입 수는 다를 수 있다. dispatch 전에 권한 철회로 막힌 예약은 사용한 호출이 아니다. 모델이 보고한 토큰, 추정 context 토큰, 실제 외부 과금도 서로 다르다.

## 첫 관측에서 배운 점

첫 build는 resolve 명령의 reason 누락과 기본 숫자 인자의 literal 타입 추론으로 실패했다. 수정 후 첫 평가/재생 시험 60개와 단순 업무 12개가 통과했다. 첫 전체 관측에서는 192개 중 180개 계약 준수, 완료 80/192·완료 가능 업무 기준 80/102, 잘못된 완료 0, 실행 오류 0, 기록 재생 192/192였다. 12개 실패는 평가기가 dispatch 전 차단을 사용한 도구 호출로 세던 오류였다. 이 중간 기록을 보존하고 수정된 평가기를 다시 실행했다. 최종 결과는 아래에 기록했다.

정정본의 접근 권한을 잃거나 철회했다고 옛 자료를 다시 최신 근거로 부활시키지 않는다. 현재 원본이 꼭 필요한 평가라면 그 원본을 명시적으로 요구해 결손·부분 상태를 확인한다. 일반적인 완료 정책을 평가기 기대에 맞춰 바꾸지 않았다. [독립 검토](/Users/seunghanee/Documents/secumon/design/chapters/P2-evaluation-review.md)에 관측과 미결정 정책을 구분해 기록했다.

## 코드 따라 읽기

| 역할 | 파일 |
| --- | --- |
| 평가 사례·관측·pin·재생 결과 계약 | [execution-evaluation.ts](/Users/seunghanee/Documents/secumon/runtime/src/domain/execution-evaluation.ts) |
| 독립 완료 판정·비용/지연 집계 | [execution-evaluation.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-evaluation.ts) |
| 쓰기 없는 영수증·원본 재생 | [evaluation-replay.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/evaluation-replay.ts) |
| 고정 업무·가설·응답 스크립트 | [evaluation-cases.ts](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/evaluation-cases.ts) |
| 실제 workflow 관측과 저장/재개 | [local-evaluation.ts](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/local-evaluation.ts) |
| 평가/재생 명령 | [evaluate.ts](/Users/seunghanee/Documents/secumon/runtime/src/presentation/evaluate.ts) |

함께 볼 질문은 “실행이 안전하게 멈춘 것과 답을 완성한 것은 어떻게 다른가?”, “저장 응답을 재사용하면서 어떤 후속 호출은 새로 필요한가?”, “평가기 자체가 틀리지 않았는지는 무엇으로 확인하는가?”이다. 고정 oracle, 모든 커밋 관측, 별도의 실패 시험이 각각의 답을 구체화한다.


## 최종 비교와 검증

고정 Node 24.20.0의 `npm run verify`는 exit 0, **1,278/1,278·실패 0**이다. 코어 별도 타입 검사·안쪽 계층 80파일/위반 0·합성 4시나리오/22판정도 통과했다. 새 시험 110개는 독립 평가 32·재생 32·전체 workflow 통합 39·빌드 대응 7개다. 별도 lint 명령은 구성되어 있지 않다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-evaluation-local-verification.json)과 [전체 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-evaluation-verify.log)에 명령·hash·중간 실패를 저장했다.

최종 평가에서는 source와 dist hash가 실행 전후 같았다. 192개 계약 판정과 192개 기록 재생이 모두 통과했고, 잘못된 완료와 실행 오류는 0개다. 모드별 표의 모드는 최초 요청값이며 실행 중 명시적인 모드 변경 사례도 포함한다.

| 최초 모드 | 계약 준수 | 전체 업무 완료 | 완료 가능 업무 중 완료 | scripted 모델 진입 | 도구 구현 진입 |
| --- | --- | --- | --- | --- | --- |
| auto | 64/64 | 30/64 | 30/34 | 120 | 70 |
| fast | 64/64 | 20/64 | 20/34 | 76 | 40 |
| deep | 64/64 | 30/64 | 30/34 | 120 | 70 |

전체 완료는 80/192, 완료 가능 업무 기준은 80/102다. 취소·원본 결손 등 90개는 완료 가능 분모에서 제외하되 전체 분모에 남긴다. 빠른 모드의 복잡 요청 제한과 전달 결과 불명은 계약을 지켜도 업무 완료로 세지 않는다. 단순 업무는 세 모드 모두 모델 1회·도구 1회로 끝났다. 이 결과는 고정 scripted 응답의 코어 평가이며 실제 모델의 추론 품질이나 운영 성공률이 아니다.

최종 합성 사용량은 [비교 JSON](/Users/seunghanee/Documents/secumon/runtime/evidence/evaluation-final/report.json)의 overall/byMode/byVariant와 개별 cohort에서 볼 수 있다. 동일한 기준의 한 번 관측이며 실행 순서는 고정되어 있다. 각 case의 상태 저장소/채널은 새 디렉터리지만 OS cache·장비 부하를 통제한 성능 벤치마크는 아니다. 상태 저장 backend 두 가지 모두 로컬 채널은 SQLite다.

빌드 hash만 새 소스로 붙이는 오류를 막기 위해 src–dist 출력 전체 대응, 현재 hash, 평가 입장 시 source digest 재검사를 추가했다. 취소 후 모델 응답이 늦게 저장되는 경계에서는 pending 정산을 기다린 뒤 최종 checkpoint를 고정한다. 첫 전체 1,276개 통과 이후 실행에서는 1,277개가 통과하고 1개가 이 평가 기록 경계에서 실패했다. fixture가 늦은 응답 순서를 매번 강제하도록 수정한 뒤 관련 46/46 및 최종 전체 1,278/1,278을 통과했다.

원본 1,973파일·dependency lock·이전 예산 검증 JSON/로그를 보존했고 현재 소스 194개 hash를 기록했다. Git 저장소를 만들지 않았다. 다음 로컬 단위는 **P2-06 정보 경계 대안과 공개 정책**이다. 실제 모델 품질/API 적합성, 실제 MCP/Knox/컴퓨터 유즈 연동은 미검증으로 유지한다.
