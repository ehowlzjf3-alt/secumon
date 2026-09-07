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
