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
  const full = await run('P4-board-wake-verify1'), targeted = await run('P4-board-wake-target4');
  if (full.counts.tests !== 2354 || [full, targeted].some(value => value.exitCode || value.counts.tests !== value.counts.pass ||
    ['fail', 'cancelled', 'skipped', 'todo'].some(key => value.counts[key]))) throw new Error('verification_incomplete');
  const fullLog = await readFile(full.log, 'utf8'), architecture = JSON.parse(fullLog.split('\n').find(line => line.startsWith('{"inspected":')) ?? 'null');
  const fixture = await json('evidence/fixture-baseline.json'), build = await json('dist/build-manifest.json');
  const { evaluationCodePin } = await import('../dist/infrastructure/local-evaluation.js');
  const pin = await evaluationCodePin(process.cwd());
  if (pin.digest !== build.sourceDigest || !architecture || architecture.failures.length || !fixture.passed || fixture.scenarios !== 4 ||
    fixture.checkpoints !== 22 || fixture.createdAt < full.startedAt) throw new Error('native_checks_incomplete');
  const times = text => text.split('\n').filter(line => line.includes('discover and finish a request using observed IDs'))
    .map(line => ({ scenario: line.slice(2, line.lastIndexOf(' (')), durationMs: Number(line.match(/\(([0-9.]+)ms\)$/)?.[1]) }));
  const path = 'evidence/P4-board-wake-local-verification.json';
  const record = { schemaVersion: 1, chapter: 'P4-board-wake', revision: 'v0.49', createdAt: new Date().toISOString(), node: process.version,
    full, targeted, firstTargeted: await run('P4-board-wake-target1'), intermediateTargeted: await run('P4-board-wake-target2'),
    beforeModelFixtureBudget: await run('P4-board-wake-target3'),
    firstStorage: await run('P4-board-wake-store1'), correctedHappy: await run('P4-board-wake-happy2'),
    build: { sourceDigest: build.sourceDigest, files: build.files.length }, coreTypecheck: 'passed_in_native_verify', lint: 'not_configured', architecture,
    fixtures: { path: 'evidence/fixture-baseline.json', createdAt: fixture.createdAt, scenarios: fixture.scenarios, checkpoints: fixture.checkpoints, passed: fixture.passed },
    cases: { additionalTests: 48, runtimeDiscoveryAndWake: 38, changeStorage: 10, stores: ['sqlite', 'file-journal'], families: ['documents', 'observations'],
      observedRequestIdAndRevisionHandoff: true, historicalMetadataPreserved: true, newIndependentEvidence: 0,
      happyPathToolCallsBothRoles: 14, happyPathModelCalls: 0, duplicateWakeAdditionalToolAndModelCalls: 0,
      duplicateWakeChatDeliveries: 0, missedWakeAndLostCheckpointReply: true, newOwnedBoardWorkerSigkillCases: 2,
      authorityWithdrawalAfterFinalMetadataRead: true, pendingNoticeBlocksCompletion: true, reservedModelInvalidatedBeforeInvocation: true,
      compactReopen: true, goalDataPauseAndTerminalLifecycle: true, boundedMetadataPagination: true, missingEventHistoryDenied: true, preEventSqliteRescan: true },
    limits: { subscriptionsPerWork: 16, notificationsPerWork: 512, eventsPerPage: 32, eventPageBytes: 65536,
      requestsPerPage: 20, requestPageBytes: 32768, requestPages: 13, contentionRetries: 8, cooperativeRefreshDeadlineMs: 10000 },
    scenarioTimings: { targeted: times(await readFile(targeted.log, 'utf8')), nativeParallel: times(fullLog),
      interpretation: 'Test-case elapsed time including fixture, proof I/O and compact/reopen. Not production throughput or model latency.' },
    implementation: { requestDiscovery: true, durableEventCursor: true, hostRefreshWake: true, daemonOrFairRoleDispatcher: false,
      crossRoleBudget: false, autonomousTwoRuntimeReasoning: false },
    actualModel: 'cancelled_by_user', internalServices: 'not_run', goalStatus: 'in_progress' };
  const counts = `전체 **${full.counts.tests}/${full.counts.pass}**, 관련 **${targeted.counts.tests}/${targeted.counts.pass}**, 신규 **48개**`;
  const paragraph = `이번 [요청 발견·재개 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-wake-result.md)에서 제한된 요청 조회와 영속 구독·알림을 연결했다. 중복/누락 알림, 처리 중 권한 변경, compact/reopen과 작업 수명을 검증했다. ${counts}가 통과했다. **P4-01은 진행 중**이며 다음은 [역할 간 예산과 수락 조건](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-budget-plan.md)이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-wake-local-verification.json).`;
  const updates = new Map();
  for (const file of ['README.md', '../design/README.md', '../design/03-migration-plan.md']) {
    let body = await readFile(file, 'utf8');
    body = body.replace('v0.48 · P4-01 협업 요청과 작업 의무', 'v0.49 · P4-01 요청 발견과 사건 기반 재개');
    body = body.replace(/^이번 \[협업 요청·의무 결과\].*$/m, paragraph);
    body = body.replace('읽기·게시·철회·요청 생명주기 도구와 각 작업의 의무·복구를 검증했으며, 다음은 요청 발견과 사건 기반 재개다.',
      '읽기·게시·철회·요청 생명주기·의무·발견·영속 알림/복구를 검증했으며, 다음은 역할 간 예산과 수락 조건이다.');
    updates.set(file, body);
  }
  const verification = '../design/VERIFICATION.md';
  updates.set(verification, (await readFile(verification, 'utf8')).replace('# 산출물 검증 결과\n',
    `# 산출물 검증 결과\n\n## v0.49 — 요청 발견과 사건 기반 재개\n\n${paragraph}\n\nNode 24.20.0, native verify exit 0, ${full.counts.duration_ms}ms. 코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과. 신규 48개에는 소유 board worker SIGKILL 2개가 포함된다. host refresh의 영속 재개 검증이며 상시 역할 dispatcher·자율 추론·실제 사내 연결 검증은 아니다.\n`));
  const resultPath = '../design/chapters/P4-board-wake-result.md';
  updates.set(resultPath, (await readFile(resultPath, 'utf8')).replace('2026-09-06 · 로컬 검증 진행 중', '2026-09-06 · v0.49 · 로컬 검증 완료')
    .replace('최종 수치는 전체 검증이 끝난 뒤 기록한다.', `${counts} 통과. 실패/취소/skip/todo 0. 빌드·코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과. 전체 시험 시간 ${full.counts.duration_ms}ms. [실행 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-wake-local-verification.json).`));
  const plan = '../design/chapters/P4-board-wake-plan.md';
  updates.set(plan, (await readFile(plan, 'utf8')).replace('2026-09-06 · 구현 및 로컬 검증 중', '2026-09-06 · 요청 발견/영속 알림 로컬 검증 완료 · 역할 dispatcher/자율 추론은 후속 범위'));
  const backlogPath = '../design/implementation-backlog.json', backlog = await json(backlogPath), work = backlog.work_items.find(value => value.id === 'P4-01');
  if (!work) throw new Error('missing_work_item');
  backlog.revision = 'v0.49'; work.status = 'in_progress'; work.result = 'design/chapters/P4-board-wake-result.md';
  Object.assign(work.verification, { record: `runtime/${path}`, tests_passed: full.counts.pass, targeted_tests: targeted.counts.pass, additional_tests: 48,
    runtime_tool_integration: 'read_publish_retract_requests_discovery_and_work_wake_verified', request_discovery: 'verified', board_event_wake: 'host_refresh_verified',
    role_dispatcher: 'not_implemented', board_wake_record: `runtime/${path}` });
  work.remaining = ['Add authorized cross-role parent/child budget admission and settlement without widening data grants',
    'Connect fair host role dispatch and bounded wake polling; define new mission policy after per-work subscriptions close',
    'Evaluate two-runtime counterevidence, hypothesis/replan and compact/reopen to completion; actual model validation remains separate',
    'Exercise computer-effect and board input closure together; bound retained effect metadata and input bundles without losing custody'];
  work.budget_plan = 'design/chapters/P4-board-budget-plan.md';
  backlog.next_local_work_item = { id: 'P4-01', scope: 'board_cross_role_budget_admission',
    prerequisite_note: 'Bounded request discovery, durable event checkpoints, host wake, metadata observation receipts and compact/reopen are locally verified. Next couple request acceptance to authorized per-role budget admission and settlement; fair role dispatch and autonomous two-runtime reasoning remain.' };
  updates.set(backlogPath, JSON.stringify(backlog, null, 2) + '\n');
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  for (const [file, body] of updates) await writeFile(file, body);
  console.log(JSON.stringify({ path, full: full.counts, targeted: targeted.counts, sourceDigest: build.sourceDigest, files: build.files.length, architecture, next: backlog.next_local_work_item }));
})().catch(error => { console.error(error); process.exitCode = 1; });
