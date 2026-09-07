# C05 — 문맥 선택의 미사용 byte 예산 반복 검토

읽기 전용 진단이다. 제품·시험·기존 evidence·staging은 수정하지 않았고 빌드·시험·재현·외부 연결을 실행하지 않았다. 아래 계산 예는 코드에서 도출한 반례 조건이며 실제 실행 결과가 아니다. 현재 collection 입구 로그의 실패 원인과 별도의 선택 효율 문제를 구분한다.

## 로그로 확인한 범위

`C05-mcp-collections-new5.log:10`의 진단 JSON에는 원 부모 failed/adopted=false와 child succeeded/adopted=true, 상태 근거 2개가 있다. 최종 질문을 만든 turn에는 evidence=[]/collections=[]/tools=[]이며 실제 입력 추정은 tokens=bytes=17426이다. 이 자료에는 반복별 선택 예산·후보 비용·선택 표현·최소 추정 및 중간 후보의 추정치가 없다. 따라서 **근거가 최종 입력에서 빠졌다는 것은 확인되지만, 그 근거가 당시 창에 들어갈 수 있었다거나 아래 반복 정체가 그 실행에서 발생했다는 증거는 아니다.** core evidence lookup 없는 fixture 개선과 이 효율 진단은 분리한다.

## 소스로 확인한 계산 경계

- `context-compiler.ts:601–610`은 최초 예산을 `maxInputBytes - fullBase.bytes`로 잡고, 초과하면 그 **할당량 전체**에 `min(byteLimit / measured.bytes, tokenLimit / measured.tokens)`를 곱해 64를 뺀다. 최대 6번 선택·측정 후 `useMinimum()`으로 돌아간다.
- `context-selection.ts:35–37, 63–87`은 실제 선택한 후보 비용을 별도 `chosen.bytes`로 반환한다. 큰 예산에서 모든 후보가 선택되면 예산을 줄여도 한동안 선택/추정치는 완전히 같을 수 있다. 같은 원 memo를 반복 사용하므로 이 반복 자체가 새로운 사용/노화 cycle을 만들지도 않는다.
- 기존 비-inspect 경로 `context-compiler.ts:613–635`도 같은 예산 갱신식을 사용한다. 차이는 6회 후 `model_input_limit`으로 실패한다는 점이다. inspect는 이미 검증한 최소 문맥으로 성공할 수 있어, 이전의 불필요 오류가 현재는 불필요한 optional 전부 제거로 보일 수 있다. 새 collection 기능만의 알고리즘은 아니다.
- `:420–423`의 일반 evidence는 목표 criterion/직접 입력 참조/최근 명시 조회로 보호되지 않으면 최소 표현이 omitted이다. 따라서 `useMinimum()`이 이를 전부 빼는 것은 보호 규칙 위반이 아니지만, 더 유용한 fit 조합을 시도하지 못한 경우에는 품질 손실이다.

정적 반례 조건: B0=1,000,000, 선택 비용=10,000, byte 한도는 여유가 있고 매번 token 비율=0.75이면 B1…B5는 749,936 / 562,388 / 421,727 / 316,231 / 237,109다. 모두 선택 비용보다 훨씬 커서 같은 optional 조합을 6번 측정한 뒤 최소로 돌아간다. 그 사이 fit하는 부분집합의 존재 여부는 검사하지 않는다.

그 부분집합이 존재할 수 있다는 반례도 현재 selector 계약으로 구성 가능하다. memo=null, 필수 비용 2,000, optional A full=3,000, B full=5,000/reference=100, A 우선순위>B로 둔다. 유효한 결정적 estimator가 최소=500 tokens, A 추가=600, B full 추가=900/reference 추가=10, 한도=1500을 반환하면 전체=2000은 초과하지만 최소+A+B reference=1110은 fit이다. 실제 encoded bytes를 정확히 반환하는 estimator와 적절히 패딩한 후보를 사용하면 이 구성을 시험으로 만들 수 있다. 지금 이 수치의 fixture나 실행 결과를 만든 것은 아니다.

## 가장 작은 교정 후보

두 반복문의 갱신에서 미사용 할당분을 제외하여 다음 식을 검토한다.

```ts
const ratio = Math.min(limits.maxInputBytes / measured.bytes,
  limits.maxInputTokens / measured.tokens);
budgetBytes = Math.max(0, Math.floor(Math.min(budgetBytes, chosen.bytes) * ratio) - 64);
```

반례에서 다음 예산은 7436이므로 compact 목표 약 5205 안에 필수+A+B reference(5100)가 들어가고 실제 estimator가 이를 다시 확인한다. 새 전역 예산/캐시/API나 item별 token 추정기를 만들 필요는 없다. 두 경로의 식을 함께 좁게 맞추고 기존 6회 상한, 실제 측정, required 보호, 무쓰기 inspect, materialize 현재성 검사를 유지한다.

이는 **미사용 예산으로 같은 선택을 계속 측정하는 정체**를 없애는 후보이지 최적 부분집합을 보장하는 탐색은 아니다. selector의 low watermark·residency는 그대로 적용되므로 축소가 거칠 수 있다. 그 점을 새 최적화 프레임워크로 확장하지 말고 아래 회귀로 유용한 선택이 보존되는지 먼저 증명해야 한다.

## 필요한 최소 증거·회귀

1. `context-inspection-selection.test.ts` 기존 fixture에 optional 두 개와 위처럼 결정적 token pressure를 둔 한 사례를 추가한다. 큰 byte cap/작은 token cap에서 전체는 초과하고 **명시한 optional A를 포함한 실제 요청은 fit**임을 같은 estimator로 먼저 증명한다. 현재 코드에서 inspect→materialize가 A를 빼는 실패를 기록한 뒤 교정에서 A 유지·실제 token/byte 한도·필수 정보·추정 횟수 상한·모델 호출 0·inspect 쓰기 0·frame 1을 검증한다. 같은 사례를 prepare 경로에도 적용하면 이전 경로의 불필요 model_input_limit을 함께 잡는다. 무조건 optional을 넣게 하는 assertion은 금지하고 fit 증명이 선행돼야 한다.
2. 기존 `token-driven optional reduction…` 시험(:63)은 optional이 있으면 1000 tokens, 없으면 1, 한도 10이다. **어떤 optional도 fit하지 않는** 정상 최소 fallback 시험이므로 그대로 유지한다. 정확히 맞는 필수 요청(:48), invalid estimator(:76), `context-inspection.test.ts:151` optional 도구 선택, `context-selection.test.ts` hysteresis/residency/required 회귀도 변경 없이 유지한다. 기존 시험은 이 중간 fit 조합을 검증하지 않는다.
3. new5의 실제 원인을 구분하려면 원 state/session/profile/window/이전 memo를 고정한 무송신 재현에서 각 반복의 budgetBytes, chosen.bytes, representation 목록 또는 지문, measured bytes/tokens, fullMinimum을 수집해야 한다. 그 자료로 반복 선택이 같았는지 확인하고, 같은 출처 검증을 유지한 최소+A 후보를 실제 preview/full estimator로 재측정한다. 크기 정보 없이 evidence=[]만 보고 불필요 제거라고 결론내리지 않는다. 해당 관측은 아직 수행하지 않았다.

## 읽기 시점 파일 지문

2026-09-07T15:25:59.788168+00:00

- `runtime/src/application/context-compiler.ts`: `fa558fd30dca1d58606d91ce848c12652a773a3be394202d3d37445c6c55c93c`
- `runtime/src/application/context-selection.ts`: `9405d2109822d10a892fd8633de08bc3428a646c766bcd8650b0656295b31c34`
- `runtime/src/application/model-context-preview.ts`: `83d2bf1dd76903d8d0346b91fe738da0c3c10f5c5631bc6be076278905295294`
- `runtime/src/tests/context-inspection-selection.test.ts`: `01ad097358bc6f604a852b74dc163cb6d432ff2db5d4e6e32aa394c967e032b3`
- `runtime/src/tests/context-inspection.test.ts`: `1e7eafdf4d4c9f2bbc74a9fcc3783bbb11ec15407285e400f7f5603c6ef84ac0`
- `runtime/src/tests/context-compiler.test.ts`: `33af3b6455d941ad0084b77631e42c1103daf5a2ce1da3d49908628f251fb0ff`
- `runtime/evidence/C05-mcp-collections-new5.log`: `26ff3f40cce9b36e371ef8b6aa418c4dd51b933270d3e0e0fe402e854f7ac760`
