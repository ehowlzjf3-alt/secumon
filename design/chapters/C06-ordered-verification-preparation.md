# C06 순차 검증 준비

2026-09-08 · checkpoint374. C05 뒤 이어갈 읽기 검토이며 새 실행 결과가 아니다. [V06 요구](C06-C10-verification-plan.md#c06)의 사용자 결과를 기존 코드·시험과 연결했다. 이미 C01/C02/C04에서 확인한 선택 결과는 각 소스 범위의 근거로 재사용하며 이유 없이 반복하지 않는다.

| 요구 | 재사용할 근거·구현 | 새로 확인할 공백 |
| --- | --- | --- |
| V06-01 조용한 접수·진행·결과 | `conversation`, `conversation-view`, `work-view-format`, `work-view-service` | 일반 입구의 말풍선 수와 필요할 때만 펼치는 세부 정보; 브라우저 관측과 계약 시험 구분 |
| V06-02 재접속·중복·취소·격리 | C02 지속 세션, C04 agent-turn CLI/Web·목표 변경 결과; `work-view-cli`, `web-integration`, `web-server` | C06 변경 이후 추가 제어/안내와 실제 UI 연결만 좁게 확인 |
| V06-03 Knox | `agent-knox.ts`의 접수/실행 분리, `knox-channel.ts`와 기존 outbox | Knox 공개 입구를 직접 시험한 파일은 아직 없음. 로컬 transport로 접수만 할 때 모델0회, 명시 run, 중복/재개, unknown/lookup, 권한·세션 격리 확인. 사내 MCP 매핑·실제 전달은 별도 |
| V06-04 설치·버전·첫 setup | C01 profile·동시 최초 호출·setup-mutations 및 lifecycle 구현 | npm pack, 격리 prefix 설치, 전역 명령 실행, 제거/재설치 뒤 담당 자료 보존. Linux/native Windows는 해당 플랫폼에서 별도 |
| V06-05 두 담당 배치 | `examples/two-agents.md`, 디렉터리별 config/도구/스킬과 선택 협업 구성 | 서로 다른 두 업무를 공통 엔진 수정 없이 배치하고 협업 비활성 상태에서 대화·개인 기억·업무가 섞이지 않는 입구 인수 |

기존 시험의 파일명은 `runtime/src/tests/<이름>.test.ts`다. 문서 예제와 컴파일 성공을 배치 인수로 대신하지 않는다. 실제 모델/API 시험 중단을 유지하며 준비한 응답과 로컬 전송 대역만으로 확인할 연결을 먼저 실행한다. 실제 Knox 연결의 도구명·인증·전송/조회 의미는 사내 MCP 규격을 받아 별도 검증한다.

## 다음 작은 단위의 재사용 경로

checkpoint375 읽기 검토에서 `host-tool-entry-fixture.ts`의 실제 등록 모델·도구 경로, 호출/종료 카운터를 재사용 대상으로 확인했다. 임시 담당/등록표를 만들고 신뢰된 호스트 정책에 Knox 목적지를 추가한 뒤 로컬 `send/lookup` 전송 대역으로 `openAgentKnox()`를 직접 호출한다. 새 제품 본체를 만들거나 실제 메신저를 호출할 필요는 없다.

- `accept()`만 호출하면 접수 안내1회·모델/도구0회이며, 명시 `run()`에서 결과를 만든다.
- 동일 messageId와 close/reopen은 같은 업무/세션으로 이어지고, 이미 확인한 답변을 재전송하지 않는다.
- 전달 결과가 unknown인 경우 status/history는 전달 조회·재전송을 하지 않는다. 명시 flush가 기존 전송 ID를 조회하고 전달/대화 기록을 한 번 확정한다.
- 다른 담당·사용자·대화·세션의 업무를 run/status/control/followUp/changeGoal/flush로 접근할 수 없는지 확인한다.
- 목표 revision 전달, 추가 설명과 목표 변경의 구분, 중복 run과 close 수명을 공개 입구에서 확인한다.

일반 outbox 재시도·unknown 행렬은 `conversation.test.ts`, 세션 지속과 목표 변경 자체는 기존 서비스 시험을 재사용한다. 위 목록은 다음 구현/검증 계획이며 실행 결과가 아니다.
