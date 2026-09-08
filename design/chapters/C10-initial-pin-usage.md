# 새 담당의 설치 엔진 자동 고정과 초기화 복구

2026-09-08 · checkpoint387 구현 사용법. 설치 release의 자동 최초 선택과 공개 CLI의 중단 복구를 로컬에서 확인했다. 구체적인 실행 범위는 [결과](C10-initial-pin-result.md)를 따른다. 전체 C10 완료나 운영 배포의 근거로 사용하지 않는다.

## 어떤 경우에 자동으로 고정하나

`release.json`이 있는 유효한 설치 엔진으로 **아직 담당 정보가 없는 디렉터리**를 초기화하면, 그 설치본을 처음 사용할 엔진으로 기록한다. `pin`은 버전 이름만 저장하는 설정이 아니라 설치 경로와 배포 SHA256(배포 내용을 식별하는 지문)을 포함하는 기록이다. 새 담당마다 고유한 ID를 만들고 첫 pin에도 같은 ID를 넣는다.

```sh
secumon-agent init --directory ./agent1 --name '담당 1'
secumon-agent lifecycle status --directory ./agent1 --json
secumon-agent open --directory ./agent1
```

위 명령의 전제는 `secumon-agent`가 검증 가능한 설치 release를 실행한다는 것이다. 새 디렉터리의 `open`도 같은 초기화 경로를 사용한다. 일반 담당 초기화를 거치는 `chat`과 담당형 `work`에도 적용하며, 독립 `work --data-dir`를 새 담당 초기화로 취급하지 않는다. `status`는 상태 조회이므로 새 담당이나 pin을 만들지 않는다. 초기 설정과 저장소 준비만으로 모델 연결이나 업무 수행까지 완료되는 것은 아니다.

실행한 설치본은 호스트 등록표에도 등록한다. 기본 위치는 `~/.secumon/engines`이며, 담당별 신원 등록표·대화 이력·개인 기억과 분리돼 있다. 이 등록표는 배포 파일을 담는 설치 폴더가 아니라 검증한 설치의 경로·지문·디렉터리 식별 정보를 보관하는 곳이다. 담당 config나 모델의 응답으로 실행할 설치 경로를 등록하지 않는다.

## 저장 순서와 완료 의미

새 설치형 초기 설정은 schema 3(초기 설정 기록의 세 번째 형식)을 사용한다. 담당의 대화·메모리 저장 형식이나 엔진 API 버전과는 다른 번호다.

1. 실행한 설치의 원 파일과 지문, 초기 설정 형식 지원을 확인하고 호스트 등록을 확보한다.
2. `setup-operation.json`을 먼저 공개한다. `operation`은 진행 중인 초기 설정의 원 기록이며 담당 ID, 저장소 선택, 원 설치와 첫 pin 내용을 포함한다. 동시에 시작한 호출도 실제 저장에 성공한 이 기록을 다시 읽는다.
3. 원 operation의 신원으로 `identity.json`, `config.json`과 담당 디렉터리를 준비한다.
4. 원 설치·등록·operation·신원·설정을 재확인하고 `.secumon/engine-pins/00000001.json`에 첫 pin을 공개한다.
5. `setup.json`에 같은 operation과 첫 pin의 지문을 연결한 완료 영수증(`receipt`)을 공개한다. 이때 초기 설정이 `ready`가 된다.
6. 일반 CLI/profile 입구가 기존 저장소 열기 절차를 수행한다. 이 단계가 중단돼도 새 담당 ID나 첫 pin을 다시 만들지 않는다.

첫 pin은 순번 1이며 이전 pin과 업데이트 백업이 없다. 아직 실행 중인 기존 담당을 갱신하는 작업이 아니므로 최초 초기화에 `--offline`을 대신 넣지 않는다. 사용자가 기록 파일을 직접 작성하거나 고칠 필요는 없다.

## 중단되었을 때

초기 설정 도중 멈췄다면 이미 저장한 원 operation을 기준으로 이어간다. 새로운 엔진이나 새 ID를 임의로 선택하지 않고, 원 신원·저장소 선택·첫 pin의 내용과 저장된 파일을 대조한다. 임시 파일은 이름만 보고 신뢰하지 않는다. 원 첫 pin과 정확한 바이트가 같고 허용된 파일 연결 관계인 경우에만 정상 중단 자료로 취급한다.

공개 CLI는 아직 첫 pin이 없는 중간 상태에서도 원 operation과 호스트 등록으로 원 설치를 선택한다. 원 설치에서 첫 pin 게시 직전·직후 실제 종료 후 `open`으로 재개하는 경로를 확인했다. 다른 설치 CLI에서 받아 재실행하는 미완료 초기화의 별도 인수는 남아 있다. 직접 복구를 진행할 때도 원 설치와 원 담당을 유지하며, 추가 복구 확인이 필요한 기존 불완전 상태에는 관리 명령 `repair`의 조건을 따른다. `repair`가 임의의 다른 엔진을 선택하도록 허용하는 것은 아니다.

- 원 operation·신원·설정·첫 pin이 정상이고 **완료 영수증만 없는 초기 설정**은 같은 내용의 영수증을 다시 공개할 수 있다. 이는 첫 pin 공개 직후 멈춘 경우와 같은 복구 경계다.
- 완료 영수증이 남았는데 원 operation이나 첫 pin이 없어졌다면 오류로 멈춘다. 원 proof(일치 여부를 확인할 근거 기록)가 바뀌거나 서로 맞지 않는 경우도 새 기록으로 덮어쓰지 않는다.
- 원 설치나 등록이 없거나 내용이 바뀌었다면 다른 설치로 대체하지 않는다. 원 선택을 다시 검증할 수 있어야 한다.
- 같은 초기 설정을 반복해도 정상적으로 공개된 원 기록을 유지한다. 이미 설정이 끝난 담당은 현재 pin에 맞는 엔진을 사용한다.

## 기존 담당과 이후 업데이트

이미 만들어진 무핀 담당, 과거 형식의 초기 설정 복구, `clone`으로 만든 새 신원, 백업 `restore`는 이번 자동 최초 pin의 대상이 아니다. 설치 엔진으로 열었다는 이유만으로 기존 담당에 최초 pin을 추가하지 않는다. 복원은 원 백업의 pin과 신원 및 기존 복원 절차를 따른다. 과거 무핀 담당의 명시적 첫 선택은 `lifecycle pin`을 계속 사용한다.

자동으로 첫 pin이 생긴 담당에서 엔진을 바꾸려면 기존 `check → backup → update` 절차를 사용한다. 현재 pin을 없애고 `init`을 다시 호출하는 방식으로 업데이트하지 않는다. 첫 기록은 이력에 남고 새 pin을 추가하므로, 원 초기 설정의 증명을 유지하면서 이후 배포본을 선택할 수 있다.

```sh
secumon-agent lifecycle check --directory ./agent1 --engine ../engines/version-b
secumon-agent lifecycle backup --directory ./agent1 --destination ./agent1-backup --offline
secumon-agent lifecycle update --directory ./agent1 --engine ../engines/version-b --previous CURRENT_RELEASE_SHA256 --backup ./agent1-backup --offline
secumon-agent open --directory ./agent1
```

`version-b`는 정상 설치·호스트 등록을 마친 경로이고 `CURRENT_RELEASE_SHA256`은 실제 현재 pin의 지문이다. `--offline`은 기존 실행기와 직접 DB 접근을 중지했다는 운영자의 확인이다. 자세한 설치·등록·확장 호환 조건은 [기존 사용법](C10-launcher-extensions-usage.md)을 따른다.

## 다음 범위

`release.json`이 없는 개발 체크아웃이나 현재 npm 패키지를 실행하면 기존 초기화 방식을 유지한다. 패키지의 로컬 파일로 검증 가능한 release를 준비하는 `materialization`(설치 가능한 배포본 만들기)과 그 뒤의 자동 최초 pin 연결은 다음 구현 단위다. 이번 기능이 임의의 엔진을 다운로드하거나 개발 파일을 자동으로 배포본이라고 등록하지 않는다.

새 CLI 옵션을 선택 엔진에 전달하는 `dispatch`와 실제 compact 세션의 설치 엔진 전환은 [checkpoint386 결과](C10-launch-envelope-result.md)와 [전달 사용법](C10-launch-envelope-usage.md)을 참고한다. 이번 초기 pin의 검증 상태와 구분한다. 저장 schema 이행, 미확정 외부 효과, 현재 Linux/native Windows·실제 PostgreSQL·사내 서비스·운영 설치와 최종 통합은 별도 범위로 남아 있다. 실제 모델/API 시험 중단을 유지한다.
