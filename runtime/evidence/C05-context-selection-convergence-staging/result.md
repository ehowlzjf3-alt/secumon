# 실제 ContextCompiler 수렴 반례 — 현재 dist 단회 실행

두 신규 회귀는 staging의 `src/tests/context-selection-convergence.test.ts`에 작성했다. 기존 context-inspection-selection 시험의 SQLite/FileArtifactStore/StructuredPlannerAdapter 조립을 재사용했다. 필수 catalog 2개와 크기가 다른 optional 2개, 실제 직렬화 바이트를 반환하는 명시적 유한 token estimator를 사용한다. 실제 모델/tokenizer 품질에 대한 시험은 아니다.

Node 24에서 이 시험 한 파일만 TypeScript transpileModule로 변환하고 import 경로를 당시 dist로 고정해 1회 실행했다. 제품/shared dist 빌드나 semantic typecheck는 담당자가 실행하지 않았다. 결과는 **2개 중 0 pass / 2 fail, child exit1, signal null, timeout false**이며 두 회귀가 예상한 현재 결함을 각각 검출했다. 실행 관리 스크립트 자체 exit0은 증거 기록 완료를 뜻하며 시험 통과가 아니다.

- 같은 실제 full request: 180 tokens / 13723 bytes. 한도는 150 tokens / 1000000 bytes이다.
- 그 full packet/options에서 fixture.b만 제거하고 activeToolIds/policy.allowedTools/omitted count를 일관되게 바꾼 요청을 동일 adapter estimator로 측정: **140 tokens / 9444 bytes**, 실제 fit. 최소 문맥만 fit한다고 가정한 시험이 아니다.
- full 후보 비용 합은 6259다. inspect와 prepare 모두 실제 전체 4툴/180tokens 요청을 **6번 똑같이 측정**했다.
- inspect는 이후 필수 catalog 2개만 남기고 100tokens로 materialize하여 유용한 fixture.a 유지 assertion에 실패했다. inspect 자체 쓰기0, materialize frame1, 모델·도구 invoke0이 관측됐다.
- prepare는 frame을 쓰기 전에 `model_input_limit`으로 실패했다. 모델·도구 invoke0이다.
- 각 시험의 사전 full request 측정은 별도 frame1을 만들지만 state를 변경하지 않는다. 측정 이후 writesBefore를 기준으로 본 실행의 쓰기를 분리했다. 로그의 frameWrites는 이 차이다.

최소 제품 후보는 두 루프가 next budget을 계산할 때 `Math.min(budgetBytes, chosen.bytes)`를 비율에 곱하는 것이다. 실제 측정·6회 선택 상한·기존 필수 정보 및 최소 fallback은 유지한다. 담당자는 교정한 코어를 실행하지 않았으므로 교정 통과를 주장하지 않는다.

이 재현은 별도의 결정적 optional-tool 입력이다. collection new6 원 실행에서 어떤 중간 evidence/observation 조합이 fit했는지를 직접 재현한 것은 아니다. 해당 입구의 실제 실패 로그와 구분해야 한다.

회귀는 교정 이후에도 두 필수 tool, fixture.a 유지, exact token/byte fit, state/goal 불변, invoke0, inspect 무쓰기와 frame1, memo cycle1 및 전체 estimator 호출 상한(inspect10 / prepare8)을 확인한다. 기존 '모든 optional이 반드시 overflow' 회귀는 바꾸지 않는다.

baseline 실행 당시 source/dist before/after는 baseline1.json에 보존되어 있고 현재 지문으로 덮어쓰지 않는다. 이 manifest를 작성하는 사이 부모가 compiler를 교정하고 동일 시험 SHA를 COPYFILE_EXCL로 제품에 통합했다고 알렸다. 부모의 실제 별도 기록은 `../C05-context-selection-correction-integration1.json`이며, 담당자는 제품·기존 staging에 쓰지 않았다. 현재 제품 시험 존재는 이 **부모 통합 이후 관측**이다. 부모 build9/후속 시험 진행은 본 baseline의 통과로 합치지 않는다.
