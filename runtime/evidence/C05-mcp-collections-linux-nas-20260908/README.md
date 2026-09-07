# C05 MCP collection 일반 재개: NAS 후보 도구

상태는 **candidate_prepared_not_executed**다. 완료된 [offline helper](../C05-mcp-offline-linux-nas-20260907/README.md)를 최소 변형한 첫 native attempt용 후보이며, root의 diff 검토 전 실행하지 않는다. 이 후보 생성에서는 helper/selector/configure/SSH/전송/native/finalizer 또는 문법 검사 명령도 실행하지 않았다. 제품·시험·원 helper·이전 로그·proof는 그대로다.

최종 scope는 `mcp_collections_general_resume`, native scope는 `native_linux_mcp_collections_general_resume`다. 새 원격 결과는 `evidence-mcp-collections-c05`, 백업은 `before-mcp-collections-c05-attemptN`이다. 선행 결과는 완료된 `evidence-mcp-offline-c05/result.json`이다. [선행 proof](../C05-mcp-offline-linux-nas-20260907/verification.json) SHA `28cdec0cdcaa8d7e308e8341258218a6b85e31d5053f50cf914e5e6edd7f38b9`, 원 native result SHA `a64d5f74827c2db5ae3ecb103ce1863663d4de148f189129e0ac75b10a3607c3`를 configure/common/preflight/native/finalizer에서 연결해 검사한다. 선행 수치와 source pin을 새 결과로 복사하지 않는다.

## 아직 필요한 입력

- 일반 entry 인수 통합 뒤 확정한 source/build, 동일 pin의 실제 build/new/related/core/architecture 성공 원본과 terminal 관측.
- `evidence/C05-mcp-collections-new-files.json`, `evidence/C05-mcp-collections-related-files.json`: 최종 build의 명시 `dist/tests/*.test.js` 경로 배열. 두 목록은 겹치지 않아야 하며 실제 통과 argv와 일치해야 한다. 현재 중간 교정 3파일 성공을 신규 전체 선택으로 간주하지 않는다.
- `evidence/C05-mcp-collections-stage-selection.json`: 정확히 `{build:"buildN",new:"newN",related:"relatedN",core:"coreN",architecture:"architectureN"}`.
- `evidence/C05-mcp-collections-terminal-input.json`: `{executions:[{stage,sessionId,exitCode}],synchronous?:[{stage,exitCode}],observedAt?:string,source?:string}`. 선택한 다섯 단계의 실제 종료만 한 번씩 넣고 new/related는 실제 세션 ID를 갖는다.
- root가 새로 관측한 전용 NAS root/SSH config host/default Node 버전과 별도로 개설한 same-UID 0700 control 디렉터리. 자격 증명을 인자·설정에 기록하지 않고 이전 control 수명을 재사용하지 않는다.
- 원본→후보 diff 및 정적 구문 검토. `script-provenance.json`은 생성 시점 해시와 미실행 상태만 기록한다. 실제 구문 검사/실행 기록은 아직 없다.

기존 [collection local runner](../C05-mcp-collections-run.mjs)를 사용한다. 새 runner를 복제하지 않았다. 최종 선택 실행에는 `--test --test-concurrency=2 --test-timeout=60000`을 명시한다. `--test-reporter=tap`은 선택 가능하고, selector는 기본 spec 최종 요약도 허용한다. 과거 argv에 없었던 옵션을 기록에 덧붙이거나 원본을 수정하면 안 된다.

## 검토 승인 뒤 실행 순서

다음은 **향후 인자 예시**이며 지금 실행한 명령이 아니다. 모두 `runtime`에서 해당 Node24로 실행한다.

```sh
NODE_BIN="$PWD/.tools/node-v24.20.0-darwin-arm64/bin/node"
HELPERS="evidence/C05-mcp-collections-linux-nas-20260908"
"$NODE_BIN" "$HELPERS/select-local.mjs" \
  evidence/C05-mcp-collections-stage-selection.json \
  evidence/C05-mcp-collections-terminal-input.json
"$NODE_BIN" "$HELPERS/configure.mjs" "$NAS_ROOT" "$SSH_HOST" "$OBSERVED_DEFAULT_NODE" "$NEW_CONTROL_DIRECTORY" \
  evidence-mcp-offline-c05/result.json \
  evidence/C05-mcp-offline-linux-nas-20260907/verification.json
"$NODE_BIN" "$HELPERS/preflight.mjs"
"$NODE_BIN" "$HELPERS/prepare-upload.mjs" 1 \
  "$HELPERS/local-new-result.json" "$HELPERS/local-related-result.json"
"$NODE_BIN" "$HELPERS/start-native.mjs" 1
```

selector는 실제 source before/after·build pin·Node·exit/stdio close·직접 process group 부재·로그 닫힘·최종 요약을 검사하고 불변 alias를 만든다. 출력이 하나라도 존재하면 재선택을 거절한다. config/control/pin/alias/targeted/upload/result/proof는 이 후보에 포함하지 않았으며, 별도 retry selector도 복제하지 않았다.

prepare-upload는 source tar/runner/common/config/validation-inputs/targeted-files/build-pin 7개를 전송·SHA 대조하고, 기존 source/dist를 새 백업으로 이동한다. tar allowlist와 package-lock 불변, 기존 별도 자산 7개 SHA 및 architecture CLI helper를 유지한다. Node 설치나 dependency 재설치는 하지 않는다.

원격은 build → `new-mcp-collections-tests` → related → core → architecture → architecture CLI fixtures → all-tests → fixtures의 8단계다. full은 최종 dist의 모든 `.test.js`를 사용한다. 성공 종료를 실제 관측한 뒤에만 다음 순서로 진행한다.

```sh
"$NODE_BIN" "$HELPERS/collect-attempt.mjs" final
"$NODE_BIN" "$HELPERS/close-native.mjs"
"$NODE_BIN" "$HELPERS/finalize-evidence.mjs"
```

실패하면 `collect-attempt.mjs attempt-N`으로 원 결과와 생성된 로그부터 보존한다. close-native는 성공 결과용 gate이며 실패를 성공으로 바꾸어 정리하거나 자동 재시작하지 않는다. 실패 후 정리/재시도는 별도 검토 대상이다. 원 helper의 유한 attempt 처리는 유지했지만 이 후보는 첫 attempt만 준비하며 retry selector는 없다.

## 변하지 않는 증거·정리 한계

전체 1800초/full 1200초/new·related 각각 300초/기타 180초, 개별 test 60초를 유지한다. TERM 후 KILL·최종 관측·log flush의 5초 경계와 실제 exit는 별도로 보존한다. 남은 overall 예산은 뒤 단계 한도를 줄일 수 있고 timeout 후 exit0도 성공이 아니다. raw log 회수는 현재 파일당 32MiB 한도다.

최종 proof는 실제 8단계 성공·최종 전체 파일 목록·로컬 실제 종료·동일 pin·upload 7개 SHA·결과+원로그 9개 SHA·현재 source/build·선행 proof·새 cleanup을 확인한 뒤에만 `wx`로 게시한다. 같은 UID의 접근 가능한 `/proc/exe,cwd`가 전용 root 안인 프로세스와 직접 소유 group을 검사한다. 접근 불가 peer는 unresolved이며 전 시스템 프로세스0이 아니다. SSH master/socket/control 디렉터리 종료도 별도 확인한다.

새 collection의 실제 CLI/HTTP 인수 범위는 **최종 통합된 선택 파일과 원 로그**로 판단한다. 이전 plain-read 입구 수치는 collection 증명이 아니다. `stored_complete`는 실행 허가가 아니며 자동 online fallback도 아니다. 그 밖의 page/wait 경계·실제 모델/API·사내 서비스·native Windows·PostgreSQL·전원 장애 내구성·C05 chapter/전체 goal 완료를 추정하지 않는다. 상세 재사용 근거는 [준비 메모](../C05-mcp-collections-native-preparation-note.md)에 있다.
