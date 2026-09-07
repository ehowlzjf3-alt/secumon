# 로컬 변경 전후 계측 결과

2026-09-07 KST · Node v24.20.0 · macOS arm64 · 합성 fixture 4개 × read/list × 각 5회 × 변경 전후 = 계측 호출 80회. 각 worker의 별도 warmup 1회는 계측 밖이다. NAS 결과와 구분한다.

**안정 목록의 중복 데이터 읽기 제거를 확인했다.** 네 목록 fixture 모두 파일당 open과 JSON.parse가 2회→1회, 전달된 직렬화 bytes가 절반으로 줄었다. read는 기존 1회 open/parse/원본 길이를 유지했다. 새 안정성 검사가 메타데이터 조회를 추가하므로 전체 I/O 감소를 의미하지 않는다.

| 목록 fixture | record open / JSON.parse 전→후 | 직렬화 전달 bytes 전→후 | 계측 포함 elapsed 중앙값 ms 전→후 |
|---|---|---|---|
| 단일 0 bytes | 2→1 / 2→1 | 788→394 | 7.645→7.544 |
| 단일 4 KiB | 2→1 / 2→1 | 11,722→5,861 | 7.702→7.744 |
| 단일 1 MiB | 2→1 / 2→1 | 2,797,008→1,398,504 | 10.979→10.605 |
| 혼합 8개 | 16→8 / 16→8 | 4,039,588→2,019,794 | 13.827→12.084 |

혼합 목록의 file fstat는 16→16, file lstat는 0→8, directory lstat는 39→55였다. 단일 read의 file fstat는 1→2, file lstat는 0→1, directory lstat는 39→41이었다. 모든 호출의 directory fstat와 directory fsync는 각각 6회로 같았다. 카운터는 fs API에서 실제 관측한 호출이며 Node 내부 binding 또는 장치 I/O 전체를 뜻하지 않는다.

동일 fixture의 직렬화 파일 bytes, 반환 metadata/원문, 실제 JSON.parse 검증 입력의 hash 집합이 전후 일치했다. 측정 중 원본은 보존됐고 임시 fixture 디렉터리는 남지 않았다. 이 비교는 정상·안정 입력을 사용하며 오류·경합 회귀 시험을 대신하지 않는다.

시간은 warm cache와 계측 장치가 켜진 public read/list의 lock·sync 비용을 포함한다. 작은 표본에서 빨라진 항목과 느려진 항목이 함께 보였으므로 보편적인 latency 개선을 주장하지 않는다. heap delta도 JSON 입력 참조를 보관하는 계측 비용을 포함해 원본 JSON에만 기록했으며 메모리 절감으로 해석하지 않았다.

원본 본체 SHA-256은 `c6b52d691b429a79b2853e915014160b05f60a984ae74a7a576134815456917e`, 변경 후 본체는 `93624e13953dc00780bf8eed23c27a5a6d37a9f9cc73fabc9c271fd2f77607e6`이다. 직전 NAS build manifest의 정규 files digest가 `a198150280bc635ae6b7e4dbe75ec2c73604fcf4a2bc8735d32eff3186019eeb`와 일치하고, 원본 본체 및 공통 compiled JS 의존성 42개의 해시가 모두 같음을 확인했다. 준비 중 새 빌드가 이루어진 사실과 최초의 source archive 대조는 provenance에 남겼다.

근거: [변경 전 원본 결과](baseline-measurement.json), [변경 후 원본 결과](after-measurement.json), [직전 빌드 대조](baseline-build-provenance.json), [계측 정의](README.md). source/build 및 제품 시험 결과는 이 계측에서 새로 검증하거나 통과로 표시하지 않는다.
