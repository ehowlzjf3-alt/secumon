// Run once after root authorizes the final C05 host proof. Only the five listed documents are written.
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
const proofPath = 'runtime/evidence/C05-host-linux-nas-20260907/verification.json';
const resultPath = 'design/chapters/C05-host-tools-result.md';
const usagePath = 'design/chapters/C05-host-tools-usage.md';
const nextPath = 'design/chapters/C05-mcp-host-plan.md';
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
assert.equal(proof.scope, 'host_read_tools_and_execution_authority');
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
const stepNames = ['build', 'new-host-tool-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
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
const number = value => value.toLocaleString('en-US'), pair = value => `${number(value)}/${number(value)}`;
const verified = `macOS Node24 신규 ${pair(localNew)}·관련 ${pair(localRelated)}, NAS Linux Node24 신규 ${pair(nativeNew)}·관련 ${pair(nativeRelated)}·전체 ${pair(nativeAll)} 통과`;
const remaining = 'C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox, native Windows 연결·PostgreSQL·운영 배포는 미검증 또는 후속 구현 항목이다.';
const next = '다음은 기존 MCP 읽기 어댑터를 같은 담당의 보관 포트와 일반 CLI/Web에 연결하는 일이다. 다음 MCP 연결과 문맥 조회 비용 최적화는 아직 구현 완료가 아니다.';
const intro = `신뢰된 시작 프로그램이 담당별 **읽기 도구·사용자 권한·새 업무 한도**를 일반 CLI/Web에 전달하도록 연결했다. 호스트는 실행 프로그램이며 리드 에이전트를 뜻하지 않는다. 기존 도구 계약·목록·실행·원문·세션·정산을 재사용하고, 정책 축소·종료 시 낡은 결과의 사용과 이미 소비한 자원 기록을 구분한다. **${verified}**. [C05 결과](${root}/${resultPath}) · [호스트 사용법](${root}/${usagePath}) · [확정 증거](${root}/${proofPath}). ${next} [MCP 연결 계획](${root}/${nextPath}) · [문맥 조회 비용 검토](${root}/${costPath}) · [후속 검토](${root}/${reviewPath}). ${remaining}`;
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
  let text = originals.get(path); assert.ok(!text.includes('<!-- C05-HOST-FINAL-PROOF:'), 'already updated: ' + path);
  const firstBreak = text.indexOf('\n\n'); assert.ok(firstBreak > 0);
  assert.ok(text.slice(firstBreak + 2).startsWith('<!-- C04-GOAL-FINAL-PROOF:'), 'expected v0.61 introduction');
  text = text.slice(0, firstBreak + 2) + `<!-- C05-HOST-FINAL-PROOF: ${proofHash} -->\n${intro}\n\n이전 v0.61 C04 목표 변경의 확정 결과와 C05 착수 당시 기록(아래 “다음”·진행 중 표시는 당시 상태):\n` + text.slice(firstBreak + 2);
  if (path !== 'runtime/README.md') text = once(text, 'v0.61 · C04 목표 변경 검증과 C05 호스트 읽기 도구 연결 준비',
    'v0.62 · C05 호스트 읽기 도구·실행 권한 검증과 MCP 연결 준비', path + ' version');
  if (path === 'design/README.md') {
    text = paragraph(text, '현재 goal은 지원 POSIX에서 검증한 C04 ', () => `현재 goal은 지원 POSIX에서 검증한 C04 일반 요청·목표 변경과 C05 호스트 읽기 도구·실행 권한 경로를 보존하고 [기존 MCP의 일반 입구 연결](${root}/${nextPath})을 이어가는 것이다. [문맥 조회 비용 검토](${root}/${costPath})에 따라 중복 읽기는 측정 후 줄인다. 다음 단위 착수는 챕터 전체 완료를 뜻하지 않는다. PostgreSQL 등록·적합성은 C03 잔여, native Windows와 호스트 실행 격리는 C01 잔여로 유지한다. 실제 배포 대상은 Linux와 Windows이며 macOS는 개발 환경이다. 실제 모델/API 시험은 중단 상태이고 공통 스킬을 매 단계 필수로 호출하지 않는다.`, 'current goal');
    text = paragraph(text, '[구현 현황 HTML 안내서]', () => `[구현 현황 HTML 안내서](${root}/design/secumon-review.html)의 최신 배너와 관련 모듈에 C05 읽기 도구·실행 권한 결과, 다음 MCP 연결과 비용 검토를 반영했다. 16개 기능 모듈·93개 용어·과거 P0~P6의 31개 작업을 유지하고, C04의 확정 증거와 당시 다음 계획도 역사로 보존한다. 현재 상태는 상단 최신 안내와 이 README·통합 플랜을 따른다. 브라우저 렌더링·클릭을 새로 검증한 기록은 아니다.`, 'guide status');
  }
  if (path === 'design/03-migration-plan.md') {
    text = paragraph(text, '[명시 목표 변경 결과](chapters/C04-goal-change-result.md)에서', old => {
      const before = '다음은 [C05 호스트 읽기 도구·사용자·정책 연결](chapters/C05-host-tools-plan.md)이며 C04 전체 완료를 뜻하지 않는다.';
      return once(old, before, '이후 C05 호스트 읽기 도구 연결을 검증했다. 현재 후속은 아래 C05의 MCP 연결이며 C04 전체 완료를 뜻하지 않는다.', 'C04 next reference');
    }, 'C04 retained outcome');
    text = paragraph(text, '다음 단위는 [호스트 읽기 도구·사용자·정책의 일반 프로필 연결]', () => `[호스트 읽기 도구·실행 권한 결과](chapters/C05-host-tools-result.md)에서 ${verified}. 기존 세션·원문·도구 계약·정산을 재사용하고 권한 축소·종료·늦은 결과와 사용량 보존을 연결했다. [사용법](chapters/C05-host-tools-usage.md)에 따라 신뢰된 시작 프로그램이 도구와 권한을 명시한다. 다음은 [기존 MCP 읽기의 일반 입구 연결](chapters/C05-mcp-host-plan.md)이다. [문맥 조회 비용 검토](chapters/C05-context-cost-review.md)는 현재성 경계를 유지한 중복 읽기 개선 후보이며 아직 최적화 완료가 아니다. ${remaining}`, 'C05 current unit');
  }
  updates.set(path, text);
}
const backlog = JSON.parse(originals.get('design/implementation-backlog.json'));
assert.equal(backlog.revision, 'v0.61'); backlog.revision = 'v0.62'; backlog.next_execution_chapter = 'C05';
const c05 = backlog.execution_chapters.find(chapter => chapter.id === 'C05'); assert.equal(c05.status, 'in_progress');
assert.equal(c05.host_tools_progress, undefined); assert.equal(c05.entry_preparation.status, 'implementation_and_validation_in_progress');
const progress = { status: proof.status, currentVerification: proofPath, proofSha256: proofHash, result: resultPath, usage: usagePath,
  sourceAndBuild: proof.sourceAndBuild,
  local: { platform: local.platform, newTests: localNew, relatedTests: localRelated,
    newTestNode: local.newTests.testNode, relatedTestNode: local.relatedTests.testNode, fullTests: local.fullTests.status },
  nativeLinux: { newTests: nativeNew, relatedTests: nativeRelated, tests: nativeAll, node: native.environment.node,
    finishedAt: native.finishedAt, observedOwnedProcesses: cleanup.observedOwnedProcesses, sshClosed: cleanup.sshClosed,
    unresolvedPeers: cleanup.unresolved.length, globalProcessAbsenceProven: false },
  priorAttempts: proof.priorAttempts, historicalEvidence: proof.historicalEvidence,
  chapterComplete: false, goalComplete: false, realModelApi: 'paused', browser: 'not_checked_by_this_document_update',
  remaining, nextPlan: nextPath, costReview: costPath, followUpReview: reviewPath };
c05.host_tools_progress = progress;
c05.current_implementation = 'Trusted host read tools, policy and initial limits are connected to general CLI/Web; profile-scoped execution authority, shutdown/currentness and original-call usage settlement reuse the existing runtime on supported POSIX.';
c05.nextPlan = nextPath;
c05.entry_preparation = { ...c05.entry_preparation, status: 'verified_supported_local_posix_partial_chapter', result: resultPath, currentVerification: proofPath };
backlog.next_local_work_item = { ...backlog.next_local_work_item, id: 'C05', id_kind: 'execution_chapter',
  scope: 'existing_mcp_read_adapter_general_entry_and_owned_custody_ports', next_design: nextPath, cost_review: costPath,
  status: 'next_unit_planned_not_implemented', prerequisite_note: 'Reuse the verified host read-tool entry and existing MCP custody/catalog/receipt contracts. No extra state store, model framework, real API resumption or whole-chapter completion is implied.' };
const originalBacklog = JSON.parse(originals.get('design/implementation-backlog.json'));
assert.deepEqual(backlog.execution_chapters.filter(chapter => chapter.id !== 'C05'), originalBacklog.execution_chapters.filter(chapter => chapter.id !== 'C05'));
assert.deepEqual(backlog.requirements, originalBacklog.requirements);
updates.set('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');

const originalHtml = originals.get('design/secumon-review.html'); let html = originalHtml;
assert.ok(!html.includes('C05-HOST-FINAL-PROOF:')); assert.ok(html.includes('C04-GOAL-FINAL-PROOF:'));
function replaceHtml(pattern, replacement, label) {
  assert.equal([...html.matchAll(new RegExp(pattern.source, 'g'))].length, 1, 'HTML anchor changed: ' + label);
  html = html.replace(pattern, replacement);
}
const dataPattern = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const originalData = JSON.parse(dataPattern.exec(html)[1]), data = structuredClone(originalData);
assert.equal(data.modules.length, 16); assert.equal(data.items.length, 31); assert.equal(data.glossary.length, 93); assert.ok(data.snapshot.c04Goal);
data.snapshot.currentNotesAsOf = proof.recordedAt.slice(0, 10); data.snapshot.currentResults = resultPath;
data.snapshot.currentVerification = proofPath; data.snapshot.nextPlan = nextPath;
const moduleNotes = {
  tools: ['호스트가 담당별 읽기 도구를 기존 계약·목록·실행기에 연결한다. 허용 도구를 자동 추가하지 않으며 빈 등록에는 합성 도구를 보충하지 않는다.', '다음은 기존 MCP 읽기와 담당의 보관 포트 연결이다. 실제 사내 연결·동적 목록·쓰기 효과·도구 선택 비용 평가는 남아 있다.'],
  policy: ['담당·사용자 권한과 종료 신호를 현재 프로필 수명에 연결했다. 호출 직전·비동기 검증 뒤·전송·복원에서 원 정책과 현재 권한을 확인한다.', '호스트는 신뢰된 실행 프로그램이며 OS 샌드박스가 아니다. 실제 사내 인증·배치 정책·Windows 실행 격리는 별도 인수다.'],
  channels: ['같은 일반 CLI/Web에 모델 등록표와 선택적인 도구·권한 조립을 주입한다. 기존 명시 목표 변경·원문·대화·재접속·결과 표시를 재사용한다.', 'MCP 일반 입구 연결, 사내 로그인·Knox·C06 화면 및 설치 보강은 남아 있다. 실제 브라우저 렌더링·클릭과 실제 모델/API를 이번 문서 갱신으로 검증하지 않았다.'],
  guidance: ['호스트가 도구를 제공해도 skills off를 우선 적용하고 내장 지침 조회 권한을 자동 추가하지 않는다.', '업무별 지침 배치·선택·축출·재로딩과 실제 호출 비용 비교는 C05/C06 후속 범위다.'],
  context: ['기존 등록 모델 입력 창·compact·원문을 유지하며 현재 프로필 권한을 복원과 실행 경계에 연결했다.', '기존 MCP 연결 뒤 문맥 검증의 중복 조회를 측정해 개선한다. 필수 출처·권한·실행 직전 검사를 없애는 최적화는 하지 않는다. 실제 tokenizer·의미 보존·성능은 미검증이다.'],
  memory: ['기존 담당·사용자 기억 범위와 원문 출처 검사를 유지한다. 호스트 도구를 읽었다고 개인 기억에 자동 등록하지 않는다.', '문맥 조회 비용 검토는 후속 후보이며 아직 최적화 완료가 아니다. PostgreSQL·Windows·자율 경험 출처와 실제 모델 의미 품질도 남아 있다.'],
  mcp: ['일반 읽기 도구를 담당별로 조립하는 입구가 준비됐다. 기존 MCP의 원응답·영수증·페이지·대기 검증은 재사용 대상으로 유지한다.', '다음 MCP 계획은 같은 담당의 state/artifacts 등 보관 포트를 연결하는 제안이다. 이 호스트 검증만으로 실제 MCP 일반 입구·SIEM/EDR/Knox·HTTP·쓰기 연결이 완료되지는 않는다.'],
  budget: ['호스트의 새 업무 한도와 기존 업무 장부를 분리한다. 권한 축소로 본문을 쓸 수 없어도 유효한 원 호출의 사용량을 기존 영수증과 시도 기록에 보존한다.', '재접속·목표 변경은 사용량·예약·마감을 초기화하지 않는다. 실제 모델 비용·추정 오차와 운영 배정 정책은 미검증이며 후속 범위다.'],
};
const previousModuleNotes = {};
for (const [id, [done, left]] of Object.entries(moduleNotes)) {
  const module = data.modules.find(item => item.id === id); assert.ok(module);
  previousModuleNotes[id] = { done: module.done, left: module.left, docs: structuredClone(module.docs) };
  module.done = `C05 현재 연결: ${done} ${verified}. 합성 모델·로컬 자료의 계약 검증이며 묶음은 합산하지 않는다. 이전 구현 기록: ${module.done}`;
  module.left = `${left} ${remaining}`;
  module.docs = [...new Set([...module.docs, resultPath, usagePath, nextPath, costPath])];
}
data.snapshot.c05Host = { ...progress, previousModuleNotes, retainedModuleText: 'Prior module notes are retained here and in the historical prose; current module done/left fields describe only this bounded C05 unit.' };
const link = (path, label) => `<a href="${path}" target="_blank" rel="noopener">${label} →</a>`;
const banner = `<!-- C05-HOST-FINAL-PROOF: ${proofHash} --><div class="note gap-top" id="latest-status" data-c05-host-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>C05 담당별 읽기 도구·실행 권한 연결</strong><br>같은 CLI/Web·세션·원문·정산을 유지하면서 담당마다 도구와 권한을 다르게 연결한다. 호스트는 에이전트를 시작하는 프로그램이며 리드 에이전트를 뜻하지 않는다.<br>${verified}. 합성 모델과 로컬 자료로 연결 계약을 확인한 결과다.<br>다음은 기존 MCP 읽기의 일반 입구 연결과 문맥 조회 비용 검토다. 실제 모델/API 시험은 중단 상태이며 사내 연동은 미검증이다. Windows·PostgreSQL 등 잔여 범위와 C05 전체·전체 goal은 미완료다.<br>${link('chapters/C05-host-tools-result.md', '결과와 검증 한계')} · ${link('chapters/C05-host-tools-usage.md', '호스트 사용법')} · ${link('../' + proofPath, '확정 증거')} · ${link('chapters/C05-mcp-host-plan.md', '다음 MCP 계획')} · ${link('chapters/C05-context-cost-review.md', '조회 비용 검토')}</div>`;
replaceHtml(/<!-- C04-GOAL-FINAL-PROOF: [a-f0-9]{64} --><div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/,
  old => banner + '\n<details class="gap-top" data-c04-history="goal"><summary>v0.61 목표 변경 결과와 C05 착수 당시 기록 펼치기</summary>' + old.replace('id="latest-status"', 'id="c04-goal-history-status"').replace('aria-label="최신 구현과 검증 상태"', 'aria-label="과거 C04 목표 변경 구현과 검증 상태"') + '</details>', 'latest/history');
replaceHtml(/<div class="hero-aside">[\s\S]*?<\/div>/,
  '<div class="hero-aside"><span class="badge partial">C05 읽기 도구·권한 검증</span><strong>같은 본체에<br>담당별 도구와 권한을 연결한다.</strong><p>원문·세션·근거·정산은 유지한다. 다음은 기존 MCP 읽기를 같은 담당의 일반 입구에 연결하는 일이다.</p></div>', 'hero');
replaceHtml(/C04 목표 변경 설명 갱신<br>/, 'C05 호스트 도구 설명 갱신<br>', 'sidebar');
replaceHtml(/<div class="note"><strong>현재 구현 순서는 C01~C10이다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note"><strong>현재 구현 순서는 C01~C10이다.</strong><br>C01 담당·설정 → C02 지속 대화·compact → C03 개인 기억 → C04 범용 대화·추론 → C05 도구·기억·스킬 효율 → C06 채널·업무 배치 → C07 게시판·아카이브 → C08 동료·반론·자원 → C09 에이전트 간 통신(A2A)·상시 임무 → C10 설치·운영.<br>같은 업무의 목표 변경에 이어 담당별 읽기 도구·사용자 권한·새 업무 한도를 일반 CLI/Web에 연결했다. 호스트는 실행 프로그램이고 policy는 허용된 자료·도구·목적지를 정한 정책이다. 사용자 발언으로 등록이나 권한을 늘리지 않는다.<br>${next} ${remaining}<br>${link('03-migration-plan.md', '통합 계획')} · ${link('implementation-backlog.json', '작업 목록')} · ${link('chapters/C05-host-tools-result.md', '현재 C05 결과')} · ${link('chapters/C05-mcp-host-plan.md', '다음 MCP 계획')} · ${link('chapters/C05-context-cost-review.md', '비용 검토')}</div>`, 'roadmap');
replaceHtml(/<div class="note gap-top"><strong>다음은 C05 호스트 읽기 도구·사용자·정책 연결이다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note gap-top"><strong>다음은 기존 MCP 읽기의 일반 입구 연결이다.</strong> 같은 담당의 원응답·영수증·산출물 보관 포트를 기존 MCP 어댑터에 연결한다. 문맥 조회 비용은 현재성 검사를 유지하며 측정 후 개선한다. 두 후속은 아직 구현 완료가 아니며, 아래 P0~P6 31개 항목은 과거 이력이다. ${remaining}</div>`, 'next unit');
replaceHtml(/최신 C04 목표 변경 결과와 과거 C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사 및 P0~P6 이력을 함께 보존한다\./,
  '최신 C05 호스트 읽기 도구·실행 권한 결과와 과거 C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사·목표 변경 및 P0~P6 이력을 함께 보존한다.', 'footer scope');
replaceHtml(/C04 목표 변경 설명 갱신: \d{4}\.\d{2}\.\d{2}/, 'C05 호스트 도구 설명 갱신: ' + proof.recordedAt.slice(0, 10).replaceAll('-', '.'), 'footer date');
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
for (const [path, original] of originals) assert.equal(read(path), original, 'document changed before publication: ' + path);
for (const [path, updated] of updates) writeFileSync(resolve(root, path), updated);
console.log(JSON.stringify({ status: 'updated_from_final_proof', updated: targets, revision: 'v0.62', proof: proofPath, proofSha256: proofHash,
  localNew, localRelated, nativeNew, nativeRelated, nativeAll, nextPlan: nextPath, costReview: costPath,
  preservedHtml: { modules: 16, historicalItems: 31, glossary: 93, executableScripts: true, styles: true, previousSnapshots: true },
  browserRendered: false, chapterComplete: false, goalComplete: false }));
