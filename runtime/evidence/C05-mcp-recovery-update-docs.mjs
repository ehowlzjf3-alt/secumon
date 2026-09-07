// Run once after root authorizes the final C05 MCP stored-result recovery proof. Only the five listed documents are written.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

assert.equal(process.argv.length, 2, 'no arguments; final proof and reviewed next plan required');
const runtime = realpathSync(fileURLToPath(new URL('../', import.meta.url))), root = dirname(runtime);
assert.equal(realpathSync(process.cwd()), runtime, 'run from runtime');
const proofPath = 'runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json';
const resultPath = 'design/chapters/C05-mcp-response-recovery-result.md';
const usagePath = 'design/chapters/C05-mcp-host-usage.md';
const nextPath = 'design/chapters/C05-mcp-sent-authority-plan.md';
const sequencePath = 'design/chapters/C05-mcp-host-plan.md';
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
assert.equal(proof.scope, 'mcp_stored_result_recovery_general_entry');
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
const stepNames = ['build', 'new-mcp-stored-result-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
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
for (const path of [resultPath, usagePath, nextPath, sequencePath, costPath, reviewPath]) assert.ok(read(path).trim().length > 0);
const predecessorScript = { path: 'runtime/evidence/C05-mcp-update-docs.mjs', sha256: 'ca83544ad82f02fb800be0b08c70e3c0b99ab023b0b596684ae5fff844c6cd55' };
assert.equal(sha(bytes(predecessorScript.path)), predecessorScript.sha256);
const retainedEvidence = new Map([
  ['runtime/evidence/C05-mcp-linux-nas-20260907/verification.json', 'c04e4cb45e98716b5c5f003c2609c627711100a4e018cb501c5811708f0e2226'],
  ['runtime/evidence/C05-host-linux-nas-20260907/verification.json', '6ff54f755b983c007ab7a541496f64500294086f86b0ac9a21f1445b8ee3ac5f'],
  ['runtime/evidence/C04-goal-linux-nas-20260907/verification.json', '77c47342f9fd89f5593a8eb791d58f3d7eb2d9651c5b90a3610217caf23d19be'],
]);
for (const [path, digest] of retainedEvidence) assert.equal(sha(bytes(path)), digest, 'historical proof changed: ' + path);
const priorMcpPath = 'runtime/evidence/C05-mcp-linux-nas-20260907/verification.json';
assert.ok(proof.historicalEvidence.some(item => item.path === priorMcpPath && item.sha256 === retainedEvidence.get(priorMcpPath)), 'recovery proof must retain the verified MCP predecessor');
assert.deepEqual([...native.targetedFiles].sort(), ['stored-tool-results', 'stored-result-runtime', 'mcp-stored-result', 'mcp-stored-result-recovery', 'stored-result-workflow'].map(name => `dist/tests/${name}.test.js`).sort());
const number = value => value.toLocaleString('en-US'), pair = value => `${number(value)}/${number(value)}`;
const verified = `macOS Node24 신규 ${pair(localNew)}·관련 ${pair(localRelated)}, NAS Linux Node24 신규 ${pair(nativeNew)}·관련 ${pair(nativeRelated)}·전체 ${pair(nativeAll)} 통과`;
const remaining = 'C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file 연결과 PostgreSQL의 잔여 구현·검증도 남아 있다.';
const next = '다음 단위는 도구 요청을 보낸 뒤 권한이 바뀐 경우 원응답·보고된 사용량을 보존하는 경계이며 아직 제품 구현에 착수하지 않았다. 이후 서버 없는 재개, 일반 입구의 페이지·대기 복구를 연결한다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도로 측정·인수한다.';
const behavior = '검증된 원응답과 귀속 영수증이 있으면 같은 실행 시도의 수신·채택 또는 거절/정산 → 필요한 compact → 문맥 체크포인트 복원 → 이후 작업 순서로 진행한다. receive는 수신 기록, adopt는 현재 근거 채택이며 compact는 긴 대화를 정리하는 과정이다. 문맥 체크포인트는 다음 추론에 쓸 확인된 문맥의 저장본이며 미수신 결과를 대신 만들지 않는다.';
const boundary = '원 실행자와 lease(호출 유효 시간)를 바꾸지 않고 당시 응답 기록과 현재 목표·권한·출처를 검증한다. 원문 파일만 있거나 intent(호출 의도 기록)만 있으면 복원 불가로 멈추며 자동 재조회하지 않는다. 응답 시각·트랜잭션 준비 시각은 물리 commit 완료 시각이나 재시작 간 단조 시계의 증명이 아니다.';
const intro = `**단순 MCP 원응답 수신 뒤 중단 복구**를 기존 C01 담당·실행기·정산에 연결했다. ${behavior} **${verified}**. [복구 결과](${root}/${resultPath}) · [MCP 연결 사용법](${root}/${usagePath}) · [확정 증거](${root}/${proofPath}). ${boundary} 복원에는 추가 tools/call이나 논리 도구 예산을 쓰지 않고 새 답변·compact는 기존 모델 예산을 따른다. 프로필을 다시 열 때 서버 발견(tools/list)은 필요하므로 offline은 아니다. ${next} [다음 전송 후 권한 계획](${root}/${nextPath}) · [전체 MCP 후속 순서](${root}/${sequencePath}) · [조회 비용 검토](${root}/${costPath}). ${remaining}`;
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
  let text = originals.get(path); assert.ok(!text.includes('<!-- C05-MCP-RECOVERY-FINAL-PROOF:'), 'already updated: ' + path);
  const firstBreak = text.indexOf('\n\n'); assert.ok(firstBreak > 0);
  assert.ok(text.slice(firstBreak + 2).startsWith('<!-- C05-MCP-FINAL-PROOF: c04e4cb45e98716b5c5f003c2609c627711100a4e018cb501c5811708f0e2226 -->'), 'expected v0.63 introduction');
  text = text.slice(0, firstBreak + 2) + `<!-- C05-MCP-RECOVERY-FINAL-PROOF: ${proofHash} -->\n${intro}\n\n이전 v0.63 MCP 연결의 확정 결과와 복구 착수 당시 기록(아래 “다음”·미구현 표시는 당시 상태):\n` + text.slice(firstBreak + 2);
  if (path !== 'runtime/README.md') text = once(text, 'v0.63 · C05 MCP 일반 입구 연결 검증과 원응답 복구 준비',
    'v0.64 · C05 MCP 저장 응답 복구 검증과 전송 후 권한 경계 준비', path + ' version');
  if (path === 'design/README.md') {
    text = paragraph(text, '현재 goal은 지원 POSIX에서 검증한 C04 ', () => `현재 goal은 검증한 C04 일반 요청·목표 변경, C05 호스트 권한·MCP 연결과 단순 저장 응답 복구를 보존하고 [전송 후 권한 변경 경계](${root}/${nextPath})를 다음으로 구현하는 것이다. ${behavior} 원문 귀속·현재 권한·중복 없는 정산을 유지하며 서버 없는 재개·페이지와 대기 연결·[문맥 조회 비용 개선](${root}/${costPath})도 남긴다. [MCP 전체 순서](${root}/${sequencePath})를 유지하고 이 한 단위의 검증을 챕터 전체 완료로 표시하지 않는다. 실제 대상은 Linux와 Windows이며 macOS는 개발 환경이다. ${remaining} 공통 스킬을 매 단계 필수로 호출하지 않는다.`, 'current goal');
    text = paragraph(text, '[구현 현황 HTML 안내서]', () => `[구현 현황 HTML 안내서](${root}/design/secumon-review.html)의 최신 배너·실행·문맥 모듈에 저장 응답 복구와 receive·adopt 뒤 compact 순서를 반영했다. 16개 모듈·93개 용어·과거 P0~P6의 31개 작업 및 C05 MCP·호스트·C04 확정 snapshot을 보존했다. 과거 “다음” 표시는 당시 기록이며 최신 상태는 상단 결과와 통합 계획을 따른다. 이번 문서 갱신은 브라우저 렌더링·클릭 검증이 아니다.`, 'guide status');
  }
  if (path === 'design/03-migration-plan.md') {
    text = paragraph(text, '[MCP 일반 입구 연결 결과](chapters/C05-mcp-host-result.md)에서', old =>
      `[단순 MCP 저장 응답 복구 결과](chapters/C05-mcp-response-recovery-result.md)에서 ${verified}. ${behavior} ${boundary} 동일 시도의 tools/call·정산·대화를 중복하지 않으며 도구 예산이 소진된 상태에서도 저장 수신부터 처리한다. 현재 프로필 재열기는 서버 발견이 필요하다. ${next} [다음 계획](chapters/C05-mcp-sent-authority-plan.md) · [전체 후속 순서](chapters/C05-mcp-host-plan.md). ${remaining}\n\n이전 v0.63 MCP 일반 입구 연결 결과와 당시 다음 계획: ${old}`, 'C05 current unit');
  }
  updates.set(path, text);
}
const originalBacklog = JSON.parse(originals.get('design/implementation-backlog.json')), backlog = structuredClone(originalBacklog);
assert.equal(backlog.revision, 'v0.63'); backlog.revision = 'v0.64'; backlog.next_execution_chapter = 'C05';
const c05 = backlog.execution_chapters.find(chapter => chapter.id === 'C05'), originalC05 = originalBacklog.execution_chapters.find(chapter => chapter.id === 'C05');
assert.equal(c05.status, 'in_progress'); assert.equal(c05.mcp_recovery_progress, undefined);
assert.equal(c05.mcp_host_progress.proofSha256, retainedEvidence.get(c05.mcp_host_progress.currentVerification));
const progress = { status: proof.status, currentVerification: proofPath, proofSha256: proofHash, result: resultPath, usage: usagePath,
  sourceAndBuild: proof.sourceAndBuild,
  local: { platform: local.platform, newTests: localNew, relatedTests: localRelated,
    newTestNode: local.newTests.testNode, relatedTestNode: local.relatedTests.testNode, fullTests: local.fullTests.status },
  nativeLinux: { newTests: nativeNew, relatedTests: nativeRelated, tests: nativeAll, node: native.environment.node,
    finishedAt: native.finishedAt, observedOwnedProcesses: cleanup.observedOwnedProcesses, sshClosed: cleanup.sshClosed,
    inaccessiblePeers: cleanup.inaccessiblePeers.length, unresolvedPeers: cleanup.unresolved.length, globalProcessAbsenceProven: false },
  priorAttempts: proof.priorAttempts, historicalEvidence: proof.historicalEvidence,
  chapterComplete: false, goalComplete: false, realModelApi: 'paused', browser: 'not_checked_by_this_document_update',
  plainStoredResponseRecovery: 'verified_bounded_same_attempt', ordering: 'receive_and_adopt_or_reject_settle_then_required_compact_then_context_checkpoint_restore_then_following_work',
  rawOnlyIntentOnly: 'blocked_without_hidden_retry', offlineGeneralEntry: false, postSendAuthorityReceiptRecovery: 'next_unit_not_implemented',
  collectionWaitGeneralEntry: 'required_followup', clockMeaning: 'Original capture and transaction preparation observations; not physical commit completion or cross-restart monotonic time.',
  remaining, nextPlan: nextPath, mcpSequence: sequencePath, costReview: costPath };
c05.mcp_recovery_progress = progress;
c05.current_implementation = 'Authenticated plain MCP stored responses enter the original receive and adopt-or-reject/settle lifecycle, followed by required compact, context checkpoint restoration and later work. Original owner, lease, receipts and logical tool-call budget remain unchanged; artifact-only or intent-only gaps block without an automatic retry. Profile reopen still discovers the server.';
c05.nextPlan = nextPath;
backlog.next_local_work_item = { ...backlog.next_local_work_item, id: 'C05', id_kind: 'execution_chapter',
  scope: 'mcp_post_send_authority_response_and_known_usage_preservation', next_design: nextPath, cost_review: costPath,
  status: 'next_unit_planned_not_implemented', prerequisite_note: 'Confirm the reviewed sent-authority plan before implementation. Preserve verified same-attempt stored-result recovery and current source/permission checks. Response and known-usage custody after a post-send authority change is not implemented by the preceding recovery unit; offline and page/wait general-entry remain follow-ups. C05 and the overall goal remain incomplete.' };
assert.deepEqual(backlog.execution_chapters.filter(chapter => chapter.id !== 'C05'), originalBacklog.execution_chapters.filter(chapter => chapter.id !== 'C05'));
assert.deepEqual(backlog.requirements, originalBacklog.requirements);
for (const [key, value] of Object.entries(originalC05)) if (!['current_implementation', 'nextPlan'].includes(key)) assert.deepEqual(c05[key], value, 'previous C05 field changed: ' + key);
updates.set('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');

const originalHtml = originals.get('design/secumon-review.html'); let html = originalHtml;
assert.ok(!html.includes('C05-MCP-RECOVERY-FINAL-PROOF:')); assert.ok(html.includes('C05-MCP-FINAL-PROOF:') && html.includes('C05-HOST-FINAL-PROOF:') && html.includes('C04-GOAL-FINAL-PROOF:'));
function replaceHtml(pattern, replacement, label) {
  assert.equal([...html.matchAll(new RegExp(pattern.source, 'g'))].length, 1, 'HTML anchor changed: ' + label);
  html = html.replace(pattern, replacement);
}
const dataPattern = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const originalData = JSON.parse(dataPattern.exec(html)[1]), data = structuredClone(originalData);
assert.equal(data.modules.length, 16); assert.equal(data.items.length, 31); assert.equal(data.glossary.length, 93);
assert.ok(data.snapshot.c04Goal && data.snapshot.c05Host && data.snapshot.c05Mcp); assert.equal(data.snapshot.c05McpRecovery, undefined);
assert.equal(data.snapshot.c05Mcp.proofSha256, retainedEvidence.get(data.snapshot.c05Mcp.currentVerification));
data.snapshot.currentNotesAsOf = proof.recordedAt.slice(0, 10); data.snapshot.currentResults = resultPath;
data.snapshot.currentVerification = proofPath; data.snapshot.nextPlan = nextPath;
const moduleNotes = {
  execute: ['같은 원시도의 원응답·영수증을 검증해 receive(수신 기록), adopt(현재 근거 채택)를 먼저 처리한다. 실행자 owner나 lease를 바꾸지 않으며 과거 lease-only 만료 기록도 지우지 않는다.', '원문 파일만 있거나 intent만 있으면 복구 불가로 정지한다. 전송 뒤 권한 변화에서 응답·보고 usage를 먼저 보존하는 다음 경계는 아직 구현하지 않았다.'],
  tools: ['단순 읽기 도구의 선택적 restoreResult 콜백을 고정된 계약 경계에서 호출한다. 새 도구 실행이나 가짜 결과를 만들지 않고 원 artifact·영수증을 대조한다.', '이 callback은 collection·computer·write 결과의 범용 복구가 아니다. 도구 목록 선택 효율과 실제 업무 평가를 더 진행해야 한다.'],
  mcp: ['실제 로컬 peer의 원응답 artifact 게시 뒤·response 영수증 뒤·receive commit 뒤 SIGKILL을 구분했다. 새 프로필에서도 원시도·원문·known usage·정산·대화를 중복하지 않는다.', 'raw-only·intent-only는 확정 응답이 아니다. 재열기는 tools/list 발견을 수행하므로 offline이 아니며 사내 서버·인증과 페이지·대기 입구는 후속이다.'],
  context: ['수신·채택 또는 거절/정산 → 필요한 compact → 문맥 체크포인트 복원 → 이후 작업 순서를 따른다. 작은 재개 문맥 한도나 소진된 도구 예산이 이미 받은 원자료의 수신 처리를 막지 않도록 연결했다.', 'compact는 원응답 수신·근거 검증의 대체물이 아니다. 이후 compact·새 답변에는 기존 모델 예산·입력 한도를 적용하며 원문 조회 비용 개선은 별도 측정한다.'],
  budget: ['dispatch에서 이미 쓴 논리 도구 1회는 유지하고 복구 tools/call·추가 toolCalls는 0이다. 검증한 결과의 보고 사용량을 receive에 귀속하며 재접속 후 정산과 진척을 중복하지 않는다.', '아직 받지 않은 transport 사용량은 unknown이며 0으로 만들지 않는다. 전송 뒤 권한 변화 경계와 실제 모델 usage·요금은 별도 후속이다.'],
  policy: ['원 dispatch·intent·response의 순서·owner·lease·원시각, 현재 목표·계획·권한·출처를 확인한다. 취소·확정 실패·후속 시도·새 계획을 옛 원응답으로 덮지 않는다.', '동일 신뢰 clock의 관측 시각을 대조하며 물리 commit 완료나 재시작 간 단조 시계를 증명하지 않는다. 전송 후 권한 회수 처리 확대는 다음 계획이다.'],
  channels: ['기존 일반 프로필의 workflow 재개가 수신·채택을 먼저 마친 뒤 세션 답변과 전달을 이어 간다. 기존 CLI/Web의 같은 연결을 재사용하고 새 관리용 채팅 메시지를 늘리지 않는다.', '이번 갱신은 브라우저 관측이 아니다. 서버 없는 프로필 재열기·사내 인증·Knox·C06 채널 배치는 후속이다.'],
};
const previousModuleNotes = {};
for (const [id, [done, left]] of Object.entries(moduleNotes)) {
  const module = data.modules.find(item => item.id === id); assert.ok(module);
  previousModuleNotes[id] = { done: module.done, left: module.left, docs: structuredClone(module.docs) };
  module.done = `C05 현재 저장 응답 복구: ${done} ${verified}. 합성 모델·로컬 peer 계약 인수이며 묶음은 합산하지 않는다. 이전 구현 기록: ${module.done}`;
  module.left = `${left} ${remaining}`;
  module.docs = [...new Set([...module.docs, resultPath, nextPath, sequencePath, costPath])];
}
data.snapshot.c05McpRecovery = { ...progress, previousModuleNotes, retainedModuleText: 'All previous MCP/host/C04 snapshots and module notes remain historical. This bounded recovery does not complete C05.' };
const link = (path, label) => `<a href="${path}" target="_blank" rel="noopener">${label} →</a>`;
const banner = `<!-- C05-MCP-RECOVERY-FINAL-PROOF: ${proofHash} --><div class="note gap-top" id="latest-status" data-c05-mcp-recovery-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>C05 단순 MCP 저장 응답 복구</strong><br>${behavior}<br>${verified}. 합성 모델과 실제 로컬 peer의 중단·재개 계약을 확인했다.<br>원시도·owner·lease를 유지하고 tools/call·정산·대화를 중복하지 않는다. raw-only·intent-only는 복원 불가로 멈춘다. 재열기는 서버 발견이 필요해 offline은 아니다.<br>${next} ${remaining}<br>${link('chapters/C05-mcp-response-recovery-result.md', '복구 결과와 한계')} · ${link('chapters/C05-mcp-host-usage.md', '기존 MCP 사용법')} · ${link('../' + proofPath, '확정 증거')} · ${link('chapters/C05-mcp-sent-authority-plan.md', '다음 전송 후 권한 계획')} · ${link('chapters/C05-mcp-host-plan.md', 'MCP 후속 순서')} · ${link('chapters/C05-context-cost-review.md', '조회 비용 검토')}</div>`;
replaceHtml(/<!-- C05-MCP-FINAL-PROOF: [a-f0-9]{64} --><div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/,
  old => banner + '\n<details class="gap-top" data-c05-history="mcp"><summary>v0.63 MCP 연결 결과와 복구 착수 당시 기록 펼치기</summary>' + old.replace('id="latest-status"', 'id="c05-mcp-history-status"').replace('aria-label="최신 구현과 검증 상태"', 'aria-label="과거 C05 MCP 연결 구현과 검증 상태"') + '</details>', 'latest/history');
replaceHtml(/<div class="hero-aside">[\s\S]*?<\/div>/,
  '<div class="hero-aside"><span class="badge partial">C05 MCP 저장 응답 복구 검증</span><strong>받아 둔 결과부터 확인하고<br>문맥 정리와 다음 답변을 잇는다.</strong><p>receive·adopt 뒤 필요한 compact를 진행한다. 원자료 재조회는 없지만 새 프로필의 서버 발견은 필요하다. 다음은 전송 후 권한 변경 경계다.</p></div>', 'hero');
replaceHtml(/C05 MCP 연결 설명 갱신<br>/, 'C05 MCP 복구 설명 갱신<br>', 'sidebar');
replaceHtml(/<div class="note"><strong>현재 구현 순서는 C01~C10이다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note"><strong>현재 구현 순서는 C01~C10이다.</strong><br>C01 담당·설정 → C02 지속 대화·compact → C03 개인 기억 → C04 범용 대화·추론 → C05 도구·기억·스킬 효율 → C06 채널·업무 배치 → C07 게시판·아카이브 → C08 동료·반론·자원 → C09 에이전트 간 통신(A2A)·상시 임무 → C10 설치·운영.<br>${behavior} ${boundary}<br>${next} ${remaining}<br>${link('03-migration-plan.md', '통합 계획')} · ${link('implementation-backlog.json', '작업 목록')} · ${link('chapters/C05-mcp-response-recovery-result.md', '현재 복구 결과')} · ${link('chapters/C05-mcp-sent-authority-plan.md', '다음 전송 후 권한 계획')} · ${link('chapters/C05-mcp-host-plan.md', 'MCP 전체 순서')}</div>`, 'roadmap');
replaceHtml(/<div class="note gap-top"><strong>다음은 단순 MCP 원응답 수신 뒤 중단 복구이며 착수 예정이다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note gap-top"><strong>다음은 전송 뒤 권한이 바뀌어도 원응답과 보고 사용량을 잃지 않는 경계다.</strong> 제품 미착수이며 다음 계획을 검토한 뒤 구현한다. 서버 없는 재개·페이지와 대기·조회 비용 개선도 남는다. 아래 P0~P6 31개 항목은 과거 이력이다. ${remaining}</div>`, 'next unit');
replaceHtml(/최신 C05 MCP 일반 입구 연결 결과와 과거 C05 호스트 권한·C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사·목표 변경 및 P0~P6 이력을 함께 보존한다\./,
  '최신 C05 MCP 저장 응답 복구 결과와 과거 MCP 연결·호스트 권한·C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사·목표 변경 및 P0~P6 이력을 함께 보존한다.', 'footer scope');
replaceHtml(/C05 MCP 연결 설명 갱신: \d{4}\.\d{2}\.\d{2}/, 'C05 MCP 복구 설명 갱신: ' + proof.recordedAt.slice(0, 10).replaceAll('-', '.'), 'footer date');
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
console.log(JSON.stringify({ status: 'updated_from_final_proof', updated: targets, revision: 'v0.64', proof: proofPath, proofSha256: proofHash,
  localNew, localRelated, nativeNew, nativeRelated, nativeAll, nextPlan: nextPath, mcpSequence: sequencePath, costReview: costPath, predecessorScript,
  retainedEvidence: [...retainedEvidence].map(([path, sha256]) => ({ path, sha256 })),
  preservedHtml: { modules: 16, historicalItems: 31, glossary: 93, executableScripts: true, styles: true, previousSnapshots: true },
  browserRendered: false, chapterComplete: false, goalComplete: false }));
