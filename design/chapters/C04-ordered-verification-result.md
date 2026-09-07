# C04 순차 검증 기록

## Checkpoint372 — 선택한 로컬20파일158개 확인

기본 등록 모델을 보존하면서 `runAgentCli`의 chat 분기에서 trusted `hostOptions`를 전달하도록 연결했다. 기존 비CLI9파일과 CLI2파일의 담당 생성·재접속은 같은 임시 registry를 사용한다. 제품 설정·사용자 CLI 옵션·실제 모델 연결은 추가하지 않았다.

첫 build1(session32504)은 합성 시험 host의 필수 `models` 필드 누락으로 exit2였다. 기존 미등록 상태와 같은 빈 모델 등록표를 시험에 추가한 build2(session62563)는 exit0이다. 후속15파일(session28003)은 **107/107 통과**, 실패·취소·건너뜀0이다. 일반/복합 실행, compact·재접속, 목표 변경과 같은 요청 재전송, CLI/로컬 HTTP/화면 상태를 기존 판정으로 확인했다. 새 회귀는 지정 등록표를 생성하면서 기본 registered 모델이 도구 근거를 읽고 답한 뒤 다른 프로세스에서 같은 업무를 조회하는 경로다.

이전 핵심5파일51개와 합친 선택 고유 시험은 **158개**다. 앞51개와 뒤107개는 서로 다른 기록된 빌드에서 실행했으며 같은 최종 소스로 전체를 재시험한 수치가 아니다. [실행·빌드 기록](../../runtime/evidence/C04-ordered-checkpoint.json) · [107개 원로그](../../runtime/evidence/C04-ordered-target2.log). 최종 지문은 `578542798a5b4edfa21734cdf456c6a1bff7b0546f4d807487e5f33b07d556ca`다.

실제 모델 품질·사용량·취소·tokenizer와 현재 Linux/native Windows·최종 통합 인수는 미완료다. 실제 모델/API 시험 중단을 유지한다. 다음 C05는 [기존 시험 및 연결 공백](C05-ordered-verification-preparation.md)을 재사용한다.

## Checkpoint371 당시 핵심 묶음 이력

checkpoint371. C03 복구 중단 fixture를 준비하는 동안, 이미 격리된 기존 C04 핵심 5파일 **51/51 통과**를 확인했다. C03 잔여와 C04 입구·문맥·목표 변경의 후속은 계속 남는다. [원로그](../../runtime/evidence/C04-ordered-target1.log) · [실행 지문](../../runtime/evidence/C04-ordered-checkpoint.json).

가설을 지지하던 초기 관측 뒤 반대 근거가 들어오면 가설을 수정하고 바뀐 작업 그래프에 대해서만 재계획을 정산하는 기존 흐름을 확인했다. 단순 요청은 불필요한 가설 호출을 추가하지 않고, 구조 검증을 거친 계획·도구 계약·현재 근거·완료 판정을 연결한다. 원문이나 필요한 도구가 없으면 응답·계획을 만들어내지 않는 시험도 포함한다. 이는 ScriptedPlanner와 합성 응답에 대한 구조/실행 증거이며 실제 모델의 가설·반론 품질을 입증하지 않는다.

실행은 C03 build4의 지문 `e6ea677ed53f2986942e4c702459c6918b02816afeddea6dd38aa9d75126bc6c`, macOS arm64·Node v24.20.0, session87471 exit0이다. 모델/API 실제 호출·외부 서비스는 실행하지 않았다. 후속은 [기존 시험 준비와 chat 연결 누락](C04-ordered-verification-preparation.md)을 따른다.
