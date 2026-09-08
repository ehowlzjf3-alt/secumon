# C08 동료·반론·자원 인수 결과

2026-09-08 · checkpoint378 · 첫 로컬 인수 단위 완료. [계획](C08-ordered-verification-plan.md) · [실행 기록](../../runtime/evidence/checkpoint378.json). 이번 단위 시작의 게시 기준선은 `c6a5225`이며 C08의 잔여 인수와 C01~C10 전체 goal은 미완료다. 선택 고유199개(기존152+신규47)와 관련 공통 회귀47개, 합계 고유246개를 각 실행 소스에서 확인했다.

동료 상담은 수신 담당의 자체 자원으로 수행한다. 별도 담당에게 작업 자원을 명시 배정하는 경로는 후원자와 수신자 원장을 따로 사용한다. 어느 경로도 고정 리드–워커 관계나 게시판 사용을 강제하지 않는다.

## 확인한 동작과 교정

- 원장 주소: tenant/principal/scope와 요청한 workId를 모두 확인한다. 같은 담당의 다른 작업을 반환하는 저장소 대역을 거절하지 않던 문제를 고정 dist에서 재현해 get·receipt·commit 결과를 교정했다. 분리된 실제 SQLite 원장 인수와 이 경계 대역 시험을 구분한다.
- 동료 세션: 최초 세션을 이미 존재하는 번호로 열려던 경로를 저장소의 담당/대화 경로별 생성·재개로 바꾸었다. 발신 담당뿐 아니라 tenant/principal도 대화 경로에 포함하고 실제 sessionId를 ticket에 남긴다. ticket을 읽을 때 수신자·내부 대화 경로·원 작업·세션이 일치해야 한다.
- 동료 응답: 완전히 수신한 응답의 도구 결과는 공통 계약에 맞게 `coverage: complete`다. 응답 내용은 여전히 `peer_assessment_not_independent_evidence`이며 독립 근거 목록은 빈 배열이다. 교환 완료와 사실 검증·목표 완료는 다르다. 이전 구현 문서의 `success + coverage: unknown` 표현은 이 교정으로 대체된다.
- 자원 도구 스키마: Zod의 복수 scalar type 배열을 같은 허용 값의 anyOf로 표현하고 입력 기본값을 입력 계약으로 노출했다. 엄격한 검증기 설정과 자원·문맥 한도는 바꾸지 않았다.
- 일반 동료 입구: 독립 SQLite 담당의 A→B/B→A, 동일 발신자 연속 문맥과 다른 사용자 분리, 임시·검토 요청별 세션, 구조화 반론 뒤 호출자의 자체 판별 근거와 재평가, compact/reopen 뒤 원 ticket·예산 재사용을 확인했다. peer/local 전달은 같은 전달 ID를 다른 세션·담당으로 변조해도 원 기록을 바꾸지 못한다.
- 자원 준비 진전: 실제 등록 대상, 현재 원장에 일치하는 배정·요청·정산 변화를 native 도구의 채택된 관측에서만 인정한다. 같은 내용의 task/grant/work/요청 ID·revision 변경, 반복 조회와 호출자 자체 비용 증가는 진전을 만들지 않는다. 기본 무진전 한도3을 유지한다.
- 제한 재시도: run의 호스트 실행 승인 거절만 재시도 가능한 오류다. 원 계획에 maxAttempts 2로 선언한 같은 task를 사용해, 승인 뒤 새 planner 호출 없이 같은 grant로 이어졌다. 모든 시도에서 승인과 실행 권한을 다시 확인하며 계속 거절되면 두 시도 뒤 기본 한도에서 멈춘다. 실패 영수증·원 예산·미사용 배정은 보존하고 resume는 진전 카운터를 지우지 않는다.
- 분리 원장: 실제 담당별 SQLite에서 정상 배정·실행·중복 정산, 추가 요청의 숫자 공개와 명시 증액, 응답 유실로 모르는 사용량의 회수·재개 후 보류, 원래 하드 한도 초과 시 미실행을 확인했다. 수신자 원문·자유문장 요청 사유·개인 기억은 후원자로 자동 복사하지 않는다.

## 실행별 증거

현재 macOS arm64·Node v24.20.0의 선택 로컬 시험이다. 모델 전송은 결정적 대역이며 실제 API나 사내 연결을 사용하지 않았다. 아래 서로 다른 소스에서 확인한 통과를 최종 한 소스의 전체 재실행으로 합치지 않는다.

| 범위 | 결과 | 실행 소스와 원로그 |
| --- | --- | --- |
| 기존 자원 계산·runtime·실제 로컬 자식 프로세스 중단 | 152/152 | C07 build7 · [target1](../../runtime/evidence/C08-ordered-target1.log) |
| 명시 원장 경계 신규 | 14/14 | C08 build2 · [target2](../../runtime/evidence/C08-ordered-target2.log) |
| peer 서비스·호스트 등록 신규 | 16/16 | C08 build3 · [target3](../../runtime/evidence/C08-ordered-target3.log) |
| 독립 담당 동료·반론·재개·내부 전달 신규 | 5/5 | C08 build3 · [target3](../../runtime/evidence/C08-ordered-target3.log) |
| 분리 원장 모델 자원 도구 입구 신규 | 6/6 | C08 build5 · [target5](../../runtime/evidence/C08-ordered-target5.log) |
| 자원 준비 진전 신규 | 6/6 | C08 build5 · 같은 target5, build4 통과와 중복 합산하지 않음 |
| 관련 공통 진전 회귀 | 47/47 | C08 build4 · [target4](../../runtime/evidence/C08-ordered-target4.log) |

build1은 새 시험 코드 타입 오류 4곳으로 실패했고 build2에서 교정했다. target2는 39개 중 22개 통과·17개 실패였다. 잘못 만든 첫 원장 진단의 strict owner 입력 오류도 원로그를 보존하고, 수정한 두 번째 진단에서 실제 잘못된 workId 수용을 구분했다. target3은 26개 중 21개 통과·자원 입구 5개 실패다. 도구 스키마와 결과 계약 진단의 실행 버전·우회 없는 오류를 [체크포인트](../../runtime/evidence/checkpoint378.json)에 연결했다.

target4는 58개 중 56개 통과·2개 실패였다. 승인 재개를 새 계획 호출 대신 선언한 기존 task의 제한 재시도로 교정했고, 하드 한도 시험은 예외를 기대하던 단언을 실제 `blocked` 반환과 최신 원장의 미실행 확인으로 맞췄다. run이 이미 반환한 정산 결과를 뒤이어 모델에게 중복 재조회시키는 fixture 단계는 없애고 native API의 중복 정산 불변으로 따로 확인했다. 수정 후 target5의 12개가 모두 통과했다.

최종 build5는 exit0, sourceDigest `71297c2791e56723c18dcee539e79d9ccfa239df8d7db0bf9bda75f26a176feb`이며 [소스·산출물 대조](../../runtime/evidence/checkpoint378-final-source.json) 2,217파일이 일치한다. 코어 타입 검사와 구조 검사193개/위반0은 build4 소스에서 통과했다. 이후 변경은 budget run의 오류 분류와 입구 fixture이며 새 계층 의존을 추가하지 않았다. 별도 읽기 검토에서도 자원 진전과 기존 협업 분기의 구체 결함을 발견하지 못했다. 활성 빌드·시험은 없다.

## 아직 남은 범위

C08의 추가 로컬 인수에는 분리 DB의 명시 return→재배정, 활성 grant를 가진 compact/reopen, 수신 접수 뒤 발신 ticket 저장 전 중단·복구가 남는다. 같은 DB의 기존 장애 시험 152개를 이 분리 DB 인수 대신 사용하지 않는다. 내부 전달 시험은 기존 전달 ID의 변조와 다른 담당 저장소로의 거절을 확인하며, 신뢰된 호스트가 새 ID까지 재발급하는 모든 오용을 검증한 것은 아니다.

이후 C09·C10과 C05 정책 재허용 전체 재개, C06 브라우저·기억 HTTP 지연, 현재 Linux/native Windows·PostgreSQL·최종 통합을 이어간다. 실제 모델/API 시험 중단은 유지한다. 사내 MCP/Knox·외부 peer/A2A·운영 설치와 모델 반론 품질은 로컬 대역으로 완료 처리하지 않는다.
