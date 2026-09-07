# Secumon

지속적인 대화와 기억을 유지하면서 목표를 접수하고, 계획·도구 실행·근거 확인·재개를 수행하는 에이전트 런타임이다. 담당별 저장소와 권한을 분리하고 원문·명령 영수증·사용량을 보존한다. 요청을 받은 사실, 실행 결과, 목표 완료를 각각 확인한다.

현재 소스는 `runtime/`, 설계·구현 기록과 남은 작업은 `design/`에 있다. 기능 연결을 먼저 구현하고 C01부터 C10까지 순서대로 검증·수정하는 단계다. 전체 목표와 운영 환경 인수는 아직 완료되지 않았다.

## 시작과 빌드

Node.js **24.20.0 이상, 25 미만**과 npm이 필요하다. 저장소 루트에서 실행한다.

```sh
cd runtime
npm ci --ignore-scripts
npm run build
node dist/presentation/agent-cli.js help
node dist/presentation/agent-cli.js chat help
```

빌드는 TypeScript 컴파일과 소스·빌드 지문 기록을 수행한다. 일반 요청은 제공자를 명시해 사용하며, 외부 모델·도구·저장소는 신뢰된 호스트 등록이 필요하다. 설정과 실행 예시는 [런타임 안내](runtime/README.md), [호스트 예제](runtime/examples/)를 참고한다. 위 명령은 게시 준비 과정에서 새로 실행한 결과를 뜻하지 않는다.

## 현재 확인한 범위

현재 진행은 [인수인계](design/IMPLEMENTATION-RESUME.md)의 checkpoint375를 따른다. C03 선택 고유243개, C04 선택 고유158개, C05 도구·문맥·MCP 선택 고유682개를 확인했다. 실행별 소스 지문과 실패 후 교정을 구분해 보존한다.

2026-09-08, checkpoint375 기준이다. 아래 수치는 macOS arm64·Node v24.20.0의 선택한 로컬 시험 결과이며 전체 환경의 통과 수가 아니다.

| 범위 | 상태와 근거 |
| --- | --- |
| C01 담당·저장소·호스트 식별 | 7파일 **80/80 통과**, build5 성공, 구조 검사 188개·위반 0. 별도 동시 CLI 8개씩 20회 확인은 고유 시험 수에 합산하지 않는다. [결과](design/chapters/C01-ordered-verification-result.md) |
| C02 지속 세션·compact·다음 작업 분리 | 기존 4파일 30개와 CLI·Web 1파일 5개, **고유 35개 통과**. 두 실행의 소스 지문은 다르며 각각 기록했다. [결과](design/chapters/C02-ordered-verification-result.md) |
| C03 개인 기억·이관·복구 | 선택한 **고유243개 통과**. 명시 중단7지점과 실제 로컬 쓰기의 received/unknown 기록 보존을 확인했다. 주입한 오류와 실제 프로세스 관측을 구분하며 현재 플랫폼·최종 통합은 별도다. [결과](design/chapters/C03-ordered-verification-result.md) · [남은 인수](design/chapters/C03-remaining-acceptance.md) |
| C04 모델·에이전트 실행 | 선택한20파일 **고유158개 통과**. chat의 호스트 등록 경로 전달을 보완하고 문맥·재접속·목표 변경·CLI/Web 흐름을 확인했다. 실제 모델 품질 검증은 아니다. [결과](design/chapters/C04-ordered-verification-result.md) |
| C05 도구·문맥·MCP | 선택한 **고유682개 통과**. 권한이 철회된 수집 작업의 일반 CLI/HTTP·정산·현재 제한 안내를 확인했다. 개인 기억 조회의 중복 포트 호출을 줄였고, 원본·권한 재검사를 유지했다. [결과](design/chapters/C05-ordered-verification-result.md) |
| C06~C10 기능 연결 | 채택한 지원 범위의 구현과 통합 빌드를 마쳤다. 상세 검증과 실제 연동은 별도다. [구현 결과](design/chapters/C06-C10-implementation-result.md) · [검증 목록](design/chapters/C06-C10-verification-plan.md) |

C06~C10에는 CLI/Web·전달 채널, 선택 게시판·아카이브, 동료·반론·자원 배정, A2A 지원 부분·사건별 상시 임무, 설치·버전 고정·업데이트·백업·복원이 포함된다. 구현되어 있다는 설명을 모든 조건에서 검증되었다는 의미로 사용하지 않는다. 과거 단위별 Linux 결과도 해당 소스 지문의 이력으로 보존한다.

## 남은 작업

[다음 작업](design/NEXT-STEPS.md)에 바로 이어갈 수정과 미실행 검증을 모았다.

- [C06 준비](design/chapters/C06-ordered-verification-preparation.md)의 Knox 직접 입구·격리 설치·두 담당 배치부터 C06~C10 검증을 진행한다.
- C03의 [플랫폼·최종 통합 잔여](design/chapters/C03-remaining-acceptance.md)와 C05의 권한 재허용 후 명시 재개 전체 흐름은 별도 인수로 유지한다. 완료한 묶음은 근거 없이 반복하지 않는다.
- [조회 개선 결과](design/chapters/C05-source-read-reuse-result.md)는 한 개인 기억 조회의 포트 횟수·반환량 측정이다. 전체 속도·토큰 절감률은 주장하지 않는다.

실제 모델/API 시험은 **중단 상태**다. 실제 모델의 판단 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox, A2A 상호운용, 실제 PostgreSQL·Windows 환경, 운영 설치·배포는 별도 검증이 필요하다. 미실행 항목은 통과 처리하지 않는다.

## 이어서 읽기

- [현재 상태와 이어갈 작업](design/IMPLEMENTATION-RESUME.md)
- [통합 구현·검증 계획](design/03-migration-plan.md)
- [작업 목록과 남은 범위](design/implementation-backlog.json)
- [C01~C10 순차 검증](design/chapters/C01-C10-ordered-verification.md)
- [작업 이력](design/WORKLOG.md)
- [설계 안내 화면](design/secumon-review.html)

과거 문서의 당시 “다음 작업”과 수치는 이력이다. 현재 진행 판단은 최신 체크포인트와 실행별 원로그·소스 지문을 우선한다.

작업 단위가 완료될 때마다 코드와 진행 문서를 함께 커밋하고 `origin`에 푸시한다. [저장소 작업 규칙](AGENTS.md)에 이 절차를 기록했다.
