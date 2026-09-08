# C10 로컬 패키지의 실행 설치본 준비 결과

2026-09-08 · checkpoint388 · 기준선 `b8d1e0d736d8a5e4fbc31a7381872ee2f93191d3`

release manifest가 없는 npm/개발 패키지에서 새 담당을 시작하면, 원 패키지를 읽어 검증 가능한 호스트 소유 설치본을 준비하고 동일 명령을 그 설치본의 실제 CLI 프로세스에 전달한다. 해당 설치본이 checkpoint387의 초기화를 수행해 원 담당 ID·최초 엔진 pin·완료 영수증을 만든다. 같은 원본의 다음 담당은 준비된 설치본을 재사용하되 기억·대화·설정은 각 담당 디렉터리에 유지한다.

[계획](C10-engine-preparation-plan.md) · [사용법](C10-engine-preparation-usage.md) · [체크포인트](../../runtime/evidence/checkpoint388.json)

## 구현과 확인한 동작

- 기존 bundle/install/register와 CLI 명령 전달을 재사용했다. 원 파일 목록·내용과 실행 필수 의존성의 실제 존재를 확인한 후 `~/.secumon/engine-releases/<지문>/<시도 ID>/`에 준비한다. 원 npm/개발 패키지에는 release manifest나 담당 자료를 기록하지 않는다.
- `selected.json`은 검증·등록을 마친 설치본을 가리킨다. 기존 선택을 덮어쓰지 않고 현재 설치 파일·등록 내용을 다시 확인한다. 준비 도중 다른 초기화가 완료되면 담당의 최신 엔진 선택을 다시 읽는다.
- 등록 실패 뒤에는 같은 완료 설치본을 재등록한다. 복사 도중 종료된 후보는 보존하고 새 시도에서 이어간다. 실제 manifest 연결 직후 강제 종료되어 정확한 원 manifest와 같은 파일 객체의 임시 링크가 남은 경우에도 원문과 링크를 보존하고 새 후보를 준비한다. 불완전한 후보를 실행 가능한 설치로 채택하지 않는다.
- 마지막 원본 전체 조회 중 등록이 바뀌는 재현을 추가했다. 원본 조회 뒤 선택 설치·등록을 검사하도록 순서를 보완해 해당 변경을 거절한다. 두 준비 프로세스가 경쟁해도 하나의 원 선택을 읽도록 확인했다.
- 기존 오프라인 npm pack/global install 시험을 확장했다. 실제 npm 입구에서 준비 설치본으로 새 담당 두 개를 초기화하고 같은 설치본의 재사용을 확인했다. npm 제거·재설치 뒤에도 첫 담당의 원 세션·업무·산출물을 보존하고 합성 조회를 이어갔다. 도구 1회·시험용 모델 2회이며 실제 모델 접속은 없다. 기존 직접 bundle/install 시험도 통과했다.

## 실행한 검증

| 기록 | 실행 소스 | 결과 |
| --- | --- | --- |
| [최초 빌드](../../runtime/evidence/C10-preparation-build1.log) | build1 | exit 2. 추출한 setup parser의 반환 타입이 저장 방식 문자열을 넓게 추론해 실패했다. 리터럴 반환 타입을 보존하도록 교정했다. 이 빌드로 시험하지 않았다. |
| [빌드2](../../runtime/evidence/C10-preparation-build2.log) | build2 | exit 0 |
| [신규 첫 시험](../../runtime/evidence/C10-preparation-target1.log) | build2 | 14 통과. 아래 최종 신규 16개에 포함되므로 중복 집계하지 않는다. |
| [실제 npm·직접 설치](../../runtime/evidence/C10-preparation-installation1.log) | build2 | 2 통과, 약 111초 |
| [CLI·등록·프로필 회귀](../../runtime/evidence/C10-preparation-regression1.log) | build2 | 30 통과, 약 65초 |
| [코어 타입](../../runtime/evidence/C10-preparation-core1.log) / [계층 검사](../../runtime/evidence/C10-preparation-architecture1.log) | build2 | exit 0 / 199개 검사·위반 0 |
| [최종 빌드](../../runtime/evidence/C10-preparation-build3.log) | build3 | exit 0 |
| [최종 신규 시험](../../runtime/evidence/C10-preparation-target2.log) | build3 | 의존성 7·준비 8·마지막 등록 재확인 1, 합계 16 통과 |

**신규 16개와 관련·확장 기존 32개, 고유 합계 48개가 각 기록의 소스에서 통과했다.** 모든 완료 시험의 실패·취소·건너뜀은 0이다. build2 뒤 두 경계를 보완하고 직접 관련 신규 시험 16개를 build3에서 실행했다. 큰 설치 시험과 회귀 32개를 최종 소스에서 다시 실행한 것은 아니다. 코어·계층 검사는 build2 기록이며 이후 내부 코어 변경은 없었다.

최종 환경은 Node v24.20.0, macOS arm64다. [최종 빌드 대조](../../runtime/evidence/checkpoint388-final-source.json)는 2,421파일 일치, sourceDigest `6c39ba9159cf4fd24420492cbf5e942140865fd225d92e9f18987241321cefee`, filesDigest `2e36844e5f5652e3145876449b51fb3a35bd15121814f83827898266fadd2913`이다. [build2 지문](../../runtime/evidence/checkpoint388-build2-source.json)도 별도로 보존한다.

## 적용 범위와 남은 작업

기본 적용 대상은 사용자 소유이며 필요한 의존성을 패키지 안에 갖춘 로컬 패키지다. 의존성 검사는 존재·manifest·이름·포함 경계 검사다. 버전 범위 해결, exports/main 또는 동적 import의 모든 실행 가능성을 검증한 것은 아니다. 원 tgz·외부 hoist·npm link/pnpm 링크 배치·관리자 소유 prefix까지 지원한 것으로 표시하지 않는다.

일반 setup 옵션 검사는 준비 전에 공유하지만 chat/work의 모든 의미 검사가 준비 전에 끝나는 것은 아니다. 모든 잘못된 명령이 무기록으로 끝난다고 주장하지 않는다. 프로그램 API에 주입한 호스트 콜백을 자식 프로세스로 직렬화하지 않으며 직접 API의 실행 코드 선택은 호출 호스트 책임이다. 미선택 후보·중단 후보의 자동 삭제는 구현하지 않았다.

이번 소스의 Linux/native Windows 실행, 실제 모델/API·PostgreSQL·사내 MCP/Knox·외부 A2A, 운영 설치·외부 패키지 게시·최종 통합은 수행하지 않았다. 실제 모델/API 시험 중단을 유지한다. 사용한 npm 설치는 기존 로컬 캐시를 이용한 오프라인 시험이다.

다음은 기존 저장 형식 이행 코드를 먼저 확인하고, 읽기 전용 호환 확인→백업→엔진 변경→최초 저장소 열기의 연결에서 빠진 범위를 정하는 일이다. SQLite 상태·지식 저장소에는 이미 형식 이행 코드가 있으므로 새로 만들지 않는다. 미확정 외부 효과 대조, C09 취소/목표 변경/일시정지와 저널·이력 비용, C05 권한 재허용 후 완주, C06 기억 HTTP·권한·브라우저, 플랫폼·실제 연동·운영 인수는 계속 남는다. 전체 C10과 goal은 미완료다.
