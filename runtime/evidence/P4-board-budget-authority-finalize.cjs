const { readFile, writeFile } = require('node:fs/promises');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function run(name) {
  const exit = await json(`evidence/${name}-exit.json`), log = await readFile(exit.log, 'utf8'), counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) {
    const match = log.match(new RegExp(`ℹ ${key} ([0-9.]+)`)); if (!match) throw new Error(`missing_${name}_${key}`); counts[key] = Number(match[1]);
  }
  return { ...exit, counts };
}
(async () => {
  const full = await run('P4-board-budget-authority-verify1'), targeted = await run('P4-board-budget-authority-target3');
  if (full.counts.tests !== 2416 || targeted.counts.tests !== 168 || [full, targeted].some(r => r.exitCode || r.counts.tests !== r.counts.pass ||
    ['fail', 'cancelled', 'skipped', 'todo'].some(key => r.counts[key]))) throw new Error('verification_incomplete');
  const { verifyEvaluationBuild } = await import('../dist/infrastructure/local-evaluation.js');
  const build = await verifyEvaluationBuild(process.cwd()), fixture = await json('evidence/fixture-baseline.json');
  const log = await readFile(full.log, 'utf8'), architecture = JSON.parse(log.split('\n').find(line => line.startsWith('{"inspected":')) ?? 'null');
  if (!architecture || architecture.failures.length || !fixture.passed || fixture.scenarios !== 4 || fixture.checkpoints !== 22 || fixture.createdAt < full.startedAt) throw new Error('native_checks_incomplete');
  const path = 'evidence/P4-board-budget-authority-local-verification.json';
  const record = { schemaVersion: 1, chapter: 'P4-budget-authority', revision: 'v0.50', createdAt: new Date().toISOString(), node: process.version,
    full, targeted, firstTargeted: await run('P4-board-budget-authority-target1'), intermediateTargeted: await run('P4-board-budget-authority-target2'),
    build, coreTypecheck: 'passed_in_native_verify', lint: 'not_configured', architecture,
    fixtures: { path: 'evidence/fixture-baseline.json', createdAt: fixture.createdAt, scenarios: fixture.scenarios, checkpoints: fixture.checkpoints, passed: fixture.passed },
    cases: { additionalTests: 62, runtimeTests: 60, domainTests: 2, stores: ['sqlite', 'file-journal'], separateRoleExecutionRuntimes: true,
      actualToolExecution: true, sourceArtifactDeniedToSponsor: true, independentRoleDataPolicy: true, allocationVersusExecution: true,
      duplicateMandateDenied: true, genesisGrantActivationReplyLoss: true, toolAndModelPreEntryRevocation: true,
      cancellationRoutedToChild: true, unknownUsageAndEffectsRetainEscrow: true, lateUsageSettlesOnceWithoutPlanAdoption: true,
      nestedRoleRouting: true, compactAndRestore: true, finalProofStateRace: true, missingRuntimeRetainsEscrow: true,
      boundedAuthorityLookupAndAbortSignal: true, temporaryAuthorityFailureResumesOriginalGrant: true,
      newOwnedProcessKillCases: 0, existingBudgetProcessCrashSuiteIncluded: true },
    implementation: { hostCrossRoleAuthorityPort: true, roleRuntimeRouter: true, crossRoleUsageSettlement: true,
      boardFundingPolicyAdapter: false, boardAcceptancePreparationPermission: false, agentAllocationTools: false,
      activeGrantIncreaseOrPartialReturn: false, fairRoleDispatcher: false, autonomousTwoRuntimeReasoning: false },
    actualModel: 'cancelled_by_user', internalServices: 'not_run', goalStatus: 'in_progress' };
  const paragraph = '이번 [역할 간 자원 배정·정산 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-budget-authority-result.md)에서 별도 자료 권한을 가진 역할에 자원을 배정하고, 해당 역할 runtime으로 중단·사용량 정산·미사용 반환을 연결했다. 권한 철회·응답 유실·하위 위임·compact/reopen을 검증했다. 전체 **2416/2416**, 관련 **168/168**, 신규 **62개**가 통과했다. **P4-01은 진행 중**이며 다음은 [게시판 수락과 에이전트 자원 관리 연결](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-funding-plan.md)이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-budget-authority-local-verification.json).';
  const updates = new Map();
  for (const file of ['README.md', '../design/README.md', '../design/03-migration-plan.md']) {
    let body = await readFile(file, 'utf8');
    body = body.replace('v0.49 · P4-01 요청 발견과 사건 기반 재개', 'v0.50 · P4-01 역할 간 자원 배정 권한과 정산');
    body = body.replace(/^이번 \[요청 발견·재개 결과\].*$/m, paragraph);
    body = body.replace('읽기·게시·철회·요청 생명주기·의무·발견·영속 알림/복구를 검증했으며, 다음은 역할 간 예산과 수락 조건이다.',
      '읽기·게시·철회·요청 생명주기·의무·발견·영속 알림/복구와 역할 간 자원 배정 권한·정산을 검증했으며, 다음은 게시판 수락과 에이전트의 배정/재배정 도구 연결이다.');
    updates.set(file, body);
  }
  const result = '../design/chapters/P4-budget-authority-result.md';
  updates.set(result, (await readFile(result, 'utf8')).replace('2026-09-06 · 관련 검증 통과 · 전체 검증 진행 중', '2026-09-06 · v0.50 · 역할 간 권한/정산 로컬 검증 완료')
    .replace('전체 `npm run verify`는 현재 실행 중이다. 최종 수치와 sourceDigest는 완료 뒤 검증 기록에 저장한다.',
      `전체 **2416/2416**, 관련 **168/168**, 신규 **62개** 통과. 실패/취소/skip/todo 0. 빌드·코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과. lint는 미설정이다. 전체 시험 시간 ${full.counts.duration_ms}ms, sourceDigest ${build.sourceDigest}, 빌드 파일 ${build.fileCount}개. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/${path}).`));
  const plan = '../design/chapters/P4-board-budget-plan.md';
  updates.set(plan, (await readFile(plan, 'utf8')).replace('2026-09-06 · 설계 반영 · 역할 간 확장 구현 예정',
    '2026-09-06 · 역할 간 권한/정산 로컬 검증 완료 · 게시판 수락/에이전트 배정 연결 진행 중')
    .replace('현재 역할 간 확장은 아직 검증된 기능이 아니다.', '역할 간 권한/정산 경계는 로컬 검증했다. 실제 게시판 수락과 에이전트 배정/재배정 도구 연결은 P4-board-funding-plan.md에 따라 이어간다.'));
  const verification = '../design/VERIFICATION.md';
  updates.set(verification, (await readFile(verification, 'utf8')).replace('# 산출물 검증 결과\n',
    `# 산출물 검증 결과\n\n## v0.50 — 역할 간 자원 배정 권한과 정산\n\n${paragraph}\n\nNode 24.20.0, native verify exit 0, ${full.counts.duration_ms}ms. 코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과, lint 미설정. 신규 62개 중 60개는 역할 runtime 경계, 2개는 영속 위임 계약이다. 기존 budget process-crash suite를 함께 실행했으며 신규 프로세스 강제 종료 사례를 추가했다고 주장하지 않는다. 실제 모델·게시판 funding adapter·에이전트 자원 관리 도구는 별도 미완료 범위다.\n`));
  const backlogPath = '../design/implementation-backlog.json', backlog = await json(backlogPath), work = backlog.work_items.find(item => item.id === 'P4-01');
  if (!work) throw new Error('missing_work_item');
  backlog.revision = 'v0.50'; work.status = 'in_progress'; work.result = 'design/chapters/P4-budget-authority-result.md';
  Object.assign(work.verification, { record: `runtime/${path}`, tests_passed: 2416, targeted_tests: 168, additional_tests: 62,
    cross_role_budget_authority: 'host_port_verified', cross_role_budget_settlement: 'verified', role_runtime_routing: 'verified',
    board_funding_policy: 'not_implemented', agent_budget_tools: 'not_implemented', budget_authority_record: `runtime/${path}` });
  work.remaining = ['Connect board funding policy and bounded preparation/acceptance authority to the verified cross-role grant and settlement path',
    'Connect agent-directed allocation, additional requests, safe active-grant adjustment and automatic partial reservation return with durable recovery',
    ...work.remaining.filter(value => !value.startsWith('Add authorized cross-role budget'))];
  work.funding_plan = 'design/chapters/P4-board-funding-plan.md';
  backlog.next_local_work_item = { id: 'P4-01', scope: 'board_funding_and_agent_resource_management',
    prerequisite_note: 'Cross-role host authority, independent data policy, nested role runtime routing, usage settlement, unused return and recovery are locally verified. Next connect board funding policy, narrowly authorized preparation/acceptance, and agent-directed allocation/reallocation tools. Actual model testing remains cancelled.' };
  updates.set(backlogPath, JSON.stringify(backlog, null, 2) + '\n');
  const worklog = '../design/WORKLOG.md';
  updates.set(worklog, (await readFile(worklog, 'utf8')) + `\n## 체크포인트 176: 역할 간 배정 권한과 정산 검증 완료\n\n- 최종 전체 **2416/2416**, 관련 **168/168**, 신규 **62개**. 실패/취소/skip/todo 0, 빌드·코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과, lint 미설정. 전체 시험 시간 ${full.counts.duration_ms}ms, native 종료 ${full.finishedAt}.\n- 검증 기록은 runtime/${path}, sourceDigest ${build.sourceDigest}, 빌드 파일 ${build.fileCount}개다. 전체 검증 뒤 제품/시험 source를 변경하지 않았다. 신규 사례 수는 실행 로그의 역할 runtime 60개와 domain 2개로 대조해 앞서 선집계한 64개에서 62개로 정정했다. 초기 recorder 접두어 거절과 두 번째 관련 실행의 오류명 기대 실패는 결과 문서와 실행 기록에 구분해 보존했다.\n- 역할 간 자료 정책 분리, 위임 참조 중복 방지, 배정/실행 허용 분리, 실제 호출 직전 권한·runtime 검사, 역할 및 하위 위임의 중단/정산 라우팅, 미확정 사용량 보류와 늦은 정산, compact/restore 및 일시 권한 reader 장애 복구를 검증했다.\n- README·통합 계획·검증 문서·작업 목록은 v0.50이다. 다음은 P4-board-funding-plan.md의 실제 게시판 정책·준비/수락 권한·에이전트 배정/추가 요청/회수·재배정 도구다. P4-01과 전체 목표는 진행 중이며 실제 모델/API·사내 서비스·운영 연결은 수행하지 않았다.\n`);
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  for (const [file, body] of updates) await writeFile(file, body);
  console.log(JSON.stringify({ path, full: full.counts, targeted: targeted.counts, build, architecture, next: backlog.next_local_work_item }));
})().catch(error => { console.error(error); process.exitCode = 1; });
