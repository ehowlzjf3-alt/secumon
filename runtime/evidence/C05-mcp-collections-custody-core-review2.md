# Collection custody 코어 재검토 2

[review1](C05-mcp-collections-custody-core-review.md)의 두 지적에 대한 수정 부분만 [이전 보존본](C05-mcp-collections-custody-staging/core/read-collections-before-review1.ts)과 비교했다. **두 지적은 정적 코드상 해소됐다.** 추가 source·staging·updater 변경이나 빌드·시험·SSH 실행은 하지 않았다.

- [snapshot 등록](C05-mcp-collections-custody-staging/core/src/application/read-collections.ts#L34): source 객체와 fetch/manifest/validatePage/validateDeferral/restoreResponse/restoreUsage를 각각 한 번 읽는다. 같은 캡처 값으로 함수·필수 계약을 검사하고 같은 source receiver에 bind한다. getter 재조회 때문에 검사한 callback이 누락되거나 다른 callback으로 바뀌던 경로가 없어졌다.
- [최초 intent receipt](C05-mcp-collections-custody-staging/core/src/application/read-collections.ts#L327): digest/head만으로 승인하던 조건을 보강했다. 원 업무 incarnation, policy/goal/자료 세대, 당시 revision·시각, 단일 원 attempt를 검사한다. guard의 원 task/계약/실행 owner 검증 뒤 고정 attempt identity와 이미 검증한 state의 attempt를 대조하고, cp에서 계산한 progress 전체 및 정확히 한 indexed head를 확인한다. review1의 correct digest/head를 유지한 owner·generation 등 교체는 이 조건에서 거절된다.

초기 승인 뒤 callback은 고정 intent receipt의 불변과 Broker의 원 dispatch/custody 수명을 재확인한다. 변경 가능한 현재 head를 원 dispatch identity에 다시 넣지 않아 합법적인 head 진전 뒤 원 요청 보관을 허용하는 구분은 유지됐다. 최초 전송 전 guard와 나중의 보관 callback도 합치지 않았다.

이는 수정된 두 경계의 읽기 결론이다. adapter의 원 request/dispatch/intent/bytes 증명, 실제 getter·영수증 손상 회귀, 수명 종료 경합과 B/C 통합 인수의 통과를 뜻하지 않는다. 원본 receipt의 모든 시간·revision 순서는 adapter와 후속 증명 helper에서도 검증해야 한다.

| 검토 입력 | SHA256 |
| --- | --- |
| 보존된 review1 read-collections.ts | `58f6d6cbb0792317b0c817bef2c11d2290c18af401486d047bf861fcd4ec9ea3` |
| 수정한 staging read-collections.ts | `636ab27e5a2b7448f7761d6d97d2d09a512e2f5aad5c5f5714d62a6dc8d0162e` |

core manifest는 root가 갱신하며 이전 review의 SHA와 결론을 덮어쓰지 않는다.
