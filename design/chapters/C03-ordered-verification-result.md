# C03 순차 검증·수정 기록

2026-09-08 · checkpoint370. 선택한 17파일 **156개 중 155통과·1실패**다. 기존 12파일 120/120 뒤, 추가 5파일에서 35/36을 확인했다. 종료 hook의 실패와 미실행 후속을 보존하며 C03 전체 인수는 미완료다. 사용자의 GitHub 게시 우선 지시에 따라 추가 수정·시험을 멈추고 이 상태를 저장했다. [진행 증거](../../runtime/evidence/C03-ordered-checkpoint.json).

개인 기억은 적용된 사용자 원문을 출처로 삼고, 다른 세션의 대화를 통째로 복제하지 않고도 재조회됐다. 기억의 정정은 이전 참조를 무효화하며, 잊기는 활성 기억의 본문·인용을 제거하되 원래 대화와 처리 영수증을 보존했다. 개인 기억을 업무의 검증된 근거로 승격하지 않았고, 같은 저장소에 같은 ID를 사용해도 담당·사용자·조직의 기록·색인·영수증이 분리됐다. SQLite 저장 중 실패하면 기록·색인·head·영수증이 함께 되돌아갔다. [원로그](../../runtime/evidence/C03-ordered-target1.log).

명령은 `node --test --test-concurrency=1 --test-reporter=tap dist/tests/sqlite-personal-knowledge.test.js dist/tests/personal-knowledge-service.test.js`이며 지정한 Node v24.20.0으로 실행했다. session39727 exit0, 실패/취소/건너뜀0, 소스 지문은 C02 build1의 `e49c5e5a55a1d15baf06d258d881433e363ca7d605e9a7f01c4f413d74f02336`이다. 기존 임시 저장소와 C02에서 격리한 session helper를 그대로 사용했다.

두 번째 실행(session38942)은 기존 C02 build1의 3파일 `document-memory-recovery-regressions`, `sqlite-personal-memory-migration`, `local-memory-profile`을 사용했고 exit0, 23개 통과·실패/취소/건너뜀0이다. 중단된 문서 게시의 재개, 개인 기억 이관용 고정 snapshot과 write fence, 실제 SIGKILL 전후 일관성 및 로컬 기억 도구/작업공간 재개를 확인했다. [원로그](../../runtime/evidence/C03-ordered-target2.log). 일반 담당의 새 명시 SQLite 복구 명령 시험과는 별개다.

세 번째 실행(session77090)도 같은 빌드의 기존 7파일을 사용했고 exit0, **67/67 통과**, 실패/취소/건너뜀0이다. 기억 revision 조회, 문서 저장 방식 선택, 문서 정본·색인·권한 경계, 편집 초안, 문서 import, 개인 기억 백업을 포함한다. [원로그](../../runtime/evidence/C03-ordered-target3.log). 실행한 기존 시험은 후속 묶음에서 중복하지 않는다.

추가 fixture 격리와 새 복구 시험을 포함한 C03 build1(session21634)은 exit0, 지문은 `9821f7b95576e6b89b38f3d2f5202c12fc9a8d3c1f534684e1736b84001b9ddd`이다. target4(session31180)는 36개 중 35통과·1실패, 취소/건너뜀0이다. [빌드](../../runtime/evidence/C03-ordered-build1.log) · [추가 시험](../../runtime/evidence/C03-ordered-target4.log).

실패한 `a stale absent-operation observation joins the exact apply completed by another profile`는 시험 종료 hook에서 임시 root가 삭제된 뒤 두 번째 profile의 lease를 닫다가 `ENOENT`가 났다. 본문 단언의 실패와 구분한다. 다음 수정은 fixture가 모든 profile을 닫고 임시 디렉터리를 지우도록 종료 순서를 정리하는 것이다. 아직 수정하거나 재시험하지 않았다.

checkpoint366의 SQLite `prepare → apply → status`는 새 시험에서 **state/memory/channel 3개 모두 통과**했다. 실제 임시 rollback journal과 SIGKILL을 사용해 원 main/journal 보존, 후보 rollback·owner/schema/무결성, apply·역사 status와 원 stores 재개를 확인했다. 기존 hot-journal 거절 시험을 새 명령의 성공 증거로 대신하지 않았다. 전체 장애 주입 목록과 documents fence, Linux/native Windows·최종 통합·실제 운영 데이터 복구는 별도 미완료로 유지한다. 모델/API 시험 중단을 유지한다.
