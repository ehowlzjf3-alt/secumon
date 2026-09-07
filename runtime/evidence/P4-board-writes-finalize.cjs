const { readFile, writeFile } = require('node:fs/promises');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function run(name) {
  const exit = await json(`evidence/${name}-exit.json`), log = await readFile(exit.log, 'utf8'), counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) {
    const match = log.match(new RegExp(`ℹ ${key} ([0-9.]+)`)); if (!match) throw new Error(`missing_${key}`); counts[key] = Number(match[1]);
  }
  return { ...exit, counts };
}
(async () => {
  const full = await run('P4-board-writes-verify-authority'), targeted = await run('P4-board-writes-targeted-5');
  if (full.exitCode !== 0 || full.counts.pass !== 2276 || full.counts.tests !== 2276 || targeted.exitCode !== 0 || targeted.counts.pass !== 195 ||
      [full, targeted].some(value => ['fail', 'cancelled', 'skipped', 'todo'].some(key => value.counts[key] !== 0))) throw new Error('verification_incomplete');
  const fullLog = await readFile(full.log, 'utf8');
  const architecture = JSON.parse(fullLog.split('\n').find(line => line.startsWith('{"inspected":')) ?? 'null');
  const fixture = await json('evidence/fixture-baseline.json'), build = await json('dist/build-manifest.json');
  if (!architecture || architecture.failures.length || !fixture.passed || fixture.scenarios !== 4 || fixture.checkpoints !== 22 || fixture.createdAt < full.startedAt)
    throw new Error('native_checks_incomplete');
  const recordPath = 'evidence/P4-board-writes-local-verification.json';
  const record = { schemaVersion: 1, chapter: 'P4-board-writes', revision: 'v0.47', createdAt: new Date().toISOString(), node: process.version,
    full, targeted, firstFull: await run('P4-board-writes-verify-final'), secondFull: await run('P4-board-writes-verify-connected'), preAuthorityFull: await run('P4-board-writes-verify-stable'), authorityBeforeFix: await run('P4-board-writes-authority-before-fix'), fixtureTiming: 'Board normal-flow lease increased from 1s to 10s; the depth-two computer recovery fixture uses a 60s requested lease bounded by the original work deadline after two full runs returned computer_interrupted under parallel proof I/O. Product runtime defaults and original action deadlines are unchanged.', initialBuilds: await Promise.all(['P4-board-writes-build-1', 'P4-board-writes-build-2'].map(name => json(`evidence/${name}-exit.json`))),
    firstTargeted: { ...await run('P4-board-writes-targeted-1'), authoritative: false,
      reason: 'Run against output emitted by an unsuccessful type build; the ResumePacket test field path failed in both stores. Superseded by successful build and targeted/native verification.' },
    build: { sourceDigest: build.sourceDigest, files: build.files.length }, coreTypecheck: 'passed_in_native_verify', lint: 'not_configured', architecture,
    fixtures: { path: 'evidence/fixture-baseline.json', createdAt: fixture.createdAt, scenarios: fixture.scenarios, checkpoints: fixture.checkpoints, passed: fixture.passed },
    cases: { additionalTests: 40, perStateStore: 20, stateStores: ['sqlite', 'file-journal'], boardStores: ['sqlite', 'file-journal'],
      newOwnedStorageWorkerSigkillCases: 2, newWholeExecutorSigkillCases: 0, runtimeReopen: true,
      publishRetractBroker: true, missingResultRecovery: true, immutableUnknownResult: true, lateValidResult: true,
      authorityRecheckedAfterProofIO: true, narrowerSessionAuthority: true, atomicAbsentCommandClosure: true, lateCommitRejected: true, effectReceiptCurrentAuthority: true, originalProofLoss: true,
      missingStoredReceipt: true, retainedQuoteInputs: true, compactProtectedEffectMetadata: true },
    implementation: { tools: ['core.board.publish', 'core.board.retract'], genericEffectReceipt: true, rawResultReplacement: false,
      receiptImpliesGoalCompletion: false, boardRequestTools: false, boardWorkObligations: false, crossRoleBudget: false },
    actualModel: 'cancelled_by_user', internalServices: 'not_run', goalStatus: 'in_progress' };
  await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  const paragraph = '이번 [게시판 쓰기·복구 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-writes-result.md)에서 `core.board.publish`/`core.board.retract`를 runtime에 연결했다. 저장 영수증으로 효과를 확인하고, 응답 유실 때 원래 결과를 보존하며 미실행 종료 기록으로 늦은 중복 저장을 막는다. 전체 **2,276/2,276**, 관련 **195/195**, 신규 40개가 통과했다. **P4-01은 진행 중**이며 다음은 [요청·답변과 작업 의무](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-obligations-plan.md)다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-writes-local-verification.json).';
  for (const path of ['README.md', '../design/README.md', '../design/03-migration-plan.md']) {
    let body = await readFile(path, 'utf8'); body = body.replace('v0.46 · P4-01 게시판 지속 입력', 'v0.47 · P4-01 게시판 쓰기와 복구');
    body = body.replace(/^이번 \[게시판 지속 입력 결과\].*$/m, paragraph);
    body = body.replace('다음 로컬 소단위는 게시판의 runtime 도구·의무·컨텍스트 연결이다.', '읽기·게시·철회 runtime 도구와 컨텍스트/효과 복구를 검증했으며, 다음은 요청·답변 도구와 작업 의무 연결이다.');
    await writeFile(path, body);
  }
  const verification = '../design/VERIFICATION.md';
  await writeFile(verification, (await readFile(verification, 'utf8')).replace('# 산출물 검증 결과\n', `# 산출물 검증 결과\n\n## v0.47 — 게시판 게시·철회와 효과 복구\n\n${paragraph}\n\nNode 24.20.0, native verify exit 0, ${full.counts.duration_ms}ms. 코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과. 신규 owned 저장 작업자 SIGKILL 2개이며 전체 executor의 새 SIGKILL 시험은 아니다. 실제 모델/API·사내 서비스·운영 배포는 미실행이다.\n`));
  const backlogPath = '../design/implementation-backlog.json', backlog = await json(backlogPath), work = backlog.work_items.find(value => value.id === 'P4-01');
  backlog.revision = 'v0.47'; work.status = 'in_progress'; work.result = 'design/chapters/P4-board-writes-result.md';
  Object.assign(work.verification, { record: `runtime/${recordPath}`, tests_passed: 2276, targeted_tests: 195, additional_tests: 40,
    runtime_tool_integration: 'read_publish_retract_verified_request_tools_pending', board_write_receipts: 'verified', board_write_tests: 40,
    board_read_inputs_record: 'runtime/evidence/P4-board-inputs-local-verification.json', board_write_record: `runtime/${recordPath}` });
  work.remaining = ['Bind request/accept/answer/confirm/decline/cancel to runtime tools with durable identity and effect receipts',
    'Project board request state into each authorized WorkState obligation and event-driven wake without a cross-store atomic transaction',
    'Add authorized cross-role parent/child budget integration without widening data grants',
    'Evaluate two-runtime counterevidence, hypothesis/replan and compact/reopen to completion; actual model validation remains separate',
    'Exercise computer-effect and board input closure together; bound retained effect metadata and input bundles without losing custody'];
  work.obligations_plan = 'design/chapters/P4-board-obligations-plan.md';
  backlog.next_local_work_item = { id: 'P4-01', scope: 'board_request_tools_and_work_obligations',
    prerequisite_note: 'Read/publish/retract, durable command closure, receipt reconciliation and compact/reopen are locally verified. Next bind request lifecycle tools to per-work obligations, then event wake, cross-role budgets and two-runtime reasoning. Actual model and internal services remain unverified.' };
  await writeFile(backlogPath, JSON.stringify(backlog, null, 2) + '\n');
  const resultPath = '../design/chapters/P4-board-writes-result.md';
  let result = await readFile(resultPath, 'utf8'); result = result.replace('관련 최종 재검증 중 · 전체 검증 진행 중', 'v0.47 · 전체 2276/2276 · 관련 195/195 검증 완료');
  result = result.replace('전체 검증은 진행 중이며 최종 수치를 아직 확정하지 않는다.', `최종 전체 **2276/2276**, 관련 **195/195**도 통과했고 실패/취소/skip/todo 0, 빌드·코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22를 통과했다. 전체 시험 시간은 ${full.counts.duration_ms}ms다. [실행 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-writes-local-verification.json).`);
  await writeFile(resultPath, result);
  const planPath = '../design/chapters/P4-board-writes-plan.md';
  await writeFile(planPath, (await readFile(planPath, 'utf8')).replace('2026-09-06 · 계획 · 구현 전', '2026-09-06 · 게시/철회·영수증 복구 로컬 검증 완료 · 요청/의무 구현 전') + '\n게시/철회와 효과 복구는 [결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-writes-result.md)에 기록했다. 다음 실행 단위는 [요청/의무 계획](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-obligations-plan.md)이다.\n');
  console.log(JSON.stringify({ record: recordPath, full: full.counts, targeted: targeted.counts, sourceDigest: build.sourceDigest, files: build.files.length, architecture, next: backlog.next_local_work_item }));
})().catch(error => { console.error(error); process.exitCode = 1; });
