# 담당별 엔진 선택과 확장 호환 사용법

2026-09-08 · 구현 사용법. 엔진 선택·확장 호환은 checkpoint385, 고정 CLI 전달·compact 세션 전환은 [checkpoint386 결과](C10-launch-envelope-result.md)를 따른다. checkpoint387의 설치형 자동 최초 pin은 [현재 사용법](C10-initial-pin-usage.md)과 그 검증 상태를 별도로 확인한다.

## 같은 전역 명령으로 다른 버전 사용

`secumon-agent`의 전역 명령 경로는 그대로다. 일반 `open`, `init`, `status`, `chat`, `work`, `memory-migrate`는 현재 디렉터리 또는 `--directory`의 담당을 확인한다. 담당에 pin(사용할 정확한 배포본을 가리키는 기록)이 있으면 그 설치본을 선택한다. 기존 무핀 담당은 현재 실행기를 사용한다. 설치 release에서 새 담당을 만드는 자동 최초 pin과 중단된 초기 설정의 원 operation 선택은 [checkpoint387 사용법](C10-initial-pin-usage.md)과 [로컬 확인 범위](C10-initial-pin-result.md)를 따른다.

이전 CLI가 모르는 신규 옵션은 `secumon-agent dispatch --directory ./agent1 -- 내부명령 …`으로 선택 엔진에 전달할 수 있다. 외곽 형식만 이전 입구가 읽고 내부 옵션은 선택 엔진이 해석한다. [전달 사용법](C10-launch-envelope-usage.md)의 허용 명령과 경로 조건을 따른다. compact된 실제 세션·기억·원문·미완료 업무의 설치 엔진 전환도 [checkpoint386 결과](C10-launch-envelope-result.md)에 기록돼 있다.

다른 설치본을 실행하려면 호스트 등록표에도 있어야 한다. 등록표 기본 위치는 `~/.secumon/engines`이며 담당의 메모리·대화·ID 등록표와 별개다. 배포 SHA256(내용을 식별하는 지문), 설치 경로와 실제 디렉터리 객체를 기록한다. 같은 파일을 다른 폴더에 복사한 것만으로 등록이 옮겨지지 않는다.

```sh
secumon-agent lifecycle install --source ./release-bundle --destination ../engines/version-b --digest RELEASE_SHA256
secumon-agent lifecycle check --directory ./agent1 --engine ../engines/version-b
secumon-agent lifecycle backup --directory ./agent1 --destination ./agent1-backup --offline
secumon-agent lifecycle update --directory ./agent1 --engine ../engines/version-b --previous CURRENT_RELEASE_SHA256 --backup ./agent1-backup --offline
secumon-agent open --directory ./agent1
```

`RELEASE_SHA256`과 `CURRENT_RELEASE_SHA256`은 실제 지문으로 바꾼다. 과거 방식으로 만들어 최초 pin이 없는 담당은 `update` 대신 기존 `lifecycle pin --directory ./agent1 --engine ../engines/version-b --offline`을 사용한다. 자동 최초 pin이 있는 새 담당은 `update`를 사용한다. `--offline`은 기존 실행기와 직접 DB 접근을 중지했다는 운영자의 확인이다. 업데이트는 최신 자료를 과거 백업으로 되돌리지 않는다.

CLI의 `install`은 검증·설치 뒤 등록도 수행한다. 이미 설치했거나 설치 후 등록 단계만 실패했다면 같은 파일을 재설치하지 않고 `lifecycle register --engine ../engines/version-b --digest RELEASE_SHA256`으로 등록한다. 같은 등록은 재실행해도 기존 기록을 유지한다. 설치 파일이 바뀌었거나 등록된 디렉터리가 교체되면 거절하므로 새 경로에 검증된 설치를 준비한다.

미등록·분실·변조된 엔진은 다른 버전으로 대체하지 않는다. `lifecycle`, `help`, `version`, `repair`, `clone`은 현재 입구의 관리 명령이므로 잘못된 pin이 있어도 복구를 시작할 수 있다. `version`은 입구의 버전, `status`의 `engineVersion`은 담당이 선택한 버전이다. 프로그램에서 직접 `runAgentCli`를 호출하는 호스트는 자기 런타임을 선택할 책임을 유지한다. 호스트 콜백 객체를 자식 프로세스로 자동 직렬화하지 않는다.

## 호스트가 등록하는 모델·도구·선택 기능

등록 객체의 `engineApi`는 엔진과 주고받는 함수 계약의 버전이다. 모델 revision, 도구 version, MCP/A2A 통신 버전과 다르다. `requires`는 이 확장에 필요한 엔진 기능 목록이다.

```ts
const model = {
  execution: 'host_transport' as const,
  engineApi: { version: 1, requires: ['model.turn', 'model.compact'] },
  open: existingModelFactory,
};
const host = {
  models: new Map([['company-model', model]]),
  requireDeclaredExtensions: true,
};
```

이 코드는 등록 형태 예시이며 실제 모델 연결 예제가 아니다. 기존 팩토리를 재사용하고, 제공하지 않는 기능은 선언하지 않는다. 도구·Knox·게시판·아카이브·동료·A2A·임무·자원 포트·선택된 PostgreSQL 등록에도 같은 선언을 사용할 수 있다. 비활성 선택 기능은 불러오지 않는다.

기본 정책은 과거 미선언 등록을 허용하되 `unverified`(미검증)로 표시한다. 호스트의 `requireDeclaredExtensions: true`는 미선언도 거절한다. 선언된 API 버전이나 필수 기능이 맞지 않으면 기본 정책에서도 거절한다. 등록을 캡처한 뒤 선언이 바뀌면 해당 팩토리 호출 전에 거절한다. `verified`는 선언의 계약 호환 검사이며 외부 서비스나 모델 품질의 검증 결과가 아니다.

일반 profile의 `extensions`, CLI `--json`, Web/Knox를 여는 호스트의 반환 정보에 검사 결과가 들어간다. CLI `chat status`는 미검증 상태를 표시한다. 일반 대화와 Knox 메시지마다 관리 정보를 붙이지 않는다. Web 화면에 새 관리 패널을 만든 것은 아니다.

`checkAgentLifecycle`의 마지막 options, `pinAgentEngine`의 options에는 호스트가 선택한 `extensions` 목록과 `requireDeclaredExtensions`를 전달한다. PG 전용 lifecycle에도 같은 인수가 있다. CLI의 프로그램 호출은 `runAgentCli(args, hostOptions)`로 전달할 수 있다. 일반 셸 명령은 확장 목록을 알 수 없으므로 저장 호환이 통과해도 확장 검사는 `inventory: not_provided`, `unverified`다. 담당 config에서 임의 모듈 경로를 로드하여 목록을 만들지 않는다.

## 현재 한계

자식 엔진은 shell 없이 동일 argv와 작업 디렉터리, 표준 입력/출력으로 실행된다. 부모에 온 종료 신호를 전달하며 실제 자식 종료까지 기다린다. 등록·배포·pin 재검사는 하지만 동일 OS 계정이 검사 이후 파일을 바꾸는 행위까지 원자적으로 막는 실행 샌드박스는 아니다. Windows는 기존 ACL/파일 handle 경계를 재사용하며 실제 Windows 종료 동작과 이번 전체 Linux 실행은 별도 인수다.

설치형 자동 최초 pin은 checkpoint387에서 연결했고, manifest 없는 개발/npm 패키지의 로컬 release 준비는 다음 단위다. 저장 형식 이행, 장기 임무의 미확정 외부 효과, 실제 PostgreSQL·사내 연결·운영 설치와 최종 통합은 남아 있다. 완료된 dispatch·compact 전환의 로컬 인수를 이 전체 범위의 검증으로 확대하지 않는다. 실제 모델/API 시험 중단을 유지한다.
