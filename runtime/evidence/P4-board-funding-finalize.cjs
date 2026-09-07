const { readFile, writeFile } = require('node:fs/promises');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function run(name) {
  const exit = await json(`evidence/${name}-exit.json`), log = await readFile(exit.log, 'utf8'), counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) {
    const match = log.match(new RegExp(`ℹ ${key} ([0-9.]+)`));
    if (!match) throw new Error(`missing_${name}_${key}`);
    counts[key] = Number(match[1]);
  }
  return { ...exit, counts };
}
(async () => {
  const previous = await json('evidence/P4-board-budget-authority-local-verification.json');
  const full = await run('P4-board-funding-verify1'), targeted = await run('P4-board-funding-new1');
  const log = await readFile(full.log, 'utf8');
  const newTests = log.split('\n').filter(line => line.startsWith('✔ board funding ')).length;
  if (newTests !== 44 || targeted.counts.tests !== newTests || full.counts.tests !== previous.full.counts.tests + newTests ||
    [full, targeted].some(r => r.exitCode || r.counts.tests !== r.counts.pass || ['fail', 'cancelled', 'skipped', 'todo'].some(key => r.counts[key])))
    throw new Error('verification_incomplete');
  const { verifyEvaluationBuild } = await import('../dist/infrastructure/local-evaluation.js');
  const build = await verifyEvaluationBuild(process.cwd()), fixture = await json('evidence/fixture-baseline.json');
  const architecture = JSON.parse(log.split('\n').find(line => line.startsWith('{"inspected":')) ?? 'null');
  if (!architecture || architecture.failures.length || !fixture.passed || fixture.scenarios !== 4 || fixture.checkpoints !== 22 || fixture.createdAt < full.startedAt)
    throw new Error('native_checks_incomplete');
  const path = 'evidence/P4-board-funding-local-verification.json';
  const record = { schemaVersion: 1, chapter: 'P4-board-funding', revision: 'v0.51', createdAt: new Date().toISOString(), node: process.version,
    full, targeted, firstHappy: await run('P4-board-funding-happy1'), secondHappy: await run('P4-board-funding-happy2'),
    firstTargeted: await run('P4-board-funding-target1'), profileRaceBeforeFix: await run('P4-board-funding-race-before-fix'),
    intermediateBuildFailure: await json('evidence/P4-board-funding-build7-exit.json'), finalBuild: await json('evidence/P4-board-funding-build8-exit.json'),
    build, coreTypecheck: 'passed_in_native_verify', lint: 'not_configured', architecture,
    fixtures: { path: 'evidence/fixture-baseline.json', createdAt: fixture.createdAt, scenarios: fixture.scenarios, checkpoints: fixture.checkpoints, passed: fixture.passed },
    cases: { additionalTests: newTests, stores: ['sqlite', 'file-journal'], publicDataFamilyCases: 4,
      actualToolExecution: true, scriptedModelAfterAcceptance: true, hostAllocationReturningReferencesOnly: true,
      boundedPreparationPermission: true, unrelatedPreparationDenied: true, modelBeforeAcceptanceDenied: true,
      requestAbsoluteDeadline: true, independentGoalAndPolicyBinding: true, profileAndActorRevocation: true,
      profileRaceDuringFinalActorRead: true, duplicateAllocationAcrossReopen: true, sharedRequestMetadataWithPrivateRole: true,
      privateQuestionDenied: true, privateAnswerRemainsHiddenAndUnconfirmed: true, inaccessibleAnswerDoesNotRevokeWorkerAllocation: true,
      appliedAcceptanceLostReplyRecovery: true, cancellationAndCompetingAcceptanceReturnUnused: true,
      compactAndRestore: true, newOwnedProcessKillCases: 0 },
    implementation: { boardFundingPolicyAdapter: true, boardAcceptancePreparationPermission: true, agentAllocationTools: false,
      activeGrantIncreaseOrPartialReturn: false, sharedAudienceBoardDefault: false, fairRoleDispatcher: false, autonomousTwoRuntimeReasoning: false },
    designSteering: { userConcern: 'Unreadable board answers and routine disclosure approval can block collaboration',
      next: 'Shared participant audience, separate source permissions, no routine human post approval, explicit response duties and no-response handling',
      plan: 'design/chapters/P4-shared-board-simplification.md', currentPrivacyTestsAreNotDefaultUXAdoption: true },
    actualModel: 'cancelled_by_user', internalServices: 'not_run', goalStatus: 'in_progress' };
  const paragraph = `이번 [게시판 자원 배정·수락 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-funding-result.md)에서 현재 요청/역할 프로필을 배정 장부에 연결하고, 질문 조회·수락 준비와 수락 이후 일반 실행을 구분했다. 공개 자료 역할의 답변 확인·정산, 비공개 자료 경계와 응답 유실 복구를 검증했다. 전체 **${full.counts.tests}/${full.counts.tests}**, 신규·최종 관련 **44/44** 통과. **P4-01은 진행 중**이며 다음은 사용자의 복잡성 지적을 반영한 [공유 게시판과 응답 책임 단순화](/Users/seunghanee/Documents/secumon/design/chapters/P4-shared-board-simplification.md), 에이전트 자원 도구와 역할 실행 연결이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/${path}).`;
  const updates = new Map();
  for (const file of ['README.md', '../design/README.md', '../design/03-migration-plan.md']) {
    let body = await readFile(file, 'utf8');
    body = body.replace('v0.50 · P4-01 역할 간 자원 배정 권한과 정산', 'v0.51 · P4-01 게시판 요청의 자원 배정과 수락 준비');
    body = body.replace(/^이번 \[역할 간 자원 배정·정산 결과\].*$/m, paragraph);
    updates.set(file, body);
  }
  const result = '../design/chapters/P4-board-funding-result.md';
  updates.set(result, (await readFile(result, 'utf8')).replace('2026-09-06 · 신규 44개 통과 · 전체 native 검증 진행 중',
    '2026-09-06 · v0.51 · 현재 funding 경계 로컬 검증 완료 · 공유 게시판 설계 전환 예정')
    .replace('최종 수치와 sourceDigest는 전체 native 검증 이후 기록한다.', '최종 수치와 sourceDigest는 아래 검증 기록에 저장했다.')
    .replace('신규 **44/44**, 실패/취소/skip/todo 0, 72214.080833ms로 통과했다. 전체 `npm run verify`를 같은 소스로 실행 중이다.',
      `전체 **${full.counts.tests}/${full.counts.tests}**, 신규·최종 관련 **44/44**, 실패/취소/skip/todo 0. 관련 시험 72214.080833ms, 전체 시험 ${full.counts.duration_ms}ms. 빌드·코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과, lint 미설정. sourceDigest ${build.sourceDigest}, 빌드 파일 ${build.fileCount}개. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/${path}). 새 OS 프로세스 강제 종료 사례는 추가하지 않았으며 기존 전체 회귀 suite는 함께 실행했다.`));
  const verification = '../design/VERIFICATION.md';
  updates.set(verification, (await readFile(verification, 'utf8')).replace('# 산출물 검증 결과\n',
    `# 산출물 검증 결과\n\n## v0.51 — 게시판 요청의 자원 배정과 수락 준비\n\n${paragraph}\n\nNode 24.20.0, native verify exit 0, ${full.counts.duration_ms}ms. 코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과, lint 미설정. 이번 검증은 현재 구현의 경계 확인이다. 읽을 수 없는 게시글/승인 가공을 기본 UX로 채택한 것이 아니며, 사용자 지적에 따라 공유 게시판/별도 원문 권한/명시 응답 책임으로 다음 설계를 전환한다. 에이전트 자원 도구·활성 grant 조정·역할 dispatcher·실제 모델은 미완료 범위다.\n`));
  const backlogPath = '../design/implementation-backlog.json', backlog = await json(backlogPath), work = backlog.work_items.find(item => item.id === 'P4-01');
  if (!work) throw new Error('missing_work_item');
  backlog.revision = 'v0.51'; work.status = 'in_progress'; work.result = 'design/chapters/P4-board-funding-result.md';
  Object.assign(work.verification, { record: `runtime/${path}`, tests_passed: full.counts.tests, targeted_tests: 44, additional_tests: newTests,
    board_funding_policy: 'host_adapter_verified', board_preparation_acceptance: 'verified', board_funding_record: `runtime/${path}`,
    shared_audience_board_default: 'design_revision_pending', agent_budget_tools: 'not_implemented' });
  work.remaining = work.remaining.filter(value => !value.startsWith('Connect board funding policy and bounded preparation'));
  backlog.next_local_work_item = { id: 'P4-01', scope: 'shared_board_simplification_agent_resources_and_role_dispatch',
    prerequisite_note: 'Funding profile and bounded preparation/acceptance are locally verified. User steering prioritizes a shared board audience with separate source access and explicit response duties, without routine post approval. Connect agent resource decisions and role dispatch to this flow. Actual model testing remains cancelled.',
    next_design: 'design/chapters/P4-shared-board-simplification.md' };
  updates.set(backlogPath, JSON.stringify(backlog, null, 2) + '\n');
  const worklog = '../design/WORKLOG.md';
  updates.set(worklog, (await readFile(worklog, 'utf8')) + `\n## 체크포인트 182: 게시판 funding 검증 완료와 공유 흐름 전환 준비\n\n- 최종 전체 **${full.counts.tests}/${full.counts.tests}**, 신규·최종 관련 **44/44**, 실패/취소/skip/todo 0. 빌드·코어 타입·계층 ${architecture.inspected}/위반 0·fixture 4/22 통과, lint 미설정. 전체 시험 ${full.counts.duration_ms}ms, 종료 ${full.finishedAt}.\n- 검증 기록 runtime/${path}, sourceDigest ${build.sourceDigest}, 빌드 파일 ${build.fileCount}개. 전체 실행 중/후 제품·시험·fixture source는 변경하지 않았다. 초기 기한/helper/비공개 답변 기대 실패와 프로필 race 수정 전 실패, build7 미사용 변수 오류를 원 실행 기록과 함께 보존했다.\n- 현재 funding adapter·수락 준비·일반 실행 전환·정산/복구의 동작을 검증했다. 비공개 답변 거절 시험 통과는 해당 UX를 기본안으로 채택했다는 의미가 아니다. 사용자 지적에 따라 공유 게시판/별도 원문 권한/명시 응답 책임으로 다음 설계를 수정했다.\n- 다음은 P4-shared-board-simplification.md의 공유 계약, 이어서 에이전트 자원 도구와 담당 역할 실행/미응답 처리다. P4-01과 전체 목표는 진행 중이며 실제 모델/API·사내 서비스·운영 연결은 수행하지 않았다.\n`);
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  for (const [file, body] of updates) await writeFile(file, body);
  console.log(JSON.stringify({ path, full: full.counts, targeted: targeted.counts, build, architecture, next: backlog.next_local_work_item }));
})().catch(error => { console.error(error); process.exitCode = 1; });
