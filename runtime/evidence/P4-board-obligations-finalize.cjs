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
  const full = await run('P4-board-obligations-verify1'), targeted = await run('P4-board-obligations-target4');
  if (full.exitCode !== 0 || targeted.exitCode !== 0 || full.counts.tests !== 2306 || targeted.counts.tests !== 167 ||
    [full, targeted].some(value => value.counts.tests !== value.counts.pass || ['fail', 'cancelled', 'skipped', 'todo'].some(key => value.counts[key]))) throw new Error('verification_incomplete');
  const fullLog = await readFile(full.log, 'utf8'), architecture = JSON.parse(fullLog.split('\n').find(line => line.startsWith('{"inspected":')) ?? 'null');
  const fixture = await json('evidence/fixture-baseline.json'), build = await json('dist/build-manifest.json');
  const scenarioDurations = log => log.split('\n').filter(line => line.includes('two runtimes request, accept, answer and confirm'))
    .map(line => ({ scenario: line.slice(2, line.lastIndexOf(' (')), durationMs: Number(line.match(/\(([0-9.]+)ms\)$/)?.[1]) }));
  const { evaluationCodePin } = await import('../dist/infrastructure/local-evaluation.js');
  const current = await evaluationCodePin(process.cwd());
  if (current.digest !== build.sourceDigest || !architecture || architecture.failures.length || !fixture.passed || fixture.scenarios !== 4 ||
    fixture.checkpoints !== 22 || fixture.createdAt < full.startedAt) throw new Error('native_checks_incomplete');
  const recordPath = 'evidence/P4-board-obligations-local-verification.json';
  const record = { schemaVersion: 1, chapter: 'P4-board-obligations', revision: 'v0.48', createdAt: new Date().toISOString(), node: process.version,
    full, targeted, firstTargeted: await run('P4-board-obligations-target1'), secondTargeted: await run('P4-board-obligations-target2'),
    preDeadlineContractUpdate: await run('P4-board-obligations-target3'),
    build: { sourceDigest: build.sourceDigest, files: build.files.length }, coreTypecheck: 'passed_in_native_verify', lint: 'not_configured', architecture,
    fixtures: { path: 'evidence/fixture-baseline.json', createdAt: fixture.createdAt, scenarios: fixture.scenarios, checkpoints: fixture.checkpoints, passed: fixture.passed },
    cases: { additionalTests: 30, perStore: 15, stores: ['sqlite', 'file-journal'], families: ['documents', 'observations'],
      requestAndAcceptanceLostResult: true, durableObligationProjection: true, requesterConfirmationRequired: true,
      expiredWithdrawal: true, genericResolveDenied: true, retainedAuthorityAndProofRequired: true, humanQuestionSeparation: true,
      compactReopen: true, newSigkillCases: 0, pendingWaitAdditionalModelAndToolCalls: 0, happyPathToolCallsBothRoles: 8 },
    scenarioTimings: { targeted: scenarioDurations(await readFile(targeted.log, 'utf8')), nativeParallel: scenarioDurations(fullLog),
      interpretation: 'Test-case wall time including fixture, validation and compact/reopen; not production throughput or model latency.' },
    semantics: { declineAfterDeadline: 'explicit_waiver_allowed', lateAnswer: 'denied', coordinationProgressIsEvidence: false,
      sourceDataValidationIncludesCoordinationRecursion: false, requestStatusIsPermanentInputDependency: false },
    implementation: { requestTools: true, workObligations: true, sourceBoundControlValidation: true, eventWake: false,
      requestDiscovery: false, crossRoleBudget: false, autonomousTwoRuntimeReasoning: false },
    actualModel: 'cancelled_by_user', internalServices: 'not_run', goalStatus: 'in_progress' };
  await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  const paragraph = '이번 [협업 요청·의무 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-obligations-result.md)에서 요청·수락·답변·확인·거절·취소 도구를 각 작업의 의무와 연결했다. 응답 유실 뒤 의무를 복원하고, 대기와 답변 작성/확인을 구분한다. 전체 **2,306/2,306**, 관련 **167/167**, 신규 30개가 통과했다. **P4-01은 진행 중**이며 다음은 [요청 발견과 사건 기반 재개](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-wake-plan.md)다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-obligations-local-verification.json).';
  for (const path of ['README.md', '../design/README.md', '../design/03-migration-plan.md']) {
    let body = await readFile(path, 'utf8');
    body = body.replace('v0.47 · P4-01 게시판 쓰기와 복구', 'v0.48 · P4-01 협업 요청과 작업 의무');
    body = body.replace(/^이번 \[게시판 쓰기·복구 결과\].*$/m, paragraph);
    body = body.replace('읽기·게시·철회 runtime 도구와 컨텍스트/효과 복구를 검증했으며, 다음은 요청·답변 도구와 작업 의무 연결이다.',
      '읽기·게시·철회·요청 생명주기 도구와 각 작업의 의무·복구를 검증했으며, 다음은 요청 발견과 사건 기반 재개다.');
    await writeFile(path, body);
  }
  const verification = '../design/VERIFICATION.md';
  await writeFile(verification, (await readFile(verification, 'utf8')).replace('# 산출물 검증 결과\n',
    `# 산출물 검증 결과\n\n## v0.48 — 협업 요청과 작업 의무\n\n${paragraph}\n\nNode 24.20.0, native verify exit 0, ${full.counts.duration_ms}ms. 코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과. 신규 30개는 두 역할의 정해진 도구 계획을 실행한 로컬 시험이며 모델의 자율 협업 추론이나 실제 사내 연결 검증이 아니다.\n`));
  const backlogPath = '../design/implementation-backlog.json', backlog = await json(backlogPath), work = backlog.work_items.find(value => value.id === 'P4-01');
  backlog.revision = 'v0.48'; work.status = 'in_progress'; work.result = 'design/chapters/P4-board-obligations-result.md';
  Object.assign(work.verification, { record: `runtime/${recordPath}`, tests_passed: 2306, targeted_tests: 167, additional_tests: 30,
    runtime_tool_integration: 'read_publish_retract_and_request_lifecycle_verified', board_request_tools: 'verified', board_work_obligations: 'verified',
    board_request_record: `runtime/${recordPath}` });
  work.remaining = ['Discover incoming requests with bounded current-state metadata and trusted role filtering',
    'Add durable event cursors, duplicate-safe wake and missed-event recovery without cross-owner work mutation',
    'Add authorized cross-role parent/child budget integration without widening data grants',
    'Evaluate two-runtime counterevidence, hypothesis/replan and compact/reopen to completion; actual model validation remains separate',
    'Exercise computer-effect and board input closure together; bound retained effect metadata and input bundles without losing custody'];
  work.wake_plan = 'design/chapters/P4-board-wake-plan.md';
  backlog.next_local_work_item = { id: 'P4-01', scope: 'board_request_discovery_and_event_wake',
    prerequisite_note: 'Request lifecycle tools, own-work obligation projection, applied receipt recovery, actionable/waiting control and compact/reopen are locally verified. Next remove fixture-only request ID handoff, add event wake and then cross-role budgets and autonomous two-runtime reasoning. Actual model and internal services remain unverified.' };
  await writeFile(backlogPath, JSON.stringify(backlog, null, 2) + '\n');
  const resultPath = '../design/chapters/P4-board-obligations-result.md';
  let result = await readFile(resultPath, 'utf8');
  result = result.replace('2026-09-06 · 로컬 검증 진행 중', '2026-09-06 · v0.48 · 전체 2306/2306 · 관련 167/167 통과');
  result = result.replace('최종 수치는 전체 검증이 끝난 뒤 기록한다.',
    `최종 전체 **2306/2306**, 관련 **167/167**, 신규 **30개** 통과. 실패/취소/skip/todo 0, 빌드·코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과. 전체 시험 시간 ${full.counts.duration_ms}ms. [실행 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-obligations-local-verification.json).`);
  await writeFile(resultPath, result);
  const planPath = '../design/chapters/P4-board-obligations-plan.md';
  await writeFile(planPath, (await readFile(planPath, 'utf8')).replace('2026-09-06 · 구현 및 로컬 검증 중',
    '2026-09-06 · 요청 도구/의무 로컬 검증 완료 · 요청 발견/이벤트 재개는 후속 단위'));
  console.log(JSON.stringify({ record: recordPath, full: full.counts, targeted: targeted.counts, sourceDigest: build.sourceDigest,
    files: build.files.length, architecture, next: backlog.next_local_work_item }));
})().catch(error => { console.error(error); process.exitCode = 1; });
