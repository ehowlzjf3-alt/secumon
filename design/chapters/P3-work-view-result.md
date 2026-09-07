# P3-02 첫 단위: 업무 조회와 CLI 학습·결과

2026-09-06 · v0.30 · 공통 조회/CLI 첫 단위 로컬 검증 완료

## 이번에 배울 점

장기 업무에서는 대화창이나 프로세스가 바뀌어도 같은 업무를 이어서 볼 수 있어야 한다. 이때 “이어 본다”와 “이어 실행한다”는 다른 행동이다. 상태를 읽을 때마다 planner나 outbox를 실행하면, 사용자가 현황만 보려 했는데 호출 비용이 생기거나 답변이 다시 전송될 수 있다.

| 개념 | 이번 단위에서의 의미 |
| --- | --- |
| 업무 정본 | 목표·근거·실행·전달 상태가 저장된 WorkState |
| 공개 업무 화면 | 현재 사람과 대화 경로에 허용된 일부 상태를 읽어 만든 결과 |
| 조회 커서 | 이 업무·사람·대화·조회 수준의 표시 내용이 바뀌었는지 비교하는 값 |
| 재개 패킷 | 실행을 이어가기 위해 필요한 상태와 자료를 모은 파생물 |
| 전달 영수증 | 특정 답변이 채널에 전달됐다는 관측; 사람이 읽었다는 뜻은 아님 |

커서만 오래 보관한다고 장기 추론이 되는 것은 아니다. 추론에 필요한 목표·가설·증거는 정본과 자료 저장소에 남고, 커서는 화면을 갱신하는 데 사용한다. 기존 compact/실행 재개 패킷을 화면 접속에 재사용하지 않는다.

## 코드에서 따라갈 곳

- [공통 화면 계약](/Users/seunghanee/Documents/secumon/runtime/src/domain/work-view.ts): 기본 상태/대화, 상세, 진단의 작은 데이터 구조.
- [공개 업무 조회 서비스](/Users/seunghanee/Documents/secumon/runtime/src/application/work-view-service.ts): 대화 경로와 현재 공개 권한, 근거·답변의 유효성을 확인한다. 읽기 포트만 제공하므로 모델/도구/메시지 발송과 정본 쓰기 경로가 없다.
- [CLI 진입점](/Users/seunghanee/Documents/secumon/runtime/src/presentation/cli.ts): `work-view` 분기에서 조회 서비스만 호출한다.
- [CLI 표시](/Users/seunghanee/Documents/secumon/runtime/src/presentation/work-view-format.ts): 상태는 한 줄, 필수 질문·결과는 본문, 세부 정보는 명시 조회로 표시한다. 전달 미확정 본문에는 준비된 내용이라는 표시를 붙인다.
- [구현 계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-work-view-plan.md)과 [독립 검토](/Users/seunghanee/Documents/secumon/design/chapters/P3-work-view-review.md): 조회가 실행/전달을 일으키지 않는 경계와 실패 사례.

기존 `status`는 로컬 상태 조회, `messages`는 전달 이력, `events`는 로컬 진단의 계약을 유지한다. 후속 Web은 이 내부 응답을 복사하지 않고 신규 공개 업무 조회 서비스를 사용한다. CLI profile의 고정 합성 사용자와 로컬 권한이 실제 사내 인증을 대체하는 것은 아니다.

## 실습 순서

빌드된 런타임과 새 합성 업무를 사용한다. 아래 `<work-id>`와 `<cursor>`는 앞 명령의 실제 출력에서 복사한다. 실제 모델/API를 연결하지 않는다.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
node dist/presentation/cli.js accept --data-dir .data/work-view-lesson --request-id lesson-1 --json
node dist/presentation/cli.js work-view '<work-id>' --data-dir .data/work-view-lesson --json
node dist/presentation/cli.js work-view '<work-id>' --data-dir .data/work-view-lesson --cursor '<cursor>' --json
node dist/presentation/cli.js work-view '<work-id>' --data-dir .data/work-view-lesson --level details
```

첫 조회는 `snapshot`, 같은 경로/수준의 내용을 다시 읽으면 `unchanged`가 기대값이다. 이 과정에서 합성 원본 조회 도구가 실행되면 안 된다. `details`는 별도 표시 내용이므로 기본 화면 커서를 그대로 보내도 새 상세 snapshot을 받아야 한다.

그다음 같은 `--data-dir .data/work-view-lesson`을 지정해 `demo-plan <work-id>`와 `run <work-id>`를 명시적으로 실행하고 다시 조회한다. 결과 준비/전달 상태와 메시지를 확인한다. 다른 대화에 `attach`하면 그곳에서 같은 업무를 볼 수 있지만 주 답변 경로는 바뀌지 않는다. 목표를 바꾸거나 취소한 뒤 옛 커서를 보내도 옛 답변을 현재 결과로 되살리면 안 된다. 새 실습을 시작할 때는 새 폴더명/요청 ID를 사용하고, 같은 값을 쓰면 기존 업무를 이어서 보는 것임을 확인한다.

생각해 볼 질문: 정본 revision이 바뀌지 않았는데 원본 파일이 사라지면 어떨까? 그래서 커서 비교만으로 조회를 끝낼 수 없고, 현재 권한과 결과에 필요한 출처를 다시 검사해야 한다. 반대로 이 검사가 상태 쓰기나 재발송으로 이어져서는 안 된다.

## 검증 상태

고정 Node 24.20.0에서 `npm run verify`가 exit 0으로 끝났다. **1,427/1,427, 실패 0**이며 코어 별도 타입 검사·안쪽 계층 85파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 39개는 공개 조회 서비스 28개(두 저장소), CLI 통합 7개, 사람용 표시 4개다. 최종 수정 뒤 targeted 39개도 통과했다.

[전체 검증 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-work-view-verify.log) · [최종 관련 시험](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-work-view-targeted-final.log) · [검증 기록과 소스 hash](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-work-view-local-verification.json). 첫 CLI 11개, 다음 관련 37개, 가설 basis 보완 전 전체 1,425개 로그는 중간 기록으로 보존한다. 이 기록들을 수정 후 최종 검증으로 대신 사용하지 않았다. 실제 모델/API·MCP·Knox·컴퓨터 유즈 호출은 0회다.

원본 아카이브/추출 1,973파일, dependency lock, 이전 P2-06 검증 및 비교 기록을 보존했다. 현재 소스·빌드 대응과 문서/작업 상태의 정적 대조 결과는 검증 JSON을 기준으로 한다. 저장소는 초기화하거나 이행하지 않았으며 Git 저장소도 만들지 않았다.

## 검토에서 배운 점

준비된 답변의 본문이 있어도 전달 상태가 pending/unknown일 수 있다. 이때는 “준비된 답변 · 전달 여부 미확인”처럼 표시한다. 접수 안내는 실제 업무가 저장됐다는 사실이며 메시지를 사람이 읽었다는 뜻은 아니다.

가설의 저장된 supported 상태도 현재 판단과 다를 수 있다. 근거가 철회되거나 가설 평가에 쓰인 별도 원본이 유실되면 카드의 reviewRequired를 표시하고 과거 status/근거 수는 현재 평가로 내보내지 않는다. 목표에 직접 필요한 근거 A가 정상이어도 가설 판단에 쓴 B가 유실되면 모든 조회 수준에서 결과를 재확인 대상으로 표시한다. 이 구분을 실제 자료 철회와 두 저장소 회귀로 확인했다.

## 남은 범위

이번 단위로 P3-02 전체가 끝나지 않는다. HTTP/세션/명령·상태 스트림, Web 업무 목록/대화/상세 화면, 재접속·목표 변경·취소 UI, 키보드 초점·스크롤·좁은 화면 검수가 다음 단위다. 실제 모델·MCP·Knox·컴퓨터 유즈 조건도 별도로 남는다. 브라우저 화면이나 사용성 개선을 검증했다고 주장하지 않는다.

현재 조회는 필요한 원본을 실제로 다시 읽어 유효성을 확인한다. 정본 revision만 보고 결과를 무기한 캐시하지 않는다. 후속 Web의 상시 갱신에서는 조회 빈도·원본 검증 읽기량·접속 수를 측정하고 제한해야 한다. 이번 일회 조회의 정확성 검증을 상시 폴링의 성능 검증으로 대신하지 않는다.

진단의 출력은 최근 50개 사건으로 제한하지만 현재 저장소 포트에서는 전체 사건 이력을 읽은 뒤 선별한다. 아주 긴 업무의 진단 I/O는 후속 tail/pagination 조회 계약과 함께 개선해야 한다.
