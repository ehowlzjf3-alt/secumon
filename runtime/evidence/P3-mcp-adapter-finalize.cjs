const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const file = value => path.join(root, value);
const read = value => fs.readFileSync(file(value), 'utf8');
const json = value => JSON.parse(read(value));
const write = (value, text) => fs.writeFileSync(file(value), text);
const sha = value => createHash('sha256').update(fs.readFileSync(file(value))).digest('hex');
const exit = json('runtime/evidence/P3-mcp-adapter-verify-final-exit.json'); assert.equal(exit.exitCode, 0);
const verify = read('runtime/evidence/P3-mcp-adapter-verify-final.log');
const metric = (text, key) => Number(text.match(new RegExp('^ℹ ' + key + ' ([0-9.]+)$', 'm'))?.[1]);
assert.equal(metric(verify, 'tests'), 1992); assert.equal(metric(verify, 'pass'), 1992); assert.equal(metric(verify, 'fail'), 0);
assert.equal(metric(verify, 'cancelled'), 0); assert.equal(metric(verify, 'skipped'), 0);
const duration = metric(verify, 'duration_ms'); assert.ok(duration > 0);
const targeted = read('runtime/evidence/P3-mcp-adapter-targeted-final-v2.log'); assert.equal(metric(targeted, 'pass'), 58);
const architecture = JSON.parse(verify.split('\n').find(line => line.startsWith('{"inspected":')));
assert.equal(architecture.inspected, 98); assert.deepEqual(architecture.failures, []);
const backlog = json('design/implementation-backlog.json'); assert.equal(backlog.revision, 'v0.38');
backlog.revision = 'v0.39';
const item = backlog.work_items.find(value => value.id === 'P3-01'); assert.equal(item.status, 'not_started');
Object.assign(item, { status: 'in_progress', plan: 'design/chapters/P3-mcp-adapter-plan.md', result: 'design/chapters/P3-mcp-adapter-result.md',
  verification: { local_contracts: 'partially_verified', actual_mcp: 'local_stdio_verified', actual_model: 'not_run',
    record: 'runtime/evidence/P3-mcp-adapter-local-verification.json', tests_passed: 1992, additional_tests: 42,
    new_test_groups: { mcp_read_tools: 28, mcp_stdio_client: 14 }, targeted_tests: 58,
    protocol: '2026-07-28', sdk_client: '2.0.0', sdk_server: '2.0.0', actual_internal_service: 'not_run' },
  remaining: ['MCP batch/page mapping to existing ReadCollections, cursor/snapshot persistence and explicit partial resume',
    'Rate-limit/cooldown and original collection coverage semantics', 'Host-approved protocol profiles including legacy compatibility when needed',
    'Actual internal MCP specification, credentials, scope and G-DATA; HTTP/OAuth and write-effect proof',
    'Actual model and production operations remain unverified; the user cancelled the API experiment'] });
backlog.next_local_work_item = { id: 'P3-01', scope: 'mcp_read_collection_adapter_and_explicit_resume',
  prerequisite_note: 'Local stdio single-read boundary verified in 1992 core tests and 58 targeted cases. Reuse ReadCollections for batch/page requests, raw response provenance, durable cursor/snapshot and explicit partial resume. Internal MCP/HTTP/OAuth/legacy profiles and cancelled model/API experiments remain separate.' };
write('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');
const summary = '이번 [MCP 단발 읽기 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-adapter-result.md)에서 공식 SDK의 실제 로컬 stdio 서버를 기존 도구·호출 장부·원본 proof에 연결했다. 전체 **1,992/1,992·실패/취소0**, 신규42개·관련58개가 통과했다. 문서/관측×두 저장소의 원본·근거 채택, 정책 변경·취소·목록 변경·크기/동시성 제한·명시 재연결과 저장 결과 재검증을 확인했다. SDK client/server2.0.0 추가는 의도한 lock 변경이며 기존 원본과 정본을 보존한다. P3-01은 부분 검증/진행 중이다. 다음은 MCP batch/page와 ReadCollections의 cursor·부분 결과·명시 재개 연결이다. 실제 사내 MCP·모델·Knox·운영 검증은 아니다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-local-verification.json).';
for (const name of ['design/README.md', 'design/03-migration-plan.md', 'runtime/README.md']) {
  const parts = read(name).split('\n\n'); const title = parts.shift();
  if (parts[0].startsWith('2026-09-06 · v0.38')) parts.shift();
  parts[0] = parts[0].replace(/^이번 /, '이전 ');
  let text = [title, ...(name === 'runtime/README.md' ? [] : ['2026-09-06 · v0.39 · P3-01 로컬 MCP 단발 읽기 검증']), summary, ...parts].join('\n\n');
  text = text.replace('다음 로컬 챕터는 P3-01 기존 MCP 재사용 adapter와 실제 로컬 protocol fixture다.', 'P3-01의 로컬 stdio 단발 읽기와 원본 proof를 부분 검증했다. 다음 로컬 소단위는 MCP batch/page와 ReadCollections의 cursor·명시 재개 연결이다.');
  if (name === 'design/03-migration-plan.md') text = text.replace('실제 모델/MCP/외부 채널 검증은 별도 미충족 조건이다.', '실제 모델/사내 MCP/외부 채널 검증은 별도 미충족 조건이다.');
  write(name, text);
}
let verification = read('design/VERIFICATION.md');
verification = verification.replace('# 산출물 검증 결과\n\n', '# 산출물 검증 결과\n\n## v0.39 — 로컬 MCP 단발 읽기와 원본 proof\n\n' + summary +
  `\n\nNode24.20.0 npm run verify exit0, ${duration}ms. 코어 타입·안쪽 계층98파일/위반0·합성4시나리오/22판정 통과. 신규 read28/client14, 관련58(6007.401917ms)은 전체 분모에 중복 가산하지 않는다. 측정44개 row의 자식45개 시작/종료를 확인했다. 이전 전체 실행은 전송/종료 오류 처리 수정 전 판본으로 exit143 중단했고 소유15개 PID의 잔여0을 확인했다. 첫 관련57/57과 중간실패도 보존했다.\n\n`);
write('design/VERIFICATION.md', verification);
let result = read('design/chapters/P3-mcp-adapter-result.md').replace('v0.39 준비 · 최종 전체 검증 진행 중', 'v0.39 · 로컬 단발 읽기 검증 완료, P3-01 진행 중');
result = result.replace('전체 native 검증은 진행 중이며 완료한 로그를 정본에 기록한다.', `전체 native 검증도 **1,992/1,992**, 실패·취소·skip 0, ${duration}ms로 통과했다. 코어 타입 검사·안쪽 계층98파일/위반0·합성4시나리오/22판정이 통과했다. [전체 검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-local-verification.json)을 기준으로 한다.`);
result += '\n수정 전 중간 읽기8/22·18/22·audit 환경0/24·수정후24/24와 관련57/57을 보존한다. 종료 확인 오류 수정 전 전체 실행은 exit143으로 중단했고 소유15개 PID 잔여0을 확인했다. 최종 제품/시험 소스의 검증 후 수정은 하지 않았다.\n';
write('design/chapters/P3-mcp-adapter-result.md', result);
write('design/chapters/P3-mcp-adapter-plan.md', read('design/chapters/P3-mcp-adapter-plan.md').replace('상태: 계획/구현 중', '상태: 로컬 단발 읽기 검증 완료, P3-01 진행 중'));
write('design/WORKLOG.md', read('design/WORKLOG.md') + `\n## 체크포인트 125: MCP 단발 읽기 최종 검증\n\n- 종료 확인 실패가 이미 전송한 호출을 sent=false로 바꾸는 결함을 수정했다. PID 확인 오류를 한 번 주입해 전송1회·종료 재확인·동시 close 계수1회를 검증했다. 폐기된 decoded call 응답도 응답 bytes에 포함한다.\n- 수정 전 전체는 exit143으로 중단하고 소유15PID 잔여0을 확인했다. 최종 관련58/58(6007.401917ms), 전체1992/1992·실패/취소/skip0(${duration}ms), 코어 타입·안쪽98파일/위반0·합성4/22 통과. 신규42개이며 제품/시험 소스는 이후 동결한다.\n- 원본은 SDK 정규화 JSON이며 same-process 저장소 재열기와 새 validator 재구성, peer process.exit(23), 지연 응답 유실을 검증했다. 44개 측정row에서 자식45개 시작/종료. 모델/API/사내 서비스는 미실행이다.\n- P3-01 partially_verified/in_progress·전체완료9개·전체P0–P6 활성. 다음은 MCP ReadCollections 연결과 명시 partial resume다. 최종 source/build/원본/이전기록/의존성·문서 정적 대조를 수행한다.\n`);
const input = json('runtime/evidence/P3-mcp-adapter-verification-input.json'); assert.equal(input.ready, false);
input.ready = true; input.expectedInnerFiles = 98;
input.dependencyChange.expectedNewPackageSha256 = sha('runtime/package.json'); input.dependencyChange.expectedNewLockSha256 = sha('runtime/package-lock.json');
input.dependencyChange.installRuns[0].command = 'npm install --save-exact --ignore-scripts --no-audit --no-fund @modelcontextprotocol/client@2.0.0';
input.dependencyChange.installRuns[1].command = 'npm install --save-dev --save-exact --ignore-scripts --no-audit --no-fund @modelcontextprotocol/server@2.0.0';
input.dependencyChange.installRuns.forEach(run => { run.exitCode = 0; });
Object.assign(input.verify, { log: 'runtime/evidence/P3-mcp-adapter-verify-final.log', exitCode: 0, testsPassed: 1992 });
Object.assign(input.targeted, { command: 'SECUMON_MCP_EVIDENCE_DIR="$PWD/evidence/mcp-adapter-final-v2" node --test dist/tests/mcp-read-tools.test.js dist/tests/mcp-stdio-client.test.js dist/tests/tool-broker-refresh.test.js',
  log: 'runtime/evidence/P3-mcp-adapter-targeted-final-v2.log', exitCode: 0, testsPassed: 58 });
const protocolSummary = json('runtime/evidence/P3-mcp-adapter-protocol-final.json');
const configs = { protocol: { summary: 'runtime/evidence/P3-mcp-adapter-protocol-final.json', checks: [
  { pointer: '/checks/normalReadCells', equals: 4 }, { pointer: '/checks/negotiatedVersionCheckedByTests', equals: '2026-07-28' }, { pointer: '/checks/allRecordedCallCountsMatchFixture', equals: true }] },
  recovery: { summary: 'runtime/evidence/P3-mcp-adapter-recovery-final.json', checks: [
  { pointer: '/checks/hiddenCallRetriesInTestedScenarios', equals: 0 }, { pointer: '/checks/storedResultReopenCases', equals: 2 }, { pointer: '/checks/cleanupFailureRetainsSent', equals: true }] },
  shutdown: { summary: 'runtime/evidence/P3-mcp-adapter-shutdown-final.json', checks: [
  { pointer: '/checks/allOwnedProcessesStopped', equals: true }, { pointer: '/checks/allTemporaryDirectoriesRemoved', equals: true }, { pointer: '/checks/observedChildStarts', equals: 45 }, { pointer: '/checks/observedChildCloses', equals: 45 }] } };
for (const [name, config] of Object.entries(configs)) Object.assign(input[name], config, { status: 'passed', logs: [input.targeted.log, 'runtime/evidence/P3-mcp-adapter-summary-final.log'] });
Object.assign(input.protocol.observation, { actualLocalSdkServer: true, negotiatedProtocolVersion: '2026-07-28', costDenominators: { cells: protocolSummary.cells, measuredFixtureRows: 44, modelCalls: 0, singleExecutionPerNormalCell: true } });
Object.assign(input.recovery.observation, { cancellationIsNotRemoteCompletion: true, hiddenCallRetries: 0, storedResultDoesNotRecallServer: true });
Object.assign(input.shutdown.observation, { ownedProcessesStopped: true, temporaryFilesCleaned: true });
input.acceptanceEvidence = ['runtime/evidence/P3-mcp-adapter-boundary-review.md', 'runtime/evidence/P3-mcp-adapter-fixture-final-review.md', 'runtime/evidence/P3-mcp-adapter-proof-review.md', 'runtime/evidence/P3-mcp-adapter-final-audit.md'];
input.additionalArtifacts = fs.readdirSync(file('runtime/evidence')).filter(name => name.startsWith('P3-mcp-adapter-') && !['P3-mcp-adapter-local-verification.json', 'P3-mcp-adapter-verification-input.json', 'P3-mcp-adapter-static-verification.log'].includes(name))
  .map(name => 'runtime/evidence/' + name).filter(name => fs.statSync(file(name)).isFile());
input.additionalArtifacts.push(...fs.readdirSync(file('runtime/evidence/mcp-adapter-final-v2')).map(name => 'runtime/evidence/mcp-adapter-final-v2/' + name));
input.knownLimits = item.remaining.concat(['Decoded SDK JSON, not packet capture; strictly compiled common JSON-schema subset only',
  'Same-process repository reopen and new validator reconstruction; no MCP worker SIGKILL/power-loss test',
  'Late response was delayed then lost; no late response receipt claimed', 'InputRequired auto-fulfil disabled in configuration; actual input_required exchange not tested',
  'Raw artifact corruption also blocks the rejection-state commit until integrity/lifecycle repair',
  'Stdio child is not an OS sandbox; commands/args/environment require host review', 'No atomic transaction between remote send and policy change',
  'Raw fixture measurements: 44 rows/45 children; these are not 44 unique tests or the entire suite process count',
  'The separate browser gate from v0.38 was not rerun for the MCP change']);
write('runtime/evidence/P3-mcp-adapter-verification-input.json', JSON.stringify(input, null, 2) + '\n');
console.log(JSON.stringify({ revision: backlog.revision, testsPassed: 1992, targeted: 58, durationMs: duration, codeDigest: protocolSummary.codeDigest }));
