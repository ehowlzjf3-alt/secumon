# C03 순차 검증·수정 기록

## Checkpoint372 — 준비 중단·시도 상한과 추가 거절6개 확인

신규6개(session5970, target11)는 **6/6 통과**, 실패·취소·건너뜀0이다. C04 build2(session62563)와 동일한 지문 `578542798a5b4edfa21734cdf456c6a1bff7b0546f4d807487e5f33b07d556ca`에서 실행했다. [원로그](../../runtime/evidence/C03-ordered-target11.log) · [실행 기록](../../runtime/evidence/C03-ordered-checkpoint.json).

원본/후보 사본의 실제 첫 청크 쓰기를 관측해 SIGKILL·exit/close를 확인하고, 부분 파일·원 main/journal·기존 영수증을 보존한 채 같은 ID의 다음 시도 폴더로 재개했다. 각각4회 중단 후5번째 시도 거절도 확인했다. 정상 API로 만든 다른 문서 저장소의 유효한 fence와 super-journal 이름/끝 표식은 원본을 보존하며 거절했다. POSIX 임시 파일·프로세스에서 확인했으며 Windows나 운영 데이터 복구를 검증한 결과는 아니다.

선택한 누적 고유 시험은 **222개 통과**다. 이전 시험을 이번 소스로 다시 실행하지 않았고 재시험을 고유 수에 더하지 않는다. 전체 V03-R01~08의 잔여 인수와 현재 Linux/native Windows·최종 통합은 별도로 유지한다. C04는 [선택158개 결과](C04-ordered-verification-result.md)를 기록했다.

## Checkpoint371까지의 이력

최종 확인 범위는 **고유216개 통과**로 늘었다. build5(session93374) exit0, 지문 `e6d6c53682954cdac728d0ca41e792efc53af1a5ee942e710a6b26b5d9343d0c`에서 실제 apply 중단4개(session23786)가 통과했다. 후보 정본 링크, 완료 receipt 게시, main 퇴역 링크, journal 퇴역 뒤 각각 IPC를 관측하고 SIGKILL·exit/close를 확인했다. 죽은 maintenance lease를 회수한 후에도 pending과 일반 실행 차단이 유지되며, 같은 operation을 재개해 원본/영수증/업무/기억/세션을 보존했다. [원로그](../../runtime/evidence/C03-ordered-target10.log). 앞선 target9는 잘못된 필터로 사례0개를 선택한 실행이며 파일 wrapper의 pass를 검증 수에 넣지 않았다.

남은 것은 준비 단계 중단·원본/후보 시도 상한, 추가 documents fence/super-journal 거절과 최종 환경/통합 인수다. C04 핵심5파일51/51은 별도 [C04 결과](C04-ordered-verification-result.md)에 저장했다. 실제 모델/API 시험은 계속 중단한다.

checkpoint371의 build4까지 선택 결과는 **고유212개 통과**였다. build4(session19819) exit0, 지문 `e6ea677ed53f2986942e4c702459c6918b02816afeddea6dd38aa9d75126bc6c`에서 worker 이벤트 계약14/14와 실제 임시 hot pair 거절3/3(session87960)을 추가 확인했다. [worker 원로그](../../runtime/evidence/C03-ordered-target7.log) · [owner/schema/layout 원로그](../../runtime/evidence/C03-ordered-target8.log). 이벤트 시험은 응답/exit/close·timeout/abort·출력 한도·원인 보존을 대역 이벤트로 확인하며 실제 운영체제 복구 성공과 구분한다. 실제 프로세스 중단 뒤 관리 복구의 재개·시도 상한과 일부 추가 거절 경계는 아직 남는다.

checkpoint371: GitHub에 보존한 체크포인트에서 이어서 초안 시험의 병행 profile을 `try/finally` 안에서 먼저 닫도록 고쳤다. 제품 코드는 변경하지 않았다. build2(session8374) exit0 뒤 이전 실패 시험 **1/1 재확인 통과**로 관측한 종료 hook 실패는 해결됐다. 원래 156개에 재시험을 중복 가산하지 않는다. [재확인 원로그](../../runtime/evidence/C03-ordered-draft-cleanup.log) · [빌드](../../runtime/evidence/C03-ordered-build2.log). 나머지 CLI/Web·이관 입구 및 복구 경계는 이어서 검증하며 전체 C03 인수는 미완료다.

후속 build3(session41840) exit0, 지문 `aac4a7b171c5e5e102f2927f50068a9fd26b623373f197d06dcecbc075979321`에서 **CLI/Web·초안 중단/재개·이관 7파일36/36**(session49052)과 **추가 복구 경계3/3**(session14128)을 확인했다. [입구·이관 원로그](../../runtime/evidence/C03-ordered-target5.log) · [복구 경계 원로그](../../runtime/evidence/C03-ordered-target6.log). build3 단계에서 선택한 고유 시험은195개였으며 이전 종료 hook 실패의 재확인을 포함해 모두 통과했다. 단일 최종 소스에서195개를 재실행한 결과는 아니다.

새 경계는 준비 지문 불일치 거절, pending 중 일반 실행/다른 복구 차단과 정확한 operation 재개, 완료 이후 정상 DB 변경을 과거 복구 receipt가 덮지 않음을 확인했다. 원본 보존과 현재 DB를 다시 검증했다고 주장하지 않는 역사 status를 함께 확인했다. 남은 새 복구 오류·단계 중단·worker 프로토콜/종료 관측과 환경 인수는 별개다.

2026-09-08 · checkpoint370. 선택한 17파일 **156개 중 155통과·1실패**다. 기존 12파일 120/120 뒤, 추가 5파일에서 35/36을 확인했다. 종료 hook의 실패와 미실행 후속을 보존하며 C03 전체 인수는 미완료다. 사용자의 GitHub 게시 우선 지시에 따라 추가 수정·시험을 멈추고 이 상태를 저장했다. [진행 증거](../../runtime/evidence/C03-ordered-checkpoint.json).

개인 기억은 적용된 사용자 원문을 출처로 삼고, 다른 세션의 대화를 통째로 복제하지 않고도 재조회됐다. 기억의 정정은 이전 참조를 무효화하며, 잊기는 활성 기억의 본문·인용을 제거하되 원래 대화와 처리 영수증을 보존했다. 개인 기억을 업무의 검증된 근거로 승격하지 않았고, 같은 저장소에 같은 ID를 사용해도 담당·사용자·조직의 기록·색인·영수증이 분리됐다. SQLite 저장 중 실패하면 기록·색인·head·영수증이 함께 되돌아갔다. [원로그](../../runtime/evidence/C03-ordered-target1.log).

명령은 `node --test --test-concurrency=1 --test-reporter=tap dist/tests/sqlite-personal-knowledge.test.js dist/tests/personal-knowledge-service.test.js`이며 지정한 Node v24.20.0으로 실행했다. session39727 exit0, 실패/취소/건너뜀0, 소스 지문은 C02 build1의 `e49c5e5a55a1d15baf06d258d881433e363ca7d605e9a7f01c4f413d74f02336`이다. 기존 임시 저장소와 C02에서 격리한 session helper를 그대로 사용했다.

두 번째 실행(session38942)은 기존 C02 build1의 3파일 `document-memory-recovery-regressions`, `sqlite-personal-memory-migration`, `local-memory-profile`을 사용했고 exit0, 23개 통과·실패/취소/건너뜀0이다. 중단된 문서 게시의 재개, 개인 기억 이관용 고정 snapshot과 write fence, 실제 SIGKILL 전후 일관성 및 로컬 기억 도구/작업공간 재개를 확인했다. [원로그](../../runtime/evidence/C03-ordered-target2.log). 일반 담당의 새 명시 SQLite 복구 명령 시험과는 별개다.

세 번째 실행(session77090)도 같은 빌드의 기존 7파일을 사용했고 exit0, **67/67 통과**, 실패/취소/건너뜀0이다. 기억 revision 조회, 문서 저장 방식 선택, 문서 정본·색인·권한 경계, 편집 초안, 문서 import, 개인 기억 백업을 포함한다. [원로그](../../runtime/evidence/C03-ordered-target3.log). 실행한 기존 시험은 후속 묶음에서 중복하지 않는다.

추가 fixture 격리와 새 복구 시험을 포함한 C03 build1(session21634)은 exit0, 지문은 `9821f7b95576e6b89b38f3d2f5202c12fc9a8d3c1f534684e1736b84001b9ddd`이다. target4(session31180)는 36개 중 35통과·1실패, 취소/건너뜀0이다. [빌드](../../runtime/evidence/C03-ordered-build1.log) · [추가 시험](../../runtime/evidence/C03-ordered-target4.log).

실패한 `a stale absent-operation observation joins the exact apply completed by another profile`는 시험 종료 hook에서 임시 root가 삭제된 뒤 두 번째 profile의 lease를 닫다가 `ENOENT`가 났다. 본문 단언의 실패와 구분한다. 다음 수정은 fixture가 모든 profile을 닫고 임시 디렉터리를 지우도록 종료 순서를 정리하는 것이다. 아직 수정하거나 재시험하지 않았다.

checkpoint366의 SQLite `prepare → apply → status`는 새 시험에서 **state/memory/channel 3개 모두 통과**했다. 실제 임시 rollback journal과 SIGKILL을 사용해 원 main/journal 보존, 후보 rollback·owner/schema/무결성, apply·역사 status와 원 stores 재개를 확인했다. 기존 hot-journal 거절 시험을 새 명령의 성공 증거로 대신하지 않았다. 전체 장애 주입 목록과 documents fence, Linux/native Windows·최종 통합·실제 운영 데이터 복구는 별도 미완료로 유지한다. 모델/API 시험 중단을 유지한다.
