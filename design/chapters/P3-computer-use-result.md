# P3-04 합성 컴퓨터 유즈: 학습·결과

2026-09-06 · v0.33 · 로컬 합성 자료 · 전체 1,630개 시험 통과

[작은 계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-use-plan.md)에 따라 관찰→입력 의도 저장→입력→새 관찰→조건 확인을 기존 업무 실행기에 연결했다. UI 입력을 모사하는 작은 문서 앱을 사용했다. 실제 브라우저·OS 화면에 연결한 driver는 다음 단위이며 P3-04 전체는 진행 중이다.

## 배울 개념

**입력 성공과 업무 완료는 서로 다른 판단이다.** Note에 값을 입력한 사실은 `applied`이고, 저장된 값이 요청한 값이라는 별도 조건이 확인돼야 저장 근거가 된다. 한 단계의 입력이 확인된 뒤 기한이 끝나면 해당 효과는 `confirmed`, 배치는 `partial`이다. 응답이 불명확하면 `unknown`으로 남겨 같은 저장 버튼을 자동으로 다시 누르지 않는다.

**중단 후 정산과 실행 재개도 다르다.** 입력 의도는 저장됐지만 driver에 아직 진입하지 않은 경우에는 `not_applied`를 증명할 수 있다. 입력 응답이 도착한 다음 목표 변경·취소가 발생해도 이미 확인한 사실은 같은 attempt에 저장할 수 있다. 이 정산 경로는 새 입력·새 목표 채택·사용량 초기화를 허용하지 않는다. 프로세스가 입력 후 응답 저장 전에 종료되면 그런 증명이 없으므로 intent와 미확정 의무를 유지한다.

**압축에는 원문 대신 복구에 필요한 참조를 남긴다.** 진행 중인 입력의 ID와 checkpoint head는 필수 정보다. 컴팩트와 복원 시 원본의 존재·해시·업무/시도/계약/진행 요약 일치를 검사한다. 참조가 남았다고 원본도 남아 있다고 가정하지 않는다. 상세 진단은 현재 조회 권한과 기억의 유효성을 재확인하며 과거 목표의 기록은 과거 기록으로 반환한다.

## 구현한 계약

| 영역 | 현재 동작 |
| --- | --- |
| 등록 | `composeRuntime({ computerTools: [...] })`에 신뢰된 binding을 주입한다. binding마다 `.observe`와 `.act`가 기존 도구 카탈로그·권한·예산·실행 장부를 사용한다. 기본 CLI/Web 프로필에 자동 등록하지 않는다. |
| 관찰 | session/epoch/surface/revision/focusRevision, 요소 ref와 role/name, 관찰 시각·생략 여부를 원본 artifact에 저장한다. 다른 업무·driver·세대의 관찰과 수락되지 않은 출처를 거절한다. |
| 행동·확인 | `fill`/`click`, `element_value`/`fact_equals`의 명시 계약을 사용한다. 모호한 대상·부분 관찰·오래된 ref를 거절한다. 확인된 fact 조건 중 마지막 관찰에서도 맞는 키만 완료 근거로 만든다. |
| 시간·상한 | 배치당 최대 3행동/12관찰, 관찰당 최대 40요소/32KiB, 설정상 최대 30초다. 실제 기한은 업무·attempt lease·binding·요청 기한의 최소값이며 대기마다 재설정하지 않는다. |
| 입력 직전 | driver 내부 지연과 host hook 뒤 현재 권한 callback을 다시 호출한다. 이어 세션 fencing·초점·대상 검사를 동기 구간에서 처리한다. 다른 Runtime에서 정책을 철회한 경우에도 입력을 멈춘다. |
| 영속 진행 | 기존 Attempt의 선택적 `computerUse` 요약과 ArtifactStore의 checkpoint를 사용한다. intent→응답→관찰/조건의 각 경계를 CAS로 저장하며 추가 DB를 요구하지 않는다. |
| 수신·채택 | `resultValidation: artifact-proof-v1` 요구를 계약 digest에 포함한다. 원본에서 재계산한 결과만 수신/채택하고, callback 제거 등록과 검증 도중 provider 교체를 거절한다. 실패 결과도 미확정 효과·측정 사용량을 지울 수 없다. |
| 사용량 | observe/act/wait 응답의 사용량을 body 검증·artifact 저장 전에 합산한다. 호출 후 사용량이 미보고되면 null이다. acquire/release는 이 driver의 별도 세션 계수다. |
| 복구 | 저장 결과는 재입력 없이 채택한다. 입력 뒤 결과 저장 전 종료는 unknown/effect_reconciliation으로 차단한다. 입력하지 않았다는 유효한 증명으로 닫힌 의무도 채택 전에 증명이 사라지면 다시 대조 대상으로 둔다. |

[범용 계약](/Users/seunghanee/Documents/secumon/runtime/src/domain/computer-use.ts), [실행기](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-use.ts), [driver 포트](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-use-ports.ts), [합성 driver](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/synthetic-computer-driver.ts)를 함께 읽으면 저장소와 화면 구현이 코어에서 어떻게 분리되는지 확인할 수 있다.

## 검증과 중간 실패

[신규 targeted 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-targeted-4.log)는 **94/94, 실패 0**이다. 계약 8, 합성 driver 14, 두 저장소 실행 24, compact/복원 16, 원본·정산 증명 22, 실제 SIGKILL 복구 4, 도구 결과 검증 등록 6개로 구성된다.

[전체 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-use-verify.log)의 고정 Node 24.20.0 `npm run verify`는 exit 0, **1,630/1,630·실패 0**, 154884.600584ms다. 코어 별도 타입 검사·안쪽 계층 90파일/위반 0·합성 4시나리오/22판정도 통과했다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-use-local-verification.json)에 최종 source/build 대응과 원본·이전 기록 보존을 저장한다. 별도 lint 명령은 없다. 실제 모델/API·MCP·Knox·운영 컴퓨터 입력은 실행하지 않았다.

첫 targeted 46개 중 4개는 구현이 보존하는 confirmed/partial을 시험이 unknown/error로 기대해 실패했다. 다음 66개 중 2개는 요청하지 않은 `resultsReady: false`까지 근거에 있어야 한다는 기대 때문에 실패했다. 최종 시험은 확인한 입력과 요청한 fact의 의미를 직접 검사한다. 중간 로그를 삭제하지 않았다.

독립 검토에서 입력 전 권한·실패 사용량·효과 하한·중단 후 정산·과거 기록 조회·압축 원본 검사 문제를 발견해 보완했다. 추가 검토의 ‘닫힌 의무를 다시 대조하기’와 ‘저장 직전 provider 제거’도 실제 회귀로 확인했다. 검토 에이전트 사용량 제한 뒤에는 주 에이전트가 저장된 변경을 검토하고 최종 검사를 수행했다.

## 같은 저장 업무의 호출 비용

[비교 JSON](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-use-cost-final.json)과 [실행 스크립트](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-use-cost.mjs)에 양 저장소의 4개 실행을 기록했다. 한 번 관찰한 뒤 fill/save를 묶는 방식과, fill의 마지막 관찰을 다음 save 호출에 전달하는 방식이 같은 목표·근거·독립 출처 수·완료 판정에 도달했다.

| 항목 | 짧은 묶음 | 개별 행동 |
| --- | ---: | ---: |
| 런타임 도구 호출 | 2 | 3 |
| 적용된 입력 / 저장 횟수 | 2 / 1 | 2 / 1 |
| driver observe/act/wait 호출 합계 | 6 | 7 |
| acquire / release 호출 | 2 / 2 | 3 / 3 |
| 모델 호출 / 이미지 bytes / 가상 경과 ms | 0 / 0 / 0 | 0 / 0 / 0 |

| 저장소 / byte 계측 | 짧은 묶음 | 개별 행동 |
| --- | ---: | ---: |
| SQLite / output JSON | 1,463 | 1,792 |
| SQLite / runtime body read | 259,099 | 391,892 |
| SQLite / runtime body write | 23,548 | 24,848 |
| 파일 저널 / output JSON | 1,463 | 1,787 |
| 파일 저널 / runtime body read | 259,099 | 391,029 |
| 파일 저널 / runtime body write | 23,548 | 24,809 |

새 세션 epoch는 난수여서 자릿수에 따라 byte 값에 작은 차이가 생긴다. 표는 최종 관측값이고, 비교는 ID/epoch/원본 주소를 정규화한 업무 결과와 실제 입력 수의 일치를 먼저 확인한다. 결과 점검용 추가 읽기·중복 원본 검증·고유 artifact 파일 크기는 JSON에서 따로 제공한다. bytes는 Node 파일 API 계측이며 물리 디스크 I/O나 모델 청구량이 아니다. 실제 모델 왕복·브라우저 지연·이미지 효율·운영 성공률 개선을 측정한 결과로 해석하지 않는다.

## 직접 읽고 실험하는 순서

기존 고정 Node와 설치된 의존성을 사용한다.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
npm run build
node --test dist/tests/computer-use.test.js dist/tests/computer-use-recovery.test.js
node evidence/P3-computer-use-cost.mjs "$PWD" P3-computer-use-lesson
```

마지막 명령은 새 stem의 JSON/log를 만들며 같은 이름의 기존 기록을 덮어쓰지 않는다. 임시 합성 앱/저장소는 종료 후 정리한다. 복구 시험은 자식 프로세스를 실제 SIGKILL하므로, 입력 뒤 저장 전과 결과 저장 뒤 채택 전 경계가 어떻게 다른지 시험과 checkpoint를 비교한다.

## 남은 구현 순서

P3-04 로컬 계약은 **부분 검증**, 전체는 **in_progress**다. 다음 단위는 미확정 효과를 관찰 증거와 명시적으로 대조하고, 확인된 단계 뒤의 남은 작업만 새 attempt로 이어가는 계약이다. 현재 `inspect`는 진단이며 unknown 의무를 임의 해소하거나 입력을 반복하지 않는다.

이후 로컬 합성 Web 앱에 실제 TS driver를 연결해 동일 목표 기준선과 비교한다. 실제 OS/앱·기존 driver 선택, 이미지/좌표/IME·사용자 동시 조작, 실제 권한과 조직의 G-DATA, 성공률·지연·복구율 평가는 별도 조건으로 유지한다. 합성 앱의 파일은 내용과 입력 수를 보존하지만 여러 프로세스의 전역 UI lease를 제공하지 않는다. P3-04 첫 단위 통과를 전체 컴퓨터 유즈나 P0–P6 완료로 표시하지 않는다.

첫 전체 1,628개 통과 후 채택 직전 provider 제거 경계를 추가로 보완했다. 관련 양 저장소 회귀 2개를 더해 최종 1,630개를 다시 검증했으며, 앞선 전체/정적/비용 기록은 initial 또는 기존 파일명으로 보존했다. 최종 비용은 cost-final.json의 source/build pin과 일치한다.
