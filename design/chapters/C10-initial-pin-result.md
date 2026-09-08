# C10 설치형 신규 담당의 자동 최초 pin 결과

2026-09-08 · checkpoint387. 검증된 설치 엔진에서 새 담당을 만들 때 그 엔진을 자동으로 고정하고, 초기화 도중 중단되면 원 선택으로 이어가도록 연결했다. 실제 모델/API 시험 중단을 유지한다. npm/개발 패키지의 release 준비와 전체 C10/goal은 미완료다.

## 바뀐 동작

설치 release를 실행하는 `init`, 새 담당의 `open`, 일반 담당 초기화를 거치는 `chat`/`work`는 별도 수동 pin 없이 첫 엔진을 기록한다. `release.json`을 실제 파일 지문과 대조하고 호스트 등록표를 확보한 뒤 초기화 operation에 담당 ID·저장 선택·첫 pin 원문을 고정한다. 첫 pin과 그 지문을 연결한 완료 영수증이 모두 있어야 준비 완료가 된다. DB 열기와 모델 실행은 그 뒤의 별도 단계다.

`operation`은 초기화 진행의 원 기록, `receipt`는 준비 완료를 나타내는 영수증, `pin`은 사용할 설치 경로와 내용 지문을 지정하는 기록이다. 새 operation/receipt는 schema 3를 사용하며 config·대화·기억 형식과 별개다. release에는 setup 지원 형식을 따로 선언하고 일반 실행과 lifecycle check/pin/update에서 검사한다. 과거 manifest의 선언 누락을 schema 3 지원으로 해석하지 않는다.

기존 무핀 담당·과거 초기화 repair·clone·restore는 새 담당으로 재분류하지 않는다. 설치 release가 없는 개발/npm 경로도 이번 단위에서는 기존 동작을 유지한다. 이후 정상 업데이트는 첫 증명을 보존하고 최신 pin을 실행에 사용한다.

## 원 선택을 유지하는 복구

operation, 첫 pin, 완료 영수증 게시 경계에서 프로세스가 종료돼도 새 담당 ID나 첫 pin timestamp를 만들지 않는다. 첫 pin 게시 전의 정확한 임시 파일과 게시 직후 남은 동일 객체의 임시 링크만 원 operation과 대조해 허용한다. 다른 내용이나 외부 파일 연결은 거절하고 원 후보를 임의로 삭제하지 않는다.

일반 CLI의 엔진 선택기는 복구 가능한 schema 3 초기화의 operation을 읽어 첫 선택을 찾는다. 게시된 pin이 있으면 그 기록을 우선한다. 등록·설치 객체·실제 파일·설정 형식과 원 operation을 다시 검사한 뒤 선택 엔진에서 초기화를 이어간다. 설치가 바뀌었거나 원 증명이 소실됐다면 다른 엔진을 임의로 선택하지 않는다.

완료 영수증만 없으면 첫 pin 게시 직후 중단된 경우와 구별할 수 없으므로 원 operation·첫 pin에 맞는 같은 영수증을 게시한다. 반면 완료 영수증이 있는데 첫 pin이나 operation이 없거나, setup 증명 둘이 모두 사라지고 pin만 남은 경우에는 복구 오류로 멈춘다. 남은 자료로 과거 형식의 새 초기화를 만들지 않는다.

## 확인한 범위

같은 최종 build2에서 **신규 20개·관련 79개, 합계 99개**가 통과했다. 실패·취소·건너뜀은 모두 0이다. 신규 묶음의 20개는 최상위 18개와 동시 호출 하위 사례 2개를 포함하는 Node 집계다. [체크포인트](../../runtime/evidence/checkpoint387.json)에 실행별 결과를 저장했다.

| 실행 | 통과 | 원 로그 |
| --- | ---: | --- |
| 최초 선택·중단 복구·호환 | 20 | [target2](../../runtime/evidence/C10-initial-target2.log) |
| 기존 담당·clone·등록·저장 개설 | 64 | [profiles](../../runtime/evidence/C10-initial-regression-profiles.log) |
| 설치 전환·업데이트·확장 호환 | 15 | [engines](../../runtime/evidence/C10-initial-regression-engines.log) |

- 작은 검증 release의 신규 선택·중복 초기화, 과거 무핀/clone 보존, 첫 기록 소실·변조 거절을 확인했다.
- 실제 자식 프로세스를 operation/첫 pin/영수증 게시 직후와 첫 pin 게시 직전에 `SIGKILL`로 종료한 뒤 원 ID·원문·파일 객체를 유지해 재개했다. 같은 엔진과 서로 다른 엔진의 동시 최초 호출도 실제 두 프로세스로 확인했다.
- 정상 bundler/installer로 만든 한 전체 설치본에서 실제 CLI init→open→합성 모델의 자료 읽기→중복 요청을 실행했다. 같은 설치본과 격리한 등록표로 별도 담당 두 개를 첫 pin 게시 전·후에 종료하고 실제 CLI `open`으로 복구했다.
- 이 일반 읽기 예제는 합성 모델 2회·도구 1회이며 같은 요청을 다시 보내도 호출이 늘지 않았다. 실제 모델의 추론 품질을 평가한 결과가 아니다.
- 기존 schema/clone 복구, SQLite/file-journal의 실제 저장 개설 중단·동시성, 호스트 엔진 등록 경계를 재사용해 회귀를 확인했다.
- 실제 전체 설치 A/B를 사용한 고정 CLI 전달·compact 세션 전환·원 업무 재개와 두 저장 방식의 백업/업데이트/되돌리기를 확인했다. 처음 수동 pin을 가정하던 기존 시험은 자동 첫 pin을 조회하도록 바꿨다. 명시적 과거 무핀 담당의 첫 pin 호환 검사는 별도 legacy 초기화로 유지했다.

현재 실행 환경은 macOS arm64, Node v24.20.0이다. 코어 타입 검사 exit0, 계층 199개/위반0을 확인했다. 최종 빌드와 소스 2,403파일 대조가 일치했으며 지문은 `45cea2366d064e2c3ed9c1938e65a4596ff97945f5aaa876e96d1aa0b9059f6b`이다. [소스 대조](../../runtime/evidence/checkpoint387-final-source.json).

build1의 초기 16개 통과 뒤, setup 증명 소실 거절과 공개 CLI의 미완료 초기화 선택을 보완하고 build2에서 신규 20개를 다시 실행했다. build1을 최종 소스 시험으로 합산하지 않는다. 공개 CLI 복구 시험은 같은 전체 설치본을 재사용했다.

## 남은 작업

[다음 계획](C10-initial-pin-plan.md)의 npm/개발 경로에서 로컬 package를 호스트 소유의 검증 가능한 release로 준비하고 그 설치본을 실제 실행하는 연결이 다음 단위다. package 원본을 수정하지 않고 기존 bundle/install/register 및 고정 CLI 전달을 재사용한다. 첫 pin만 복사본으로 기록하고 실제 실행은 개발본에 남기는 방식은 사용하지 않는다.

새 schema 3 초기화와 clone의 직접 동시 경쟁, 미완료 초기 선택을 다른 설치 CLI가 받아 실행하는 별도 인수, 현재 Linux/native Windows 실행은 추가 확인 범위다. 이번 공개 CLI 중단 복구는 선택된 설치 자체에서 실행했다. 설정의 PostgreSQL 선택 보존·지원 형식 검사와 실제 PostgreSQL 연결을 구분한다.

저장 schema 이행·미확정 외부 효과, C09 취소/목표변경/일시정지와 저널·이력 비용, C05 권한 재허용 후 완주, C06 기억 HTTP/권한/브라우저, 실제 PostgreSQL·사내 MCP/Knox/외부 A2A·운영 배포·최종 통합은 계속 남는다. 이번 단위에서 이 외부 연결이나 패키지 registry 게시를 실행하지 않았다.

[사용법](C10-initial-pin-usage.md) · [현재 다음 작업](../NEXT-STEPS.md)
