const { readFile, writeFile } = require('node:fs/promises');

const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function run(name) {
  const exit = await json(`evidence/${name}-exit.json`);
  const log = await readFile(exit.log, 'utf8');
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) {
    const match = log.match(new RegExp(`ℹ ${key} ([0-9.]+)`));
    if (!match) throw new Error(`missing_count_${key}`);
    counts[key] = Number(match[1]);
  }
  return { ...exit, counts };
}
(async () => {
  const full = await run('P4-board-inputs-verify-connected');
  const targeted = await run('P4-board-inputs-targeted-connected');
  const firstFull = await run('P4-board-inputs-verify-final');
  if (full.exitCode !== 0 || full.counts.tests !== 2236 || full.counts.pass !== 2236 || targeted.exitCode !== 0 || targeted.counts.pass !== 165 ||
      [full, targeted].some(run => ['fail', 'cancelled', 'skipped', 'todo'].some(key => run.counts[key] !== 0))) throw new Error('verification_not_complete');
  const log = await readFile(full.log, 'utf8');
  const architecture = JSON.parse(log.split('\n').find(line => line.startsWith('{"inspected":')) ?? 'null');
  const fixture = await json('evidence/fixture-baseline.json');
  const build = await json('dist/build-manifest.json');
  if (!architecture || architecture.failures.length || !fixture.passed || fixture.scenarios !== 4 || fixture.checkpoints !== 22 || fixture.createdAt < full.startedAt)
    throw new Error('native_checks_incomplete');
  const record = { schemaVersion: 1, chapter: 'P4-board-inputs', revision: 'v0.46', createdAt: new Date().toISOString(), node: process.version,
    full, targeted, firstFull, firstTargeted: await run('P4-board-inputs-targeted-1'),
    initialFailure: 'Board success used unknown coverage, violating the common ToolResult contract; complete/partial page results now match it.',
    build: { sourceDigest: build.sourceDigest, files: build.files.length }, coreTypecheck: 'passed_in_native_verify', architecture,
    fixtures: { path: 'evidence/fixture-baseline.json', createdAt: fixture.createdAt, scenarios: fixture.scenarios, checkpoints: fixture.checkpoints, passed: fixture.passed },
    cases: { additionalTests: 36, boardRuntimeTests: 34, missingNestedValidatorTests: 2, familyStorageCases: 4,
      stateStores: ['sqlite', 'file-journal'], boardStores: ['sqlite', 'file-journal'], knowledgeStore: 'sqlite',
      runtimeReopen: true, newOwnedWorkerSigkillCases: 0, mixedMemoryCollectionBoard: true, mixedComputerEffectBoard: 'not_separately_exercised' },
    implementation: { readTool: 'core.board.read', generalInputCustody: true, currentHostAuthority: true, internalMetadataHidden: true,
      boardWritesAsRuntimeTools: false, boardWorkObligations: false, crossRoleBudget: false },
    actualModel: 'cancelled_by_user', internalServices: 'not_run', goalStatus: 'in_progress' };
  const recordPath = 'evidence/P4-board-inputs-local-verification.json';
  await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  const paragraph = '이번 [게시판 지속 입력 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-inputs-result.md)에서 `core.board.read`를 실제 runtime 호출과 입력 장부에 연결했다. 두 역할의 글·기억·수집 출처를 공통 그래프로 검사하고, 과거 호출·공개 화면·compact/reopen에서도 현재 권한과 원본을 확인한다. 전체 **2,236/2,236**, 관련 **165/165**, 신규 36개가 통과했다. **P4-01은 진행 중**이며 다음은 [게시·요청·답변 도구와 작업 의무](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-writes-plan.md)다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-inputs-local-verification.json).';
  for (const path of ['README.md', '../design/README.md', '../design/03-migration-plan.md']) {
    let body = await readFile(path, 'utf8');
    body = body.replace('v0.45 · P4-01 공통 입력 검증', 'v0.46 · P4-01 게시판 지속 입력');
    body = body.replace(/^이번 \[공통 입력 검증 결과\].*$/m, paragraph);
    await writeFile(path, body);
  }
  const verification = '../design/VERIFICATION.md';
  const detail = `Node 24.20.0, native verify exit 0, ${full.counts.duration_ms}ms. 코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과. 관련 시험은 전체 시험에 포함된다. 새 모델/API·사내 서비스·운영 배포 시험은 없으며, 두 runtime의 쓰기/의무/예산/가설 재계획 전체 흐름은 남아 있다.`;
  await writeFile(verification, (await readFile(verification, 'utf8')).replace('# 산출물 검증 결과\n', `# 산출물 검증 결과\n\n## v0.46 — 게시판 읽기와 지속 입력\n\n${paragraph}\n\n${detail}\n`));
  const backlogPath = '../design/implementation-backlog.json', backlog = await json(backlogPath);
  const work = backlog.work_items.find(work => work.id === 'P4-01');
  backlog.revision = 'v0.46'; work.status = 'in_progress'; work.result = 'design/chapters/P4-board-inputs-result.md';
  Object.assign(work.verification, { record: `runtime/${recordPath}`, tests_passed: 2236, targeted_tests: 165, additional_tests: 36,
    runtime_tool_integration: 'read_verified_write_pending', retained_board_input_validation: 'verified',
    cross_owner_current_grant_resolution: 'verified_for_board_and_memory', mixed_effect_collection_input_closure: 'memory_collection_board_verified_effect_combination_pending',
    board_runtime_tests: 34, missing_nested_validator_tests: 2, runtime_reopen_family_storage_cases: 4,
    input_graph_record: 'runtime/evidence/P4-board-input-graph-local-verification.json', board_read_inputs_record: `runtime/${recordPath}` });
  work.remaining = [
    'Bind publish/retract/request/accept/answer/confirm to runtime tools with durable command identity, proof and call budgets',
    'Connect board requests to WorkState obligations, interruption/reconciliation and event-driven wake',
    'Add authorized cross-role parent/child budget integration without widening data grants',
    'Evaluate two-runtime counterevidence, hypothesis/replan and compact/reopen to completion; actual model validation remains separate',
    'Exercise a computer-effect proof and retained board inputs in the same closure; optimize bounded input bundles without dropping custody'
  ];
  work.write_plan = 'design/chapters/P4-board-writes-plan.md';
  backlog.next_local_work_item = { id: 'P4-01', scope: 'board_write_tools_receipts_and_work_obligations',
    prerequisite_note: 'Board read tools, retained observations, current host authority, memory/collection closure and compact/reopen are locally verified. Start with publish/retract tools and durable receipt reconciliation, then request obligations, wake, cross-role budgets and two-runtime reasoning. Actual model and internal service integrations remain unverified.' };
  await writeFile(backlogPath, JSON.stringify(backlog, null, 2) + '\n');
  const resultPath = '../design/chapters/P4-board-inputs-result.md';
  let result = await readFile(resultPath, 'utf8');
  result = result.replace('관련 165개 통과 · 최종 전체 검증 진행 중', 'v0.46 · 전체 2236/2236 · 관련 165/165 검증 완료');
  result = result.replace('첫 전체 검증은 2234/2234 통과했으며, 중첩 입력 보완 후 최종 전체 검증을 진행 중이다.',
    `첫 전체 검증은 2234/2234 통과했다. 중첩 입력 보완 후 최종 전체 **2236/2236**, 관련 **165/165**, 실패/취소/skip/todo 0이며 빌드·코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22를 통과했다. 최종 전체 시험 시간은 ${full.counts.duration_ms}ms다. [실행 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-inputs-local-verification.json).`);
  await writeFile(resultPath, result);
  const planPath = '../design/chapters/P4-board-runtime-plan.md';
  await writeFile(planPath, (await readFile(planPath, 'utf8')).replace('관련 165개 시험을 통과했으며 최종 전체 검증 중이다.', '전체 2236/2236·관련 165/165 시험으로 읽기 연결을 로컬 검증했다.'));
  console.log(JSON.stringify({ record: recordPath, sourceDigest: build.sourceDigest, files: build.files.length, full: full.counts, targeted: targeted.counts, architecture, next: backlog.next_local_work_item }));
})().catch(error => { console.error(error); process.exitCode = 1; });
