# C05/C06 완주·개인기억 사용법

2026-09-09 · checkpoint402. [로컬 인수 결과](C05-C06-completion-result.md)는 권한 복구 뒤 CLI 완주, 기억만 허용한 두 담당 HTTP 업무, 조회 비용, 실제 기억 화면 조작을 다룬다. 실제 모델/API와 사내 서비스 연결은 실행하지 않았다.

## 개인기억만 허용하는 호스트

일반 호스트 등록표 `AgentExecutionHost`에 선택적 `allowPersonalMemoryWrites`를 지정한다. 호스트가 제공하는 값이며 채팅 문장·HTTP 본문·담당 설정 파일로 권한을 올리는 옵션이 아니다.

```ts
import type { AgentExecutionHost } from '../../runtime/src/presentation/host-tools.js';

function withPersonalMemory(existingHost: AgentExecutionHost): AgentExecutionHost {
  return { ...existingHost, allowPersonalMemoryWrites: true };
}
```

위 코드는 기존 등록표에 기억 허용만 더하는 예시다. 사용하는 프로그램의 위치에 맞게 import 경로를 정한다. 일반 Web/CLI 입구에 이 등록표를 전달하며, 외부 쓰기 도구를 등록하거나 `policy.allowWrites`를 `true`로 바꿀 필요가 없다.

| `allowPersonalMemoryWrites` | 개인기억 변경·업무 선택 | 외부 도구 쓰기 |
| --- | --- | --- |
| `true` | 현재 담당·사용자·원출처·세션 등 기존 검사를 통과하면 허용 | 기존 작업 정책·도구 등록·실행 권한 그대로 |
| `false` | `allowWrites:true`인 actor라도 거절 | 기존 권한 그대로 |
| 미지정 | 기존 `actor.allowWrites !== false` 동작 유지 | 기존 권한 그대로 |

일반 호스트의 기본 `allowWrites:false`에서는 새 기억 허용도 미지정이면 읽기 전용이다. 과거의 신뢰된 로컬 actor에서 `allowWrites` 자체를 생략하던 동작까지 새 기본값으로 바꾸지는 않는다. 기존 actor에 기억 필드를 자동 추가하지 않으며, 과거 요청의 영수증 형식을 일괄 변경하지 않는다. 이 옵션은 공개 기억 관리·선택 경로의 권한이다. 저수준 `personalKnowledge`는 기존 신뢰된 호스트 서비스로 유지한다.

기억 쓰기를 허용해도 작업 실행·게시판·아카이브·외부 쓰기 정책이 넓어지지 않는다. 새 기억을 저장한 것과 업무에 선택한 것, 실제 업무를 실행한 것은 각각 별도 동작이다.

## Web에서 기억을 사용하는 순서

1. 지속 대화에서 기억할 사용자 발언을 선택하고 기억 이름을 입력해 저장한다. 선택한 기존 발언 원문은 읽기 전용이다. 내용을 정정하려면 새 발언이나 기존 정정 절차를 사용한다.
2. 개인기억을 검색·조회한다. 조회만으로 업무 문맥에 추가하지 않는다.
3. 사용할 업무에서 **이번 업무에 사용**을 눌러 현재 기억 버전을 명시 선택한다. 같은 선택 요청을 다시 전달해도 중복 적용하지 않는다.
4. 업무 실행을 요청한다. 모델 문맥에는 선택한 자기 담당의 기억이 들어가며, 검증된 독립 근거와 구분된다. 접수 안내와 완료 결과를 대화에서 확인한다.
5. 재접속하면 같은 업무·세션·기억·결과를 조회한다. 단순 재접속이나 조회가 완료 업무를 다시 실행하지 않는다.

서버는 `WorkbenchConfig.personalMemoryWritable`로 유효한 기억 권한을 화면에 전달한다. 읽기 전용이면 조회는 유지하고 저장·선택/해제·정정·잊기·초안 생성/적용/재개 버튼을 비활성화한다. 기존 초안 적용 상태 조회는 읽기 경로로 유지한다. 화면 비활성화와 별도로 서버도 권한을 검사한다.

기존 HTTP 경로를 그대로 사용한다. 기억 목록은 `GET /api/memories`, 본문은 `GET /api/memories/:id`, 변경은 `POST /api/memories/remember|revise|forget`이다. 업무 기억은 `GET /api/works/:workId/memories`로 확인하고 같은 경로에 `POST`하여 명시 선택한다. 기존 인증·CSRF·요청 ID·목표/상태 버전 검사를 유지한다. 허용되지 않은 기억 변경은 `personal_memory_read_only`, 허용되지 않은 새 선택은 `personal_memory_not_selectable`로 거절한다.

documents 기억의 초안 기능도 같은 기억 권한을 사용한다. 파일 편집만으로 정식 기억을 변경하지 않으며 원출처·현재 버전 확인과 명시 적용을 거친다. 기억을 잊어도 과거 대화 원문이나 백업을 자동 삭제하지 않는다.

## C05 권한 복구 뒤 명시 재개

원 수집 응답이 보관됐지만 현재 읽기 권한이 없어 `blocked/tool_permission_denied`인 업무는 먼저 신뢰된 호스트 경로에서 **저장 업무의 정책**을 복구해야 한다. 호스트 등록표의 허용 범위만 넓히거나 다시 접속하는 것으로 저장된 정책과 차단 상태가 자동 변경되지는 않는다. 이번 인수는 기존 호스트 transaction 경로를 사용했으며 새 관리자 권한 편집 CLI를 추가하지 않았다.

권한 복구 뒤에도 상태 조회는 읽기만 수행한다. 사용자는 같은 업무·세션에서 요청 ID와 재개 원문을 포함해 명시 재개한다. 다음은 등록 호스트가 연결된 CLI의 호출 형태이며 각 자리에는 실제 상태에서 확인한 값을 넣는다.

```text
secumon-agent chat resume --directory <담당경로> --provider registered \
  --session <대화ID> --conversation <채널대화ID> --work <업무ID> \
  --goal-revision <현재목표버전> --message-id <재개요청ID> \
  --text "권한이 복구된 저장 자료로 원래 업무를 이어서 완료해 주세요." --json
```

응답을 잃었으면 같은 요청 ID·원문·대상으로 다시 확인한다. 이번에 확인한 `stored_only` 등록은 원 응답을 보관소에서 검증하고 기존 후속 시도로 완료한다. 원 전송을 다시 수행하지 않으며 원 실패 시도를 성공으로 덮어쓰지 않는다. 결과 조회에서 저장된 응답을 재투영해 검증할 수 있으므로 조회 콜백 증가를 새 전송·정산으로 해석하지 않는다.

## 확인된 성능과 남은 환경

단회 비교에서 기억 저장소 조회는 2,064→1,845회, 원 업무 조회는 6,365→5,927회로 줄었다. documents 기억의 HTTP 실행은 약24.6→23.7초였고 SQLite 기억은 약4.13→4.18초였다. **논리 조회 비용 감소는 확인했지만 일관된 실행 속도 개선이나 응답 시간 보장은 아니다.** 기존 60초 시험 대기 상한은 성능 목표가 아니며, 문서형 기억의 약23.7초 지연은 최종 선택 배치의 성능 인수에 남아 있다. [계측 근거](../../runtime/evidence/checkpoint402-measurements.json).

현재 Linux/native Windows, 실제 PostgreSQL·사내 MCP/Knox·외부 A2A와 운영 배치는 별도 인수다. 실제 모델/API 시험 중단은 유지한다. 로컬 네 흐름의 결과를 보존하고 C10을 이어가며 전체 C05/C06 또는 전체 목표 완료로 확대하지 않는다.
