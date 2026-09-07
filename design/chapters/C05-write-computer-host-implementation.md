# C05 일반 쓰기·컴퓨터 유즈 호스트 연결

2026-09-08 · checkpoint364 구현 연결 기록. 일반 담당의 호스트 등록은 기존에 읽기 도구·collection만 받았다. 컴퓨터 유즈 코어와 일반 쓰기 실행기는 있었지만 이 입구에 연결되지 않았다. 이번 단위는 그 조립을 연결하며 기존 추론·실행·세션·원문·정산을 재사용한다.

## 구현하는 연결

- `host.tools.open()`의 기존 `tools`는 읽기 도구 입력으로 유지한다. 일반 쓰기는 선택 `writeTools`로 명시한다. 쓰기 결과는 기존 `artifact-proof-v1` 원문 검증과 `validateResult`를 제공해야 한다.
- 동적 목록은 해당 `providerSources` 항목의 `allowWrites:true`를 명시한 경우에만 쓰기 계약을 받을 수 있다. 현재 업무의 도구/목적지/라벨/쓰기 권한은 여전히 별도로 적용한다. 전체 provider 목록을 모델 프롬프트에 고정해서 넣지 않는다.
- 일반 쓰기 공급자는 같은 provider의 `effectReaders`를 등록한다. 현재 영수증 검사, 저장 결과 재확인, 원 시도의 미확정 효과 대조를 기존 `EffectProofValidator`로 연결한다. 원 쓰기를 재전송하는 API가 아니다.
- `computerTools`는 호스트가 만든 `ComputerBinding`을 받는다. 기존 `prepareComputerBinding`과 `createComputerTools`로 네 도구(관찰·행동·재개·검증)를 만들고 같은 `ComputerUse`·정산·복구 서비스에 연결한다. 별도 도구 루프나 driver 프로세스를 만들지 않는다.
- 일반 읽기/쓰기/collection/컴퓨터 도구의 ID·버전 충돌과 provider 목록의 소유 충돌을 함께 검사한다. 동일 driver/session의 중복 등록과 core 사칭은 거절한다.

바인딩은 화면 세션과 도구 계약을 호스트에 고정하는 설정이다. 모델 입력은 관찰 결과의 대상 참조와 허용된 행동만 선택하며 endpoint·스크립트·driver 모듈을 교체할 수 없다. 기존 원문·checkpoint·부분 성공·unknown 구분과 실제 행동 전 권한 재검사를 재사용한다. 외부 도구 코드 자체는 신뢰된 호스트 코드이며 같은 OS 계정의 임의 코드를 차단하는 sandbox라고 설명하지 않는다.

일반 담당의 `policy.allowWrites`는 등록과 별개의 실행 권한이다. 컴퓨터 바인딩이 있어도 쓰기 권한이 없으면 관찰·검증 경로만 실행할 수 있다. 일반 쓰기의 결과 영수증을 확인할 공급자가 없거나 원 tool 계약·provider가 달라지면 미확정/사용 불가로 남긴다. callback이 반환한 상태로 원 업무를 덮어쓰지 않으며 원 저장소를 다시 읽는다.

종료는 기존 담당 lifetime 중단 → 호스트 연결 종료 → 실행기의 제한된 결과 정리 → 저장소 종료를 사용한다. driver의 lease 해제·만료 보장은 driver 계약이며 현재 사용자 앱을 임의로 종료하는 기능은 아니다.

## 별도 검증 항목

아래 항목은 구현 후 검증 단계에서 수행하며 이번 단계의 통과 결과가 아니다.

1. 읽기 전용 기존 등록과 명시 쓰기 등록, 권한 없는 act 거절, generic 결과/영수증 위조·provider/계약 불일치 거절.
2. 동적 provider 갱신에서 쓰기 선언·도구 퇴출·provider 소유 충돌, 원 호출 unknown 상태와 미사용 자원 반환 보류.
3. computer 관찰→행동 묶음→결과 확인·부분 성공/대기→재개, 동일 세션 독점과 driver metadata 변경, 일반 CLI/Web에 같은 서비스 적용.
4. 모델이 반론/재계획하면서 구조화 도구와 UI 도구를 선택하고 미사용 계약을 활성 문맥에서 정리하는 기존 흐름과의 통합.
5. 취소/종료/늦은 응답에서 원문·사용량·미확정 효과 유지, 등록 종료 1회와 일반 담당별 자료 분리.
6. 기존 synthetic/instrumented-web driver로 로컬 연결을 확인한 뒤, 실제 Linux/Windows driver·MCP/사내 시스템은 별도 실제 연동으로 판정한다. 실제 모델/API 시험 중단은 유지한다.

최종 통합 빌드·대상 소스·원로그는 [체크포인트](../../runtime/evidence/C05-write-computer-host-checkpoint.json)에 기록한다. 현재 구현 검증과 운영/모델 품질 검증은 구분한다.

TypeScript build1(session2144)은 actual exit0이다. 최종 빌드 지문과 5개 변경 소스 지문을 체크포인트에 저장했다. 상세 시험과 실제 도구/컴퓨터 호출은 실행하지 않았다.
