# C05 collection 인수 시험 교정 진단

원 focused 실행은 exit 1, 110개 중 103 통과·7 실패다. 이 메모의 담당 범위는 그중 5개 실패이며, 남은 context 시험 2개는 별도 담당 범위다. 원 로그와 staging은 변경하지 않았다.

- `host-collection-profile.test.ts` 두 backend 실패: `FileArtifactStore.get()`은 `Uint8Array` 계약 아래 실제 `Buffer`를 반환하고, fixture는 TextEncoder의 `Uint8Array`를 보관했다. 원 로그 123–190행은 값의 길이·내용보다 concrete prototype 차이에서 deepStrictEqual이 실패했음을 보인다. 최초 읽기와 재열기 두 비교를 모두 `Buffer.from(actual)` 대 `Buffer.from(expected)`로 바꾸었다. byte 전체 비교는 유지한다.
- `read-complete-resume.test.ts` 정상 2개와 게시 후 취소 1개 실패: `work-transactions.ts:19`는 이벤트에 `data: { payload: data }`를 저장한다. fixture의 `childEvents`가 `event.data.attemptId`를 조회하여 실제 child checkpoint 이벤트를 0개로 셌다. 실제 경로 `event.data.payload.attemptId`를 읽으며 envelope/payload가 object인지 assert하도록 교정했다. 게시 후 취소 hook은 잘못된 count assert가 먼저 던져 hits 증가·취소 호출에 도달하지 못했던 경계다. 교정 후에도 정확한 이벤트 수 1, 미게시 수 0, 실제 hook hit 1을 요구한다.

부모/child lineage, 원 owner와 영수증/원문, logical tool call 1·child transport 0, 등록 execute/source.fetch/reuse 추가 호출 0, 취소 후 비채택 검사를 제거하거나 완화하지 않았다. 이번 읽기 진단에서 이 5개 실패를 설명하기 위한 제품 결함은 확인되지 않았다. 제품 코드·기존 staging·원 실행 로그는 그대로이며 빌드/시험/SSH는 수행하지 않았다. 교정본의 실행 결과는 아직 없다.

## 변경 지문

- `runtime/src/tests/host-collection-profile.test.ts`
  - 교정 전: `5b6819d41bda6e05c9f6dd69d9aeaa8e6381c9a1b6431247820624d862bf4a94`
  - 교정 후: `5d7b08ad1068859b4ffa467d218cfd021f22b552922cb485f925c0e8bc301121`
- `runtime/src/tests/read-complete-resume.test.ts`
  - 교정 전: `a681a9245b75474e62378c1786c0473b7f655b9acf773e2d47a20500af6df89b`
  - 교정 후: `9140ca4c69f24795b26cacfe7e484000adb89bdb7e44b5094f21c144f325cd71`

## 보존 확인

- `runtime/evidence/C05-mcp-collections-new1.log`: `21cdaed0dfdc4eaa9f669901c6cec3549d4c012c39432011244592811982c774` (전후 동일)
- `runtime/evidence/C05-mcp-collections-new1.json`: `03131a49fd24c8297ad405637683fbfa5a5011344dcdb4fded2c7222f1f1da05` (전후 동일)
- `runtime/evidence/C05-mcp-collections-staging/windows/src/tests/host-collection-profile.test.ts`: `5b6819d41bda6e05c9f6dd69d9aeaa8e6381c9a1b6431247820624d862bf4a94` (전후 동일)
- `runtime/evidence/C05-mcp-collections-staging/windows/src/tests/read-complete-resume.test.ts`: `a681a9245b75474e62378c1786c0473b7f655b9acf773e2d47a20500af6df89b` (전후 동일)
- `runtime/evidence/C05-mcp-collections-staging/windows/manifest.json`: `c1bc42b0fca074f9d5c35a34592268fcf1cf451063e08efbdca9e514bc6e1e3f` (전후 동일)

