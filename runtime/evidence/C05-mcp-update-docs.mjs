// Run once after root authorizes the final C05 MCP proof. Only the five listed documents are written.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

assert.equal(process.argv.length, 2, 'no arguments; final proof and adopted next plan required');
const runtime = realpathSync(fileURLToPath(new URL('../', import.meta.url))), root = dirname(runtime);
assert.equal(realpathSync(process.cwd()), runtime, 'run from runtime');
const proofPath = 'runtime/evidence/C05-mcp-linux-nas-20260907/verification.json';
const resultPath = 'design/chapters/C05-mcp-host-result.md';
const usagePath = 'design/chapters/C05-mcp-host-usage.md';
const nextPath = 'design/chapters/C05-mcp-response-recovery-plan.md';
const costPath = 'design/chapters/C05-context-cost-review.md';
const reviewPath = 'design/chapters/C05-after-host-review.md';
const targets = ['design/README.md', 'design/03-migration-plan.md', 'design/implementation-backlog.json', 'runtime/README.md', 'design/secumon-review.html'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function bytes(path) {
  assert.match(path, /^(?:runtime|design)\/[a-zA-Z0-9_./-]+$/); assert.ok(!path.split('/').includes('..'));
  const absolute = resolve(root, path), stat = lstatSync(absolute);
  assert.equal(realpathSync(absolute), absolute); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 128 * 1024 * 1024);
  return readFileSync(absolute);
}
// Existing document links also name root-level archives. Check their presence without
// reading their contents or broadening the evidence-body/hash reader above.
function checkLocalLink(absolute) {
  assert.ok(absolute.startsWith(root + '/'));
  const stat = lstatSync(absolute);
  assert.equal(realpathSync(absolute), absolute); assert.ok(stat.isFile() && !stat.isSymbolicLink());
}
const read = path => bytes(path).toString('utf8');
const proofText = read(proofPath), proofHash = sha(proofText), proof = JSON.parse(proofText);
assert.equal(proof.schemaVersion, 1); assert.equal(proof.chapter, 'C05');
assert.equal(proof.scope, 'mcp_host_read_tools_general_entry');
assert.equal(proof.status, 'verified_supported_local_posix_partial_chapter');
assert.equal(proof.chapterComplete, false); assert.equal(proof.goalComplete, false);
assert.deepEqual(await verifyEvaluationBuild(runtime), proof.sourceAndBuild);
const local = proof.local, native = proof.nativeLinux, cleanup = native.cleanup;
assert.equal(local.platform, 'darwin'); assert.equal(local.nodeScope, 'finalization_process_only');
assert.equal(local.build.node, process.version); assert.match(process.version, /^v24\./);
assert.deepEqual(local.build.sourceAndBuild, proof.sourceAndBuild);
assert.equal(sha(read('runtime/dist/build-manifest.json')), local.build.manifestSha256);
assert.equal(native.status, 'passed'); assert.equal(native.environment.platform, 'linux'); assert.equal(native.environment.node, 'v24.20.0');
assert.deepEqual(native.sourceAndBuild, proof.sourceAndBuild);
const stepNames = ['build', 'new-mcp-host-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
assert.deepEqual(native.steps.map(step => step.name), stepNames);
for (const step of native.steps) {
  assert.equal(step.status, 'passed'); assert.equal(step.exitCode, 0); assert.equal(step.signal, null);
  assert.equal(step.timedOut, false); assert.equal(step.terminationReason, null); assert.equal(step.nodeTestTimeoutFailures, 0);
  assert.equal(step.groupAbsentConfirmed, true); assert.equal(step.finalGroupState, 'absent');
  assert.equal(step.logFlushCompleted, true); assert.deepEqual(step.errors, []);
}
assert.equal(cleanup.sshClosed, true); assert.equal(cleanup.observedOwnedProcesses, 0); assert.deepEqual(cleanup.auditErrors, []);
assert.equal(cleanup.globalProcessAbsenceProven, false); assert.ok(Array.isArray(cleanup.inaccessiblePeers) && Array.isArray(cleanup.unresolved));
assert.ok(Number.isFinite(Date.parse(native.finishedAt))); assert.equal(native.collectedFiles.length, 9);
assert.ok(Array.isArray(proof.files) && proof.files.length > 0);
for (const item of proof.files) assert.equal(sha(bytes(item.path)), item.sha256, 'retained evidence changed: ' + item.path);
function count(value) {
  assert.ok(Number.isSafeInteger(value.tests) && value.tests > 0); assert.equal(value.pass, value.tests);
  for (const field of ['fail', 'cancelled', 'skipped', 'todo', 'timeoutFailures']) assert.equal(value[field], 0);
  return value.tests;
}
const localNew = count(local.newTests.tests), localRelated = count(local.relatedTests.tests);
const nativeNew = count(native.newTests), nativeRelated = count(native.relatedTests), nativeAll = count(native.tests);
for (const selected of [local.newTests, local.relatedTests]) {
  assert.match(selected.testNode, /^v24\./); assert.deepEqual(selected.sourceAndBuild, proof.sourceAndBuild);
  assert.equal(selected.sourceObservation.kind, 'per_run_source_and_build_verification');
  assert.deepEqual(selected.sourceObservation.before, proof.sourceAndBuild); assert.deepEqual(selected.sourceObservation.after, proof.sourceAndBuild);
}
assert.equal(nativeNew, localNew); assert.equal(nativeRelated, localRelated);
assert.ok(native.targetedFiles.length > 0 && native.relatedFiles.length > 0);
for (const path of [...native.targetedFiles, ...native.relatedFiles]) assert.ok(native.allTestFiles.includes(path));
for (const path of [resultPath, usagePath, nextPath, costPath, reviewPath]) assert.ok(read(path).trim().length > 0);
const predecessorScript = { path: 'runtime/evidence/C05-host-update-docs.mjs', sha256: '01c588538781eafc3c07708a4721c969a87100db171937d3c0842b97bcd97f85' };
assert.equal(sha(bytes(predecessorScript.path)), predecessorScript.sha256);
const retainedEvidence = new Map([
  'runtime/evidence/C05-host-linux-nas-20260907/verification.json',
  'runtime/evidence/C04-goal-linux-nas-20260907/verification.json',
].map(path => [path, sha(bytes(path))]));
const oldHostProof = JSON.parse(read('runtime/evidence/C05-host-linux-nas-20260907/verification.json'));
assert.equal(oldHostProof.status, 'verified_supported_local_posix_partial_chapter');
assert.ok(proof.historicalEvidence.some(item => item.path === 'runtime/evidence/C05-host-linux-nas-20260907/verification.json' &&
  item.sha256 === retainedEvidence.get(item.path)), 'the final MCP proof must retain its verified host predecessor');
const number = value => value.toLocaleString('en-US'), pair = value => `${number(value)}/${number(value)}`;
const verified = `macOS Node24 신규 ${pair(localNew)}·관련 ${pair(localRelated)}, NAS Linux Node24 신규 ${pair(nativeNew)}·관련 ${pair(nativeRelated)}·전체 ${pair(nativeAll)} 통과`;
const remaining = 'C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox, native Windows runtime/file 연결·PostgreSQL·운영 배포는 미검증 또는 후속 구현 항목이다.';
const next = '다음 단위는 원응답과 MCP 영수증을 저장한 뒤 실행기의 received 전에 중단된 단순 읽기의 복구로, 착수 예정이며 실행 권한(lease)과 수신 시각 등 세부조건은 검토 중이다. 그 뒤 전송 후 권한 변경·known usage 보존, 서버 없는 재개, 페이지·대기의 일반 입구 연결을 이어간다. 문맥 조회 비용 개선도 남아 있다.';
const intro = `기존 MCP 읽기를 **같은 C01 담당의 보관 포트와 일반 CLI/Web**에 연결했다. 호스트 시작 프로그램이 승인한 실행 설정·도구 계약을 등록하고 기존 계획·도구 실행·원응답·영수증·증거·정산을 사용한다. **${verified}**. [MCP 연결 결과](${root}/${resultPath}) · [사용법](${root}/${usagePath}) · [확정 증거](${root}/${proofPath}). 저장된 received/완료 결과는 tools/call을 중복하지 않지만, 프로필 재열기에는 서버 발견(tools/list)이 필요하므로 offline 재개는 아니다. ${next} [다음 원응답 복구 계획](${root}/${nextPath}) · [문맥 조회 비용 검토](${root}/${costPath}). ${remaining}`;
const originals = new Map(targets.map(path => [path, read(path)])), updates = new Map();
function once(text, before, after, label) {
  const at = text.indexOf(before); assert.ok(at >= 0 && text.indexOf(before, at + before.length) < 0, 'anchor changed: ' + label);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function paragraph(text, starts, replacement, label) {
  const matches = text.split('\n\n').filter(value => value.startsWith(starts));
  assert.equal(matches.length, 1, 'paragraph changed: ' + label); return once(text, matches[0], replacement(matches[0]), label);
}
for (const path of ['design/README.md', 'design/03-migration-plan.md', 'runtime/README.md']) {
  let text = originals.get(path); assert.ok(!text.includes('<!-- C05-MCP-FINAL-PROOF:'), 'already updated: ' + path);
  const firstBreak = text.indexOf('\n\n'); assert.ok(firstBreak > 0);
  assert.ok(text.slice(firstBreak + 2).startsWith('<!-- C05-HOST-FINAL-PROOF:'), 'expected v0.62 introduction');
  text = text.slice(0, firstBreak + 2) + `<!-- C05-MCP-FINAL-PROOF: ${proofHash} -->\n${intro}\n\n이전 v0.62 C05 호스트 연결의 확정 결과와 MCP 착수 당시 기록(아래 “다음”·진행 중 표시는 당시 상태):\n` + text.slice(firstBreak + 2);
  if (path !== 'runtime/README.md') text = once(text, 'v0.62 · C05 호스트 읽기 도구·실행 권한 검증과 MCP 연결 준비',
    'v0.63 · C05 MCP 일반 입구 연결 검증과 원응답 복구 준비', path + ' version');
  if (path === 'design/README.md') {
    text = paragraph(text, '현재 goal은 지원 POSIX에서 검증한 C04 ', () => `현재 goal은 지원 POSIX에서 검증한 C04 일반 요청·목표 변경, C05 호스트 권한과 MCP 일반 입구 연결을 보존하고 [단순 MCP 원응답 수신 뒤 중단 복구](${root}/${nextPath})를 이어가는 것이다. 원응답 귀속·현재 권한·중복 없는 정산을 유지하며 다음 전송 후 권한 변경·서버 없는 재개·페이지와 대기 연결도 범위에 남긴다. [문맥 조회 비용 검토](${root}/${costPath})에 따른 개선은 별도 측정·인수한다. 다음 단위 착수는 챕터 전체 완료를 뜻하지 않는다. 실제 배포 대상은 Linux와 Windows이며 macOS는 개발 환경이다. PostgreSQL과 native Windows의 잔여 구현·검증, 실제 모델/API 시험 중단을 유지하고 공통 스킬을 매 단계 필수로 호출하지 않는다.`, 'current goal');
    text = paragraph(text, '[구현 현황 HTML 안내서]', () => `[구현 현황 HTML 안내서](${root}/design/secumon-review.html)의 최신 배너와 관련 모듈에 MCP 일반 입구 연결 결과·사용법과 다음 원응답 복구를 반영했다. 16개 기능 모듈·93개 용어·과거 P0~P6의 31개 작업을 유지하고 C05 호스트·C04 확정 증거와 당시 다음 계획은 역사로 보존한다. 현재 상태는 상단 최신 안내와 이 README·통합 플랜을 따른다. 이번 갱신은 브라우저 렌더링·클릭 검증이 아니다.`, 'guide status');
  }
  if (path === 'design/03-migration-plan.md') {
    text = paragraph(text, '[호스트 읽기 도구·실행 권한 결과](chapters/C05-host-tools-result.md)에서', old =>
      `[MCP 일반 입구 연결 결과](chapters/C05-mcp-host-result.md)에서 ${verified}. 같은 담당의 기존 보관 포트·계약 목록·원응답·영수증·정산을 재사용하며 received/완료 뒤 재접속에서 tools/call 중복을 막았다. 새 프로필은 서버 발견을 수행하므로 offline은 아니다. [사용법](chapters/C05-mcp-host-usage.md)에 따라 신뢰된 호스트가 실행 설정·도구와 권한을 전달한다. 다음은 [단순 원응답 수신 뒤 중단 복구](chapters/C05-mcp-response-recovery-plan.md)다. ${next} ${remaining}\n\n이전 v0.62 호스트 연결 결과와 당시 다음 계획: ${old}`, 'C05 current unit');
  }
  updates.set(path, text);
}
const originalBacklog = JSON.parse(originals.get('design/implementation-backlog.json')), backlog = structuredClone(originalBacklog);
assert.equal(backlog.revision, 'v0.62'); backlog.revision = 'v0.63'; backlog.next_execution_chapter = 'C05';
const c05 = backlog.execution_chapters.find(chapter => chapter.id === 'C05'), originalC05 = originalBacklog.execution_chapters.find(chapter => chapter.id === 'C05');
assert.equal(c05.status, 'in_progress'); assert.equal(c05.mcp_host_progress, undefined);
assert.equal(c05.host_tools_progress.proofSha256, retainedEvidence.get(c05.host_tools_progress.currentVerification));
const progress = { status: proof.status, currentVerification: proofPath, proofSha256: proofHash, result: resultPath, usage: usagePath,
  sourceAndBuild: proof.sourceAndBuild,
  local: { platform: local.platform, newTests: localNew, relatedTests: localRelated,
    newTestNode: local.newTests.testNode, relatedTestNode: local.relatedTests.testNode, fullTests: local.fullTests.status },
  nativeLinux: { newTests: nativeNew, relatedTests: nativeRelated, tests: nativeAll, node: native.environment.node,
    finishedAt: native.finishedAt, observedOwnedProcesses: cleanup.observedOwnedProcesses, sshClosed: cleanup.sshClosed,
    inaccessiblePeers: cleanup.inaccessiblePeers.length, unresolvedPeers: cleanup.unresolved.length, globalProcessAbsenceProven: false },
  priorAttempts: proof.priorAttempts, historicalEvidence: proof.historicalEvidence,
  chapterComplete: false, goalComplete: false, realModelApi: 'paused', browser: 'not_checked_by_this_document_update',
  offlineGeneralEntry: false, rawBeforeReceivedRecovery: 'next_unit_not_implemented', postSendAuthorityReceiptRecovery: 'required_followup',
  collectionWaitGeneralEntry: 'required_followup', remaining, nextPlan: nextPath, costReview: costPath };
c05.mcp_host_progress = progress;
c05.current_implementation = 'The existing MCP plain-read adapter uses the same C01 custody and tool catalog through the registered general CLI/Web profile. Received/completed results survive reopen without another tools/call, while each new profile still discovers the server. Raw-before-received recovery is planned next; lease and receipt-timestamp conditions remain under review.';
c05.nextPlan = nextPath;
backlog.next_local_work_item = { ...backlog.next_local_work_item, id: 'C05', id_kind: 'execution_chapter',
  scope: 'plain_mcp_stored_response_recovery_before_executor_received', next_design: nextPath, cost_review: costPath,
  status: 'next_unit_planned_not_implemented', prerequisite_note: 'Reuse verified MCP host custody, dispatch/intent/response proof and the existing receive/settlement lifecycle. Lease and receipt-timestamp conditions remain under review before implementation. Preserve the original attempt and prevent hidden calls. Post-send authority/known-usage, offline resume and page/wait general-entry remain required; no chapter or goal completion is implied.' };
assert.deepEqual(backlog.execution_chapters.filter(chapter => chapter.id !== 'C05'), originalBacklog.execution_chapters.filter(chapter => chapter.id !== 'C05'));
assert.deepEqual(backlog.requirements, originalBacklog.requirements);
for (const [key, value] of Object.entries(originalC05)) if (!['current_implementation', 'nextPlan'].includes(key)) assert.deepEqual(c05[key], value, 'previous C05 field changed: ' + key);
updates.set('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');

const originalHtml = originals.get('design/secumon-review.html'); let html = originalHtml;
assert.ok(!html.includes('C05-MCP-FINAL-PROOF:')); assert.ok(html.includes('C05-HOST-FINAL-PROOF:') && html.includes('C04-GOAL-FINAL-PROOF:'));
function replaceHtml(pattern, replacement, label) {
  assert.equal([...html.matchAll(new RegExp(pattern.source, 'g'))].length, 1, 'HTML anchor changed: ' + label);
  html = html.replace(pattern, replacement);
}
const dataPattern = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const originalData = JSON.parse(dataPattern.exec(html)[1]), data = structuredClone(originalData);
assert.equal(data.modules.length, 16); assert.equal(data.items.length, 31); assert.equal(data.glossary.length, 93);
assert.ok(data.snapshot.c04Goal && data.snapshot.c05Host); assert.equal(data.snapshot.c05Mcp, undefined);
assert.equal(data.snapshot.c05Host.proofSha256, retainedEvidence.get(data.snapshot.c05Host.currentVerification));
data.snapshot.currentNotesAsOf = proof.recordedAt.slice(0, 10); data.snapshot.currentResults = resultPath;
data.snapshot.currentVerification = proofPath; data.snapshot.nextPlan = nextPath;
const moduleNotes = {
  tools: ['기존 MCP 읽기를 담당의 같은 계약 목록에 게시하고 CLI/Web에서 정확한 해시 포함 버전으로 호출한다. 호스트 binding에 없는 원격 도구와 허용 목록 밖의 도구는 자동 연결하지 않는다.', '현재 plain read 연결 다음에는 원응답 수신 뒤 중단 복구·권한 변경·offline·페이지와 대기 입구를 연결한다. 실제 도구 선택 품질·비용 평가는 남아 있다.'],
  mcp: ['같은 C01 state/artifacts·지문·시각 포트를 재사용해 실제 로컬 stdio peer의 원응답, dispatch·intent·response, 결과 증명을 보관한다. 두 담당의 원자료와 peer 종료를 분리했다.', '현재 재열기에는 서버 발견이 필요해 offline이 아니다. received 전 raw 복구와 전송 후 권한 변경·known usage 보존, 서버 없는 재개, 페이지·대기의 일반 입구는 후속이다. 사내 서버·인증·HTTP MCP는 미검증이다.'],
  channels: ['기존 일반 CLI/Web에 같은 호스트 MCP 등록을 주입하고 원문·결과·세션을 이어 쓴다. 별도 CLI 프로세스와 localhost HTTP에서 실제 로컬 peer와 재접속을 검사했다.', 'HTTP 시험은 실제 브라우저 관측과 다르다. 사내 인증·Knox·C06 화면과 설치, 서버 없이 여는 일반 재개는 남아 있다.'],
  policy: ['실행 설정과 projector는 신뢰된 호스트 코드에서 등록한다. 사용자 원문·HTTP로 실행 파일·환경·권한을 설정하지 않으며 기존 프로필 권한·취소 검사를 재사용한다.', '전송 후 권한 변경 때 MCP 응답과 known usage를 먼저 귀속·보존하는 후속 경계는 아직 연결하지 않았다. host는 OS 샌드박스가 아니며 사내 권한·Windows 인수가 남아 있다.'],
  budget: ['received/완료 뒤 재접속에서 같은 원자료의 tools/call과 사용량 정산·답변을 중복하지 않는 흐름을 검사했다. 새 업무 한도와 기존 장부를 유지한다.', '프로필을 다시 열 때 발견 호출은 별도로 발생한다. wire 전송 뒤 어댑터가 거절한 응답의 known usage 보존은 후속이며 실제 모델 요금·추정 오차를 검증한 것이 아니다.'],
  context: ['현재 카탈로그 계약·보관된 원문 증명을 기존 문맥과 실행기에 연결했다. 재접속은 과거 응답을 현재 정책과 계약으로 다시 검증하며 작업 완료로 세션을 버리지 않는다.', '문맥 검증의 중복 조회는 측정 기준선을 보존한 별도 개선이다. 원문·권한·최종 현재성 검사를 생략하지 않는다. 실제 tokenizer·의미 보존·성능은 미검증이다.'],
  memory: ['MCP 원응답과 근거는 해당 담당의 기존 보관 포트에 남긴다. 읽은 자료를 개인 장기 기억으로 자동 등록하거나 다른 담당 기억과 합치지 않는다.', '원응답 수신과 장기 기억의 명시 등록·회상은 구분한다. 중복 조회 최적화, PostgreSQL·Windows 및 자율 경험 기록의 의미 품질은 후속이다.'],
};
const previousModuleNotes = {};
for (const [id, [done, left]] of Object.entries(moduleNotes)) {
  const module = data.modules.find(item => item.id === id); assert.ok(module);
  previousModuleNotes[id] = { done: module.done, left: module.left, docs: structuredClone(module.docs) };
  module.done = `C05 현재 MCP 연결: ${done} ${verified}. 합성 모델·로컬 peer 계약 인수이며 묶음은 합산하지 않는다. 이전 구현 기록: ${module.done}`;
  module.left = `${left} ${remaining}`;
  module.docs = [...new Set([...module.docs, resultPath, usagePath, nextPath, costPath])];
}
data.snapshot.c05Mcp = { ...progress, previousModuleNotes, retainedModuleText: 'Previous module notes and c05Host/C04 snapshots remain historical evidence; this bounded MCP connection does not complete C05.' };
const link = (path, label) => `<a href="${path}" target="_blank" rel="noopener">${label} →</a>`;
const banner = `<!-- C05-MCP-FINAL-PROOF: ${proofHash} --><div class="note gap-top" id="latest-status" data-c05-mcp-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>C05 MCP 읽기·일반 입구 연결</strong><br>같은 담당의 CLI/Web·원문·보관 포트·계약 목록을 통해 로컬 MCP 자료를 읽고 근거 답변을 남긴다. 실행 설정은 신뢰된 시작 프로그램에서 등록한다.<br>${verified}. 실제 로컬 stdio peer와 합성 모델의 연결 계약을 검사했다.<br>received/완료 뒤 재접속은 tools/call을 중복하지 않지만 서버 발견은 필요하므로 offline은 아니다. 다음은 received 전에 중단된 원응답의 복구다. C05·전체 goal은 미완료이며 실제 모델/API는 중단 상태다.<br>${link('chapters/C05-mcp-host-result.md', '결과와 한계')} · ${link('chapters/C05-mcp-host-usage.md', 'MCP 연결 사용법')} · ${link('../' + proofPath, '확정 증거')} · ${link('chapters/C05-mcp-response-recovery-plan.md', '다음 원응답 복구')} · ${link('chapters/C05-context-cost-review.md', '조회 비용 검토')}</div>`;
replaceHtml(/<!-- C05-HOST-FINAL-PROOF: [a-f0-9]{64} --><div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/,
  old => banner + '\n<details class="gap-top" data-c05-history="host"><summary>v0.62 호스트 연결 결과와 MCP 착수 당시 기록 펼치기</summary>' + old.replace('id="latest-status"', 'id="c05-host-history-status"').replace('aria-label="최신 구현과 검증 상태"', 'aria-label="과거 C05 호스트 연결 구현과 검증 상태"') + '</details>', 'latest/history');
replaceHtml(/<div class="hero-aside">[\s\S]*?<\/div>/,
  '<div class="hero-aside"><span class="badge partial">C05 MCP 일반 입구 검증</span><strong>같은 담당의 도구와 원문으로<br>MCP 자료를 이어 사용한다.</strong><p>수신·완료 결과는 재호출하지 않는다. 다음은 실행기 수신 기록 전에 중단된 원응답의 복구다. 현재 재열기는 서버 발견이 필요하다.</p></div>', 'hero');
replaceHtml(/C05 호스트 도구 설명 갱신<br>/, 'C05 MCP 연결 설명 갱신<br>', 'sidebar');
replaceHtml(/<div class="note"><strong>현재 구현 순서는 C01~C10이다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note"><strong>현재 구현 순서는 C01~C10이다.</strong><br>C01 담당·설정 → C02 지속 대화·compact → C03 개인 기억 → C04 범용 대화·추론 → C05 도구·기억·스킬 효율 → C06 채널·업무 배치 → C07 게시판·아카이브 → C08 동료·반론·자원 → C09 에이전트 간 통신(A2A)·상시 임무 → C10 설치·운영.<br>기존 호스트 읽기·권한 연결에 같은 C01 보관 포트와 MCP 발견·계약 게시를 연결했다. 원자료 응답과 출처·실행 영수증을 구분해 보존하고 기존 세션·계획·정산을 재사용한다.<br>${next} ${remaining}<br>${link('03-migration-plan.md', '통합 계획')} · ${link('implementation-backlog.json', '작업 목록')} · ${link('chapters/C05-mcp-host-result.md', '현재 MCP 결과')} · ${link('chapters/C05-mcp-response-recovery-plan.md', '다음 원응답 복구')} · ${link('chapters/C05-context-cost-review.md', '비용 검토')}</div>`, 'roadmap');
replaceHtml(/<div class="note gap-top"><strong>다음은 기존 MCP 읽기의 일반 입구 연결이다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note gap-top"><strong>다음은 단순 MCP 원응답 수신 뒤 중단 복구이며 착수 예정이다.</strong> 원응답과 MCP 영수증은 있지만 실행기의 received 기록 전인 시도를 복구하는 범위다. 실행 권한(lease)과 수신 시각 등 세부조건은 검토 중이다. 전송 후 권한 변경·known usage, 서버 없는 재개, 페이지·대기도 필수 후속이다. 아래 P0~P6 31개 항목은 과거 이력이다. ${remaining}</div>`, 'next unit');
replaceHtml(/최신 C05 호스트 읽기 도구·실행 권한 결과와 과거 C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사·목표 변경 및 P0~P6 이력을 함께 보존한다\./,
  '최신 C05 MCP 일반 입구 연결 결과와 과거 C05 호스트 권한·C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사·목표 변경 및 P0~P6 이력을 함께 보존한다.', 'footer scope');
replaceHtml(/C05 호스트 도구 설명 갱신: \d{4}\.\d{2}\.\d{2}/, 'C05 MCP 연결 설명 갱신: ' + proof.recordedAt.slice(0, 10).replaceAll('-', '.'), 'footer date');
replaceHtml(dataPattern, () => '<script id="review-data" type="application/json">' + JSON.stringify(data, null, 2).replaceAll('<', '\\u003c') + '</script>', 'snapshot and modules');
const parsed = JSON.parse(dataPattern.exec(html)[1]);
for (const key of ['items', 'glossary', 'scenarios']) assert.deepEqual(parsed[key], originalData[key], 'preserved data changed: ' + key);
for (const module of parsed.modules) {
  const previous = originalData.modules.find(item => item.id === module.id);
  for (const key of Object.keys(previous)) if (!(moduleNotes[module.id] && ['done', 'left', 'docs'].includes(key))) assert.deepEqual(module[key], previous[key]);
}
for (const [key, value] of Object.entries(originalData.snapshot)) if (!['currentNotesAsOf', 'currentResults', 'currentVerification', 'nextPlan'].includes(key)) assert.deepEqual(parsed.snapshot[key], value);
const matching = (text, pattern) => [...text.matchAll(pattern)].map(match => match[0]);
for (const pattern of [/<article class="module"[\s\S]*?<\/article>/g, /<article class="glossary-item"[\s\S]*?<\/article>/g,
  /<details class="work-card"[\s\S]*?<\/details>/g, /<div class="road-phase">[\s\S]*?<\/span><\/div>/g, /<style[^>]*>[\s\S]*?<\/style>/g])
  assert.deepEqual(matching(html, pattern), matching(originalHtml, pattern), 'preserved HTML content changed');
const executable = text => matching(text, /<script[^>]*>[\s\S]*?<\/script>/g).filter(value => !value.startsWith('<script id="review-data"'));
assert.deepEqual(executable(html), executable(originalHtml));
for (const script of executable(html)) new Script(script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
const staticHtml = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''), ids = matching(staticHtml, /\sid="[^"]+"/g);
assert.equal(new Set(ids).size, ids.length); assert.equal((html.match(/id="latest-status"/g) ?? []).length, 1);
for (const match of staticHtml.matchAll(/\bhref="([^"]+)"/g)) {
  const href = match[1]; if (href.startsWith('#')) { assert.ok(ids.includes(' id="' + decodeURIComponent(href.slice(1)) + '"')); continue; }
  assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//'));
  const absolute = resolve(root, 'design', decodeURIComponent(href.split(/[?#]/)[0])); assert.ok(absolute.startsWith(root + '/')); read(absolute.slice(root.length + 1));
}
for (const module of parsed.modules) for (const path of [...module.files, ...module.docs]) read(path);
updates.set('design/secumon-review.html', html);
for (const [path, text] of updates) if (path.endsWith('.md')) {
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1]; if (/^(?:https?:|#)/.test(href)) continue;
    const absolute = resolve(root, dirname(path), decodeURIComponent(href.split(/[?#]/)[0]));
    checkLocalLink(absolute);
  }
}
assert.deepEqual([...updates.keys()].sort(), [...targets].sort());
assert.deepEqual(await verifyEvaluationBuild(runtime), proof.sourceAndBuild); assert.equal(read(proofPath), proofText);
for (const [path, digest] of retainedEvidence) assert.equal(sha(bytes(path)), digest, 'historical evidence changed: ' + path);
for (const [path, original] of originals) assert.equal(read(path), original, 'document changed before publication: ' + path);
for (const [path, updated] of updates) writeFileSync(resolve(root, path), updated);
console.log(JSON.stringify({ status: 'updated_from_final_proof', updated: targets, revision: 'v0.63', proof: proofPath, proofSha256: proofHash,
  localNew, localRelated, nativeNew, nativeRelated, nativeAll, nextPlan: nextPath, costReview: costPath, predecessorScript,
  retainedEvidence: [...retainedEvidence].map(([path, sha256]) => ({ path, sha256 })),
  preservedHtml: { modules: 16, historicalItems: 31, glossary: 93, executableScripts: true, styles: true, previousSnapshots: true },
  browserRendered: false, chapterComplete: false, goalComplete: false }));
