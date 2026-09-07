# 일반 담당에 쓰기·컴퓨터 유즈 등록

`openAgentTurnProfile`에 전달하는 기존 호스트의 `tools.open(context, assembly)`에서 다음 항목을 반환한다. `assembly.custody`는 그 담당의 실제 상태·원문·지문·시계 포트이고 `assembly.signal`은 담당 수명 신호다. 도구 어댑터가 별도 담당 DB를 열지 않도록 이 포트로 조립한다.

```ts
return {
  tools: readTools,                  // 기존 읽기 도구
  writeTools: writeAdapters.map(item => item.tool),
  effectReaders: writeAdapters.map(item => ({
    provider: item.provider,
    reader: item.effectReader,       // current / refresh / recover
  })),
  computerTools: [computerBinding],
  policy,                           // 현재 담당의 도구/라벨/목적지/쓰기 허가
  limits,                           // 기존 작업 자원 한도
  close: closeOwnedAdapters,
};
```

위 변수들은 호스트가 준비한 실제 어댑터와 정책이다. 예제 자체가 임의 어댑터를 내려받거나 연결하지 않는다. 읽기 도구만 있으면 새 필드는 모두 생략한다. 일반 쓰기는 `effect:'write'`, `resultValidation:'artifact-proof-v1'`, 원문을 검증하는 `validateResult`와 같은 provider의 효과 확인 reader가 필요하다. `recover`는 원 실행의 영수증/현재 결과를 조회해 대조하며 쓰기를 재전송하지 않아야 한다.

동적 목록에서 쓰기를 사용하려면 기존 `providerSources` 항목에 `allowWrites:true`와 같은 provider의 `effectReaders`를 함께 등록한다. 선언이 없으면 목록은 계속 읽기 전용이다. provider 갱신은 기존 도구 목록·계약 선택·퇴출 경로를 사용한다.

`computerBinding`은 기존 `ComputerBinding` 계약이다. 호스트가 provider·ID·버전·목적지·라벨·화면 sessionId·driver·행동 한도를 정한다. 런타임은 `<id>.observe`, `<id>.act`, `<id>.continue`, `<id>.verify`를 같은 코어에 등록한다. 실행할 도구 ID와 목적지는 `policy.allowedTools`/`allowedDestinations`에 명시해야 하며, `policy.allowWrites:false`이면 행동 입력을 허가하지 않는다.

기존 `SyntheticComputerDriver`는 합성 동작 확인용이고, `InstrumentedWebComputerDriver`는 계측된 웹 화면의 타입이 정해진 프로토콜용이다. 이를 일반 사이트 전체나 OS 네이티브 입력 지원으로 설명하지 않는다. 사내 driver는 같은 계약으로 공급하며 실제 Linux/Windows 입력·취소·세션 독점은 별도 인수에서 확인한다.

등록 callback과 reader는 신뢰된 호스트 코드다. 사용자 채팅, 담당 설정의 문자열, 모델 응답으로 모듈이나 스크립트를 로딩하지 않는다. 호스트 연결 종료는 자기 소유 어댑터만 닫으며 사용자의 앱이나 다른 담당 세션을 종료하지 않는다.
