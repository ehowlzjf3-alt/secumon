// Run once after root authorizes the final C05 MCP offline proof. Only the nine listed documents are written.
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
const proofPath = 'runtime/evidence/C05-mcp-offline-linux-nas-20260907/verification.json';
const resultPath = 'design/chapters/C05-mcp-offline-resume-result.md';
const planPath = 'design/chapters/C05-mcp-offline-resume-plan.md';
const usagePath = 'design/chapters/C05-mcp-offline-resume-usage.md';
const hostUsagePath = 'design/chapters/C05-mcp-host-usage.md';
const nextPath = 'design/chapters/C05-mcp-collections-entry-notes.md';
const nextNotesPath = 'design/chapters/C05-mcp-offline-resume-notes.md';
const sequencePath = 'design/chapters/C05-mcp-host-plan.md';
const costPath = 'design/chapters/C05-context-cost-review.md';
const reviewPath = 'design/chapters/C05-after-host-review.md';
const targets = [resultPath, planPath, usagePath, hostUsagePath, 'design/README.md', 'design/03-migration-plan.md', 'design/implementation-backlog.json', 'runtime/README.md', 'design/secumon-review.html'];
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
assert.equal(proof.scope, 'mcp_offline_general_resume');
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
const stepNames = ['build', 'new-mcp-offline-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
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
const predecessorScript = { path: 'runtime/evidence/C05-mcp-custody-update-docs.mjs', sha256: '0f71805addf46b2cb8b3dd91d1a8f1bcfd3cf91406ab6104c98415c8170acd51' };
assert.equal(sha(bytes(predecessorScript.path)), predecessorScript.sha256);
const predecessorPath = 'runtime/evidence/C05-mcp-custody-linux-nas-20260907/verification.json';
const retainedEvidence = new Map([[predecessorPath, '3783a0a1f5ba3a4eea5a9a2231d5def3dbaf44a163c4444b8e559642283e463c']]);
for (const [path, digest] of retainedEvidence) assert.equal(sha(bytes(path)), digest);
assert.ok(proof.historicalEvidence.some(item => item.path === predecessorPath && item.sha256 === retainedEvidence.get(predecessorPath)));
const predecessor = JSON.parse(read(predecessorPath)); assert.equal(predecessor.nativeLinux.status, 'passed');
const predecessorAll = count(predecessor.nativeLinux.tests);
const retainedStages = new Map([
  ['runtime/evidence/C05-mcp-offline-new1.json', 'a127a80e1664dd656a154b92b34fa549e173ce2fe4814fc39400028149adf655'],
  ['runtime/evidence/C05-mcp-offline-new1.log', '5ad2f6c0619695636a054a129e6324137c384f8105770d4afb38a5a99afcefda'],
  ['runtime/evidence/C05-mcp-offline-related1.json', '93e26ef9cf816d39e2f15d8eb69da6c8cf323c4699c5629f25ebb03cf0714bd7'],
  ['runtime/evidence/C05-mcp-offline-related1.log', '08df63759b86a2b396b5fa6b4851fef23a2c46960e17b2140996977e704c3021'],
]);
for (const [path, digest] of retainedStages) assert.equal(sha(bytes(path)), digest, 'retained first run changed: ' + path);
const selectionPath = 'runtime/evidence/C05-mcp-offline-new-files.json';
assert.ok(proof.files.some(item => item.path === selectionPath));
assert.deepEqual([...native.targetedFiles].sort(), [...JSON.parse(read(selectionPath))].sort());
for (const name of ['mcp-stored-only', 'mcp-stored-host-tools', 'mcp-offline-entry', 'model-tool-availability', 'tool-availability-runtime'])
  assert.ok(native.targetedFiles.includes(`dist/tests/${name}.test.js`));
// The integration cases are read from the retained native log, not inferred from a total.
const nativeNewLog = 'runtime/evidence/C05-mcp-offline-linux-nas-20260907/final/new-mcp-offline-tests.log';
assert.ok(proof.files.some(item => item.path === nativeNewLog));
const entryNames = ['real CLI child restores the original MCP response and finishes after the actual peer has stopped',
  'actual localhost HTTP preserves an uncalled wait and completes the original task after online reopen',
  'actual localhost HTTP restores the original raw response without a peer and remains complete after reopen'];
const passedNames = [...read(nativeNewLog).matchAll(/^\s*(?:ok \d+ - |✔ )(.+)$/gm)].map(match => match[1]);
for (const backend of ['sqlite', 'file-journal']) for (const name of entryNames)
  assert.ok(passedNames.some(value => value.startsWith(`${backend}: ${name}`)), 'missing actual entry pass: ' + backend + ': ' + name);
const linkedInputs = new Map();
for (const path of [resultPath, planPath, usagePath, hostUsagePath, nextPath, nextNotesPath, sequencePath, costPath, reviewPath]) {
  const text = read(path); assert.ok(text.trim()); linkedInputs.set(path, sha(text));
}
function historicalCounts(stage) {
  const path = `runtime/evidence/C05-mcp-offline-${stage}`, record = JSON.parse(read(path + '.json')), log = read(path + '.log'), values = {};
  for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...log.matchAll(new RegExp('^(?:#|ℹ)\\s+' + field + '\\s+(\\d+)\\s*$', 'gm'))];
    assert.equal(matches.length, 1); values[field] = Number(matches[0][1]);
  }
  assert.equal(record.sourceUnchanged, true); assert.equal(record.sourceBefore, record.sourceAfter);
  assert.equal(record.exitCode, stage === 'new1' ? 0 : 1); assert.equal(record.status, stage === 'new1' ? 'passed' : 'failed');
  return { stage, path, ...values, sourceAndBuild: record.buildBefore, finishedAt: record.finishedAt };
}
const history = ['new1', 'related1'].map(historicalCounts);
const number = value => value.toLocaleString('en-US'), pair = value => `${number(value)}/${number(value)}`;
const verified = `macOS Node24 신규 ${pair(localNew)}·관련 ${pair(localRelated)}, NAS Linux Node24 신규 ${pair(nativeNew)}·관련 ${pair(nativeRelated)}·전체 ${pair(nativeAll)} 통과`;
const remaining = 'C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.';
const behavior = '신뢰된 시작 프로그램이 저장 전용 모드를 명시하면 MCP 서버를 시작하거나 발견하지 않고 같은 담당의 저장 응답과 영수증을 검증해 일반 CLI·Web에서 재개한다. 새 읽기가 필요하면 연결을 기다리고, 같은 담당을 온라인으로 다시 열어 기존 목표를 이어 실행한다.';
const boundary = '저장 계약과 새 호출 가능성을 구분하며 원문·현재 권한·목표·출처 검사는 유지한다. raw 파일만 있거나 intent 영수증만 있으면 응답 영수증을 만들거나 재전송하지 않는다. 보관·사용량 정산 성공은 본문 채택이나 업무 완료의 허가가 아니다. 자동 연결 실패 fallback과 모델까지 포함한 무네트워크 실행을 뜻하지 않는다.';
const entry = 'C01 SQLite/file-journal에서 실제 로컬 stdio peer를 닫은 뒤 별도 CLI 자식 프로세스 2사례와 실제 localhost HTTP 4사례를 확인했다. HTTP는 저장 응답 복구·재열기와 미호출 작업의 연결 대기→명시 온라인 재열기를 각각 두 저장 방식에서 확인했다. 온라인 전환은 원 work/session/goal/plan/task를 보존하고 tools/call 한 번으로 완료하며, 같은 명령 재전송은 추가 호출·정산·답변을 만들지 않는다. 실제 브라우저 렌더링 시험은 아니다.';
const next = '다음 후보는 collection(여러 항목 수집)·페이지·대기의 일반 입구 연결이다. 검토 메모를 준비했으며 제품은 미착수다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도 측정·인수한다.';
const cost = '모델 dispatch의 저장 입력 artifact 읽기 1회가 추가됐고 반복 원문·이벤트 검증 비용도 남는다. 이번 결과로 성능 개선 수치를 주장하지 않는다.';
const intro = `**MCP 서버 없는 일반 재개와 명시 온라인 재열기**를 연결했다. ${behavior} **${verified}**. [결과](${root}/${resultPath}) · [계획과 이력](${root}/${planPath}) · [저장 전용 사용법](${root}/${usagePath}) · [MCP 호스트 사용법](${root}/${hostUsagePath}) · [확정 증거](${root}/${proofPath}). ${boundary} ${next} [후속 연결 메모](${root}/${nextPath}) · [전체 MCP 순서](${root}/${sequencePath}) · [조회 비용 검토](${root}/${costPath}). ${remaining}`;
const marker = `<!-- C05-MCP-OFFLINE-FINAL-PROOF: ${proofHash} -->`;
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
  const text = originals.get(path); assert.ok(!text.includes('C05-MCP-OFFLINE-FINAL-PROOF:'), 'already updated: ' + path);
  const firstBreak = text.indexOf('\n\n'); assert.ok(firstBreak > 0);
  return (title ?? text.slice(0, firstBreak)) + '\n\n' + marker + '\n' + body + '\n\n' + historyLabel + '\n\n' + text.slice(firstBreak + 2);
}
assert.ok(originals.get(resultPath).startsWith('# C05 — MCP 서버 없는 일반 재개 결과'));
assert.ok(originals.get(planPath).startsWith('# C05 — MCP 서버 없는 일반 재개 구현 계획'));
assert.ok(originals.get(usagePath).startsWith('# MCP 서버 없이 저장 응답으로 재개하기'));
const historyText = history.map(item => `[${item.stage}](${root}/${item.path}.json) ${number(item.tests)}개 중 ${number(item.pass)} 통과·${number(item.fail)} 실패 ([원로그](${root}/${item.path}.log))`).join(' → ');
const evidenceDetail = `소스 지문 \`${proof.sourceAndBuild.sourceDigest}\`, 빌드 파일 지문 \`${proof.sourceAndBuild.filesDigest}\`, 파일 수 ${number(proof.sourceAndBuild.fileCount)}의 같은 빌드에서 확인했다. Linux 종료는 \`${native.finishedAt}\`이며 필수 ${native.steps.length}단계와 원로그·결과 ${native.collectedFiles.length}개 회수, 관측 가능한 전용 root 프로세스 ${cleanup.observedOwnedProcesses}개 및 SSH 종료를 확인했다. 접근 불가 peer ${cleanup.inaccessiblePeers.length}개와 범위 미확정 ${cleanup.unresolved.length}개는 남으므로 시스템 전체 프로세스 부재를 주장하지 않는다. 최종 소스의 로컬 전체 회귀는 별도 실행하지 않았고 Linux 전체와 구분한다.`;
const historyDetail = `첫 실행 이력: ${historyText}. new1은 당시 선택 파일의 통과 기록이며, related1의 실패는 context-dispatch의 종전 늦은 거절 기대를 새 조기 취소 경계에 맞춘 회귀와 구분한다. 원 입력·정책·dispatch 부재 검사는 유지했고 HTTP 입구 인수를 추가한 뒤 최종 소스로 다시 검증했다. 첫 실행의 지문·종료·로그를 바꾸거나 최종 통과 수에 더하지 않는다. 선행 [custody 증거](${root}/${predecessorPath})의 Linux ${pair(predecessorAll)}는 당시 결과로 보존한다.`;
updates.set(resultPath, prepend(resultPath, `${intro}\n\n${entry}\n\n${evidenceDetail}\n\n${historyDetail}\n\n${cost}\n\n아래의 “진행 중”·Linux 미확정 표시는 작성 당시 초안이다. 최종 확인 범위는 이 상단의 실제 증거를 따르며 이전 진단·원로그는 보존한다.`, '## 구현 중 초안과 첫 검증 이력', '# C05 — MCP 서버 없는 일반 재개 결과'));
updates.set(planPath, prepend(planPath, `${intro}\n\n${entry}\n\n연결 대기는 새 예약·논리 호출을 소비하지 않는다. 기존 미송신 예약은 원 owner·lease까지 유지하고 만료 회수를 우선한다. 실제 송신한 실패를 reservation_expired/cancelled 문자열만으로 시도 수에서 빼지 않는 경계도 이번 인수에 포함했다.\n\n아래의 구현 예정·미수정 표시는 착수 당시 계획이다. 최종 현재 동작은 [결과](${root}/${resultPath})와 [사용법](${root}/${usagePath})을 따른다.`, '## 착수 당시 계획과 인수 항목'));
let usage = originals.get(usagePath);
usage = paragraph(usage, '2026-09-07 · **구현 중이며', () => `${marker}\n2026-09-07 · **지원 POSIX의 이번 단위 인수를 확인했다. ${verified}.** ${entry} [결과](${root}/${resultPath}) · [계획](${root}/${planPath}) · [확정 증거](${root}/${proofPath}). 아래 TypeScript 예제는 설명용 조립이며 예제 자체를 별도 실행한 결과로 확대하지 않는다.`, 'offline usage status');
usage = paragraph(usage, '일반 CLI·HTTP가 이 조건을 끝까지 지키는지는', old => `${next} [후속 연결 메모](${root}/${nextPath}) · [비용 검토](${root}/${costPath}). ${remaining} 설치 패키지의 공개 exports는 C10 후속이다.\n\n이전 사용법 초안의 검증 대기 문장(당시 기록): ${old}`, 'offline usage acceptance');
updates.set(usagePath, usage);
updates.set(hostUsagePath, prepend(hostUsagePath, `${intro}\n\n${entry}\n\n온라인 등록은 기존 config 방식, 저장 전용 등록은 mode: 'stored_only'와 origin(endpointId·protocolVersion)을 사용한다. 같은 binding·정확한 버전과 현재 정책을 호스트가 제공해야 한다. 등록 객체를 나중에 바꾸거나 CLI/HTTP가 원격 계약을 주입하지 않는다. 서버를 다시 사용할 때는 현재 앱을 닫고 online 호스트로 같은 담당을 연다.\n\n서버 발견이 필요해 재개할 수 없다는 아래 문장은 이전 온라인 전용 시작 경로의 역사다. 현재 저장 전용 모드는 발견·새 호출 없이 증명을 읽으며, 정상 수신·채택/정산 → 필요한 compact → 문맥 복원 → 이후 작업의 순서를 유지한다. 보관 권한과 현재 본문 권한, 원 입력 접근 거절, 원문 파일만 남은 중단의 제한은 그대로다. 아래 기존 등록 API 예제와 과거 수치는 보존했다.`, '## 이전 온라인 등록·보관 검증 기록과 기존 API 예제'));
for (const path of ['design/README.md', 'design/03-migration-plan.md', 'runtime/README.md']) {
  const original = originals.get(path), firstBreak = original.indexOf('\n\n');
  assert.ok(original.slice(firstBreak + 2).startsWith('<!-- C05-MCP-CUSTODY-FINAL-PROOF: ' + retainedEvidence.get(predecessorPath) + ' -->'), 'expected v0.65 introduction');
  let text = prepend(path, intro, '이전 v0.65 보관·정산의 확정 결과와 서버 없는 재개 착수 당시 기록(아래 “다음”·미구현 표시는 당시 상태):');
  if (path !== 'runtime/README.md') text = once(text, 'v0.65 · C05 MCP 전송 후 보관·정산 검증과 서버 없는 재개 계획', 'v0.66 · C05 MCP 서버 없는 재개·온라인 재열기 검증과 후속 연결 검토', path + ' version');
  if (path === 'design/README.md') {
    text = paragraph(text, '현재 goal은 검증한 C04 ', () => `현재 goal은 검증한 C04 일반 요청·목표 변경과 C05 호스트·MCP 연결·원응답 보관·정산·서버 없는 재개를 보존하고 다음 작은 미완료 단위를 잇는 것이다. ${next} [후속 연결 메모](${root}/${nextPath})와 [전체 MCP 순서](${root}/${sequencePath})를 유지한다. 실제 대상은 Linux와 Windows이며 macOS는 개발 환경이다. ${remaining} 공통 스킬을 매 단계 필수로 호출하지 않는다.`, 'current goal');
    text = paragraph(text, '[구현 현황 HTML 안내서]', () => `[구현 현황 HTML 안내서](${root}/design/secumon-review.html)의 최신 배너·실행·도구·문맥·정산 설명을 저장 전용 재개와 명시 온라인 재열기로 갱신했다. 16개 모듈·93개 용어·과거 P0~P6의 31개 작업과 기존 snapshot을 보존했다. 과거 “다음” 표시는 당시 기록이다. 이번 문서 갱신은 브라우저 렌더링·클릭 검증이 아니다.`, 'guide status');
  }
  if (path === 'design/03-migration-plan.md') text = paragraph(text, '[MCP 전송 후 보관·정산 결과](chapters/C05-mcp-sent-authority-result.md)에서', old => `[MCP 서버 없는 일반 재개 결과](chapters/C05-mcp-offline-resume-result.md)에서 ${verified}. ${behavior} ${boundary} ${next} [현재 사용법](chapters/C05-mcp-offline-resume-usage.md) · [후속 연결 메모](${root}/${nextPath}) · [MCP 전체 순서](chapters/C05-mcp-host-plan.md). ${remaining}\n\n이전 v0.65 보관·정산 결과와 당시 다음 계획: ${old}`, 'C05 current unit');
  updates.set(path, text);
}
const originalBacklog = JSON.parse(originals.get('design/implementation-backlog.json')), backlog = structuredClone(originalBacklog);
assert.equal(backlog.revision, 'v0.65'); backlog.revision = 'v0.66'; backlog.next_execution_chapter = 'C05';
const c05 = backlog.execution_chapters.find(chapter => chapter.id === 'C05'), originalC05 = originalBacklog.execution_chapters.find(chapter => chapter.id === 'C05');
assert.equal(c05.status, 'in_progress'); assert.equal(c05.mcp_offline_progress, undefined);
assert.equal(c05.mcp_custody_progress.proofSha256, retainedEvidence.get(predecessorPath));
const progress = { status: proof.status, currentVerification: proofPath, proofSha256: proofHash, result: resultPath, plan: planPath, usage: usagePath,
  sourceAndBuild: proof.sourceAndBuild,
  local: { platform: local.platform, newTests: localNew, relatedTests: localRelated, newTestNode: local.newTests.testNode, relatedTestNode: local.relatedTests.testNode, fullTests: local.fullTests.status },
  nativeLinux: { newTests: nativeNew, relatedTests: nativeRelated, tests: nativeAll, node: native.environment.node, finishedAt: native.finishedAt,
    observedOwnedProcesses: cleanup.observedOwnedProcesses, sshClosed: cleanup.sshClosed, inaccessiblePeers: cleanup.inaccessiblePeers.length, unresolvedPeers: cleanup.unresolved.length, globalProcessAbsenceProven: false },
  priorAttempts: proof.priorAttempts, historicalEvidence: proof.historicalEvidence, retainedLocalStages: history,
  chapterComplete: false, goalComplete: false, realModelApi: 'paused', browser: 'not_checked_by_this_document_update',
  offlineGeneralEntry: true, entryCases: { cli: 2, http: 4, storage: ['sqlite', 'file-journal'], evidence: nativeNewLog },
  offline: 'explicit_host_registered_stored_only_without_peer_discovery_or_new_call_not_automatic_fallback',
  onlineReopen: 'same_owner_session_work_goal_plan_task_one_real_call_then_idempotent_command',
  storedProof: 'current_authority_definition_version_original_receipts_and_artifact_proof_preserved',
  connectionWait: 'no_new_reservation_or_logical_call_existing_untransmitted_lease_preserved_expiry_first_independent_tasks_continue',
  rawOnlyIntentOnly: 'no_invented_receipt_or_retransmission', collectionWaitGeneralEntry: 'required_followup',
  nextPlan: nextPath, nextPlanStatus: 'review_notes_product_not_started', mcpSequence: sequencePath, costReview: costPath, remaining };
c05.mcp_offline_progress = progress;
c05.current_implementation = 'Explicit host stored_only registration reuses stored-response custody, usage and current body proof without opening an MCP peer. General CLI/HTTP can restore saved plain-read responses; uncalled tasks wait without new reservations, preserve existing lease expiry, and resume the same work after explicit online reopen. Current contract and authority checks remain distinct from new execution availability.';
c05.nextPlan = nextPath;
backlog.next_local_work_item = { ...backlog.next_local_work_item, id: 'C05', id_kind: 'execution_chapter', scope: 'mcp_collection_general_entry_connection', next_design: nextPath,
  status: 'next_unit_review_notes_product_not_started', cost_review: costPath,
  prerequisite_note: 'Preserve verified plain-read stored-only CLI/HTTP resume and explicit online reopen. Review bounded collection/page/wait general-entry connection next; no new contracts inferred from stored data. C05 and the overall goal remain incomplete.' };
assert.deepEqual(backlog.execution_chapters.filter(chapter => chapter.id !== 'C05'), originalBacklog.execution_chapters.filter(chapter => chapter.id !== 'C05'));
assert.deepEqual(backlog.requirements, originalBacklog.requirements);
for (const [key, value] of Object.entries(originalC05)) if (!['current_implementation', 'nextPlan'].includes(key)) assert.deepEqual(c05[key], value, 'previous C05 field changed: ' + key);
updates.set('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');
const originalHtml = originals.get('design/secumon-review.html'); let html = originalHtml;
assert.ok(!html.includes('C05-MCP-OFFLINE-FINAL-PROOF:'));
for (const prior of ['C05-MCP-CUSTODY-FINAL-PROOF:', 'C05-MCP-RECOVERY-FINAL-PROOF:', 'C05-MCP-FINAL-PROOF:', 'C05-HOST-FINAL-PROOF:', 'C04-GOAL-FINAL-PROOF:']) assert.ok(html.includes(prior));
function replaceHtml(pattern, replacement, label) {
  assert.equal([...html.matchAll(new RegExp(pattern.source, 'g'))].length, 1, 'HTML anchor changed: ' + label); html = html.replace(pattern, replacement);
}
const dataPattern = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const originalData = JSON.parse(dataPattern.exec(html)[1]), data = structuredClone(originalData);
assert.equal(data.modules.length, 16); assert.equal(data.items.length, 31); assert.equal(data.glossary.length, 93);
assert.ok(data.snapshot.c04Goal && data.snapshot.c05Host && data.snapshot.c05Mcp && data.snapshot.c05McpRecovery && data.snapshot.c05McpCustody);
assert.equal(data.snapshot.c05McpOffline, undefined); assert.equal(data.snapshot.c05McpCustody.proofSha256, retainedEvidence.get(predecessorPath));
data.snapshot.currentNotesAsOf = proof.recordedAt.slice(0, 10); data.snapshot.currentResults = resultPath; data.snapshot.currentVerification = proofPath; data.snapshot.nextPlan = nextPath;
const moduleNotes = {};
moduleNotes.execute = ['새 읽기가 필요하면 연결을 기다린다. 새 예약·논리 호출은 늘리지 않고 기존 미송신 예약은 원 유효 시간의 만료를 먼저 처리한다. 실제로 받은 응답의 수신·채택·정산은 별도 검증으로 이어간다.', '연결 대기는 실패 확정이나 완료가 아니다. 같은 담당을 명시적으로 온라인으로 열면 현재 권한·원 목표를 다시 확인한다.'];
moduleNotes.tools = ['저장 전용 도구는 원응답 검증 계약에 남고 새 모델 호출 목록·실행 검색 후보에서는 빠진다. 현재 호출 가능성은 원 definition 지문과 분리했다.', '호스트가 같은 binding·정확한 버전을 등록해야 한다. 과거 파일에서 도구를 자동 등록하거나 미등록 버전을 추측하지 않는다.'];
moduleNotes.mcp = ['명시 stored_only 모드에서는 client·서버 시작·발견 없이 단순 저장 응답을 읽는다. 실제 로컬 peer 종료 후 CLI와 HTTP 재개, HTTP의 온라인 재열기를 확인했다.', '자동 fallback이 아니다. collection·페이지·대기의 일반 입구 연결은 후속이며 실제 사내 MCP·인증·HTTP MCP 연동도 미검증이다.'];
moduleNotes.context = ['과거 결과·출처의 계약은 유지하고 새 호출 후보만 제외한다. 필수 현재 원문·정책 검사를 유지하며 수신/정산 뒤 필요한 대화 정리와 문맥 복원으로 진행한다.', '모델까지 연결이 필요 없는 실행을 보장하지 않는다. 원 입력 접근 거절을 연결 대기로 숨기지 않으며 반복 검증 비용은 별도 측정 대상이다.'];
moduleNotes.budget = ['저장 응답의 입증된 사용량을 반복 합산하지 않는다. 연결 대기로 새 도구 예약·논리 호출을 만들지 않고 기존 예산과 마감은 유지한다.', '새 답변·대화 정리에 필요한 모델 자원은 기존 한도를 따른다. 과거 sent 표시는 원격 실행·성공·과금의 증명이 아니다.'];
moduleNotes.policy = ['저장 증명의 소유·버전·원문과 현재 본문 권한을 검사한다. 현재 호출 불가를 이미 받은 응답의 보관 허가와 혼동하지 않는다.', '권한이 없는 도구의 존재를 새로 공개하지 않는다. 저장 전용 등록은 신뢰된 시작 프로그램의 선택이며 사용자 원문·HTTP의 권한 주입이 아니다.'];
moduleNotes.channels = ['기존 CLI 2사례와 localhost HTTP 4사례에서 저장 응답 복구, 연결 대기와 명시 온라인 재열기를 확인했다. 원 work·session·goal·task 및 중복 방지 기록을 유지한다.', '실제 브라우저 렌더링 인수는 아니다. collection 일반 입구, 사내 인증·Knox·C06 배치는 후속이다.'];
const previousModuleNotes = {};
for (const [id, [done, left]] of Object.entries(moduleNotes)) {
  const module = data.modules.find(item => item.id === id); assert.ok(module);
  previousModuleNotes[id] = { done: module.done, left: module.left, docs: structuredClone(module.docs) };
  module.done = `C05 현재 서버 없는 재개: ${done} ${verified}. 합성 모델·로컬 peer 계약 인수이며 묶음은 합산하지 않는다. 이전 구현 기록: ${module.done}`;
  module.left = `${left} ${remaining}`; module.docs = [...new Set([...module.docs, resultPath, planPath, usagePath, hostUsagePath, nextPath, sequencePath, costPath])];
}
data.snapshot.c05McpOffline = { ...progress, previousModuleNotes, retainedModuleText: 'All prior custody/recovery/MCP/host/C04 snapshots and module notes remain historical. This bounded plain-read offline unit does not complete C05.' };
const link = (path, label) => `<a href="${path}" target="_blank" rel="noopener">${label} →</a>`;
const banner = `${marker}<div class="note gap-top" id="latest-status" data-c05-mcp-offline-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>C05 MCP 서버 없는 재개·온라인 재열기</strong><br>${behavior}<br>${verified}. 합성 모델·실제 로컬 peer의 계약 인수이며 실제 모델 품질은 미검증이다.<br>${next} C05 전체와 전체 goal, Windows·PostgreSQL·사내 연동은 미완료다. 실제 모델/API 시험은 중단 상태다.<br>${link('chapters/C05-mcp-offline-resume-result.md', '결과와 한계')} · ${link('chapters/C05-mcp-offline-resume-usage.md', '사용법')} · ${link('../' + proofPath, '확정 증거')} · ${link('../' + nextPath, '후속 연결 메모')} · ${link('chapters/C05-context-cost-review.md', '조회 비용 검토')}</div>`;
replaceHtml(/<!-- C05-MCP-CUSTODY-FINAL-PROOF: [a-f0-9]{64} --><div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/,
  old => banner + '\n<details class="gap-top" data-c05-history="mcp-custody"><summary>v0.65 전송 후 보관·정산 결과와 당시 다음 계획 펼치기</summary>' + old.replace('id="latest-status"', 'id="c05-mcp-custody-history-status"').replace('aria-label="최신 구현과 검증 상태"', 'aria-label="과거 C05 MCP 전송 후 보관·정산 상태"') + '</details>', 'latest/history');
replaceHtml(/<div class="hero-aside">[\s\S]*?<\/div>/, '<div class="hero-aside"><span class="badge partial">C05 서버 없는 재개 검증</span><strong>저장한 응답은 확인하고<br>새 자료는 연결을 기다린다.</strong><p>신뢰된 시작 프로그램이 저장 전용 또는 온라인 모드를 고른다. 같은 담당의 목표와 원문·사용량을 유지한다. 다음은 여러 항목 수집의 일반 입구 연결 검토다.</p></div>', 'hero');
replaceHtml(/C05 MCP 보관·정산 설명 갱신<br>/, 'C05 MCP 서버 없는 재개 설명 갱신<br>', 'sidebar');
replaceHtml(/<div class="note"><strong>현재 구현 순서는 C01~C10이다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note"><strong>현재 구현 순서는 C01~C10이다.</strong><br>C01 담당·설정 → C02 지속 대화·compact → C03 개인 기억 → C04 범용 대화·추론 → C05 도구·기억·스킬 효율 → C06 채널·업무 배치 → C07 게시판·아카이브 → C08 동료·반론·자원 → C09 에이전트 간 통신(A2A)·상시 임무 → C10 설치·운영.<br>${behavior} ${boundary}<br>${next} ${remaining}<br>${link('03-migration-plan.md', '통합 계획')} · ${link('implementation-backlog.json', '작업 목록')} · ${link('chapters/C05-mcp-offline-resume-result.md', '현재 재개 결과')} · ${link('../' + nextPath, '후속 연결 메모')}</div>`, 'roadmap');
replaceHtml(/<div class="note gap-top"><strong>다음은 MCP 서버 없는 일반 재개를 구현한다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note gap-top"><strong>다음은 여러 항목 수집의 일반 입구 연결을 검토한다.</strong> ${next} 아래 P0~P6 31개 항목은 과거 이력이다. ${remaining}</div>`, 'next unit');
replaceHtml(/최신 C05 MCP 전송 후 보관·정산 결과와 과거 저장 응답 복구·MCP 연결·호스트 권한·C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사·목표 변경 및 P0~P6 이력을 함께 보존한다\./,
  '최신 C05 MCP 서버 없는 재개 결과와 과거 전송 후 보관·정산·저장 응답 복구·MCP 연결·호스트 권한·C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사·목표 변경 및 P0~P6 이력을 함께 보존한다.', 'footer scope');
replaceHtml(/C05 MCP 보관·정산 설명 갱신: \d{4}\.\d{2}\.\d{2}/, 'C05 MCP 서버 없는 재개 설명 갱신: ' + proof.recordedAt.slice(0, 10).replaceAll('-', '.'), 'footer date');
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
  const absolute = resolve(root, 'design', decodeURIComponent(href.split(/[?#]/)[0])); assert.ok(absolute.startsWith(root + '/')); checkLocalLink(absolute);
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
for (const [path, digest] of linkedInputs) assert.equal(sha(bytes(path)), digest, 'linked input changed before publication: ' + path);
for (const [path, text] of updates) if (path.endsWith('.md')) assert.deepEqual(matching(text, /```[^\n]*\n[\s\S]*?```/g), matching(originals.get(path), /```[^\n]*\n[\s\S]*?```/g), 'existing code example changed: ' + path);
for (const [path, updated] of updates) writeFileSync(resolve(root, path), updated);
console.log(JSON.stringify({ status: 'updated_from_final_proof', updated: targets, revision: 'v0.66', proof: proofPath, proofSha256: proofHash,
  localNew, localRelated, nativeNew, nativeRelated, nativeAll, nextPlan: nextPath, nextPlanStatus: 'review_notes_product_not_started',
  mcpSequence: sequencePath, costReview: costPath, predecessorScript,
  retainedStages: [...retainedStages].map(([path, sha256]) => ({ path, sha256 })),
  retainedEvidence: [...retainedEvidence].map(([path, sha256]) => ({ path, sha256 })),
  linkedInputs: [...linkedInputs].map(([path, sha256]) => ({ path, sha256 })),
  documents: targets.map(path => ({ path, beforeSha256: sha(originals.get(path)), afterSha256: sha(updates.get(path)) })),
  preservedHtml: { modules: 16, historicalItems: 31, glossary: 93, executableScripts: true, styles: true, previousSnapshots: true },
  entryCases: progress.entryCases, browserRendered: false, chapterComplete: false, goalComplete: false }));
