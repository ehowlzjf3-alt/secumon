# C04 Linux 검증 준비

2026-09-07 실행·회수·정리를 마쳤다. `verification.json`이 확정 증거이며 Linux 신규100/100·관련636/636·전체3138/3138과8단계가 통과했다. 아래 절차는 당시 실행 기록이다. 완료된 실행을 반복하지 않는다. C03 원본은 그대로 두었으며 `script-provenance.json`에 재사용한 원본 파일의 SHA256을 기록했다.

실행 대상은 범용 응답 생성, 원문·이전 초안의 현재성, 대화·컴팩트·개인 기억 연결, 답변 전달과 읽기 화면이다. 합성 모델로 구조를 검증하며 실제 모델의 답변 품질이나 사내 연동을 검증했다고 표현하지 않는다.

`targeted-files.json`은 신규 12개 파일과 root가 선택한 기존 관련 39개 파일을 담는다. 기존 관련 목록은 `evidence/C04-turn-related-files.json`을 그대로 복사했다. `related-files-recommendation.json`의 추가 후보는 참고용이며 실행 목록에 자동 추가하지 않는다. 소스 시험 파일 개수와 TAP의 시험 개수는 다르다. 스크립트는 성공 개수나 `new2`, `build5` 같은 로컬 관측 이름을 가정하지 않는다.

## 실행한 순서와 재현 시 구분

원격 시험은 지원 Node24.20.0을 사용했다. 로컬 build5 manifest는 잘못된 PATH로 인해 기본 Node25.8.0을 기록했으므로 로컬 pin 대조에는 그 빌드와 일치하는 Node를 사용했다. 로컬 시험 자체의 Node 버전은 선택한 원결과에 수집되지 않았다. 최종 증거의 local.build/nodeScope/testNodeVersion과 C04-turn-finalize-diagnosis.json에 이 차이를 보존했다. 이후 새 소스 빌드는 runtime/.tools의 Node24.20.0을 사용한다. 아래 Node 경로는 당시 로컬 빌드 대조 경로이며 현재 버전이 같다고 가정하지 않는다. 비밀번호나 API 키를 인수·설정 파일에 넣지 않는다.

```sh
NODE='/opt/homebrew/bin/node' # 당시 v25.8.0; 해당 build5 manifest와 일치 확인
S='evidence/C04-turn-linux-nas-20260907'

# 기존 별도 Linux 시험 root / SSH 설정 호스트 / 관측한 기본 Node / 새 private control 디렉터리
# control 디렉터리 안의 control 소켓은 root가 먼저 생성한다. 이 스크립트는 연결을 만들지 않는다.
"$NODE" "$S/configure.mjs" \
  '/absolute/dedicated-linux-root' 'SSH_HOST' 'vMAJOR.MINOR.PATCH' \
  '/absolute/private-control-directory' 'evidence-PRIOR/result.json' \
  'evidence/PRIOR-verification.json' 'evidence/RETAINED-diagnosis.json'

"$NODE" "$S/preflight.mjs"
"$NODE" "$S/prepare-upload.mjs" 1 \
  'evidence/CHOSEN-new-result.json' 'evidence/CHOSEN-related-result.json'
"$NODE" "$S/start-native.mjs" 1

# 종료가 확인된 실패면 final 대신 attempt-1. 실패 기록은 다시 쓰지 않는다.
"$NODE" "$S/collect-attempt.mjs" final
"$NODE" "$S/close-native.mjs"
"$NODE" "$S/finalize-evidence.mjs"
```

configure의 마지막 historical JSON 인수는 선택 사항이다. D3 결과와 기존 D2 초기화/MCP 원인 미확정 기록을 보존하려면 해당 실제 경로를 명시한다. 숫자·검증 완료 시점은 인수가 아니라 실제 결과 파일에서 읽는다. 설정 파일에 pin은 저장하지 않는다.

로컬 결과 인수는 root가 저장한 명시적 wrapper다. `code/signal/timedOut/sourceAndBuild`, 실제 원로그 `logPath`, `sourceObservation`, 원증거 hash 배열 `evidence`를 확인한다. TAP의 `# tests`와 Node spec의 `ℹ tests`를 모두 읽으며 로그를 변환하거나 복사하지 않는다. 현재 wrapper는 `evidence/C04-turn-new-result.json`과 `evidence/C04-turn-related-result.json`이다.

신규 실행의 정확한 종료 시각은 수집하지 않았으므로 `finishedAt`을 만들지 않는다. `completedObservedAt`, `timestampMeaning: completion_observed_after_actual_exit`, `exactFinishedAtCaptured:false`와 실제 도구 exit 관측을 그대로 보존한다. 관련 실행은 원 stage runner의 `startedAt/finishedAt` 및 process JSON을 대조한다. `sourceObservation`은 build5 뒤 소스를 동결했고 두 실행 뒤 현재 build/source 일치를 확인했다는 증거다. `perRunBeforeCaptured:false`를 명시하며 없는 `before.json`을 요구하거나 생성하지 않는다. configure는 이미 기록된 control 디렉터리가 같은 canonical 경로면 기존 파일을 변경하지 않고 사용한다.

전송은 `src`, `scripts`, `fixtures`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.core.json`만 압축한다. 원격의 기존 Node 24.20.0·의존성과 별도 `architecture-cli-check.mjs`를 재사용한다. 기존 7개 검증 자산 SHA256도 그대로 확인한다. lockfile이 바뀌면 중단하며 설치나 기본 Node 변경을 하지 않는다. 원격 기존 소스와 dist는 `before-turn-c04-attemptN`으로 보존하고 `evidence-turn-c04`에 이번 결과를 기록한다.

## 실행과 종료의 유한 경계

단계는 build → new-agent-turn-tests → related-existing-tests → typecheck-core → architecture → architecture-cli-fixtures → all-tests → fixtures 순이다. 마지막 전체 시험 목록은 그 빌드의 모든 `dist/tests/*.test.js`에서 정해 원본 JSON에 저장한다.

전체 실행 예산은 1200초, all-tests는 최대 900초, 나머지 단계는 각각 최대 180초다. 모든 Node 시험은 개별 60초 제한을 유지한다. 각 단계는 남은 전체 시간을 넘기지 않는다. 시간초과·실패 시 해당 runner가 직접 시작한 detached 프로세스 그룹만 TERM → 5초 → KILL → 5초 관측으로 정리하고 로그 flush는 최대 5초 기다린다. 정리 시간은 실행 예산 이후에 붙을 수 있다. 원 exit code/signal, leader exit, stdio close, group 부재 확인을 각각 저장한다. timeout을 정상 성공으로 바꾸지 않는다.

프로세스 관측은 이름이 `node`인지에 의존하지 않는다. 같은 UID에서 읽을 수 있는 `/proc/PID/exe`·`cwd`가 전용 root 안인지 확인한다. EACCES/EPERM으로 범위를 확인하지 못한 프로세스는 미확정으로 남는다. 관측한 owned 프로세스 0개를 전체 시스템 프로세스 부재라고 주장하지 않는다. 다른 그룹으로 이탈한 자손까지 모두 종료한다고 보장하지 않는다.

실패한 실행은 먼저 `collect-attempt.mjs attempt-N`으로 수거한다. 다음 번호의 prepare는 종료된 실패만 보존·교체할 수 있다. 자동 재실행이나 광범위한 프로세스 종료는 없다. SSH 관측자 exit만으로 native 완료를 판정하지 않으며 native result와 로그를 별도로 수거한다.

## 지문과 최종 증거

소스 지문은 기존 `evaluationCodePin` 규약을 그대로 사용한다. 입력은 위 소스·설정 파일 목록이며 `evidence`, 에이전트별 메모리, D3 migration marker/assignment/ready는 포함하지 않는다. 빌드 파일 지문에서는 자기 자신인 `dist/build-manifest.json`만 제외한다. D3 marker를 지우거나 고쳐 지문을 맞추지 않는다.

최종 증거는 이 폴더의 `verification.json`에 한 번만 생성된다. 현재 pin, 두 로컬 성공 증거, 전송된 파일 hash, 8단계 실제 exit/TAP, 회수 hash, fresh process audit와 SSH 소켓 종료를 모두 대조한다. 생성만으로 C04 챕터나 전체 goal을 완료 처리하지 않는다. Windows 미연결·미검증, PostgreSQL 미구현, 실제 API 중단·사내 연동 미검증, 과거 D2 원인 미확정은 별도로 남긴다. 실제 실행 전에는 `verification.json`이 없어야 정상이다.
