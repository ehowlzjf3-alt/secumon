import { readFile, writeFile, appendFile } from 'node:fs/promises';

const record = JSON.parse(await readFile('evidence/P3-mcp-waits-local-verification.json', 'utf8'));
if (record.status !== 'local_verified') throw new Error('chapter not verified');
const all = record.checks['verify-final'].summary; const related = record.checks['targeted-final'].summary;
const resultLink = '/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-waits-result.md';
const recordLink = '/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-waits-local-verification.json';
const summary = `이번 [MCP 대기·재개 결과](${resultLink})에서 제한 응답의 재개 시각을 저장하고 모델 호출 없이 기다린 뒤 남은 항목을 이어가는 경로를 구현했다. 전체 **${all.pass}/${all.tests}**, 관련 **${related.pass}/${related.tests}**, 실제 로컬 worker SIGKILL 복원 4개가 통과했다. 과거 Python 구현 전체를 비교하지 않고 현재 기능과 새 코어의 회귀를 검증했다. P3-01과 전체 P0–P6는 진행 중이다. 실제 모델·사내 MCP·Knox와 상시 스케줄러는 이번 검증에 포함하지 않았다. [검증 기록](${recordLink}).`;
for (const path of ['../design/README.md', '../design/03-migration-plan.md']) {
  let body = await readFile(path, 'utf8');
  body = body.replace('2026-09-06 · v0.40 · P3-01 로컬 MCP collection·재개 검증', '2026-09-06 · v0.41 · P3-01 MCP 제한 대기·명시 재개');
  body = body.replace(/^이번 \[MCP collection 학습·결과\][^\n]*/m, summary);
  await writeFile(path, body);
}
let runtime = await readFile('README.md', 'utf8');
runtime = runtime.replace(/^이번 \[MCP collection 학습·결과\][^\n]*/m, summary); await writeFile('README.md', runtime);
let verification = await readFile('../design/VERIFICATION.md', 'utf8');
verification = verification.replace('# 산출물 검증 결과\n', `# 산출물 검증 결과\n\n## v0.41 — MCP 제한 대기와 명시 재개\n\n${summary}\n`);
await writeFile('../design/VERIFICATION.md', verification);
let plan = await readFile('../design/chapters/P3-mcp-waits-plan.md', 'utf8');
plan = plan.replace('2026-09-06 · 계획/구현 중 · 선행 v0.40, 전체2,040개 검증', '2026-09-06 · 로컬 구현·검증 완료 · 결과: P3-mcp-waits-result.md');
await writeFile('../design/chapters/P3-mcp-waits-plan.md', plan);
let result = await readFile('../design/chapters/P3-mcp-waits-result.md', 'utf8');
result = result.replace('2026-09-06 · 구현 완료, 전체 검증 진행 중', '2026-09-06 · v0.41 · 로컬 구현·검증 완료');
result = result.replace('전체 native verify 결과와 실행한 소스·빌드 기록은 검사가 끝나면 아래에 추가한다.',
  `전체 native verify는 **${all.pass}/${all.tests}**, 실패·취소·건너뜀 0으로 종료했다. 코어 타입 검사, 계층 검사 ${record.architecture.inspected}파일/위반 0, fixture ${record.fixture.scenarios}개/${record.fixture.checkpoints}판정도 통과했다. 신규 시험은 MCP 30·복원 4·제어 8·checkpoint 4·proof 3으로 49개다. [실행 로그·소스/빌드 기록](${recordLink})에 현재 파일과 실행 산출물의 일치를 저장했다. 별도 lint 명령은 없다.`);
await writeFile('../design/chapters/P3-mcp-waits-result.md', result);
const backlogPath = '../design/implementation-backlog.json';
const backlog = JSON.parse(await readFile(backlogPath, 'utf8')); backlog.revision = 'v0.41';
const item = backlog.work_items.find(value => value.id === 'P3-01');
item.plan = 'design/chapters/P3-mcp-waits-plan.md'; item.result = 'design/chapters/P3-mcp-waits-result.md';
const { total: _total, ...newTestGroups } = record.additionalTests;
Object.assign(item.verification, { record: 'runtime/evidence/P3-mcp-waits-local-verification.json', tests_passed: all.pass,
  additional_tests: 49, new_test_groups: newTestGroups, targeted_tests: related.pass,
  rate_limit_wait_and_resume: 'local_stdio_verified', actual_owned_worker_sigkill_cases: 4, background_scheduler: 'not_implemented' });
item.remaining = item.remaining.filter(value => !value.startsWith('Rate-limit Retry-After/cooldown'));
item.remaining.unshift('HTTP Retry-After and endpoint-wide quota profiles; background wake driver belongs to P4-03');
backlog.next_local_work_item = { id: 'P3-01', scope: 'collection_coverage_and_unadopted_response_recovery',
  prerequisite_note: 'Local MCP wait and explicit resume passed with fixed original retry time, bounded calls and no model polling. Next define business completion coverage and recovery for a stored response not yet adopted into the checkpoint. Scope is driven by current requirements; repeated legacy-code comparisons are unnecessary. Internal service/model/API runs remain unverified.' };
await writeFile(backlogPath, JSON.stringify(backlog, null, 2) + '\n');
await appendFile('../design/WORKLOG.md', `\n## 체크포인트 133: MCP 대기·재개 검증 완료\n\n- 제한 응답/항목 retryAt → 영속 checkpoint → Control.wait/runnable → 명시 재개를 연결했다. 요약으로 원본 검증 후보를 제외하는 결함도 수정했다.\n- 관련 ${related.pass}/${related.tests}, 전체 ${all.pass}/${all.tests}, 실패·취소0. 실제 SIGKILL 복원4개와 신규49개를 검증했다. 초기 회귀 시험 준비 오류1개를 수정했고 실패 로그는 보존한다.\n- 결과는 P3-mcp-waits-result.md, 검증 정본은 runtime/evidence/P3-mcp-waits-local-verification.json. 소스 digest ${record.sourceDigest}. 현재 소스·빌드와 이번 실행 증거만 기록했으며 과거 Python/압축 원본/이전 모든 기록의 대조를 반복하지 않았다.\n- 사용자 보완에 따라 학습 가이드의 Python 대안 비교 필수 실습도 제거했다. P3-01/전체 P0–P6는 진행 중이며 모델/API 취소를 유지한다. 다음은 수집 완료의 업무 의미와 미반영 응답 복원 조건이다.\n`);
console.log(JSON.stringify({ revision: backlog.revision, tests: all.pass, chapter: 'local_verified', goal: 'in_progress' }));
