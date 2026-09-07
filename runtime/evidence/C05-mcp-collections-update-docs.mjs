// Candidate only. Root runs once after actual final native proof and cleanup; no test/SSH calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

assert.equal(process.argv.length, 2, 'no arguments; reviewed final proof required');
const runtime = realpathSync(fileURLToPath(new URL('../', import.meta.url))), root = dirname(runtime);
assert.equal(realpathSync(process.cwd()), runtime, 'run from runtime');
const folder = 'runtime/evidence/C05-mcp-collections-linux-nas-20260908';
const staging = 'runtime/evidence/C05-mcp-collections-docs-staging';
const proofPath = folder + '/verification.json';
const resultPath = 'design/chapters/C05-mcp-collections-entry-result.md';
const planPath = 'design/chapters/C05-mcp-collections-entry-plan.md';
const usagePath = 'design/chapters/C05-mcp-collections-entry-usage.md';
const hostUsagePath = 'design/chapters/C05-mcp-host-usage.md';
const sequencePath = 'design/chapters/C05-mcp-host-plan.md';
const costPath = 'design/chapters/C05-context-cost-review.md';
const implementationPath = 'design/chapters/C05-mcp-collections-implementation-notes.md';
// No nonexistent follow-up document: this plan explicitly retains the required collection custody unit.
const nextPath = planPath, nextPlanStatus = 'collection_post_send_custody_required_followup_not_implemented';
const newTargets = [resultPath, usagePath];
const targets = [resultPath, planPath, usagePath, hostUsagePath, 'design/README.md', 'design/03-migration-plan.md',
  'design/implementation-backlog.json', 'runtime/README.md', 'design/secumon-review.html'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const seen = new Map(), updates = new Map();
function bytes(path) {
  assert.match(path, /^(?:runtime|design)\/[a-zA-Z0-9_./-]+$/); assert.ok(!path.split('/').includes('..'));
  const absolute = resolve(root, path), stat = lstatSync(absolute);
  assert.equal(realpathSync(absolute), absolute); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 128 * 1024 * 1024);
  const data = readFileSync(absolute), hash = sha(data);
  if (seen.has(path)) assert.equal(hash, seen.get(path), 'input changed while preparing documents: ' + path);
  seen.set(path, hash); return data;
}
const read = path => bytes(path).toString('utf8'), json = path => JSON.parse(read(path));
const manifest = json(staging + '/manifest.json');
assert.equal(manifest.status, 'candidate_not_executed'); assert.deepEqual(manifest.targets, targets);
assert.equal(manifest.candidateScript.path, 'runtime/evidence/C05-mcp-collections-update-docs.mjs');
assert.equal(sha(bytes(manifest.candidateScript.path)), manifest.candidateScript.sha256, 'candidate script changed after review');
for (const item of [...manifest.originals, ...manifest.templates, ...manifest.retainedEvidence])
  assert.equal(sha(bytes(item.path)), item.sha256, 'candidate input changed: ' + item.path);
assert.equal(sha(bytes(manifest.predecessorScript.path)), manifest.predecessorScript.sha256);
for (const path of newTargets) assert.equal(existsSync(resolve(root, path)), false, 'new document already exists: ' + path);
const originals = new Map();
for (const item of manifest.originals) {
  assert.ok(targets.includes(item.target) && !newTargets.includes(item.target));
  const saved = read(item.path), current = read(item.target); assert.equal(current, saved, 'document changed since candidate review: ' + item.target);
  originals.set(item.target, current);
}
assert.deepEqual([...originals.keys()].sort(), targets.filter(path => !newTargets.includes(path)).sort());
const proofText = read(proofPath), proofHash = sha(proofText), proof = JSON.parse(proofText);
assert.equal(proof.schemaVersion, 1); assert.equal(proof.chapter, 'C05');
assert.equal(proof.scope, 'mcp_collections_general_resume');
assert.equal(proof.status, 'verified_supported_local_posix_partial_chapter');
assert.equal(proof.chapterComplete, false); assert.equal(proof.goalComplete, false);
assert.deepEqual(await verifyEvaluationBuild(runtime), proof.sourceAndBuild);
const local = proof.local, native = proof.nativeLinux, cleanup = native.cleanup;
assert.equal(local.platform, 'darwin'); assert.equal(local.nodeScope, 'finalization_process_only');
assert.equal(local.build.node, process.version); assert.match(process.version, /^v24\./);
assert.deepEqual(local.build.sourceAndBuild, proof.sourceAndBuild);
assert.equal(sha(bytes('runtime/dist/build-manifest.json')), local.build.manifestSha256);
assert.equal(native.status, 'passed'); assert.equal(native.environment.platform, 'linux'); assert.equal(native.environment.node, 'v24.20.0');
assert.deepEqual(native.sourceAndBuild, proof.sourceAndBuild);
const stepNames = ['build', 'new-mcp-collections-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
assert.deepEqual(native.steps.map(step => step.name), stepNames);
for (const step of native.steps) {
  assert.equal(step.status, 'passed'); assert.equal(step.exitCode, 0); assert.equal(step.signal, null);
  assert.equal(step.timedOut, false); assert.equal(step.terminationReason, null); assert.equal(step.nodeTestTimeoutFailures, 0);
  assert.equal(step.groupAbsentConfirmed, true); assert.equal(step.finalGroupState, 'absent');
  assert.equal(step.logFlushCompleted, true); assert.deepEqual(step.errors, []);
  for (const point of [step.leaderExit, step.stdioClose]) { assert.equal(point.code, 0); assert.equal(point.signal, null); }
}
assert.equal(cleanup.sshClosed, true); assert.equal(cleanup.observedOwnedProcesses, 0); assert.deepEqual(cleanup.auditErrors, []);
assert.equal(cleanup.globalProcessAbsenceProven, false); assert.ok(Array.isArray(cleanup.inaccessiblePeers) && Array.isArray(cleanup.unresolved));
assert.ok(Number.isFinite(Date.parse(native.finishedAt)) && Date.parse(cleanup.at) >= Date.parse(native.finishedAt));
assert.equal(native.collectedFiles.length, 9);
assert.ok(Array.isArray(proof.files) && proof.files.length > 0 && new Set(proof.files.map(item => item.path)).size === proof.files.length);
for (const item of proof.files) assert.equal(sha(bytes(item.path)), item.sha256, 'retained final evidence changed: ' + item.path);
const metadata = json(folder + '/run-metadata.json'), collection = json(folder + '/final-collection.json');
assert.equal(metadata.status, 'passed'); assert.equal(metadata.observerExitCode, 0); assert.equal(metadata.observerSignal, null);
assert.equal(metadata.sessionCompleted, true); assert.equal(metadata.sshClosed, true); assert.equal(metadata.finishedAt, native.finishedAt);
assert.deepEqual(metadata.sourceAndBuild, proof.sourceAndBuild);
assert.equal(collection.status, 'passed'); assert.equal(collection.finishedAt, native.finishedAt);
assert.deepEqual(collection.files, native.collectedFiles); assert.deepEqual(collection.sourceAndBuild, proof.sourceAndBuild);
assert.deepEqual(metadata.logsCollected, ['result.json', ...stepNames.map(name => name + '.log')]);
for (const item of collection.files) {
  assert.ok(metadata.logsCollected.includes(item.file)); assert.equal(sha(bytes(folder + '/final/' + item.file)), item.sha256);
}
const controlDirectory = read(folder + '/control-directory.txt').trim();
assert.ok(controlDirectory.startsWith('/')); assert.equal(existsSync(controlDirectory), false, 'SSH control directory remains');
function counts(log) {
  const clean = log.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const result = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...clean.matchAll(new RegExp('^(?:#|ℹ) ' + key + ' (\\d+)\\r?$', 'gm'))];
    assert.equal(matches.length, 1, 'exactly one actual test summary required: ' + key); result[key] = Number(matches[0][1]);
  }
  assert.ok(result.tests > 0); assert.equal(result.tests, result.pass + result.fail + result.cancelled + result.skipped + result.todo); return result;
}
function successful(value, log) {
  const observed = counts(log); for (const key of Object.keys(observed)) assert.equal(value[key], observed[key]);
  assert.equal(observed.pass, observed.tests); for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(observed[key], 0);
  assert.equal(value.timeoutFailures ?? 0, 0); assert.equal(/testTimeoutFailure/.test(log), false); return observed.tests;
}
for (const selected of [local.newTests, local.relatedTests]) {
  assert.match(selected.testNode, /^v24\./); assert.deepEqual(selected.sourceAndBuild, proof.sourceAndBuild);
  assert.equal(selected.sourceObservation.kind, 'per_run_source_and_build_verification');
  assert.deepEqual(selected.sourceObservation.before, proof.sourceAndBuild); assert.deepEqual(selected.sourceObservation.after, proof.sourceAndBuild);
  const actual = json('runtime/' + selected.sourceObservation.runnerPath);
  assert.equal(actual.status, 'passed'); assert.equal(actual.exitCode, 0); assert.equal(actual.signal, null); assert.equal(actual.timedOut, false);
  assert.equal(actual.groupAbsentConfirmed, true); assert.equal(actual.logCloseCompleted, true); assert.equal(actual.node, selected.testNode);
  assert.equal(actual.sourceBefore, proof.sourceAndBuild.sourceDigest); assert.equal(actual.sourceAfter, proof.sourceAndBuild.sourceDigest);
  assert.deepEqual(actual.buildBefore, proof.sourceAndBuild); assert.deepEqual(actual.buildAfter, proof.sourceAndBuild);
  const observations = json('runtime/' + selected.evidence.find(item => item.role === 'recorded_exec_exit_observations').path);
  assert.ok(observations.executions.some(item => item.sessionId === selected.processEvidence.sessionId && item.exitCode === 0 &&
    'runtime/evidence/C05-mcp-collections-' + item.stage + '.log' === selected.log));
}
const localNew = successful(local.newTests.tests, read(local.newTests.log)), localRelated = successful(local.relatedTests.tests, read(local.relatedTests.log));
const nativeNewLog = folder + '/final/new-mcp-collections-tests.log';
const nativeNew = successful(native.newTests, read(nativeNewLog));
const nativeRelated = successful(native.relatedTests, read(folder + '/final/related-existing-tests.log'));
const nativeAll = successful(native.tests, read(folder + '/final/all-tests.log'));
assert.equal(nativeNew, localNew); assert.equal(nativeRelated, localRelated);
const localFinalPath = 'runtime/evidence/C05-mcp-collections-local-final1.json', localFinal = json(localFinalPath);
assert.equal(localFinal.status, 'local_selected_integration_passed_native_pending');
assert.deepEqual(localFinal.sourceAndBuild, proof.sourceAndBuild);
assert.equal(localFinal.new.tests, localNew); assert.equal(localFinal.new.pass, localNew);
assert.equal(localFinal.related.tests, localRelated); assert.equal(localFinal.related.pass, localRelated);
for (const role of ['new', 'related']) {
  const listPath = `runtime/evidence/C05-mcp-collections-${role}-files.json`, selected = json(listPath);
  assert.ok(proof.files.some(item => item.path === listPath));
  assert.deepEqual([...selected].sort(), [...(role === 'new' ? native.targetedFiles : native.relatedFiles)].sort());
  assert.equal(selected.length, localFinal[role].files);
  for (const path of selected) assert.ok(native.allTestFiles.includes(path));
}
for (const name of ['mcp-collection-entry', 'read-resume-options', 'read-collection-context', 'context-selection-convergence', 'evidence-recall-progress'])
  assert.ok(native.targetedFiles.includes(`dist/tests/${name}.test.js`));
const caseNames = [
  ...['sqlite', 'file-journal'].map(backend => `${backend}: SIGKILL collection response resumes through actual CLI, compacts its real session and consumes an explicit complete successor offline`),
  ...['sqlite', 'file-journal'].map(backend => `${backend}: SIGKILL at a real nonfinal page resumes through HTTP, waits offline repeatedly and continues only the next online page`),
  'sqlite: normally adopted partial batch retains its offline wait and explicitly retries only the failed item online',
  'inspect retains a measured fitting optional subset when byte capacity exceeds the chosen items',
  'prepare retains a measured fitting optional subset instead of exhausting unused-byte-budget retries',
  ...['sqlite', 'file-journal'].map(backend => `${backend}: actual find/get adoption earns first recall progress then identical reads stop at the default limit`),
];
for (const path of [nativeNewLog, local.newTests.log]) {
  const passedNames = [...read(path).matchAll(/^\s*(?:ok \d+ - |✔ )(.+)$/gm)].map(match => match[1]);
  for (const name of caseNames) assert.ok(passedNames.some(value => value === name || value.startsWith(name + ' (')), 'required actual acceptance missing: ' + name);
}
const predecessorPath = 'runtime/evidence/C05-mcp-offline-linux-nas-20260907/verification.json';
const predecessorHash = '28cdec0cdcaa8d7e308e8341258218a6b85e31d5053f50cf914e5e6edd7f38b9';
assert.equal(sha(bytes(predecessorPath)), predecessorHash);
assert.ok(proof.historicalEvidence.some(item => item.path === predecessorPath && item.sha256 === predecessorHash));
assert.equal(json(predecessorPath).nativeLinux.status, 'passed');
const history = [];
for (const item of manifest.retainedEvidence) {
  const match = /^runtime\/evidence\/C05-mcp-collections-((?:build|new|related)\d+)\.json$/.exec(item.path);
  if (!match) continue;
  const observed = json(item.path); if (observed.status !== 'failed') continue;
  const logPath = item.path.replace(/\.json$/, '.log'); assert.ok(manifest.retainedEvidence.some(value => value.path === logPath));
  const testCounts = /^(?:new|related)/.test(match[1]) ? counts(read(logPath)) : null;
  history.push({ stage: match[1], result: item.path, log: logPath, exitCode: observed.exitCode, counts: testCounts,
    sourceDigest: observed.sourceBefore, finishedAt: observed.finishedAt });
}
for (const prior of proof.priorAttempts) {
  assert.equal(prior.status, 'failed'); assert.ok(proof.files.some(item => item.path === prior.evidence));
  const old = json(prior.evidence); assert.equal(old.status, 'failed'); assert.equal(old.finishedAt, prior.finishedAt);
  assert.deepEqual(old.buildPin, prior.sourceAndBuild);
}
const number = value => value.toLocaleString('en-US'), pair = value => `${number(value)}/${number(value)}`;
const verified = `macOS Node24 신규 ${pair(localNew)}·관련 ${pair(localRelated)}, NAS Linux Node24 신규 ${pair(nativeNew)}·관련 ${pair(nativeRelated)}·전체 ${pair(nativeAll)} 통과`;
const remaining = 'C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태다. 실제 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이며 native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.';
const behavior = '같은 담당의 여러 항목 수집을 일반 CLI·Web에 연결했다. 저장된 원응답을 먼저 정산하고 필요한 대화 요약과 문맥 복원을 거친 뒤, 모델이 명시한 완전한 저장 결과의 후속 시도를 로컬에서 소비한다. 새 페이지가 필요하면 연결을 기다리고 명시 온라인 재열기에서 다음 페이지나 실패 항목만 요청한다.';
const boundary = '완전한 저장 결과 안내는 실행 허가가 아니다. 원 부모·원문·영수증·현재 계약과 권한을 다시 검사하며 부모의 실패를 성공으로 바꾸지 않는다. 로컬 후속 소비는 논리 도구 호출 한 번이고 원격 전송은 0회다. 필요한 근거 조회와 새 모델 호출은 기존 예산을 따른다.';
const improvements = '문맥 선택은 실제 한도에 들어오는 선택 항목 일부를 유지하도록 수렴을 고쳤다. 현재 허용된 원근거의 최초 카드·본문 조회만 준비 진전으로 인정한다. 동일 내용·파생 복사본의 반복 조회는 기본 무진전 한도 3을 초기화하지 않으며 준비 진전은 새 사실이나 목표 완료가 아니다.';
const next = '다음 필수 단위는 collection 페이지별 전송 후 원응답 보관·known usage 정산과 현재 본문 채택의 분리다. 기존 단순 읽기의 보관 인수와 구분하며 아직 별도 구현·검증이 필요하다. 원문 재검증·조회 비용 개선도 측정과 경합 검증을 거쳐 진행한다.';
const entry = '실제 일반 입구는 CLI 2사례와 localhost HTTP 3사례다. SQLite/file-journal CLI는 SIGKILL 뒤 서버 없는 재개·실제 session compact·명시 저장 소비·공개된 근거 ID 조회·최종 답변을 확인했다. HTTP 두 저장 방식은 비최종 페이지 SIGKILL 뒤 반복 대기와 다음 온라인 페이지를, SQLite 한 사례는 정상 채택된 partial batch의 실패 항목만 재시도를 확인했다. 마지막 사례는 강제 종료나 file-journal 인수로 확대하지 않는다. 반복 명령은 원문·시도·예산·대화를 중복하지 않으며 HTTP 시험은 브라우저 렌더링 시험이 아니다.';
const marker = `<!-- C05-MCP-COLLECTIONS-FINAL-PROOF: ${proofHash} -->`;
const intro = `**MCP 수집의 일반 입구 재개와 저장 근거 조회**를 연결했다. ${behavior} **${verified}**. [결과](${root}/${resultPath}) · [사용법](${root}/${usagePath}) · [계획과 이력](${root}/${planPath}) · [확정 증거](${root}/${proofPath}). ${boundary} ${improvements} ${next} [필수 후속](${root}/${nextPath}) · [MCP 전체 순서](${root}/${sequencePath}) · [조회 비용 검토](${root}/${costPath}). ${remaining}`;
const evidenceDetail = `같은 source \`${proof.sourceAndBuild.sourceDigest}\`, build files digest \`${proof.sourceAndBuild.filesDigest}\`, compiled 파일 ${number(proof.sourceAndBuild.fileCount)}개를 확인했다. Linux 종료는 \`${native.finishedAt}\`이며 ${native.steps.length}단계·결과와 원로그 ${native.collectedFiles.length}개 회수·관측 가능한 전용 프로세스 ${cleanup.observedOwnedProcesses}개·SSH 종료를 확인했다. 접근 불가 peer ${cleanup.inaccessiblePeers.length}개와 범위 미확정 ${cleanup.unresolved.length}개는 전 시스템 프로세스 부재 증명이 아니다. 로컬 최종 전체 회귀는 별도 실행하지 않았고 Linux 전체 결과와 구분한다. 합성 estimator와 모델 응답은 실제 모델 토큰·의미 품질·비용 측정이 아니다.`;
const historyDetail = history.map(item => `- [${item.stage}](${root}/${item.result}): exit ${item.exitCode}${item.counts ? `, ${item.counts.tests}개 중 ${item.counts.pass} 통과·${item.counts.fail} 실패` : ''}. [원로그](${root}/${item.log}), 당시 source \`${item.sourceDigest}\`.`).join('\n');
const nativeHistory = proof.priorAttempts.length ? proof.priorAttempts.map(item => `- [native attempt ${item.nativeAttempt}](${root}/${item.evidence}): ${item.status}, \`${item.finishedAt}\`, 당시 source \`${item.sourceAndBuild.sourceDigest}\`.`).join('\n') : '이번 최종 proof에 선행 실패 native attempt는 기록되지 않았다.';
const tokens = { ROOT: root, MARKER: marker, INTRO: intro, ENTRY: entry, EVIDENCE: evidenceDetail, IMPROVEMENTS: improvements,
  HISTORY: historyDetail, NATIVE_HISTORY: nativeHistory, NEXT: next, REMAINING: remaining, VERIFIED: verified };
function template(name) {
  const source = read(staging + '/' + name);
  const rendered = source.replace(/@@([A-Z_]+)@@/g, (_all, key) => { assert.ok(Object.hasOwn(tokens, key), 'unknown template token'); return tokens[key]; });
  assert.equal(/@@[A-Z_]+@@/.test(rendered), false); return rendered;
}
updates.set(resultPath, template('entry-result.md')); updates.set(usagePath, template('entry-usage.md'));
function once(text, before, after, label) {
  const at = text.indexOf(before); assert.ok(at >= 0 && text.indexOf(before, at + before.length) < 0, 'anchor changed: ' + label);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function paragraph(text, start, replacement) {
  const found = text.split('\n\n').filter(value => value.startsWith(start)); assert.equal(found.length, 1, 'paragraph changed: ' + start);
  return once(text, found[0], replacement(found[0]), start);
}
function prepend(path, body, historyLabel) {
  const text = originals.get(path); assert.equal(text.includes('C05-MCP-COLLECTIONS-FINAL-PROOF:'), false);
  const at = text.indexOf('\n\n'); assert.ok(at > 0);
  return text.slice(0, at) + '\n\n' + marker + '\n' + body + '\n\n' + historyLabel + '\n\n' + text.slice(at + 2);
}
updates.set(planPath, prepend(planPath, `${intro}\n\n${entry}\n\n기존 계획의 미결정 local permit안 대신 같은 ReadCollections의 현재 complete 검사·소비를 사용했다. 아래 구현 전·선행 NAS 관측·미결정 표시는 당시 기록이며 현재 구조는 [구현 메모](${root}/${implementationPath})와 결과를 따른다. 페이지별 post-send 보관·정산은 별도 필수 후속으로 유지한다.`, '## 착수 당시 계획과 남겨 둔 후속'));
updates.set(hostUsagePath, prepend(hostUsagePath, `${intro}\n\n${entry}\n\ncollectionBindings는 기존 bindings와 별도 배열로 제공한다. 같은 endpoint/provider의 혼합 등록은 하나의 발견 session을 공유하며 저장 전용 등록은 config 없이 origin을 명시한다. 현재 host가 계약·정책을 주입하며 HTTP나 사용자 원문으로 실행 파일·권한을 받지 않는다. 원문·본문 사용 권한과 호출 가능성은 별개다. 기존 단순 읽기 예제와 당시 수치는 아래에 보존했다.`, '## 이전 단순 읽기·보관·offline 사용법과 API 예제'));
for (const path of ['design/README.md', 'design/03-migration-plan.md', 'runtime/README.md']) {
  const original = originals.get(path), at = original.indexOf('\n\n');
  assert.ok(original.slice(at + 2).startsWith('<!-- C05-MCP-OFFLINE-FINAL-PROOF: ' + predecessorHash + ' -->'));
  let text = prepend(path, intro, '이전 v0.66 단순 읽기의 서버 없는 재개 결과와 당시 다음 계획(아래 미착수 표시는 당시 기록):');
  if (path !== 'runtime/README.md') text = once(text, 'v0.66 · C05 MCP 서버 없는 재개·온라인 재열기 검증과 후속 연결 검토',
    'v0.67 · C05 수집 재개·문맥 수렴·저장 근거 조회 검증과 페이지별 보관 후속', path + ' version');
  if (path === 'design/README.md') {
    text = paragraph(text, '현재 goal은 검증한 C04 ', () => `현재 goal은 검증한 C04 일반 요청·목표 변경과 C05 수집 재개·문맥 선택·저장 근거 조회를 보존하고 남은 필수 단위를 잇는 것이다. ${next} [현재 결과](${root}/${resultPath}) · [필수 후속](${root}/${nextPath}). 실제 대상은 Linux와 Windows이며 macOS는 개발 환경이다. ${remaining}`);
    text = paragraph(text, '[구현 현황 HTML 안내서]', () => `[구현 현황 HTML 안내서](${root}/design/secumon-review.html)의 최신 상태와 관련 모듈을 수집 재개·문맥 수렴·준비 진전으로 갱신했다. 16모듈·93용어·P0~P6의 31역사 항목과 모든 이전 snapshot을 보존했다. 이 문서 갱신은 실제 브라우저 렌더링 검증이 아니다.`);
  }
  if (path === 'design/03-migration-plan.md') text = paragraph(text, '[MCP 서버 없는 일반 재개 결과](chapters/C05-mcp-offline-resume-result.md)에서',
    old => `[MCP 수집 일반 입구 결과](chapters/C05-mcp-collections-entry-result.md)에서 ${verified}. ${behavior} ${improvements} ${next} [사용법](chapters/C05-mcp-collections-entry-usage.md) · [필수 후속](chapters/C05-mcp-collections-entry-plan.md). ${remaining}\n\n이전 v0.66 결과와 당시 다음 계획: ${old}`);
  updates.set(path, text);
}
const backlogPath = 'design/implementation-backlog.json', originalBacklog = JSON.parse(originals.get(backlogPath)), backlog = structuredClone(originalBacklog);
assert.equal(backlog.revision, 'v0.66'); backlog.revision = 'v0.67'; backlog.next_execution_chapter = 'C05';
const c05 = backlog.execution_chapters.find(value => value.id === 'C05'), originalC05 = originalBacklog.execution_chapters.find(value => value.id === 'C05');
assert.equal(c05.status, 'in_progress'); assert.equal(c05.mcp_collections_progress, undefined);
assert.equal(c05.mcp_offline_progress.proofSha256, predecessorHash);
const progress = { status: proof.status, currentVerification: proofPath, proofSha256: proofHash, result: resultPath, plan: planPath, usage: usagePath,
  sourceAndBuild: proof.sourceAndBuild, local: { platform: local.platform, newTests: localNew, relatedTests: localRelated,
    newTestNode: local.newTests.testNode, relatedTestNode: local.relatedTests.testNode, fullTests: local.fullTests.status },
  nativeLinux: { newTests: nativeNew, relatedTests: nativeRelated, tests: nativeAll, node: native.environment.node, finishedAt: native.finishedAt,
    observedOwnedProcesses: cleanup.observedOwnedProcesses, sshClosed: cleanup.sshClosed, inaccessiblePeers: cleanup.inaccessiblePeers.length,
    unresolvedPeers: cleanup.unresolved.length, globalProcessAbsenceProven: false },
  priorAttempts: proof.priorAttempts, historicalEvidence: proof.historicalEvidence, retainedLocalFailures: history,
  entryCases: { cli: 2, http: 3, evidence: nativeNewLog, cliSigkillComplete: ['sqlite', 'file-journal'], httpSigkillNonfinal: ['sqlite', 'file-journal'], httpNormallyAdoptedPartialBatch: ['sqlite'] },
  completeResume: 'explicit_model_readResume_current_complete_proof_normal_ledger_local_tool_call_one_transport_zero',
  partialWait: 'stored_only_preserves_originals_then_explicit_online_next_page_or_failed_item_only',
  contextSelectionConvergence: 'measured_fitting_optional_subset_with_unchanged_mandatory_and_final_limits_not_global_optimum',
  evidenceRecallPreparation: 'first_validated_adopted_original_card_body_only_default_no_progress_three_unchanged_not_new_evidence',
  collectionPostSendCustody: 'required_followup', costMeasurement: 'no_new_io_latency_or_real_token_savings_claim',
  nextPlan: nextPath, nextPlanStatus, mcpSequence: sequencePath, costReview: costPath,
  chapterComplete: false, goalComplete: false, realModelApi: 'paused', browser: 'not_checked_by_this_document_update', remaining };
c05.mcp_collections_progress = progress; c05.current_implementation = `${behavior} ${boundary} ${improvements}`; c05.nextPlan = nextPath;
backlog.next_local_work_item = { ...backlog.next_local_work_item, id: 'C05', id_kind: 'execution_chapter', scope: 'mcp_collection_post_send_custody',
  next_design: nextPath, status: nextPlanStatus, cost_review: costPath, prerequisite_note: `${next} ${remaining}` };
assert.deepEqual(backlog.execution_chapters.filter(value => value.id !== 'C05'), originalBacklog.execution_chapters.filter(value => value.id !== 'C05'));
for (const [key, value] of Object.entries(originalC05)) if (!['current_implementation', 'nextPlan'].includes(key)) assert.deepEqual(c05[key], value);
for (const [key, value] of Object.entries(originalBacklog)) if (!['revision', 'next_execution_chapter', 'next_local_work_item', 'execution_chapters'].includes(key)) assert.deepEqual(backlog[key], value);
updates.set(backlogPath, JSON.stringify(backlog, null, 2) + '\n');
const htmlPath = 'design/secumon-review.html', originalHtml = originals.get(htmlPath); let html = originalHtml;
assert.equal(html.includes('C05-MCP-COLLECTIONS-FINAL-PROOF:'), false);
function replaceHtml(pattern, replacement, label) {
  assert.equal([...html.matchAll(new RegExp(pattern.source, 'g'))].length, 1, 'HTML anchor changed: ' + label); html = html.replace(pattern, replacement);
}
const dataPattern = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const originalData = JSON.parse(dataPattern.exec(html)[1]), data = structuredClone(originalData);
assert.equal(data.modules.length, 16); assert.equal(data.items.length, 31); assert.equal(data.glossary.length, 93);
assert.equal(data.snapshot.c05McpOffline.proofSha256, predecessorHash); assert.equal(data.snapshot.c05McpCollections, undefined);
data.snapshot.currentNotesAsOf = proof.recordedAt.slice(0, 10); data.snapshot.currentResults = resultPath; data.snapshot.currentVerification = proofPath; data.snapshot.nextPlan = nextPath;
const moduleNotes = {
  work: ['현재 원근거를 처음 찾아 읽는 일을 준비 진전으로 센다. 동일 내용·파생 복사본의 반복은 기본 무진전 한도 3을 우회하지 않는다.', '준비 진전은 새 근거 생성이나 목표 완료가 아니다.'],
  plan: ['실제 입력의 완전한 저장 결과 안내를 보고 모델이 원 query와 parent/head를 잇는 후속 계획을 명시한다. 필요한 근거 ID도 현재 입력에서 찾아 읽는다.', '안내 표식은 실행 허가가 아니며 부분 자료를 완료로 바꾸지 않는다.'],
  execute: ['저장 수집 정산을 필요한 compact·첫 문맥 복원보다 먼저 처리하고 명시된 완전 후속 시도를 로컬에서 소비한다.', '부모 실패·owner·원문을 유지하며 새 페이지는 명시 연결이 필요하다.'],
  context: ['실제 fit하는 선택 항목 일부가 남도록 수렴을 고쳤다. 필수 문맥과 최종 전체 요청 한도·출처 재검사는 유지한다.', '최적 배치나 실제 tokenizer 정확도를 증명하지 않으며 반복 조회 비용은 미측정이다.'],
  tools: ['plain과 collection binding을 같은 C01 조립에 연결하고 mixed online 발견·stored_only 원문 검사를 구분한다.', '과거 원문에서 계약을 새로 등록하거나 자동 online fallback을 하지 않는다.'],
  mcp: ['일반 CLI의 SIGKILL 복구·compact·complete 소비와 HTTP의 부분 페이지 대기·명시 다음 요청을 확인했다.', 'collection 페이지별 전송 후 원응답 보관·known usage 정산은 별도 필수 후속이다.'],
  budget: ['완전 후속의 로컬 소비는 논리 도구 호출 한 번·원격 전송 0회다. 근거 조회와 답변·compact는 기존 예산을 따른다.', '동일 명령의 반복 정산은 없고 sent 표시를 실제 원격 실행·과금으로 해석하지 않는다.'],
  channels: ['CLI 2사례·localhost HTTP 3사례를 실제 저장소와 로컬 peer로 확인했다. HTTP partial batch 1사례는 SQLite 정상 채택 상태다.', '실제 브라우저 렌더링과 사내 채널 연동은 별도이며 합성 모델 의미 품질을 검증한 것이 아니다.'],
  policy: ['원 부모·원문·계약·현재 권한을 후속 예약·실행·채택에서 재검사한다. 모델 표식으로 권한을 얻지 않는다.', 'collection 전송 후 보관 권한과 현재 본문 채택 분리는 아직 필수 후속이다.'],
};
const previousModuleNotes = {};
for (const [id, [done, left]] of Object.entries(moduleNotes)) {
  const module = data.modules.find(value => value.id === id); assert.ok(module);
  previousModuleNotes[id] = { done: module.done, left: module.left, docs: structuredClone(module.docs) };
  module.done = `C05 현재 수집 재개: ${done} ${verified}. 묶음은 합산하지 않는다. 이전 구현 기록: ${module.done}`;
  module.left = `${left} ${remaining}`; module.docs = [...new Set([...module.docs, resultPath, planPath, usagePath, hostUsagePath, sequencePath, costPath])];
}
data.snapshot.c05McpCollections = { ...progress, previousModuleNotes, retainedModuleText: 'Prior snapshots and module text remain historical; this bounded unit does not complete C05.' };
const link = (path, label) => `<a href="${path}" target="_blank" rel="noopener">${label} →</a>`;
const banner = `${marker}<div class="note gap-top" id="latest-status" data-c05-mcp-collections-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>C05 수집 재개·문맥 수렴·저장 근거 조회</strong><br>${behavior}<br>${verified}. 합성 모델·로컬 peer 계약 인수다.<br>${improvements}<br>${next} ${remaining}<br>${link('chapters/C05-mcp-collections-entry-result.md', '결과와 한계')} · ${link('chapters/C05-mcp-collections-entry-usage.md', '사용법')} · ${link('../' + proofPath, '확정 증거')} · ${link('../' + nextPath, '필수 후속')}</div>`;
replaceHtml(/<!-- C05-MCP-OFFLINE-FINAL-PROOF: [a-f0-9]{64} --><div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/,
  old => banner + '\n<details class="gap-top" data-c05-history="mcp-offline"><summary>v0.66 단순 읽기 offline 결과와 당시 다음 계획 펼치기</summary>' + old.replace('id="latest-status"', 'id="c05-mcp-offline-history-status"').replace('aria-label="최신 구현과 검증 상태"', 'aria-label="과거 C05 단순 읽기 offline 상태"') + '</details>', 'latest/history');
replaceHtml(/<div class="hero-aside">[\s\S]*?<\/div>/, '<div class="hero-aside"><span class="badge partial">C05 수집 재개 검증</span><strong>받은 자료는 이어 쓰고<br>필요한 근거는 찾아 읽는다.</strong><p>완전한 저장 결과는 명시 후속 계획으로 소비하고 새 페이지는 연결을 기다린다. 문맥 한도와 반복 제한을 유지한다.</p></div>', 'hero');
replaceHtml(/C05 MCP 서버 없는 재개 설명 갱신<br>/, 'C05 수집 재개 설명 갱신<br>', 'sidebar');
replaceHtml(/<div class="note"><strong>현재 구현 순서는 C01~C10이다\.<\/strong>[\s\S]*?<\/div>/,
  old => {
    assert.equal((old.match(/<br>신뢰된 시작 프로그램이/g) ?? []).length, 1, 'roadmap body changed');
    return old.replace(/<br>신뢰된 시작 프로그램이[\s\S]*$/, `<br>${behavior} ${improvements}<br>${next} ${remaining}<br>${link('03-migration-plan.md', '통합 계획')} · ${link('implementation-backlog.json', '작업 목록')} · ${link('chapters/C05-mcp-collections-entry-result.md', '현재 결과')}</div>`);
  }, 'roadmap');
replaceHtml(/<div class="note gap-top"><strong>다음은 여러 항목 수집의 일반 입구 연결을 검토한다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note gap-top"><strong>다음은 페이지별 전송 후 보관·정산을 연결한다.</strong> ${next} 아래 P0~P6 31개 항목은 과거 이력이다. ${remaining}</div>`, 'next unit');
replaceHtml(/최신 C05 MCP 서버 없는 재개 결과와 과거 전송 후 보관·정산·저장 응답 복구·MCP 연결·호스트 권한·C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사·목표 변경 및 P0~P6 이력을 함께 보존한다\./,
  '최신 C05 수집 재개·문맥 수렴·저장 근거 조회 결과와 과거 단순 읽기 offline·보관·정산·MCP·C02·C03·C04 및 P0~P6 이력을 함께 보존한다.', 'footer scope');
replaceHtml(/C05 MCP 서버 없는 재개 설명 갱신: \d{4}\.\d{2}\.\d{2}/, 'C05 수집 재개 설명 갱신: ' + proof.recordedAt.slice(0, 10).replaceAll('-', '.'), 'footer date');
replaceHtml(dataPattern, () => '<script id="review-data" type="application/json">' + JSON.stringify(data, null, 2).replaceAll('<', '\\u003c') + '</script>', 'snapshot/modules');
const parsed = JSON.parse(dataPattern.exec(html)[1]);
for (const key of ['items', 'glossary', 'scenarios']) assert.deepEqual(parsed[key], originalData[key]);
for (const module of parsed.modules) {
  const before = originalData.modules.find(value => value.id === module.id);
  for (const key of Object.keys(before)) if (!(moduleNotes[module.id] && ['done', 'left', 'docs'].includes(key))) assert.deepEqual(module[key], before[key]);
}
for (const [key, value] of Object.entries(originalData.snapshot)) if (!['currentNotesAsOf', 'currentResults', 'currentVerification', 'nextPlan'].includes(key)) assert.deepEqual(parsed.snapshot[key], value);
const matching = (text, pattern) => [...text.matchAll(pattern)].map(match => match[0]);
for (const pattern of [/<article class="module"[\s\S]*?<\/article>/g, /<article class="glossary-item"[\s\S]*?<\/article>/g,
  /<details class="work-card"[\s\S]*?<\/details>/g, /<div class="road-phase">[\s\S]*?<\/span><\/div>/g, /<style[^>]*>[\s\S]*?<\/style>/g])
  assert.deepEqual(matching(html, pattern), matching(originalHtml, pattern));
const executable = text => matching(text, /<script[^>]*>[\s\S]*?<\/script>/g).filter(value => !value.startsWith('<script id="review-data"'));
assert.deepEqual(executable(html), executable(originalHtml));
for (const script of executable(html)) new Script(script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
const staticHtml = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''), ids = matching(staticHtml, /\sid="[^"]+"/g);
assert.equal(new Set(ids).size, ids.length); assert.equal((html.match(/id="latest-status"/g) ?? []).length, 1);
updates.set(htmlPath, html);
function checkLocalLink(absolute) {
  assert.ok(absolute.startsWith(root + '/'));
  const relative = absolute.slice(root.length + 1);
  if (newTargets.includes(relative)) { assert.ok(updates.get(relative)?.trim()); assert.equal(existsSync(absolute), false); return; }
  const stat = lstatSync(absolute); assert.equal(realpathSync(absolute), absolute); assert.ok(stat.isFile() && !stat.isSymbolicLink());
}
for (const match of staticHtml.matchAll(/\bhref="([^"]+)"/g)) {
  const href = match[1]; if (href.startsWith('#')) { assert.ok(ids.includes(' id="' + decodeURIComponent(href.slice(1)) + '"')); continue; }
  assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//'));
  checkLocalLink(resolve(root, 'design', decodeURIComponent(href.split(/[?#]/)[0])));
}
for (const module of parsed.modules) for (const path of [...module.files, ...module.docs]) {
  if (newTargets.includes(path)) assert.ok(updates.has(path)); else read(path);
}
for (const [path, text] of updates) if (path.endsWith('.md')) {
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1]; if (/^(?:https?:|#)/.test(href)) continue;
    checkLocalLink(resolve(root, dirname(path), decodeURIComponent(href.split(/[?#]/)[0])));
  }
  if (originals.has(path)) assert.deepEqual(matching(text, /```[^\n]*\n[\s\S]*?```/g), matching(originals.get(path), /```[^\n]*\n[\s\S]*?```/g));
}
assert.deepEqual([...updates.keys()].sort(), [...targets].sort());
assert.deepEqual(await verifyEvaluationBuild(runtime), proof.sourceAndBuild); assert.equal(read(proofPath), proofText);
for (const [path, expected] of seen) assert.equal(sha(readFileSync(resolve(root, path))), expected, 'input changed before publication: ' + path);
for (const [path, expected] of originals) assert.equal(read(path), expected);
for (const path of newTargets) assert.equal(existsSync(resolve(root, path)), false);
// These writes are not a cross-file transaction. Immutable candidate originals are retained for recovery;
// after any write failure, inspect the partial state instead of automatically rerunning this script.
for (const [path, text] of updates) writeFileSync(resolve(root, path), text, newTargets.includes(path) ? { flag: 'wx' } : {});
console.log(JSON.stringify({ status: 'updated_from_final_proof', revision: 'v0.67', updated: targets, proof: proofPath, proofSha256: proofHash,
  sourceAndBuild: proof.sourceAndBuild, localNew, localRelated, nativeNew, nativeRelated, nativeAll, nextPlan: nextPath, nextPlanStatus,
  entryCases: progress.entryCases, retainedLocalFailures: history, priorNativeAttempts: proof.priorAttempts,
  retainedCandidateEvidence: manifest.retainedEvidence, predecessorScript: manifest.predecessorScript,
  documents: targets.map(path => ({ path, beforeSha256: originals.has(path) ? sha(originals.get(path)) : null, afterSha256: sha(updates.get(path)) })),
  preservedHtml: { modules: 16, historicalItems: 31, glossary: 93, styles: true, executableScripts: true, previousSnapshots: true },
  browserRendered: false, chapterComplete: false, goalComplete: false }));
