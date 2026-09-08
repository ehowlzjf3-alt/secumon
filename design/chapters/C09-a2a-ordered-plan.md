# C09 A2A 등록·접수·실행 인수

2026-09-08 · checkpoint380. 직전 단위는 C08 신규5개와 영향11개의 실제 소스별 검증, 기록, `ca9913a4a72ee887bcf28359d9f5f5f89164b13a` 게시·원격 일치 확인으로 진행했다. 현재 작업 트리는 깨끗했고 활성 실행은 없다. 전체 goal은 미완료다.

[C09 준비 문서](C09-ordered-verification-preparation.md)의 첫 단위다. A2A는 다른 에이전트에게 업무를 보내고 현재 상태·답변을 가져오는 연결이다. 요청이 접수됐다는 응답, 수신 담당의 실제 실행, 발신 담당이 검토한 답변·자기 목표 완료를 따로 확인한다.

- 현재 `A2aJsonRpcPeer`, `openHostA2a`, 일반 profile의 `openA2aHandler`와 세션·작업·전달 원장을 재사용한다. 클라이언트의 fetch를 실제 수신 handler에 연결한 로컬 전송 대역을 쓰며 HTTP listener나 인증 서비스를 가동하지 않는다.
- root는 독립 SQLite 담당 둘과 등록된 구조화 모델 대역으로 일반 도구 실행→원 접수→명시 실행→답변 조회, 재전달·서로 다른 caller/담당, 후속 질문·취소와 미확정 송신을 확인한다. 모델은 자기 공개 문맥만 읽는다.
- 별도 작성자는 전송 계약의 원 요청·응답 ID·크기·취소·timeout·close, 호스트의 기능 off/on·권한·등록/종료 경계를 작성한다. 같은 guard를 위한 과도한 행렬은 만들지 않는다.
- 소스 동결 후 root가 Node v24.20.0으로 한 빌드를 만들고 신규 시험부터 실행한다. 실패가 확인되면 최소 제품 교정과 직접 영향 시험을 추가한다. 통과한 이전 C08 또는 C01~C07 전체 시험을 반복하지 않는다.

설정의 endpoint·인증된 caller·권한·agent/session ID를 수신 metadata로 교체하지 않는다. 원격 완료와 동의는 로컬 독립 근거나 자동 완료가 아니며, 송신 뒤 응답 유실을 자동 재송신으로 해결하지 않는다. 닫힌 profile의 남은 도구/peer/source 참조도 호출을 시작하지 못해야 한다.

실제 모델/API·사내 서비스·Knox·외부 A2A 호출 중단은 유지한다. 현재 지원하는 text/data와 세 RPC의 로컬 인수이며 외부 상대 상호운용, listener 인증, Linux/native Windows·PostgreSQL 운영 검증을 완료로 표시하지 않는다. 이 단위 뒤 사건·상시 임무·협업 비교와 C10을 이어간다. 진행은 `runtime/evidence/checkpoint380.json`에 저장한다.
