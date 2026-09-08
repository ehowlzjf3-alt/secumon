# C07 게시판·아카이브 순차 검증 결과

2026-09-08 · checkpoint377 · **C07 로컬 선택 인수 고유 261개와 관련 회귀 89개, 합계 350/350을 확인했다.** 기준선은 `69f84d5`다. C07은 기존 215개와 신규 46개이며, 신규는 registry 6, 공유 DB의 owner 출처 2, 호스트 등록 9, archive 16, 독립 담당 board 4, 협업 진전 7, 게시 committed revision 2다. 재실행 수는 고유 수에 더하지 않는다. 서로 다른 빌드의 결과를 합산했으며 전체를 최종 단일 소스에서 다시 실행한 것은 아니다. [인수 계획](C07-ordered-verification-plan.md) · [실행·종료 기록](../../runtime/evidence/checkpoint377.json).

마지막 build7은 exit0, sourceDigest `5a935be65c4bfc584c08a28d11f00721e4852889cbc00605c912b2f630eb92da`다. 같은 빌드의 target11은 **46/46**, target12는 **6/6** 통과해 명시 요청 왕복과 원 revision·기존 영수증 호환을 확인했다. build5의 관련 target8 **89/89**, affected board/등록 target9 **153/153**도 exit0이다. 모든 실행은 종료했으며 [최종 소스·산출물 대조](../../runtime/evidence/checkpoint377-final-source.json)는 2,184파일의 일치를 기록한다. 현재 플랫폼·외부 인수와 전체 goal은 미완료다.

## 확인한 동작과 적용한 교정

공유 저장소에 다른 담당의 업무 행이 있어도 [BoardService](../../runtime/src/application/board-service.ts)는 명시 등록된 그 owner의 원문·입력 증명 검사기를 선택한다. 등록이 없으면 공유 DB의 행으로 대신하지 않는다. tenant·principal·업무 scope와 현재 원출처 검사를 유지하며, 기존 shared-store fixture도 두 owner의 출처를 명시 등록했다. [registry](../../runtime/src/application/board-work-source-registry.ts)의 반복 unregister가 같은 ID의 후속 등록을 지우지 않도록 하고, input/memory/coverage 조회 중 해제된 출처의 늦은 응답을 거절한다. [4건 재현 기록](../../runtime/evidence/C07-registry-baseline.json)은 결함 재현이며 통과 인수로 합산하지 않는다.

[호스트 등록 9개](../../runtime/src/tests/host-collaboration-registration.test.ts)는 기능 off의 일반 CLI 연속 세션, on+미등록 오류, 명시 도구 목록·공급자 능력·쓰기 허가의 분리, actor identity와 공유 scope, 메타데이터/메서드 고정, 해제 중 조회·반복 close·원오류 보존을 확인했다. 기능 off는 provider factory를 열지 않는다. 읽기/쓰기 허용을 기능 flag 하나로 확대하지 않았다.

[archive 서비스](../../runtime/src/tests/archive-service.test.ts)와 [일반 입구](../../runtime/src/tests/archive-entry.test.ts)는 로컬 FileArchiveProvider 및 호스트 공급자 대역을 사용한다. 검색은 본문 없는 카드, 명시 get은 정확한 원문을 반환한다. 등록·정정·삭제는 원 command digest와 revision/출처 버전을 유지한다. 응답 유실 뒤 재열기는 원 receipt로만 효과를 확인하며 mutate를 다시 호출하지 않는다. null/mismatched receipt는 미확정 효과·원 실패·정산 의무를 유지하고 완료나 재실행 허가로 바꾸지 않는다. 조회 결과와 수신자 자료를 Evidence 또는 개인 장기기억으로 자동 복사하지 않는다.

[독립 담당 시험](../../runtime/src/tests/board-deployment-entry.test.ts)은 서로 다른 디렉터리·SQLite 상태 DB·담당 scope를 가진 실제 profile의 **일반 입력·모델/도구 루프**를 사용한다. HTTP 시험은 아니다. 선택 답글과 명시 요청의 수락→답변→요청자 확인을 분리하고, 현재 모델 packet에서 관측한 ID/revision으로 행동한다. 선택 답글, 반대 방향의 명시 요청 왕복, 출처 scope 철회, 반복 읽기 중단 4개 모두 build7 target11에서 통과했다. 응답 도착만으로 요청자의 확인이나 목표 완료를 대신하지 않는다.

build3에서 성공한 archive/board 관측도 진전으로 연결되지 않아 정상 흐름이 멈추는 현상을 재현했다. [native 도구 identity](../../runtime/src/application/collaboration-tool-identity.ts)를 등록 snapshot에도 유지하고, [채택된 진전 계산](../../runtime/src/application/work-progress.ts)에 archive 카드/본문, board 토론/요청 관측 및 실제 적용된 게시 명령의 의미를 연결했다. 이는 네이티브 OS API 검증이라는 뜻이 아니라 본체가 만든 실제 도구 객체의 identity다. 도구 이름·복사된 metadata만으로 credit을 얻지 못한다. Evidence·기억·목표 완료를 추가하지 않으며 **기본 무진전 한도 3을 유지한다.**

[진전 회귀 7개](../../runtime/src/tests/collaboration-progress.test.ts)는 query·순서·시각·task/attempt/result ID·게시물/cause ID·revision만 바꾼 반복을 새 진전으로 세지 않는지 확인한다. unknown/미적용·재사용·거절 결과에는 게시 진전이 없다. 이 단위 fixture는 이미 채택된 결과와 실제 도구 표식을 제공하므로 저장 증명 검증 자체의 대역이며, 실제 archive/board 일반 입구 시험과 구분한다.

마지막으로 [BoardCommands](../../runtime/src/application/board-commands.ts)의 성공 output에 **검증한 원 command의 committed revision**을 추가했다. 현재 board head라고 주장하지 않으며 tool definition·버전은 그대로다. revision이 없던 기존 version1 output도 원 증명과 정확히 일치할 때 계속 검증한다. [추가 2개 회귀](../../runtime/src/tests/board-write-runtime.test.ts)는 이후 board 변경·재열기에도 원 revision 유지, legacy 호환과 잘못된 revision·추가 필드·오염된 output 및 권한 철회 거절을 확인했다. 일반 입구는 이 revision을 다음 expectedRevision에 쓰고, 필요한 요청 상태·본문 조회는 유지한다.

## 빌드·실행별 원증거

아래 짧은 지문은 해당 manifest의 전체 `sourceDigest`를 가리킨다. 과거 소스의 통과를 build7에서 전부 다시 실행한 것으로 합치지 않는다. 빌드 실패 두 건은 해당 시험 실행 전 타입 오류다.

| 빌드와 소스 근거 | 결과·용도 |
|---|---|
| [C06 build6 manifest](../../runtime/evidence/C06-ordered-build6-manifest.json) · `bd6d7965…` | 기존 dist 기준선으로 C07 target1 실행. 새 C07 소스는 아직 포함되지 않음. |
| [C07 build1 원로그](../../runtime/evidence/C07-ordered-build1.log) | exit2. 새 fixture의 GeneratedAnswer artifact 참조·archive mutation union·personalKnowledge factory 사용·ES2022의 Promise.withResolvers 타입 문제. fixture 교정. |
| [build2 manifest](../../runtime/evidence/C07-ordered-build2-manifest.json) · `920fb637…` / [로그](../../runtime/evidence/C07-ordered-build2.log) | exit0. 출처/등록 교정 및 첫 신규 입구 시험. |
| [build3 manifest](../../runtime/evidence/C07-ordered-build3-manifest.json) · `0568b6d7…` / [로그](../../runtime/evidence/C07-ordered-build3.log) | exit0. retained-reader 기대와 authority·개인 기억 조회 fixture 교정 후 시험. |
| [build4 원로그](../../runtime/evidence/C07-ordered-build4.log) | exit2. 새 반복 board-read fixture의 pages 배열 타입 명시 필요. 제품 동작 실패와 구분. |
| [build5 manifest](../../runtime/evidence/C07-ordered-build5-manifest.json) · `5d3f9771…` / [로그](../../runtime/evidence/C07-ordered-build5.log) | exit0. 협업 진전 연결 및 반복 중단 회귀 포함. |
| [build6 manifest](../../runtime/evidence/C07-ordered-build6-manifest.json) · `7dc425af…` / [로그](../../runtime/evidence/C07-ordered-build6.log) | exit0. 제한된 문맥에서 재사용되던 fixture task ID 교정 후 원인 재확인. |
| [build7 manifest](../../runtime/evidence/C07-ordered-build7-manifest.json) · `5a935be6…` / [로그](../../runtime/evidence/C07-ordered-build7.log) | exit0. 원 committed revision 제공·기존 출력 호환·일반 입력 연결 및 추가 회귀 포함. |

| 원 시험 로그 | 빌드 | 실제 판정 및 집계 의미 |
|---|---|---|
| [target1](../../runtime/evidence/C07-ordered-target1.log) | C06 build6 | 기존 215개 중 201통과/14실패, exit1. 다른 owner의 증명 closure에 호출자 reader를 사용하던 연결 실패. |
| [target2](../../runtime/evidence/C07-ordered-target2.log) | C07 build2 | 120개 중 118통과/2실패, exit1. 기존 affected 112개와 registry 6개 통과로 이전 14실패 해결. 새 shared 2개만 retained-reader의 정상 거절을 성공 page로 기대한 fixture 실패. |
| [target3](../../runtime/evidence/C07-ordered-target3.log) | C07 build2 | 26개 중 17통과/9실패, exit1. 등록9·archive 서비스7·null receipt1 통과. archive6은 개인 기억 조회 scope/namespace, board3은 strict source authority fixture 오류를 드러냄. |
| [target4](../../runtime/evidence/C07-ordered-target4.log) | C07 build3 | shared source 2/2, exit0. source 철회 뒤 기존 retained reader의 `board_unavailable` 거절과 원출처 보존을 확인. |
| [target5](../../runtime/evidence/C07-ordered-target5.log) | C07 build3 | archive 입구 7개 중 5통과/2실패, exit1. 성공 search/get 이후 `no_progress_limit`를 실제 재현. |
| [target6](../../runtime/evidence/C07-ordered-target6.log) | C07 build3 | 독립 board 3개 중 1통과/2실패, exit1. 성공 읽기·게시 이후 같은 진전 연결 문제 재현. |
| [target7](../../runtime/evidence/C07-ordered-target7.log) | C07 build5 | archive 입구9·board4·진전7 합계 20개 중 19통과/1실패, exit1. 당시 명시 요청 왕복 실패 보존. |
| [target8](../../runtime/evidence/C07-ordered-target8.log) | C07 build5 | 관련 work/resource/evidence/computer 진전·host provider 등록 7파일, 89/89·exit0. 신규44개에 가산하지 않음. |
| [target9](../../runtime/evidence/C07-ordered-target9.log) | C07 build5 | affected board runtime/write/request/wake·호스트 등록 5파일, 153/153·exit0. |
| [target10](../../runtime/evidence/C07-ordered-target10.log) | C07 build6 | 독립 board 4개 중 3통과/1실패, exit1. task ID 교정 후 publish→revision만 위한 재조회→계획에서 무진전 3회 한도 재현. |
| [target11](../../runtime/evidence/C07-ordered-target11.log) | C07 build7 | 독립 board4+board write42, 46/46·exit0, 전체 시험 83,221.200666ms. 원 revision/legacy 새2 포함. |
| [target12](../../runtime/evidence/C07-ordered-target12.log) | C07 build7 | 기존 request 영수증·응답 유실·복구 선택 6/6·exit0, 6,103.462792ms. 기존 사례 재실행이며 고유 수에 추가하지 않음. |

[코어 타입](../../runtime/evidence/C07-ordered-core1.log)과 [계층 검사](../../runtime/evidence/C07-ordered-architecture1.log)는 exit0, 계층 192개/위반0이다. 이 검사는 각각의 기록 범위이며 모든 최종 플랫폼·기능 시험을 대신하지 않는다.

## 실패의 구분과 다음 상태

첫 shared-source 14실패는 제품의 foreign-owner 선택과 예전 fixture의 명시 source 등록을 함께 교정했다. shared2의 후속 실패는 철회된 retained proof를 가진 reader가 안전하게 거절하는 계약을 fixture가 잘못 기대한 것이었다. archive의 `knowledge_unavailable`은 personal namespace/scope와 profile이 선택하는 owner를 맞췄고, board authority는 strict knowledge actor에 없는 `canManageBoards`를 제거했다. 접근 허용이나 원문 판정을 완화한 수정이 아니다.

그 후 build3의 `no_progress_limit`는 도구가 실제 성공한 뒤 발생한 별도 제품 연결 누락이었다. build5 target7의 남은 1건은 성공한 요청 조회·수락·자료 읽기 뒤 막혔다. 제한된 문맥을 기준으로 task ID를 반복하던 fixture를 먼저 교정했지만, build6 target10에서도 publish 뒤 다음 expectedRevision만 얻기 위한 재조회와 계획이 무진전 3회에 도달했다. 원 committed revision을 결과로 제공하고 fixture가 그 값을 소비하도록 연결한 뒤 build7에서 왕복이 끝났다. 불필요한 revision 전용 조회만 제거했으며, 필요한 본문·요청 상태 조회와 기본 한도 3, 완료·출처·응답 책임 판정은 유지했다. 앞선 실패 원로그는 모두 보존한다.

실제 모델/API·사내 게시판/아카이브 연결 중단을 유지한다. 이번 범위는 macOS/arm64 Node24.20.0의 임시 저장소와 유한 구조화 모델 대역이며, 현재 Linux/native Windows·PostgreSQL 실환경, 브라우저 렌더링, 검색 규모·운영 성능과 외부 공급자 인수는 미완료다. 로컬 파일 공급자의 명령 중복 방지를 의미가 비슷한 사례의 자동 병합으로 확대하지 않는다. C07의 선택한 로컬 실패는 해결했고 다음은 [C08 동료·반론·자원 검증](C08-ordered-verification-preparation.md)이다. 현재 OS·외부 인수와 최종 통합을 포함한 전체 goal은 미완료다.
