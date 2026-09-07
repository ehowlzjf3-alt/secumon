// Finalizes documentation only after recorded native checks have completed successfully.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const json = file => JSON.parse(read(file));
const write = (file, value) => fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
const prefix = 'runtime/evidence/P3-mcp-collections-';
const exit = json(prefix + 'verify-final-exit.json');
const log = read(prefix + 'verify-final.log');
const metric = name => { const hits = [...log.matchAll(new RegExp('^(?:ℹ |# )' + name + ' ([0-9.]+)\\s*$', 'gm'))];
  if (hits.length !== 1) throw new Error('missing_native_metric:' + name); return Number(hits[0][1]); };
if (exit.exitCode !== 0 || metric('tests') !== 2040 || metric('pass') !== 2040 || metric('fail') || metric('cancelled') || metric('skipped')) throw new Error('whole_verification_not_passed');
const backlog = json('design/implementation-backlog.json');
if (backlog.revision !== 'v0.39') throw new Error('already_finalized_or_wrong_predecessor');
const resultPath = 'design/chapters/P3-mcp-collections-result.md';
const planPath = 'design/chapters/P3-mcp-collections-plan.md';
const recordPath = prefix + 'local-verification.json';
const work = backlog.work_items.find(item => item.id === 'P3-01');
work.plan = planPath; work.result = resultPath;
work.verification = { ...work.verification, record: recordPath, tests_passed: 2040, additional_tests: 48, targeted_tests: 127,
  new_test_groups: { mcp_read_collections: 26, mcp_read_collection_recovery: 6, read_page_proof: 16 },
  read_collection_resume: 'local_stdio_verified', actual_owned_worker_sigkill_cases: 6 };
work.remaining = [
  'Rate-limit Retry-After/cooldown waits and scheduled explicit resume with original deadlines and cumulative limits',
  'Whole-collection business coverage semantics and explicit reconciliation of raw receipts not yet accepted into a collection head',
  'Additional actual kill boundaries after remote send, raw receipt, complete orphan and received result',
  'Host-approved protocol profiles including legacy compatibility when needed',
  'Actual internal MCP specification, credentials, scope and G-DATA; HTTP/OAuth and write-effect proof',
  'Actual model and production operations remain unverified; the user cancelled the API experiment',
];
backlog.revision = 'v0.40';
backlog.next_local_work_item = { id: 'P3-01', scope: 'mcp_rate_limit_wait_and_explicit_resume',
  prerequisite_note: 'Local collection raw proof and explicit resume verified in 2040 native tests and 127 related cases, including 6 owned-worker SIGKILL cases. Next persist bounded retry waits without spinning model calls, preserve cancellation/deadline/remaining budget, and resume unfinished reads explicitly. Business coverage and orphan raw-response reconciliation are separate follow-ups. Internal services and cancelled model/API tests remain unrun.' };
write('design/implementation-backlog.json', backlog);
let result = read(resultPath).replace('2026-09-06 · 최종 전체 검증 진행 중', '2026-09-06 · v0.40 · 로컬 단위 검증 완료 / P3-01 진행 중');
result = result.replace('전체 native verify 결과는 완료 후 여기에 확정한다. 최종 정본 경로는 runtime/evidence/P3-mcp-collections-local-verification.json이다.',
  `전체 **npm run verify 2,040/2,040, 실패·취소·skip 0**, ${metric('duration_ms')}ms다. 코어 타입·안쪽 계층98파일/위반0·합성4시나리오/22판정도 통과했다. [최종 정본](/Users/seunghanee/Documents/secumon/${recordPath})에 소스/빌드와 이전 기록의 보존 검사를 결합한다.`);
write(resultPath, result);
const summary = `이번 [MCP collection 학습·결과](/Users/seunghanee/Documents/secumon/${resultPath})에서 기존 수집 장부에 실제 로컬 MCP의 batch/page를 연결했다. 전체 **2,040/2,040·실패/취소0**, 신규48개·관련127개가 통과했다. 개별 원응답 검증, 빈 페이지 보존, 부분 항목만 재조회, 등록 교체 중 전송 거절과 실제 worker SIGKILL 복구6개를 확인했다. SDK/lock과 이전 원본·정본을 보존한다. P3-01은 부분 검증/진행 중이고 다음은 rate-limit 대기와 명시 재개다. 사내 MCP·모델·Knox·운영 검증은 아니다. [검증 기록](/Users/seunghanee/Documents/secumon/${recordPath}).`;
for (const file of ['design/README.md', 'design/03-migration-plan.md']) {
  let body = read(file).replace('2026-09-06 · v0.39 · P3-01 로컬 MCP 단발 읽기 검증', '2026-09-06 · v0.40 · P3-01 로컬 MCP collection·재개 검증');
  body = body.replace('이번 [MCP 단발 읽기', summary + '\n\n이전 [MCP 단발 읽기'); write(file, body);
}
write('runtime/README.md', read('runtime/README.md').replace('이번 [MCP 단발 읽기', summary + '\n\n이전 [MCP 단발 읽기'));
write('design/VERIFICATION.md', read('design/VERIFICATION.md').replace('# 산출물 검증 결과\n\n', '# 산출물 검증 결과\n\n## v0.40 — MCP collection 원본·명시 재개\n\n' + summary + '\n\n'));
write('design/WORKLOG.md', read('design/WORKLOG.md') + `\n## 체크포인트 129: MCP collection 최종 실행 검증\n\n- 최종 관련127/127, 전체2040/2040·실패/취소/skip0(${metric('duration_ms')}ms), 코어 타입·안쪽98파일/위반0·합성4/22 통과. 신규48개다. 제품/시험 소스는 최종 실행 이후 동결한다.\n- 32측정행=통합26+실제복구6, MCP peer38개·worker6개 종료를 확인했다. SDK가 측정한 현재32세션 calls46과 종료 전 peer의 audit calls4를 합친 fixture50calls를 구분한다. 최초 snapshot의 독립 인증, raw 영수증 이후 수락 전 중단, cooldown은 남은 한계다.\n- P3-01 부분검증/진행중·전체완료9개·P0–P6 활성 유지. 다음 로컬 단위는 rate-limit 대기와 명시 재개. 실제 API/모델 취소·사내 서비스 미실행 유지.\n`);
const targetedExit = json(prefix + 'targeted-final-exit.json');
const input = { schemaVersion: 1, ready: true, backlogRevision: 'v0.40', expectedInnerFiles: 98,
  verify: { command: 'npm run verify', exitCode: exit.exitCode, testsPassed: 2040, testsSkipped: 0, log: prefix + 'verify-final.log' },
  targeted: { command: targetedExit.command, exitCode: targetedExit.exitCode, testsPassed: 127, testsSkipped: 0, log: prefix + 'targeted-final.log' },
  acceptanceEvidence: [planPath, resultPath, prefix + 'adapter-review.md', prefix + 'core-review.md', prefix + 'final-audit.md'],
  additionalArtifacts: [prefix + 'summarize.cjs', prefix + 'finalize.cjs', prefix + 'verify-final-exit.json', prefix + 'targeted-final-exit.json',
    prefix + 'summary-final.log', prefix + 'boundary-review.md', prefix + 'fixture-review.md', prefix + 'recovery-review.md',
    prefix + 'targeted-1.log', prefix + 'recovery-1.log', ...[1,2,3,4].map(n => prefix + `build-${n}.log`), prefix + 'typecheck-1.log'],
  knownLimits: ['Actual SIGKILL is limited to intent-before-wire, accepted partial, and accepted nonfinal page on two stores.',
    'Whole-tool rate-limit errors preserve cost and stop; per-item Retry-After/cooldown scheduling is not implemented.',
    'Pending raw response receipts cannot yet be reconciled into a read head without a new explicit request.',
    'Partial records retain raw/output but do not generate Evidence in this adapter.',
    'MCP integration tests and synthetic core compact/reopen proof tests are complementary; not every edge was repeated through a live MCP peer.',
    'The separate browser gate was not rerun for this slice.'] };
for (const name of ['protocol', 'recovery', 'shutdown']) {
  const summaryPath = prefix + name + '-final.json'; const observed = json(summaryPath);
  const observation = name === 'protocol' ? { transport: 'stdio', effects: 'read-only', actualLocalSdkServer: true,
    negotiatedProtocolVersion: '2026-07-28', backends: ['sqlite', 'file-journal'], actualModelCalls: 0, externalServiceCalls: 0,
    httpOrOAuthVerified: false, readCollectionResumeVerified: true, writeEffectsVerified: false,
    costDenominators: observed.checks } : name === 'recovery' ? { cancellationIsNotRemoteCompletion: true, hiddenCallRetries: 0,
      storedResultDoesNotRecallServer: true, actualWorkerSigkillCases: 6, acceptedSuccessesRetained: true,
      rawReceiptWithoutAcceptedHeadMayBeReread: true } : { ownedProcessesStopped: true, temporaryFilesCleaned: true,
      integrationRemoval: 'awaited rm in passing test after-hook', recoveryRemoval: 'rm and explicit ENOENT probe' };
  input[name] = { status: 'passed', summary: summaryPath, sourceDigestPointer: '/codeDigest',
    checks: [{ pointer: '/status', equals: 'passed' }, ...Object.entries(observed.checks).map(([key, value]) => ({ pointer: '/checks/' + key, equals: value }))],
    logs: [prefix + 'targeted-final.log', prefix + 'summary-final.log'], artifacts: observed.measurements.map(ref => ref.path), observation };
}
write(prefix + 'verification-input.json', input);
console.log(JSON.stringify({ backlog: 'v0.40', tests: 2040, related: 127, additional: 48, durationMs: metric('duration_ms'), input: prefix + 'verification-input.json' }));
