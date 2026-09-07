# P3-04 로컬 Web driver: 계획과 완료 기준

2026-09-06 · v0.38 로컬 검증 완료 · 전체 P0–P6 목표의 한 챕터

## 학습할 개념

기존 합성 driver는 같은 프로세스에서 상태 검사와 입력을 수행한다. 실제 브라우저는 런타임 승인, 브라우저 메시지, DOM 이벤트, 앱 저장이 서로 다른 시점이다. 입력이 전달되었다는 사실과 앱 저장이 확인되었다는 사실을 분리해야 안전하게 이어갈 수 있다.

이번 구현은 renderer 내부에서 typed 명령을 검사하고 DOM fill/click을 수행하는 **계측 Web 앱 전용 adapter**다. 브라우저와 HTML 폼은 실제로 실행한다. DOM 이벤트는 프로그램이 발생시키므로 native OS input 검증으로 세지 않는다. 일반 사내 사이트에 동일 보장이 있다고 가정하지 않는다.

## 구현 순서

1. 기존 ComputerDriver 계약에 remote DOM 보장 범위를 명시하고 해당 보장을 도구 계약에 고정한다.
2. Node/TypeScript localhost fixture에 Query/Search/Note/Save 폼, DOM 관찰, epoch/ref/focus 변경, 저장 receipt를 구현한다.
3. 제한된 typed 명령만 전달하는 Web driver와 Playwright 연결 adapter를 작성한다. 모델에게 JavaScript나 임의 URL 권한을 노출하지 않는다. core와 저장소 계약은 유지한다.
4. 실제 브라우저로 정상 작업, stale view, focus/rerender, 전송 후 불확실성 및 재조회/이어가기를 확인한다.
5. 같은 목표를 합성과 Web에서, 개별 호출과 batch로 비교한다. 모델 호출·도구 호출·내부 메시지·입력·저장 횟수를 구분하고 속도는 관측치로만 기록한다.
6. 사람용 화면을 desktop/mobile에서 확인하고 전체 기본 검증 및 원본/기록 보존 검사를 수행한다.

## 완료 기준

- 실제 HTML 폼에서 note=reviewed 저장과 fresh observation 기반 목표 판정을 확인한다.
- SQLite와 file-journal에서 동일 ComputerDriver/application 경로를 사용한다.
- DOM 입력0이 증명되지 않는 전송 후 실패를 not_applied로 바꾸지 않는다. 앱 receipt는 mutation과 함께 영속화하며 누락 receipt는 unknown이다.
- renderer에서 lease/epoch/surface/ref/revision/focus/unique target/deadline을 검사한 뒤 같은 동기 구간에서 DOM 입력을 수행한다. host 승인 이후 RPC 사이의 분산 경계는 남는 한계로 기록한다.
- 재접속 시 epoch가 바뀌며 과거 lease가 입력에 재사용되지 않는다. 조회는 입력을 반복하지 않는다.
- 취소/응답 유실은 진행 중 명령을 확실히 되돌렸다고 주장하지 않는다.
- localhost 전용 서버와 소유한 테스트 브라우저를 종료한다. 실제 모델/API 실험 취소, 원본1,973파일 보존, 운영 서비스 미접속을 유지한다.

## 근거와 구현 선택

설치된 Playwright1.62.1을 주입하여 시험한다. core 의존성을 늘리지 않고 runtime 인프라의 좁은 page transport에 연결한다. 패키지가 없는 환경은 실제 browser 시험을 명시적으로 미실행 처리하며 일반 core 시험과 구분한다.

- [Playwright page.evaluate](https://playwright.dev/docs/api/class-page#page-evaluate): 브라우저 실행 문맥에 명령 전달.
- [MDN Event.isTrusted](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted), [HTMLElement.click](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/click): DOM 자동화와 사용자/native 입력의 구분.
- [fixture 검토](../../runtime/evidence/P3-local-web-driver-fixture-review.md)
- [기존 결과](P3-continuation-runner-result.md)

## 남는 범위

OS/native 입력, 비계측 사내 앱과 배포 브라우저 선택, 실제 내부 데이터/모델/Knox 연결은 이번 성공만으로 완료 처리하지 않는다. 전체 목표와 P3-04는 이 챕터 후에도 남은 완료 기준으로 판단한다.

완료 결과: [학습·구현·검증 기록](P3-local-web-driver-result.md). 전체 P0–P6 목표와 P3-04의 운영/선택환경 조건은 계속 진행 중이다.
