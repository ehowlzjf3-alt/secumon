# Collection 문서 게시 후보 — 미실행

`../C05-mcp-collections-update-docs.mjs`와 이 디렉터리는 **게시 후보**다. 현재 design/HTML/backlog/runtime README를 쓰지 않았고 새 결과·사용법도 이 디렉터리의 템플릿으로만 보관했다. 템플릿의 `@@...@@`는 실제 최종 proof를 검증한 뒤에만 치환한다. NAS 진행 중 수치나 예상 총계로 문서를 게시하지 않는다.

`manifest.json`은 후보 script·템플릿 두 개·기존 대상 문서 일곱 개·보존할 로컬 원증거·선행 offline updater의 SHA256을 담는다. `originals/`는 대상 일곱 파일의 byte 사본이다. 같은 파일이 후보 검토 뒤 바뀌면 updater가 쓰기 전에 거절한다. 신규 결과·사용법 대상이 이미 있어도 거절하므로 먼저 root가 소유 범위와 입력 변경을 검토해야 한다.

## 후보의 게시 대상 9개

- 신규 `design/chapters/C05-mcp-collections-entry-result.md`
- 기존 `design/chapters/C05-mcp-collections-entry-plan.md`
- 신규 `design/chapters/C05-mcp-collections-entry-usage.md`
- 기존 `design/chapters/C05-mcp-host-usage.md`
- 기존 `design/README.md`
- 기존 `design/03-migration-plan.md`
- 기존 `design/implementation-backlog.json`
- 기존 `runtime/README.md`
- 기존 `design/secumon-review.html`

다음 계획 링크는 기존 entry plan을 유지하며 `collection_post_send_custody_required_followup_not_implemented`로 명시한다. 별도 custody 설계는 이 후보가 채택하거나 덮어쓰지 않는다. C05는 `in_progress`, chapter/전체 goal은 미완료다. v0.66과 모든 이전 proof/snapshot은 보존하고 현재 표지만 v0.67로 갱신한다.

## Root가 게시 전 확인할 조건

1. collection `verification.json`이 실제 `verified_supported_local_posix_partial_chapter`이며 현재 source/build와 같아야 한다. 로컬 runner before/after·Node24·실제 exec 종료·TAP/선택 파일을 다시 대조한다. 183/519를 상수로 승인하지 않는다.
2. native의 정확한 8단계 성공, 결과/원로그 9개 수집, 원본 SHA, detached group 종료, 관측 가능한 전용 프로세스 0, SSH/control 디렉터리 종료를 확인한다. inaccessible/unresolved peer는 전역 프로세스 부재로 바꾸지 않는다.
3. CLI 2·HTTP 3과 문맥 선택 2·근거 조회 준비 2의 실제 성공 이름이 동일 pin의 로컬 및 Linux 신규 원로그에 있어야 한다. HTTP의 정상 partial batch 한 사례는 SQLite이며 SIGKILL/file-journal 인수로 확대하지 않는다.
4. 이전 offline proof와 원 실패/반례/교정 증거를 그대로 읽고 해시를 기록한다. 새 native 선행 실패는 proof에 있을 때만 표시한다. 최종 proof 밖에 보완한 로컬 증거는 별도 `retainedCandidateEvidence`다.
5. 모든 9개 문자열을 메모리에서 완성한 뒤 링크·JSON·HTML의 앵커와 역사 보존을 검사한다. 기존 코드 예제·CSS·실행 JS·16모듈의 비대상 필드·31역사 항목·93용어·기존 snapshot은 보존한다. 기존 문서 일곱 개의 작성 시점 byte와 다르면 먼저 거절한다.
6. 쓰기 직전 proof/모든 읽은 파일의 해시/current build를 다시 검사한다. 새 문서는 `wx`이며 중복 실행 marker도 거절한다. 다중 파일 원자 게시는 아니므로 쓰기 중 오류라면 자동 재실행하지 말고 보존한 원본과 부분 상태를 root가 검토한다.

이번 준비에서는 updater import/실행, `node --check`, 빌드/시험, SSH, 실제 브라우저 검증을 하지 않았다. Root가 syntax와 정적 입력을 검토한 뒤 실제 native finalization·정리 완료 시 한 번 게시한다. 문서 정적 검사는 제품 시험이나 브라우저 렌더링의 추가 통과가 아니다.

향후 실행 위치는 `runtime`이며 실제 build manifest의 Node24를 사용한다. 아직 실행할 명령이나 자동 스케줄은 등록하지 않았다. stdout에는 변경 전/후 문서 SHA와 proof SHA가 출력되므로 root가 새 증거 파일로 보존한다.
