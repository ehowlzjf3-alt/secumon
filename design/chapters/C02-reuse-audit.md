# C02 착수용 재사용 조사

2026-09-06 · 읽기 전용 조사 · 구현/검증 완료 아님

C02는 작업이 끝나도 같은 담당·사용자의 세션 문맥을 유지하면서 다음 작업을 이어가는 연결이다. 기존 작업 엔진을 다시 만들지 않는다. C01의 담당 생성·기본 저장 통과를 이 세션 기능 완료로 설명하지 않는다.

| 연결 지점 | 유지할 동작 | 필요한 추가 연결 |
| --- | --- | --- |
| `domain/conversation.ts`의 ConversationBinding | 채널·사용자·대화 연결 | 호스트가 확인한 agentId(담당 식별자)와 sessionId(계속 이어지는 대화/문맥 식별자). 채팅방 번호만으로 소유권 결정 금지 |
| `application/conversation-service.ts`의 accept, `new-work.ts`의 newWork | 인증·중복 접수 방지, 작업별 새 목표·계획·근거·자원 장부 | 기존 작업 후속 입력인지 같은 세션의 새 작업인지 연결. 새 작업을 만든다는 이유로 세션 문맥을 폐기하지 않음 |
| `infrastructure/local-channel.ts`의 send/messages | 전달된 응답·중복 방지·조회 권한 | 사용자 입력도 포함하는 transcript(대화 원문 이력)를 세션 순서로 저장. 원문 이력 전체가 모델 입력은 아님 |
| `application/context-store.ts`의 frameMatches/previous/stage | workId·목표 버전·정책·데이터 세대 검사 | 세션 문맥을 별도 입력으로 연결. 과거 결론의 원래 작업/출처 유지. 이전 프레임을 새 작업의 증거나 완료 조건으로 자동 승격하지 않음 |
| `application/context-compiler.ts`의 prepare, context-selection의 selectContextItems | 용량·최근 사용·본문/참조/제외 선택 | 핵심 합의·미해결 질문·최근 대화·원문 참조의 세션 요약. 기존 ContextMemo는 항목 선택 이력이지 대화 요약이 아님 |
| `application/planning-runtime.ts`의 reserve, context-recovery의 restore | 입력 산출물 고정·작업 contextHead·정본 재검증 | 세션 문맥 버전·이력 반영 위치·활성 작업도 복원. 같은 세션의 두 실행기가 서로 덮어쓰지 않게 제어 |
| `application/knowledge-service.ts`의 get/search/create | 신뢰한 사용자·namespace(기억의 구역) 검사와 기억 기능 | 세션을 이어가기 위해 개인 장기기억 create를 자동 호출하지 않음. 원문 이력·현재 문맥·선별 장기기억을 계속 분리 |
| `application/compose-runtime.ts`, `presentation/local-workbench.ts`의 accept | 공통 실행 조합과 현재 Web 접수 | LocalWorkbench의 직접 newWork 호출도 세션 접수로 연결. CLI만 이어지고 Web은 새로 시작하는 차이 방지 |

추가 시험은 X 작업 완료 후 Y에서 합의 유지, 다른 담당/사용자 격리, compact 이후 프로세스 재시작, 같은 세션의 동시 입력·문맥 게시를 우선한다. 기존 conversation/context-store/context-selection/context-reservation 시험을 유지한다. 새 저장 계약과 구체 구현 계획은 C02 착수 시 현재 소스를 확인해 확정한다.
