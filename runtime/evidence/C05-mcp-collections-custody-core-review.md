# Collection custody A 코어 staging 읽기 검토

2026-09-08. [계획](../../design/chapters/C05-mcp-collections-custody-plan.md)과 원본 대비 staging 네 파일의 diff를 검토했다. 아래는 **실행하지 않은 정적 발견**이며 adapter의 원문 저장·usage 복원 구현이 완료됐다고 가정하지 않는다. 이 메모 외 source·staging·updater·기존 문서를 수정하지 않았고 빌드·시험·SSH를 실행하지 않았다.

## 수정할 구체 경계

**1. `restoreUsage` getter를 검사한 값과 등록한 값이 달라질 수 있다.** [read-collections.ts:36](C05-mcp-collections-custody-staging/core/src/application/read-collections.ts#L36), [47](C05-mcp-collections-custody-staging/core/src/application/read-collections.ts#L47).

새 메서드를 `!== undefined`, `typeof`, spread 조건, `.bind`에서 다시 읽는다. getter가 첫 두 번 함수 A를 반환하고 세 번째에 undefined를 반환하면 함수 검사는 통과했지만 등록에서 사라진다. A/A/A/B라면 검사한 A 대신 B를 등록한다. `createReadCollectionTool`의 `restoreReadUsage`와 Broker의 collection custody 선택 여부가 이 결과를 그대로 사용한다. 기존 source callback의 반복 조회 패턴에 새 보관 메서드를 추가하면서 같은 구멍이 생긴 것이다. plain `ToolContracts.snapshotTool`은 이미 메서드를 한 번 읽어 두는 방식이다.

최소 수정은 binding의 source 객체와 각 callback을 한 번 캡처하고, 같은 값으로 유효성 검사·필수 검사·원 receiver bind를 수행하는 것이다. getter 호출 횟수 1, 검사한 함수 고정, 등록 뒤 원본 메서드 교체 무효를 좁게 확인하면 된다. 새 프레임워크나 도구 정의 지문 변경은 필요 없다.

**2. 최초 intent receipt의 원 소유·시도 귀속을 확인하지 않은 채 고정한다.** [read-collections.ts:317](C05-mcp-collections-custody-staging/core/src/application/read-collections.ts#L317)–327.

처음 읽은 영수증은 command digest와 `readProgress.head`만 확인한다. 두 값을 그대로 둔 채 receipt.state의 work ID/createdAt/tenant/principal/자료 세대 또는 해당 attempt의 owner/inputDigest/contractDigest/startedAt/leaseUntil을 바꾼 영수증도 최초 조건을 통과한다. 저장소가 이후 같은 잘못된 영수증을 반환하면 `same(intentReceipt, freshReceipt)`도 참이다. Broker는 원 dispatch 영수증과 현재 work/attempt를 검사하지만 이 별도 intent 영수증의 state는 검사하지 않는다. 이 재현은 실제 저장소 손상을 주입한 시험으로 실행한 것은 아니다.

최소 수정은 최초 intent receipt를 이미 검증한 checkpoint·basis·원 attempt에 대조하여 같은 업무 incarnation/소유자/세대/원 task·contract·lease 귀속과 원 intent head를 확인한 뒤 그 전체 값의 불변을 재검사하는 것이다. command digest는 의도 종류·checkpointId·phase·calls를 고정하지만 receipt.state 전체의 출처 검증을 대신하지 않는다. 이미 읽은 cp/원 attempt를 사용하고, 나중의 **현재 mutable head를 원 dispatch pin에 다시 넣지는 않는다**. 최소 회귀는 correct digest/head를 유지한 owner 또는 generation 교체가 custody callback 전에 거절되는 경우다. adapter도 원 intent/dispatch/bytes를 독립 검증해야 하므로 이 발견을 실제 잘못된 raw 게시 성공으로 확대하지 않는다.

## 그 밖의 확인 범위

- [tool-broker.ts:25](C05-mcp-collections-custody-staging/core/src/application/tool-broker.ts#L25)의 collection 분기만 mutable `readProgress`를 원 attempt pin에서 제외한다. plain 기본값과 식별 항목은 유지된다. 원 dispatch 전체 지문, 원 task/contract, 현재 incarnation·owner·자료 세대 검사는 남아 있다. 합법적인 다음 head·후속 시도로 원 요청 귀속을 잃지 않게 하는 방향은 계획과 맞는다.
- 보관 callback은 취소·목표·현재 본문 정책을 송신 허가로 사용하지 않으며, Broker `custodyActive`와 `hooks.custodyCurrent`를 각 await 뒤 다시 확인한다. 페이지 wrapper도 원 intent 조회 전후에 Broker callback을 호출한다. 현재 실행용 authorize/current와 수신 page 검사는 별도로 유지된다. 수명 종료와 DB 게시의 원자화를 새로 보장하는 코드는 아니다.
- [tool-contracts.ts:219](C05-mcp-collections-custody-staging/core/src/application/tool-contracts.ts#L219)의 새 포트는 strict 입력·응답, 단일 원 attempt 선택, collection/read/proof 계약, 복사한 입력과 await/parse 뒤 등록 객체 동일성을 확인한다. 본문을 반환하거나 projection을 호출하지 않는다. callback이 받은 복사본을 변형해도 호출자 원본은 변하지 않는다. source callback의 실제 원 dispatch·request·intent·raw 증명과 시간 검사는 adapter 및 후속 B helper의 책임이며 이번 네 파일만으로 완료가 아니다.
- 새 intent receipt await 뒤 실제 transport에 들어갈 adapter는 기존 `context.authorize`를 즉시 호출해야 한다. custody callback은 그 검사를 대신할 수 없다. adapter가 작성 중이므로 이 이행이나 실제 전송 0을 이번 읽기로 통과 처리하지 않았다.

## 읽은 byte 기준

계획 SHA256: `f7d36e9d01a32de3e21b0b7f4eac5981e6c118fb6cf6a69dea766b0c4ab0f75f`.

| 파일 | 원본 runtime/src/application SHA256 | 검토한 staging SHA256 |
| --- | --- | --- |
| ports.ts | `a05319935d8db6ced11f808c3bf7736d38caa22224b802490f09116924b67e26` | `ae7a30573b5fc045b4f5b68b007943ea0b9c59fff6caa99a8a8560c6515a2cad` |
| tool-contracts.ts | `23fcab37da66e52cc5e441ceece3db9089cfd61db502cafbb1d1c0b74d23fb3e` | `edd05b79c94992cbeef5dee2e3c3aaf5f268932ac70ac81c2d2eba4b837aa0d0` |
| tool-broker.ts | `c27f2b5877c645a411c434c521536ec8aa43291bf0a09db401a91e48b296d028` | `125f3e0339f01256090c1b5f39c5d520f6bbe8f1af62d2651bbef4c8b8026dcd` |
| read-collections.ts | `d10955ecfcb008974287ec6aae6a63cfeafcf2c642a5913959858c1720485472` | `58f6d6cbb0792317b0c817bef2c11d2290c18af401486d047bf861fcd4ec9ea3` |

행 번호와 발견은 위 staging byte에 해당한다. 이후 root가 교정한 버전을 이 검토의 통과로 소급하지 않는다.
