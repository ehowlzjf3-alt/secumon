# C05 개인 기억 원문 조회 재사용 결과

2026-09-08 · checkpoint375. [계획](C05-source-read-reuse-plan.md)의 후보1을 구현하고 로컬 검증했다. 같은 원문 검사 안에서 입력 기록과 업무의 중복 조회를 제거했다. 호출 간 성공 캐시, 검증 생략 옵션, SQLite 전용 코어 의존성은 추가하지 않았다.

`session-original-validation.ts`의 순수 함수는 사용자 이력과 입력 기록의 본문·payload·종류·업무·순번·라벨·digest를 대조하고 출처 정책·공개 허용을 검사한다. 일반 대화/compact 조회는 자기 자료 조회와 pending·artifact 검사를 유지한다. 개인 기억은 최초 입력/업무를 이력 대조에 재사용하고, 끝에서 업무 정책·원문 세대·적용 세션과 **전체 입력 기록을 다시 조회·비교**한다. 서로 다른 업무의 목표·근거·실행 기록을 합치지 않는다.

## 변경 전후 관측

동일한 [계측 스크립트](../../runtime/evidence/C05-source-read-comparison-probe.mjs)로, 각각 새 임시 담당·원문105 UTF-8 바이트·개인 기억1건을 만들고 `KnowledgeService.get` 한 번만 관측했다. 각 실행 전후 source/build 지문과 스크립트 지문이 같음을 확인했다. setup과 결과 확인용 추가 조회는 별도 구간이다.

| 포트 | 변경 전 호출 / 반환 JSON 바이트 | 변경 후 호출 / 반환 JSON 바이트 |
| --- | --- | --- |
| 업무 `state.get` | 12 / 28,404 | 8 / 18,936 |
| 입력 `session.input` | 12 / 16,824 | 8 / 11,216 |
| 원문 이력 `session.history` | 4 / 1,468 | 4 / 1,468 |
| 기억 `knowledge.get` | 4 / 5,656 | 4 / 5,656 |

원문 검사는 전후4회이며 각 검사에서 최초·마지막 입력/업무 조회와 이력1회가 유지됐다. 기억 본문 hash·revision·반환 크기·담당 일치 확인 등 **기록한 결과 요약**이 같았다. 매 실행의 담당/세션 ID·시각은 다르므로 전체 반환 객체가 바이트 단위로 같다는 주장은 아니다. 원문 보존과 모델/도구 호출·사용량0, 임시 자료 정리도 확인했다.

[변경 전](../../runtime/evidence/C05-source-read-before2.json) · [변경 후](../../runtime/evidence/C05-source-read-after2.json) · [비교](../../runtime/evidence/C05-source-read-comparison2.json). 업무와 입력 포트의 호출/반환량은 각각1/3 줄었다. 이는 논리 포트 응답 크기이며 중첩 자료가 포함된다. 물리 디스크 I/O·처리시간·모델 토큰·전체 문맥 조립 비용의 절감률로 확대하지 않는다.

## 확인한 경계

[target11](../../runtime/evidence/C05-ordered-target11.log)은 신규7개와 관련 기존5파일55개, 합계 **62/62 통과**다. SQLite/파일 업무 저장소의 독립 `capture/current`, history 반환 뒤 입력 전체/권한·disclosure·원문 세대·적용 입력 변경/소실, 같은/다른 페이지의 중복과 누락, 다른 정상 발언으로 대체를 거절했다. 이 경합 시험은 실제 저장 원문을 읽은 뒤 포트 응답에 변경을 주입한 결정적 시험으로 실제 다중 DB의 원자 snapshot 증거는 아니다.

기존 개인 기억 등록·정정·잊기·권한/담당 분리, SQLite/문서 기억의 실제 문맥·frame·재접속, 늦은 모델 응답의 정산/채택 거절, 일반 대화/compact의 원문 tamper·정책 철회·artifact 소실 검사를 재사용했다. 실제 모델 호출 없이 준비한 응답으로 실행 연결을 확인했다.

build6 exit0, sourceDigest `3c39b6c0150c38ca48480d62e5d46f2a992d2cef9d101e17e4f01b09b2f2ebd9`, macOS arm64·Node v24.20.0이다. 코어 타입 검사와 구조190개/위반0도 통과했다. [전체 실행 기록](../../runtime/evidence/checkpoint375.json). 실제 모델/API 중단은 유지한다.

후보2의 여러 선택 기억을 묶어 안정화하는 변경은 이번에 채택하지 않았다. 먼저 완료한 이 개선을 유지한 채 C06~C10의 사용자 흐름 검증을 진행한다. 추가 비용 개선이 필요하면 전체 문맥 준비와 문서 저장소 구간을 별도 계측한 후 결정한다. 현재 Linux/native Windows·실제 연동·최종 통합과 전체 goal은 미완료다.
