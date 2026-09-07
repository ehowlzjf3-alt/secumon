# C04 등록 단위 — 동시 초기화 실패의 한정 진단

2026-09-07 · **원인 미확정, 제품 수정 없음.** 관련 시험 첫 실행은 245개 중 244개 통과·1개 실패였다. 같은 빌드의 단일 시험 재실행은 1/1, 이어진 관련 시험의 concurrency 1 재실행은 245/245 통과했다. 해당 시험 안의 동시 CLI 8개는 유지했다. 재현되지 않았다는 관측이며 해결이나 등록 단위 전체 통과로 표현하지 않는다. [지문·비교·원로그 목록](../../runtime/evidence/C04-registered-profile-diagnosis.json)에 세 실행을 보존했다.

실패한 [agent-profile.test.ts:139](../../runtime/src/tests/agent-profile.test.ts)는 임시 담당 하나에 CLI `init` 프로세스 8개를 동시에 시작한다. 모두 종료한 뒤 ID가 하나인지 확인하고 임시 데이터를 지운다. 이번 실패의 CLI 출력은 `agent_storage_path_unsafe`뿐이므로 정확한 DB 경로·stat 값·원 throw stack은 없다. 원 [related1 로그](../../runtime/evidence/C04-registered-related1.log)와 [단일 재실행 로그](../../runtime/evidence/C04-registered-new-profile-diagnostic1.log)를 함께 유지한다.

source `5fbcaf2a9e041479f06230548332db0860f91132a3ff2d366d7c9d69ca93f150`, build files `566f1372854a1399e2600c90d632ff97e320a0888606ff5bd890e0095b992b8a`의 1,611개 파일이다. 실패 실행은 source 전후 동일과 buildBefore를 기록했으며 buildAfter 필드는 없다. 뒤 단일·관련 재실행에는 같은 build의 전후 확인이 있다. 이 관측을 실패 실행의 사후 build 확인으로 소급하지 않는다. [관련 재실행 기록](../../runtime/evidence/C04-registered-related2.json) · [로그](../../runtime/evidence/C04-registered-related2.log).

## 이번 변경과 비교

완료된 window 업로드 tar의 원본을 디스크에 풀지 않고 읽어 현재 파일과 바이트 지문을 비교했다. `agent-database-owner.ts`, `sqlite-knowledge-owner.ts`, `agent-state-profile.ts`, `agent-memory-profile.ts`, `personal-memory-migration-profile.ts`, `file-agent-profile.ts`, 해당 시험 파일은 모두 동일하다. `agent-cli.ts`는 chat 도움말 한 줄만 바뀌었다. `agent-stores.ts`는 close 오류 보존을 바꿨으며 정상 owner 검사·DB 열기 순서는 그대로다. 등록 factory/주턴/compact 경로는 이 `init` 명령에서 호출하지 않는다.

따라서 등록 모델 연결이 잘못된 DB 객체를 만들었다는 직접 근거는 없다. [D2의 과거 진단](../../runtime/evidence/C03-drafts-initialization-diagnosis.json)에도 동시 첫 저장소 열기에서 같은 오류 코드가 관측됐다. **기존 초기화 경합의 재발이라는 가설이 우선이지만 동일 원인으로 확정할 수는 없다.** 과거 API 진단은 metadata를 부모에서 먼저 준비한 뒤 4개 worker를 실행했으므로 이번 8개 전체 CLI 초기화와 동일한 재현 조건도 아니다.

## 다음 재발 때 구분할 경계

[agent-database-owner.ts](../../runtime/src/infrastructure/agent-database-owner.ts)의 오류 지점은 다음과 같다.

- 25–26행: SQLite main 또는 `-wal/-shm/-journal`이 일반 파일인지, link 수가 1인지, private 권한과 UID가 맞는지 검사한다.
- 40행: 앞서 관측한 main이 사라졌거나 dev/ino가 바뀌었는지 검사한다.
- 58·79행: 존재/생성 확인과 최초 identity 확보 사이에 main이 사라졌는지 검사한다.

프로필 JSON의 `.pending` hardlink 게시와 SQLite 경로는 별개다. 프로필 후보의 정상 2-link 창을 DB 검사 오류의 원인으로 연결할 근거는 없다. SQLite sidecar의 일시적인 관측 값이나 main 재검사 경합은 후보 원인이지만, 현재 로그로 `nlink=0`, 권한, UID, inode 변경 중 어느 것인지 알 수 없다. 이를 추정해 검사 조건을 완화하지 않는다.

관련 시험의 한정 재실행은 통과했으므로 추가 진단 실행을 제안하지 않는다. 이후 다시 발생할 때만 새 private 임시 담당의 정확한 SQLite 경로를 대상으로, 원 `lstatSync`의 반환/예외를 바꾸지 않는 짧은 preload 관측을 추가하는 것이 최소 다음 단계다. PID·경로·dev/ino·nlink·mode·UID·존재 여부·호출 위치를 제한된 ring에 보존하고 실패 종료 때 출력한다. 기존 [C03 CLI trace](../../runtime/evidence/C03-drafts-owner-cli-trace.mjs)는 `agent-backend-binding-*` 경로만 선택하므로 **그대로 쓰면 이번 `agent-profile-*` 경로를 관측하지 못한다.** 정확한 새 fixture root에 맞춰야 한다.

관측은 타이밍을 바꿀 수 있다. 원인이 드러나지 않으면 미확정으로 남기며, 반복 통과를 얻기 위한 무제한 실행·sidecar 삭제·권한 재설정·경계 완화는 하지 않는다. 이 진단 작성에서는 소스·시험·기존 증거를 수정하지 않았고 빌드·시험·SSH도 실행하지 않았다.
