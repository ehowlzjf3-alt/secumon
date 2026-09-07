# P2-04 내부 I/O 비교 자료

이 폴더는 실제 모델/서비스를 호출하지 않은 합성 비교 증거다. 최신 제품의 전체 검증은 상위 `P2-internal-io-local-verification.json`과 `P2-internal-io-verify.log`를 따른다.

| 자료 | 용도 |
|---|---|
| `v024-baseline.tar.gz`, `v024-snapshot-manifest.json` | 계측 전 v0.24 빌드/fixture 430개 hash와 재현 runner/helper 보존. 압축 재추출 뒤 hash 확인 |
| `v024-original-metrics.json` | 변경하지 않은 기준선의 API 계수와 source/result/evidence 기대값 |
| `v024-instrumented-metrics.json`, `v024-instrumented-manifest.json` | 같은 legacy 코어에 관찰용 FileArtifactStore 계측만 적용한 파일 bytes/hash 기준선 |
| `instrumented-file-artifacts.js` | 모든 계측 비교에 동일하게 사용한 컴파일 adapter |
| `uncached-metrics.json`, `uncached-manifest.json` | 증분 저장·검증 범위 공유를 적용한 초기 구현. 반복 논리 복원으로 경과 시간이 늘어난 중간 결과 |
| `cache-intermediate-metrics.json`, `cache-intermediate-manifest.json` | 논리 계산 캐시를 적용한 중간 구현. 이후 chain/원본 경계 보강 전 결과 |
| `final-metrics.json`, `final-manifest.json`, `final-comparison.json` | 최종 전체 검증과 같은 제품 코드의 12개 실행, 각 프로필 의미·비용 대조와 한계 |
| `preservation.json` | 기준선 압축과 중간 증거의 보존 hash |

일반 회귀 검증은 runtime 디렉터리에서 고정 Node 24.20.0으로 `npm run verify`를 실행한다. `fixtures/internal-io/legacy-v024.json`은 과거 원 기준선에서 추출한 source/result/core state·근거 ID/lineage/관측/기록 시각·usage·복사 표현을 고정한다. 비교 시험은 정확한 의미 일치와 같은 계측 legacy보다 적은 본문 읽기/hash/본문 쓰기 총 bytes를 확인한다. 기대값을 최신 구현으로 자동 갱신하지 않는다.

보존한 archive는 의존 패키지를 포함하지 않는다. 별도 임시 폴더에 풀어 manifest를 검증하고, runtime과 같은 고정 의존성을 연결한 뒤 포함된 Node runner를 실행하면 원 기준선을 다시 측정할 수 있다. 당시 source 및 검증 이력은 상위 v0.24 기록을 따른다. 변경된 계측 기준선은 원 코드에서 `dist/infrastructure/file-artifacts.js`만 이 폴더의 계측 adapter로 바꾼 별도 사본이다. 중간/final manifest는 그 시점 빌드의 식별 자료이며 원본 코어를 현재 코드로 대체한 것으로 표시하지 않는다.

`physical`이라는 JSON 계수 이름은 FileArtifactStore 안에서 실제로 호출한 파일 API와 hash의 계측을 뜻한다. OS 물리 디스크 접근, OS 캐시 hit, CPU 시간, 모델 token/과금은 측정하지 않았다. 최초 두 프로필 일부 실행은 동시 부하가 있었고, 최종 프로필은 전체 verify 종료 뒤 따로 실행한다. 단회 walltime은 반복 실험의 p50/p95나 안정적인 속도 개선율이 아니다.

최종 코드는 재사용 전에 현재 원본을 확인한다. 원본 삭제/변조·정책/계약/기억 변경의 거부, stage 대기와 cache eviction 경합, chain/용량 상한과 두 backend 재시작은 별도 회귀 시험에서 확인하며 비용 측정 한 번으로 그 보장을 대체하지 않는다.
