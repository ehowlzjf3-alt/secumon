# P3-02 공통 업무 조회와 CLI 독립 검토

2026-09-06 · 첫 구현 단위의 설계·회귀 제안 · 구현 완료나 시험 실행 기록 아님

[학습 방식](/Users/seunghanee/Documents/secumon/design/04-learning-guide.md)에 따라 [P3-02의 전체 수용 기준](/Users/seunghanee/Documents/secumon/design/03-migration-plan.md)을 공통 공개 조회와 CLI부터 연결한다. 이번 단위에는 Web 서버·화면·키보드/좁은 화면 검수, 실제 모델·MCP·Knox가 없다. 따라서 이번 결과만으로 P3-02 전체나 Web 재접속 UX가 완료됐다고 표시하면 안 된다.

## 조회를 실행과 분리하는 이유

[채널 설계](/Users/seunghanee/Documents/secumon/design/10-chat-and-channels.md)는 대화, 작업 상세, 실행 진단의 세 수준을 구분한다. “어디까지 했어?”라는 조회는 새 업무나 새로운 추론·메시지를 만들지 않는다. 현재 공개 상태를 같은 업무에 다시 표시한다. 접수·필수 질문·결과를 사용자가 찾기 쉽게 유지하면서 도구/재시도/compact 사건은 진단에서만 확인하게 하는 것이 목적이다.

이번 API `read(workId, actor, access, options)`의 access는 `{channel, conversationId, destination, recipientId, allowDiagnostics}`, options는 `{level, cursor?}`다. `access`는 신뢰된 채널 adapter가 인증·정책에 따라 구성해야 한다. 사용자가 diagnostics를 요청했다는 사실만으로 `allowDiagnostics=true`가 되지 않는다. CLI의 합성 고정 주체와 로컬 목적지는 실제 사내 인증을 검증한 것이 아니다.

## 기존 코드에서 재사용할 것과 그대로 공개하면 안 되는 것

| 현재 코드 | 재사용할 의미 | 새 공개 조회에서 추가로 확인할 것 |
| --- | --- | --- |
| [conversation-service.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/conversation-service.ts) | 상태, analysisReady/resultReady/전달 상태, 현재 목표·근거·가설 검토 | 기존 snapshot은 주체의 업무 조회이며 route에 결합된 공개 DTO가 아님. reason·질문 reason·기준 ID·진단 필드도 공개 정책 필요 |
| [conversation-view.ts](/Users/seunghanee/Documents/secumon/runtime/src/presentation/conversation-view.ts) | 같은 revision의 snapshot과 최신 메시지 선택, 취소/새 목표/반증 뒤 낡은 답 숨김 | 현재 binding/목적지/수신자와 전송 등급을 별도로 확인. 과거 채널 메시지의 존재만으로 현재 공개 허용 판단 불가 |
| [local-channel.ts](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/local-channel.ts) | 실제 로컬 전송 영수증과 전달된 메시지 이력 | messages는 과거 전송 사실이다. 현재 결과 유효성·현재 work 정책 검사 없이 새로운 work-view의 본문으로 복사하지 않음 |
| [cli.ts](/Users/seunghanee/Documents/secumon/runtime/src/presentation/cli.ts) | JSON 출력, 단정한 상태 표시, 종료와 취소의 구분 | 새 work-view 명령은 기존 run/accept/messages/status의 의미를 암묵적으로 변경하지 않음. TTY 정리·오류 정규화·JSON 한 결과 문서 유지 |

업무 조회 포트에는 가능한 한 state 읽기·필요한 artifact 무결성 읽기·knowledge 검증만 제공한다. 모델·도구·sink 전송/lookup, commit/put, response.prepare, recovery.restore, refreshKnowledge를 조회의 정상 경로에서 호출하지 않는다. 기억 검증이 실패하면 유효하지 않음을 표시하거나 공개를 거절하며 조회가 이를 상태에 새로 기록해 고치지 않는다. 원본을 읽어 무결성을 확인하는 것과 원문을 응답에 노출하는 것도 다르다.

## Snapshot과 cursor의 계약

이번 cursor는 최신 전체 snapshot을 다시 받을 필요가 있는지 확인하는 값이다. 누락된 내부 사건을 한 개씩 재생하는 event stream이나 전달 영수증이 아니다. 변경이 있으면 최신 전체 snapshot으로 교체하고, unchanged이면 클라이언트가 가진 같은 route/수준의 snapshot을 유지한다.

- cursor를 work, 인증된 주체/유효 권한, channel·conversation·destination·recipient, 표시 수준과 진단 권한에 결합한다. 다른 방이나 details에서 받은 값을 conversation에 재사용할 수 있다고 가정하지 않는다. cursor는 접근 권한을 부여하지 않는다.
- cursor가 같더라도 현재 binding·권한·정보 공개 정책·필요한 출처/산출물 검증을 먼저 수행한다. 같은 work revision 밖에서 원본·기억이 철회되거나 artifact가 사라질 수 있다. 단순한 revision 비교만으로 unchanged를 반환하지 않는다.
- 한 응답은 같은 정본 revision에서 조합한 상태·현재 결과·질문·전달 상태여야 한다. 비동기 read 중 변경되면 제한된 재시도나 명확한 contention 오류로 종료한다. 오래된 본문에 새 goal revision만 붙이지 않는다.
- 조회 시각처럼 호출마다 바뀌는 값 때문에 항상 changed가 되지 않도록 의미 있는 view와 측정 시각을 구분한다. 오래된 cursor를 전달했다고 옛 snapshot으로 되돌리거나 업무를 재개하지 않는다.
- 잘못된 형식·과대 길이·다른 route·다른 수준·미지원 version의 cursor 처리(거절 또는 reset)를 계약으로 고정한다. 어느 경우도 검사를 생략하거나 숨은 자료를 반환하지 않는다. cursor에 원문·프롬프트·서명 없는 권한 주장을 넣지 않는다.

저장소 두 종류에서 reopen 뒤 동일 조회/unchanged가 유지되는지 확인한다. 이는 상태 조회의 재접속 계약이다. Web의 SSE/WebSocket, 브라우저 cache, 탭 동기화와 실제 화면의 재접속 경험은 별도 구현·검수 대상이다.

## 실패 사례와 필수 단언

| 사례 | 확인할 결과 |
| --- | --- |
| 최초 조회 후 같은 cursor 반복 | 첫 snapshot 뒤 unchanged. state revision·events·deliveries·예산 불변, 실제 model/tool/send/lookup·commit/put 진입 0 |
| 다른 work·조직·주체·방·채널·수신자·목적지 | 소유권만 맞아도 route가 다르면 거절. 진단 요청도 추가 권한을 만들지 않음 |
| read 또는 artifact 확인 사이 권한/binding 철회 | 새 snapshot과 unchanged 모두 금지. 거절 오류에 목표/질문/원문 내용을 포함하지 않음 |
| 같은 revision의 기억 철회·artifact 유실/손상 | 오래된 resultReady/본문을 유지하지 않음. 기존 cursor가 검증을 우회하지 못함. 조회가 의무 정산이나 새 checkpoint를 만들지 않음 |
| 목표 변경·늦은 반증·가설 재검토 | 옛 전달 이력은 보존하되 최신 유효 결과로 표시하지 않음. 새 목표·현재 근거의 readiness와 일치 |
| 결과 준비·pending/sending/unknown/delivered | 결과 준비와 전달 확인을 구분. delivered를 읽음으로 바꾸지 않고 unknown을 failed/absent로 추정하지 않음 |
| 분석 전용 완료·전달 거절 | completed 상태와 미전달을 함께 나타낼 수 있음. 조회가 분석을 재실행하거나 완료 상태를 임의 취소하지 않음 |
| 취소·정지·응답 대기 | 현재 상태가 과거 결과 메시지에 가려지지 않음. 이미 해결된 질문은 현재 필요한 질문에서 제외. 연결 종료는 업무 취소가 아님 |
| 다수 내부 사건·도구 실패·compact | conversation 결과에 내부 이벤트/로그를 줄줄이 복사하지 않음. details/diagnostics에도 도구 원응답·프롬프트·비공개 사고를 포함하지 않음 |
| 자유 문자열·제어 문자·긴 목록 | 목표·상태 reason·task 설명·오류 문자열·locator에 합성 표식을 각각 넣고 응답의 필드별 공개 기준 검사. terminal 제어문자 처리, 표시 제한과 생략 사실 확인 |
| 다중 업무·두 대화·두 저장소 | 요청한 업무/route만 조회. 다른 업무의 마지막 메시지·usage·대기 질문·cursor와 섞이지 않음 |
| CLI 호환성 | 새 명령의 JSON과 일반 출력, cursor round-trip, 잘못된 level/route/옵션 오류 검증. 기존 accept/run/status/messages의 기존 시험을 유지 |

금지 문자열 검사만으로 충분하지 않다. 정상 허용된 질문/결과와 상태가 실제로 남는 양성 대조, 잘못된 원문/route를 넣었을 때 검사가 실패하는 음성 대조가 필요하다. 필드가 비어 있기만 해서 누출 0이 된 응답은 유용한 공개 업무 조회를 구현했다는 증거가 아니다.

진단도 권한이 있는 사용자를 위한 선별 view다. 내부 원응답·원문 산출물·프롬프트 다운로드 endpoint를 이번 조회에 추가하지 않는다. summary/search/log/screen 등 P2-06 공통 게이트를 통과했다는 이유만으로 이 새로운 조회 DTO 전체가 공개 가능하다고 가정하지 않는다. 현재 work의 보존된 등급과 이 route의 channel 목적지 정책을 실제 반환 경계에서 확인한다.

## 완료 기록과 다음 단위

이번 결과에는 공통 view 계약, CLI 명령과 사용 예, 정상·철회·재접속·전달 상태 검증, 두 저장소의 관측 근거를 기록한다. 새 서비스시험과 CLI 통합시험, 전체 회귀의 개수를 분리한다. read 호출 수, 공개 메시지 수, 내부 사건 수, 업무 완료 수를 서로 대신 쓰지 않는다. 사용자 가독성·접수 지연·실제 웹 성능 개선은 측정 없이 주장하지 않는다.

통과 후에도 P3-02의 Web 화면·변경/취소 UI·snapshot/cursor 연결·키보드 초점·좁은 화면 검수는 남는다. P3-02 전체 status는 진행 중으로 유지하고 이번 공통 조회/CLI slice의 증거를 별도로 기록하는 것이 적절하다. 학습의 핵심은 **조회가 실행을 일으키지 않고, 전달된 과거 메시지와 현재 유효한 결과를 구분한다**는 데 있다.

## 첫 구현에 대한 독립 소스 검토

CLI의 신규 조회 분기와 기존 명령 호환성, 마지막 close 경로를 확인했다. 처음에는 전달 미확정 본문을 상태 구분 없이 출력했는데, 준비된 질문/답변과 전달 상태를 표시하도록 보완했다. 초기 CLI/표시 11개 시험이 통과했으며 최종 서비스 검증과는 구분한다.

서비스의 포트에는 state get/deliveries/events, artifact get, digest와 knowledge validate만 있다. 실행/정본 쓰기/발송을 호출하는 경로는 없으며, 등록 대화·읽기·screen/log 정책 검사와 두 번의 표시 내용 대조가 cursor 판정 전에 이뤄지는 것을 읽어서 확인했다.

추가 발견은 상세 가설 카드의 과거 평가 표시다. 근거 정정/철회는 hypothesisAssessment를 무효화하지만 저장된 hypothesis.status/supportIds를 유지하므로, 그대로 표시하면 이전 supported 상태를 현재 판정으로 오인한다. 현재 평가 여부를 별도로 확인하고 재검토가 필요한 상태/근거 수를 현재 판단으로 표시하지 않는 수정과 두 저장소 회귀가 필요하다. 이 절은 소스 검토 기록이며 해당 회귀 실행 결과는 최종 결과 문서에서 확인한다.

해당 표시를 고친 뒤, 목표의 직접 근거 A와 가설 평가 근거 B가 다른 경우를 추가로 검토했다. B만 유실되면 상세 가설은 재검토로 바뀌어도 기본 화면이 A만 검사해 결과를 유효하다고 표시할 수 있었다. 가설의 현재 원자료 검사를 공통 projection 단계로 옮겨 analysisReady/resultReady와 상세 카드를 같은 기준으로 판정하도록 보완했다. 목표의 결과 evidenceIds에 A만 들어가고 평가 basis에는 A/B가 있는 독립 사례를 두 저장소에 추가했다.
