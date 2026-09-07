// Run once after root authorizes the final C05 MCP response-custody proof. Only the eight listed documents are written.
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
const proofPath = 'runtime/evidence/C05-mcp-custody-linux-nas-20260907/verification.json';
const resultPath = 'design/chapters/C05-mcp-sent-authority-result.md';
const planPath = 'design/chapters/C05-mcp-sent-authority-plan.md';
const usagePath = 'design/chapters/C05-mcp-host-usage.md';
const nextPath = 'design/chapters/C05-mcp-offline-resume-plan.md';
const nextNotesPath = 'design/chapters/C05-mcp-offline-resume-notes.md';
const sequencePath = 'design/chapters/C05-mcp-host-plan.md';
const costPath = 'design/chapters/C05-context-cost-review.md';
const reviewPath = 'design/chapters/C05-after-host-review.md';
const targets = [resultPath, planPath, usagePath, 'design/README.md', 'design/03-migration-plan.md', 'design/implementation-backlog.json', 'runtime/README.md', 'design/secumon-review.html'];
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
assert.equal(proof.scope, 'mcp_post_send_response_custody');
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
const stepNames = ['build', 'new-mcp-custody-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
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
for (const path of [resultPath, planPath, usagePath, nextPath, nextNotesPath, sequencePath, costPath, reviewPath]) assert.ok(read(path).trim().length > 0);
const predecessorScript = { path: 'runtime/evidence/C05-mcp-recovery-update-docs.mjs', sha256: '9d88db96bbfbec4ae07ea1d5ff0eba39350164bc7490e0361f5bbfd21b989985' };
assert.equal(sha(bytes(predecessorScript.path)), predecessorScript.sha256);
const retainedEvidence = new Map([
  ['runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json', 'f2fbe8a2e971f29bf182a9cf018d8122ef38b1c7996628e4e6b8da1b4e926960'],
  ['runtime/evidence/C05-mcp-linux-nas-20260907/verification.json', 'c04e4cb45e98716b5c5f003c2609c627711100a4e018cb501c5811708f0e2226'],
  ['runtime/evidence/C05-host-linux-nas-20260907/verification.json', '6ff54f755b983c007ab7a541496f64500294086f86b0ac9a21f1445b8ee3ac5f'],
  ['runtime/evidence/C04-goal-linux-nas-20260907/verification.json', '77c47342f9fd89f5593a8eb791d58f3d7eb2d9651c5b90a3610217caf23d19be'],
]);
for (const [path, digest] of retainedEvidence) assert.equal(sha(bytes(path)), digest, 'historical proof changed: ' + path);
const priorMcpPath = 'runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json';
assert.ok(proof.historicalEvidence.some(item => item.path === priorMcpPath && item.sha256 === retainedEvidence.get(priorMcpPath)), 'custody proof must retain the verified stored-result recovery predecessor');
const currentSelectionPath = 'runtime/evidence/C05-mcp-custody-new-files.json';
assert.ok(proof.files.some(item => item.path === currentSelectionPath), 'final proof must retain the actual new-file selection');
assert.deepEqual([...native.targetedFiles].sort(), [...JSON.parse(read(currentSelectionPath))].sort());
for (const name of ['mcp-response-capture', 'stored-tool-usage', 'mcp-custody-context', 'mcp-custody-runtime', 'mcp-custody-profile-close', 'mcp-custody-crash', 'stored-result-after-usage', 'stored-usage-records', 'mcp-custody-workflow', 'mcp-custody-entry'])
  assert.ok(native.targetedFiles.includes(`dist/tests/${name}.test.js`), 'missing acceptance file: ' + name);

const retainedStages = new Map([
  [
    "runtime/evidence/C05-mcp-custody-new3.json",
    "5a4799e424eb6bd1a26e075574f1f41c7af24353aed3e90d9fb21ba104cbfd85"
  ],
  [
    "runtime/evidence/C05-mcp-custody-new3.log",
    "739efd7896eb71577a295de003d4622cf5bc3d267169bcfad1a82db11d8dd297"
  ],
  [
    "runtime/evidence/C05-mcp-custody-new4.json",
    "67646d665373c82c03e2ba6943210ec83a30e763879e6e2106e0b21fe30f4f42"
  ],
  [
    "runtime/evidence/C05-mcp-custody-new4.log",
    "a43075a5899dba5a59ebbc94807e0cdddd108758952c70e309324662756fe8b7"
  ],
  [
    "runtime/evidence/C05-mcp-custody-related-entry1.json",
    "4e22871e22e387514cc171a315e463f6e3a7721e01d0a847e8d8f51c81b7642d"
  ],
  [
    "runtime/evidence/C05-mcp-custody-related-entry1.log",
    "f4ef861253a3ad87139d152311b7660633ed14e75b355a67b83fecbbd449c2a2"
  ]
]);
for (const [path, digest] of retainedStages) assert.equal(sha(bytes(path)), digest, 'historical stage changed: ' + path);

const number = value => value.toLocaleString('en-US'), pair = value => `${number(value)}/${number(value)}`;
const verified = `macOS Node24 신규 ${pair(localNew)}·관련 ${pair(localRelated)}, NAS Linux Node24 신규 ${pair(nativeNew)}·관련 ${pair(nativeRelated)}·전체 ${pair(nativeAll)} 통과`;
const remaining = 'C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file 연결의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.';
const next = '다음 구현은 MCP 서버 없는 일반 CLI·Web 재개이며 설계 확정·제품 미착수다. 호스트가 명시한 저장 전용 도구에서 기존 보관·본문 검증을 재사용하고, 새 연결이 필요한 작업은 기다리며 다른 독립 작업은 진행하는 경계를 연결한다. 일반 입구의 collection(여러 항목 수집)·페이지·대기 복구와 문맥 조회 비용 개선도 후속이며, 원문·권한의 현재성 검사를 유지한다.';
const behavior = '허용한 읽기를 보낸 뒤 권한이 바뀌어도, 실제 받은 원응답과 입증된 사용량을 원 담당·원 시도에 보관하고 정산한다. 본문을 지금 보여 주거나 근거로 채택하는 권한은 따로 검사한다. 정상 저장 결과의 수신·채택 또는 거절/정산 → 필요한 compact(긴 대화 정리) → 문맥 체크포인트 복원 → 이후 작업 순서를 유지하며, 일반 run 진입에서 사용량 보완을 한 번의 유한한 과정으로 연결했다.';
const boundary = '보관 원문은 SDK가 해석한 MCP 응답 JSON이다. sent는 로컬 전송 시도 표시이며 원격 실행·성공·과금의 증명이 아니다. 입증되지 않은 측정값은 unknown(null)으로 남긴다. 원문 파일만 있거나 intent(호출 의도 기록)만 있으면 영수증을 만들어 복구하거나 자동 재전송하지 않는다. 원문·원 영수증·owner·자료 세대를 유지하며 현재 본문 검사를 느슨하게 하지 않는다.';
const entryBoundary = '공개된 원 사용자 요청을 그대로 읽을 수 있는 재개는 보호 raw를 문맥에서 제외한 유효한 blocked 체크포인트를 반환할 수 있다. 이는 업무 완료나 보호 본문 채택이 아니다. 원 사용자 요청 자체를 읽을 수 없으면 사용량 정산 뒤에도 session_current_input_unavailable로 거절한다. GET·상태 조회·SSE는 읽기만 하며 정산은 명시 실행·명령에 연결한다.';
const costBoundary = '같은 실행 측정값과 일치하는 기존 정산 이벤트·영수증을 확인한 시도는 정산 선별에서 raw 재조회를 생략한다. 정상 null 필드가 남았다는 이유로 반복 정산하지 않는다. 이 생략은 본문·문맥의 별도 원문 검증을 없애지 않으며 성능 개선 수치는 측정하지 않았다.';
const closeBoundary = '프로필 종료는 새 실행을 막고 모델·도구 연결을 닫은 뒤 기존 pending 수신을 기본 최대 5초 마무리하고 stores를 닫는다. 이 5초는 실행기 pending 마감이며 임의 호스트 close까지 포함한 전체 종료 상한이 아니다. 취소 신호와 DB commit의 원자화, 전원 손실 내구성을 보장하지 않는다.';
const intro = `**MCP 전송 후 권한 변경의 원응답 보관·사용량 정산**을 연결했다. ${behavior} **${verified}**. [결과](${root}/${resultPath}) · [계획과 이력](${root}/${planPath}) · [MCP 사용법](${root}/${usagePath}) · [확정 증거](${root}/${proofPath}). ${boundary} 서버를 다시 발견(tools/list)하는 현재 시작 경로는 유지되므로 서버 없는 재개는 아직 아니다. ${next} [다음 구현 계획](${root}/${nextPath}) · [사전 검토 메모](${root}/${nextNotesPath}) · [MCP 전체 순서](${root}/${sequencePath}) · [조회 비용 검토](${root}/${costPath}). ${remaining}`;
const marker = `<!-- C05-MCP-CUSTODY-FINAL-PROOF: ${proofHash} -->`;
const originals = new Map(targets.map(path => [path, read(path)])), updates = new Map();
function once(text, before, after, label) {
  const at = text.indexOf(before); assert.ok(at >= 0 && text.indexOf(before, at + before.length) < 0, 'anchor changed: ' + label);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function paragraph(text, starts, replacement, label) {
  const matches = text.split('\n\n').filter(value => value.startsWith(starts));
  assert.equal(matches.length, 1, 'paragraph changed: ' + label); return once(text, matches[0], replacement(matches[0]), label);
}
function prepend(path, body, historyLabel, title) {
  let text = originals.get(path); assert.ok(!text.includes('C05-MCP-CUSTODY-FINAL-PROOF:'), 'already updated: ' + path);
  const firstBreak = text.indexOf('\n\n'); assert.ok(firstBreak > 0);
  return (title ?? text.slice(0, firstBreak)) + '\n\n' + marker + '\n' + body + '\n\n' + historyLabel + '\n\n' + text.slice(firstBreak + 2);
}
// Earlier failed logs and their pins remain independent of the final selected runs.
function historicalCounts(stage) {
  const path = `runtime/evidence/C05-mcp-custody-${stage}`, record = JSON.parse(read(path + '.json')), log = read(path + '.log');
  const values = {};
  for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...log.matchAll(new RegExp('^(?:#|ℹ)\\s+' + field + '\\s+(\\d+)\\s*$', 'gm'))];
    assert.equal(matches.length, 1); values[field] = Number(matches[0][1]);
  }
  assert.equal(record.sourceUnchanged, true); assert.equal(record.sourceBefore, record.sourceAfter);
  assert.equal(record.exitCode, stage === 'related-entry1' ? 0 : 1);
  assert.equal(record.status, stage === 'related-entry1' ? 'passed' : 'failed');
  return { stage, path, ...values, sourceAndBuild: record.buildBefore, finishedAt: record.finishedAt };
}
const history = ['new3', 'new4', 'related-entry1'].map(historicalCounts);
const historyText = history.map(item => `[${item.stage}](${root}/${item.path}.json) ${number(item.tests)}개 중 ${number(item.pass)} 통과·${number(item.fail)} 실패 ([원로그](${root}/${item.path}.log))`).join(' → ');
const finalDetail = `${intro}\n\n최종 근거의 소스 지문은 \`${proof.sourceAndBuild.sourceDigest}\`, 빌드 파일 지문은 \`${proof.sourceAndBuild.filesDigest}\`, 파일 수는 ${number(proof.sourceAndBuild.fileCount)}다. Linux 종료는 \`${native.finishedAt}\`이며 필수 8단계와 원로그 ${native.collectedFiles.length}개 회수를 확인했다. 관측 가능한 전용 root의 프로세스 ${cleanup.observedOwnedProcesses}개와 SSH 종료를 확인했지만, 읽을 수 없던 같은 UID 프로세스 ${cleanup.inaccessiblePeers.length}개·범위 미확정 ${cleanup.unresolved.length}개가 있으므로 시스템 전체 프로세스 부재를 주장하지 않는다. 로컬 전체 회귀는 이 최종 소스로 별도 실행하지 않았고 Linux 전체 결과와 구분한다.\n\n${entryBoundary}\n\n${costBoundary}\n\n${closeBoundary} 잘못된 도구 결과는 기존 invalid_tool_result로 정규화될 수 있어 모든 실패 본문을 그대로 저장한다고 표현하지 않는다. 실제 로컬 stdio peer와 C01 SQLite/file-journal의 중단·종료 계약 인수이며, 합성 모델의 정해진 답변을 실제 모델 품질로 해석하지 않는다.\n\n중간 실행 이력: ${historyText}. new3는 고정 clock 변경을 시도한 시험 준비와 미전송 예약의 not_invoked 선별 누락을 교정했다. new4의 입구 실패는 시험 서버의 기존 최대 1,000,000을 넘긴 sentinel 8675309를 867539로 고친 시험 자료 변경이며 제품 변경으로 설명하지 않는다. 이 중간 묶음을 최종 집계에 더하거나 그 소스 지문을 최종 지문으로 바꾸지 않는다. 이전 초기화·MCP 정체의 원인 미확정 범위도 이전 증거에 남긴다.\n\n아래의 “검증 중”·실패 후 대기 표시는 작성 당시 기록이다. 최종 확인 범위는 위 증거를 따르며, 당시 구현 설명과 원로그는 보존한다.`;
updates.set(resultPath, prepend(resultPath, finalDetail, '## 최초 결과 초안과 중간 검증 기록', '# C05 — MCP 전송 후 권한 변경과 원응답 보관 결과'));
updates.set(planPath, prepend(planPath, `${intro}\n\n${entryBoundary}\n\n${costBoundary}\n\n${closeBoundary}\n\n최종 지원 POSIX 계약 인수를 확인했으며 다음 서버 없는 재개는 아직 구현하지 않았다. 아래 “구현 중”·“제품 미착수”·“권고” 표현과 연결부 표는 해당 시점의 설계 및 구현 기록이다. 이번 최종 범위와 실제 한계는 [결과](${root}/${resultPath})를 따른다.`, '## 착수 및 구현 중 계획 이력'));
updates.set(usagePath, prepend(usagePath, `${intro}\n\n기존 createMcpHostTools 등록과 runAgentTurnCli/openAgentWeb 입구를 그대로 사용한다. 새 공개 recovery 명령이나 사용자 원문·HTTP가 지정하는 보관 권한은 추가하지 않았다. 실제 서버 설정은 호스트가 정한다.\n\n${entryBoundary}\n\n본문 없는 restoreUsage 증명은 원 호출 측정값만 정산한다. unknown→known은 입증된 값으로 한 번 보완하며 known→unknown은 기존 값을 유지한다. 상충하는 known 값은 합산하지 않고 거절한다. 과거 모호한 failure.sent=true를 실제 원격 실행 1회로 격상하지 않는다. 사용량만 정산한 미수신 시도는 정확한 정산 영수증까지 확인한 경우 정상 restoreResult 검사로 돌아갈 수 있으나, 이미 실패·거절된 결과는 되살리지 않는다.\n\n${costBoundary}\n\n${closeBoundary}\n\n아래 등록 예제는 바꾸지 않았다. 이전 검증 수치와 다음 계획 표시는 당시 기록이며, 현재 보관·정산과 남은 범위는 이 상단과 결과 문서를 따른다.`, '## 기존 등록 방법과 이전 검증 기록'));
for (const path of ['design/README.md', 'design/03-migration-plan.md', 'runtime/README.md']) {
  const original = originals.get(path), firstBreak = original.indexOf('\n\n');
  assert.ok(original.slice(firstBreak + 2).startsWith('<!-- C05-MCP-RECOVERY-FINAL-PROOF: f2fbe8a2e971f29bf182a9cf018d8122ef38b1c7996628e4e6b8da1b4e926960 -->'), 'expected v0.64 introduction');
  let text = prepend(path, intro, '이전 v0.64 저장 응답 복구의 확정 결과와 권한 경계 착수 당시 기록(아래 “다음”·미구현 표시는 당시 상태):');
  if (path !== 'runtime/README.md') text = once(text, 'v0.64 · C05 MCP 저장 응답 복구 검증과 전송 후 권한 경계 준비', 'v0.65 · C05 MCP 전송 후 보관·정산 검증과 서버 없는 재개 계획', path + ' version');
  if (path === 'design/README.md') {
    text = paragraph(text, '현재 goal은 검증한 C04 ', () => `현재 goal은 검증한 C04 일반 요청·목표 변경과 C05 호스트·MCP 연결·저장 결과 복구·전송 후 보관 및 정산을 보존하고, [MCP 서버 없는 일반 재개](${root}/${nextPath})의 확정 계획에 따라 다음 구현을 잇는 것이다. ${next} [전체 MCP 순서](${root}/${sequencePath})를 유지하며 이 한 단위를 챕터 전체 완료로 표시하지 않는다. 실제 대상은 Linux와 Windows이며 macOS는 개발 환경이다. ${remaining} 공통 스킬을 매 단계 필수로 호출하지 않는다.`, 'current goal');
    text = paragraph(text, '[구현 현황 HTML 안내서]', () => `[구현 현황 HTML 안내서](${root}/design/secumon-review.html)의 최신 배너·실행·도구·문맥·정산 설명에 전송 후 보관과 현재 본문 사용의 분리를 반영했다. 16개 모듈·93개 용어·과거 P0~P6의 31개 작업 및 C05 복구·MCP·호스트·C04 확정 snapshot을 보존했다. 과거 “다음” 표시는 당시 기록이다. 이번 문서 갱신은 브라우저 렌더링·클릭 검증이 아니다.`, 'guide status');
  }
  if (path === 'design/03-migration-plan.md') text = paragraph(text, '[단순 MCP 저장 응답 복구 결과](chapters/C05-mcp-response-recovery-result.md)에서', old => `[MCP 전송 후 보관·정산 결과](chapters/C05-mcp-sent-authority-result.md)에서 ${verified}. ${behavior} ${boundary} ${entryBoundary} ${costBoundary} ${next} [다음 구현 계획](chapters/C05-mcp-offline-resume-plan.md) · [사전 검토 메모](chapters/C05-mcp-offline-resume-notes.md) · [전체 후속 순서](chapters/C05-mcp-host-plan.md). ${remaining}\n\n이전 v0.64 복구 결과와 당시 다음 계획: ${old}`, 'C05 current unit');
  updates.set(path, text);
}
const originalBacklog = JSON.parse(originals.get('design/implementation-backlog.json')), backlog = structuredClone(originalBacklog);
assert.equal(backlog.revision, 'v0.64'); backlog.revision = 'v0.65'; backlog.next_execution_chapter = 'C05';
const c05 = backlog.execution_chapters.find(chapter => chapter.id === 'C05'), originalC05 = originalBacklog.execution_chapters.find(chapter => chapter.id === 'C05');
assert.equal(c05.status, 'in_progress'); assert.equal(c05.mcp_custody_progress, undefined);
assert.equal(c05.mcp_recovery_progress.proofSha256, retainedEvidence.get(c05.mcp_recovery_progress.currentVerification));
const progress = { status: proof.status, currentVerification: proofPath, proofSha256: proofHash, result: resultPath, plan: planPath, usage: usagePath,
  sourceAndBuild: proof.sourceAndBuild,
  local: { platform: local.platform, newTests: localNew, relatedTests: localRelated, newTestNode: local.newTests.testNode, relatedTestNode: local.relatedTests.testNode, fullTests: local.fullTests.status },
  nativeLinux: { newTests: nativeNew, relatedTests: nativeRelated, tests: nativeAll, node: native.environment.node, finishedAt: native.finishedAt,
    observedOwnedProcesses: cleanup.observedOwnedProcesses, sshClosed: cleanup.sshClosed, inaccessiblePeers: cleanup.inaccessiblePeers.length, unresolvedPeers: cleanup.unresolved.length, globalProcessAbsenceProven: false },
  priorAttempts: proof.priorAttempts, historicalEvidence: proof.historicalEvidence, retainedLocalStages: history,
  chapterComplete: false, goalComplete: false, realModelApi: 'paused', browser: 'not_checked_by_this_document_update',
  custody: 'same_original_attempt_bounded_decoded_response_and_proven_usage_without_current_body_authority',
  bodyRecovery: 'normal_current_authority_and_provenance_checks_unchanged', knownUsage: 'source_bound_receipt_merge_without_addition_or_unknown_promotion',
  metadataSkip: 'exact_current_execution_and_recorded_usage_receipt_only_no_raw_read_for_accounting_skip',
  ordering: 'normal_stored_settlement_then_one_bounded_usage_pass_then_required_compact_then_context_checkpoint',
  entry: 'explicit_run_or_command_only_read_views_unchanged_original_input_denial_preserved',
  rawOnlyIntentOnly: 'blocked_without_hidden_retry', offlineGeneralEntry: false, collectionWaitGeneralEntry: 'required_followup',
  pendingClose: 'executor_local_default_5_seconds_not_whole_host_close_or_atomic_commit',
  clockMeaning: 'Original capture and transaction preparation observations; not physical commit completion or cross-restart monotonic time.',
  remaining, nextPlan: nextPath, nextPlanStatus: 'plan_adopted_product_not_started', nextPlanningNotes: nextNotesPath, mcpSequence: sequencePath, costReview: costPath };
c05.mcp_custody_progress = progress;
c05.current_implementation = 'Same-attempt decoded MCP response custody and source-bound usage reconciliation survive post-send authority changes while current body adoption checks remain strict. Normal stored-result settlement precedes one bounded usage pass, compact and context restore; exact existing accounting receipts avoid redundant raw reads. Explicit CLI/Web execution can reconcile usage but cannot authorize inaccessible original session input. Profile startup still discovers providers.';
c05.nextPlan = nextPath;
backlog.next_local_work_item = { ...backlog.next_local_work_item, id: 'C05', id_kind: 'execution_chapter', scope: 'mcp_offline_general_entry_resume', next_design: nextPath, cost_review: costPath,
  status: 'next_unit_plan_adopted_product_not_started', prerequisite_note: 'Implement the adopted host-selected stored-only plan after the preceding final proof and cleanup. Reuse verified custody, accounting, normal body recovery and current original-input checks; no silent connection-failure fallback. Collection/page/wait general entry and measured context costs remain follow-ups. C05 and the overall goal remain incomplete.' };
assert.deepEqual(backlog.execution_chapters.filter(chapter => chapter.id !== 'C05'), originalBacklog.execution_chapters.filter(chapter => chapter.id !== 'C05'));
assert.deepEqual(backlog.requirements, originalBacklog.requirements);
for (const [key, value] of Object.entries(originalC05)) if (!['current_implementation', 'nextPlan'].includes(key)) assert.deepEqual(c05[key], value, 'previous C05 field changed: ' + key);
updates.set('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');
const originalHtml = originals.get('design/secumon-review.html'); let html = originalHtml;
assert.ok(!html.includes('C05-MCP-CUSTODY-FINAL-PROOF:'));
for (const prior of ['C05-MCP-RECOVERY-FINAL-PROOF:', 'C05-MCP-FINAL-PROOF:', 'C05-HOST-FINAL-PROOF:', 'C04-GOAL-FINAL-PROOF:']) assert.ok(html.includes(prior));
function replaceHtml(pattern, replacement, label) {
  assert.equal([...html.matchAll(new RegExp(pattern.source, 'g'))].length, 1, 'HTML anchor changed: ' + label); html = html.replace(pattern, replacement);
}
const dataPattern = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const originalData = JSON.parse(dataPattern.exec(html)[1]), data = structuredClone(originalData);
assert.equal(data.modules.length, 16); assert.equal(data.items.length, 31); assert.equal(data.glossary.length, 93);
assert.ok(data.snapshot.c04Goal && data.snapshot.c05Host && data.snapshot.c05Mcp && data.snapshot.c05McpRecovery); assert.equal(data.snapshot.c05McpCustody, undefined);
assert.equal(data.snapshot.c05McpRecovery.proofSha256, retainedEvidence.get(data.snapshot.c05McpRecovery.currentVerification));
data.snapshot.currentNotesAsOf = proof.recordedAt.slice(0, 10); data.snapshot.currentResults = resultPath; data.snapshot.currentVerification = proofPath; data.snapshot.nextPlan = nextPath;
const moduleNotes = {
  execute: ['전송한 원시도에 받은 값과 측정값을 보관·정산한다. 정상 본문 복구를 먼저 처리하고 일반 run 진입에서 정산 보완을 한 번의 유한 과정으로 진행한다. 새 호출이나 과거 실패 부활은 없다.', '서버 없는 일반 재개는 아직 아니다. 현재 목표·원문·권한이 맞지 않는 본문을 정산 성공만으로 채택하지 않는다.'],
  tools: ['고정된 restoreUsage는 본문 없는 측정 증명, restoreResult는 현재 사용할 수 있는 정상 본문 복구를 맡는다. 알려진 값의 충돌은 거절하고 합산하지 않는다.', '이 범위는 단순 artifact-proof 읽기다. collection·computer·write의 범용 복구로 확대하지 않는다.'],
  mcp: ['요청별 SDK 응답 관측을 보관한다. 실제 로컬 stdio peer와 C01 저장소에서 raw·response·usage commit 경계 중단 및 프로필 종료를 검증한다.', 'wire 원바이트·원격 완료·과금의 증명은 아니다. 현재 프로필 재열기는 tools/list가 필요하며 서버 없는 재개·페이지·대기는 다음 단계다.'],
  context: ['현재 읽을 수 없는 raw라도 보관 전용 증명이 있고 다른 필수 근거로 쓰이지 않을 때만 문맥에서 제외한다. 원 state·ref·digest는 유지한다.', '원 사용자 입력·필수 결과·evidence를 감출 수 없다. 사용량 정산 뒤에도 원 입력 접근이 불가하면 재개를 거절한다.'],
  budget: ['원시도의 입증된 측정값만 보완하고 known을 unknown으로 낮추지 않는다. 기존 정산 영수증과 같은 실행값이면 정산 선별의 raw 재조회를 생략한다.', 'null은 모르는 값이지 0이나 미정산 표시는 아니다. 생략 범위 밖 원문 검증·이벤트 조회 비용은 남으며 성능 개선을 측정한 것은 아니다.'],
  policy: ['현재 전송 권한·원 호출의 제한된 보관 권한·현재 본문 채택 권한을 구분한다. owner·식별·자료 세대 변경은 보관 증명에서도 거절한다.', '호스트 내부 권한이며 악성 플러그인 격리가 아니다. 취소 신호와 DB commit의 원자화·전원 내구성은 보장하지 않는다.'],
  channels: ['기존 CLI와 Web 명시 실행·명령이 원시도의 정산을 이어 처리한다. 조회·SSE는 읽기이며 공개 원 요청의 blocked 재개와 원 요청 접근 거절을 구분한다.', '이번 HTTP 계약 인수와 문서 검사는 실제 브라우저 관측이 아니다. 오프라인 시작·사내 인증·Knox·C06 배치는 후속이다.'],
};
const previousModuleNotes = {};
for (const [id, [done, left]] of Object.entries(moduleNotes)) {
  const module = data.modules.find(item => item.id === id); assert.ok(module);
  previousModuleNotes[id] = { done: module.done, left: module.left, docs: structuredClone(module.docs) };
  module.done = `C05 현재 전송 후 보관·정산: ${done} ${verified}. 합성 모델·로컬 peer 계약 인수이며 묶음은 합산하지 않는다. 이전 구현 기록: ${module.done}`;
  module.left = `${left} ${remaining}`; module.docs = [...new Set([...module.docs, resultPath, planPath, usagePath, nextPath, sequencePath, costPath])];
}
data.snapshot.c05McpCustody = { ...progress, previousModuleNotes, retainedModuleText: 'All prior recovery/MCP/host/C04 snapshots and module notes remain historical. This bounded custody unit does not complete C05.' };
const link = (path, label) => `<a href="${path}" target="_blank" rel="noopener">${label} →</a>`;
const banner = `${marker}<div class="note gap-top" id="latest-status" data-c05-mcp-custody-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>C05 MCP 전송 후 보관·정산</strong><br>${behavior}<br>${verified}. 합성 모델·실제 로컬 peer의 계약 인수이며 실제 모델 품질은 미검증이다.<br>보관·정산 성공은 보호 본문 공개나 업무 완료가 아니다. 원자료만 남은 경우 새 영수증·재전송으로 복구를 꾸미지 않는다.<br>${next} ${remaining}<br>${link('chapters/C05-mcp-sent-authority-result.md', '결과와 한계')} · ${link('chapters/C05-mcp-host-usage.md', 'MCP 사용법')} · ${link('../' + proofPath, '확정 증거')} · ${link('chapters/C05-mcp-offline-resume-plan.md', '다음 서버 없는 재개 계획')} · ${link('chapters/C05-mcp-host-plan.md', 'MCP 후속 순서')}</div>`;
replaceHtml(/<!-- C05-MCP-RECOVERY-FINAL-PROOF: [a-f0-9]{64} --><div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/,
  old => banner + '\n<details class="gap-top" data-c05-history="mcp-recovery"><summary>v0.64 저장 응답 복구 결과와 당시 다음 계획 펼치기</summary>' + old.replace('id="latest-status"', 'id="c05-mcp-recovery-history-status"').replace('aria-label="최신 구현과 검증 상태"', 'aria-label="과거 C05 MCP 저장 응답 복구 상태"') + '</details>', 'latest/history');
replaceHtml(/<div class="hero-aside">[\s\S]*?<\/div>/, '<div class="hero-aside"><span class="badge partial">C05 전송 후 보관·정산 검증</span><strong>받은 사실과 측정값은 남기고<br>본문 사용 권한은 다시 확인한다.</strong><p>같은 시도에 정산하며 중복 전송하지 않는다. 현재 원 요청을 읽을 수 없으면 재개는 거절한다. 다음은 확정 계획에 따른 서버 없는 재개 구현이다.</p></div>', 'hero');
replaceHtml(/C05 MCP 복구 설명 갱신<br>/, 'C05 MCP 보관·정산 설명 갱신<br>', 'sidebar');
replaceHtml(/<div class="note"><strong>현재 구현 순서는 C01~C10이다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note"><strong>현재 구현 순서는 C01~C10이다.</strong><br>C01 담당·설정 → C02 지속 대화·compact → C03 개인 기억 → C04 범용 대화·추론 → C05 도구·기억·스킬 효율 → C06 채널·업무 배치 → C07 게시판·아카이브 → C08 동료·반론·자원 → C09 에이전트 간 통신(A2A)·상시 임무 → C10 설치·운영.<br>${behavior} ${boundary}<br>${next} ${remaining}<br>${link('03-migration-plan.md', '통합 계획')} · ${link('implementation-backlog.json', '작업 목록')} · ${link('chapters/C05-mcp-sent-authority-result.md', '현재 보관·정산 결과')} · ${link('chapters/C05-mcp-offline-resume-plan.md', '다음 구현 계획')}</div>`, 'roadmap');
replaceHtml(/<div class="note gap-top"><strong>다음은 전송 뒤 권한이 바뀌어도 원응답과 보고 사용량을 잃지 않는 경계다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note gap-top"><strong>다음은 MCP 서버 없는 일반 재개를 구현한다.</strong> 설계 확정·제품 미착수다. collection·페이지·대기와 조회 비용 개선도 남는다. 아래 P0~P6 31개 항목은 과거 이력이다. ${remaining}</div>`, 'next unit');
replaceHtml(/최신 C05 MCP 저장 응답 복구 결과와 과거 MCP 연결·호스트 권한·C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사·목표 변경 및 P0~P6 이력을 함께 보존한다\./,
  '최신 C05 MCP 전송 후 보관·정산 결과와 과거 저장 응답 복구·MCP 연결·호스트 권한·C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사·목표 변경 및 P0~P6 이력을 함께 보존한다.', 'footer scope');
replaceHtml(/C05 MCP 복구 설명 갱신: \d{4}\.\d{2}\.\d{2}/, 'C05 MCP 보관·정산 설명 갱신: ' + proof.recordedAt.slice(0, 10).replaceAll('-', '.'), 'footer date');
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
for (const [path, digest] of retainedStages) assert.equal(sha(bytes(path)), digest, 'historical stage changed: ' + path);
for (const item of proof.files) assert.equal(sha(bytes(item.path)), item.sha256, 'evidence changed before publication: ' + item.path);
for (const [path, original] of originals) assert.equal(read(path), original, 'document changed before publication: ' + path);
for (const [path, updated] of updates) writeFileSync(resolve(root, path), updated);
console.log(JSON.stringify({ status: 'updated_from_final_proof', updated: targets, revision: 'v0.65', proof: proofPath, proofSha256: proofHash,
  localNew, localRelated, nativeNew, nativeRelated, nativeAll, nextPlan: nextPath, mcpSequence: sequencePath, costReview: costPath, predecessorScript,
  retainedStages: [...retainedStages].map(([path, sha256]) => ({ path, sha256 })),
  retainedEvidence: [...retainedEvidence].map(([path, sha256]) => ({ path, sha256 })),
  preservedHtml: { modules: 16, historicalItems: 31, glossary: 93, executableScripts: true, styles: true, previousSnapshots: true },
  browserRendered: false, chapterComplete: false, goalComplete: false }));
