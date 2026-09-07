// Run once after root authorizes the final goal proof. Only the five listed documents are written.
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
const proofPath = 'runtime/evidence/C04-goal-linux-nas-20260907/verification.json';
const browserPath = 'runtime/evidence/C04-goal-browser-attempt.json';
const resultPath = 'design/chapters/C04-goal-change-result.md';
const usagePath = 'design/chapters/C04-goal-change-cli-usage.md';
const nextPath = 'design/chapters/C05-host-tools-plan.md';
const targets = ['design/README.md', 'design/03-migration-plan.md', 'design/implementation-backlog.json', 'runtime/README.md', 'design/secumon-review.html'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function bytes(path) {
  assert.match(path, /^(?:runtime|design)\/[a-zA-Z0-9_./-]+$/); assert.ok(!path.split('/').includes('..'));
  const absolute = resolve(root, path), stat = lstatSync(absolute);
  assert.equal(realpathSync(absolute), absolute); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 128 * 1024 * 1024);
  return readFileSync(absolute);
}
const read = path => bytes(path).toString('utf8');
const proofText = read(proofPath), proofHash = sha(proofText), proof = JSON.parse(proofText);
assert.equal(proof.schemaVersion, 1); assert.equal(proof.chapter, 'C04');
assert.equal(proof.scope, 'explicit_general_goal_change_raw_receipts_control_and_compact');
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
const stepNames = ['build', 'new-goal-change-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
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
for (const file of ['agent-goal-change.test.js', 'agent-goal-change-cli.test.js', 'agent-goal-change-compact.test.js', 'agent-turn-web.test.js', 'web-view-state.test.js', 'complex-agent-turn.test.js'])
  assert.ok(native.targetedFiles.includes('dist/tests/' + file) && native.allTestFiles.includes('dist/tests/' + file), 'required native acceptance missing');
const browserText = read(browserPath), browserHash = sha(browserText), browser = JSON.parse(browserText);
assert.equal(browser.status, 'not_executed_host_locked'); assert.equal(browser.browser.renderChecked, false); assert.equal(browser.browser.interactiveGoalChangeChecked, false);
assert.equal(browser.syntheticServer.processAbsentObserved, true); assert.equal(browser.syntheticServer.tempDirectoryRemoved, true); assert.equal(browser.externalModelCalls, false);
for (const path of [resultPath, usagePath, nextPath]) assert.ok(read(path).trim().length > 0);
const number = value => value.toLocaleString('en-US');
const pair = value => `${number(value)}/${number(value)}`;
const verified = `macOS Node24 신규 ${pair(localNew)}·관련 ${pair(localRelated)}, NAS Linux Node24 신규 ${pair(nativeNew)}·관련 ${pair(nativeRelated)}·전체 ${pair(nativeAll)} 통과`;
const remaining = '실제 모델/API 시험은 중단 상태다. 실제 모델의 의미 판단·usage·취소·tokenizer 적합성과 native Windows runtime/file 연결·PostgreSQL·사내 연동·C08 독립 반론 협업은 남아 있다. C04 전체와 전체 goal은 미완료다.';
const next = '다음은 C05에서 호스트가 준비한 읽기 도구와 사용자·정책을 일반 담당 프로필에 연결하는 일이다. 계획은 채택됐고 구현은 아직 시작하지 않았다.';
const intro = `같은 담당·대화·업무의 **명시 목표 변경**을 일반 CLI/Web에 연결했다. 원문·근거·시도·사용량과 원래 한도를 유지하고, 같은 요청 재전송·새 입력 경합·옛 답변 무효화·compact 뒤 원문 재확인을 검증했다. **${verified}**. 앞선 복합 조사 시험도 이번 Linux 신규·전체 묶음에 포함했다. [목표 변경 결과](${root}/${resultPath}) · [CLI 사용법](${root}/${usagePath}) · [확정 증거](${root}/${proofPath}). 실제 브라우저는 호스트 잠금으로 렌더링·클릭을 확인하지 못했고 임시 서버와 담당은 정리했다. [브라우저 시도 기록](${root}/${browserPath}). ${next} [다음 계획](${root}/${nextPath}). ${remaining}`;
const originals = new Map(targets.map(path => [path, read(path)])), updates = new Map();
function once(text, before, after, label) {
  const at = text.indexOf(before); assert.ok(at >= 0 && text.indexOf(before, at + before.length) < 0, 'anchor changed: ' + label);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
for (const path of ['design/README.md', 'design/03-migration-plan.md', 'runtime/README.md']) {
  let text = originals.get(path); assert.ok(!text.includes('<!-- C04-GOAL-FINAL-PROOF:'), 'already updated: ' + path);
  const firstBreak = text.indexOf('\n\n'), firstEnd = text.indexOf('\n\n', firstBreak + 2);
  assert.ok(firstBreak > 0 && firstEnd > firstBreak); const previous = text.slice(firstBreak + 2, firstEnd);
  assert.ok(previous.startsWith('일반 요청의 복합 조사 인수에서'), 'complex history introduction changed');
  text = text.slice(0, firstBreak + 2) + `<!-- C04-GOAL-FINAL-PROOF: ${proofHash} -->\n${intro}\n\n이전 v0.60 복합 조사 로컬 인수 당시의 기록(아래 “미실행”과 “다음”도 당시 상태): ` + text.slice(firstBreak + 2);
  if (path !== 'runtime/README.md') text = once(text, 'v0.60 · C04 복합 조사 로컬 인수와 명시 목표 변경 연결', 'v0.61 · C04 목표 변경 검증과 C05 호스트 읽기 도구 연결 준비', path + ' version');
  if (path === 'design/README.md') {
    const previousGoal = text.split('\n\n').find(paragraph => paragraph.startsWith('현재 goal은 C04 일반 요청·문맥 창·등록 모델과 ')); assert.ok(previousGoal);
    text = once(text, previousGoal, `현재 goal은 지원 POSIX에서 검증한 C04 일반 요청·문맥 창·등록 모델·복합 조사·목표 변경 경로를 보존하고 [C05 호스트 읽기 도구·사용자·정책 연결](${root}/${nextPath})을 이어가는 것이다. 다음 챕터 착수는 C04 전체 완료를 뜻하지 않는다. PostgreSQL 등록·적합성은 C03 잔여, native Windows와 호스트 실행 격리는 C01 잔여로 유지한다. 실제 배포 대상은 Linux와 Windows이며 macOS는 개발 환경이다. 실제 모델/API 시험은 중단 상태이고, 공통 스킬을 매 단계 필수로 호출하지 않는다.`, 'current goal');
    const oldGuide = text.split('\n\n').find(paragraph => paragraph.startsWith('[구현 현황 HTML 안내서]')); assert.ok(oldGuide);
    text = once(text, oldGuide, `[구현 현황 HTML 안내서](${root}/design/secumon-review.html)의 최신 배너에 목표 변경 결과와 C05 다음 계획을 반영한다. 16개 기능 모듈·93개 용어와 과거 P0~P6의 31개 작업은 기존 내용을 보존하며 당시 설명 속 “다음”을 현재 미구현 항목으로 읽지 않는다. 현재 상태는 상단 최신 안내와 이 README·통합 플랜을 따른다.`, 'guide status');
  }
  if (path === 'runtime/README.md') text = once(text, '목표 변경 CLI는 이제 `change-goal', '기존 사실 조건 예제의 목표 변경 CLI는 `change-goal', 'legacy goal CLI distinction');
  if (path === 'design/03-migration-plan.md') {
    const oldC04 = text.split('\n\n').find(paragraph => paragraph.startsWith('[첫 일반 요청 연결 결과]')); assert.ok(oldC04);
    text = once(text, oldC04, `[명시 목표 변경 결과](chapters/C04-goal-change-result.md)에서 ${verified}. 복합 조사도 같은 Linux 검증에 포함했다. 원문·세션·사용량과 원래 한도를 보존하며 기존 세션 명령·영수증·현재성·응답 완료 검사를 재사용한다. 다음은 [C05 호스트 읽기 도구·사용자·정책 연결](chapters/C05-host-tools-plan.md)이며 C04 전체 완료를 뜻하지 않는다. ${remaining}\n\n이전 v0.60 C04 연결 상태와 당시 다음 계획: ` + oldC04, 'C04 current unit');
    text = once(text, '### C05 — 도구·메모리·스킬 호출과 컴퓨터 유즈 효율\n', '### C05 — 도구·메모리·스킬 호출과 컴퓨터 유즈 효율\n\n다음 단위는 [호스트 읽기 도구·사용자·정책의 일반 프로필 연결](chapters/C05-host-tools-plan.md)이다. 지원 POSIX의 C04 경로를 재사용하는 계획을 채택했고 구현은 아직 시작하지 않았다. 아래 C05 전체 범위의 완료를 뜻하지 않는다.\n', 'C05 entry plan');
  }
  updates.set(path, text);
}
const backlog = JSON.parse(originals.get('design/implementation-backlog.json'));
assert.equal(backlog.revision, 'v0.60'); backlog.revision = 'v0.61'; backlog.next_execution_chapter = 'C05';
const c04 = backlog.execution_chapters.find(chapter => chapter.id === 'C04'), c05 = backlog.execution_chapters.find(chapter => chapter.id === 'C05');
assert.equal(c04.status, 'in_progress'); assert.equal(c05.status, 'planned'); assert.equal(c04.goal_change_progress, undefined);
c04.current_implementation = 'Explicit goal changes reuse durable session commands, raw receipts, control/input/policy comparisons, prior-answer invalidation and compact recovery; complex acceptance is included in the final supported POSIX run.';
c04.nextPlan = nextPath;
c04.goal_change_progress = { status: proof.status, currentVerification: proofPath, proofSha256: proofHash, result: resultPath, usage: usagePath,
  sourceAndBuild: proof.sourceAndBuild, local: { platform: local.platform, newTests: localNew, relatedTests: localRelated,
    newTestNode: local.newTests.testNode, relatedTestNode: local.relatedTests.testNode, fullTests: local.fullTests.status },
  nativeLinux: { newTests: nativeNew, relatedTests: nativeRelated, tests: nativeAll, node: native.environment.node, finishedAt: native.finishedAt,
    complexAcceptanceIncluded: true, observedOwnedProcesses: 0, sshClosed: true, unresolvedPeers: cleanup.unresolved.length, globalProcessAbsenceProven: false },
  browser: { evidence: browserPath, sha256: browserHash, status: browser.status, renderChecked: false, interactionsChecked: false },
  priorAttempts: proof.priorAttempts, historicalEvidence: proof.historicalEvidence, chapterComplete: false, goalComplete: false,
  realModelApi: 'paused', remaining: remaining, nextPlan: nextPath };
const observation = c04.follow_up_observations.find(item => item.source === 'C02_compact_model_window_allocation'); assert.ok(observation);
observation.current_remaining = 'Model window, registered profile, complex investigation and explicit goal changes are verified with deterministic providers on supported POSIX. Real-model semantics, usage, cancellation, tokenizer and summary quality remain unverified; model/API tests stay paused. C05 starts with trusted host read tools and actor/policy composition.';
c05.nextPlan = nextPath; c05.entry_preparation = { status: 'plan_adopted_implementation_not_started', plan: nextPath, prerequisite: proofPath, wholeC04CompletionRequired: false };
const r25 = backlog.requirements.find(item => item.id === 'R25'); assert.equal(r25.implementation_status, 'not_started');
r25.implementation_status = 'in_progress';
r25.implementation_note = { implemented: '범용 메인 프롬프트·주턴 답변/질문/계획·모델 자체 검토와 복합 반증/부분 재계획을 기존 코어에 연결하고 합성 제공자로 검증했다.',
  remaining: '독립 반론 에이전트는 C08에 남으며 실제 모델 판단·의미 보존·응답 품질은 API 시험 중단으로 미검증이다. 자체 검토는 독립 근거가 아니다.',
  evidence: ['design/chapters/C04-general-turn-result.md', 'design/chapters/C04-complex-turn-result.md', resultPath], status: 'partial_implementation_not_whole_requirement_complete' };
backlog.next_local_work_item = { id: 'C05', id_kind: 'execution_chapter', scope: 'trusted_host_read_tools_actor_policy_general_profile', next_design: nextPath,
  prerequisite_note: 'Reuse the supported POSIX general entry, sessions, registered model, existing tool catalog/executor and final source checks. This next unit does not complete C04 or resume real-model/API tests.' };
updates.set('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');

const originalHtml = originals.get('design/secumon-review.html'); let html = originalHtml;
assert.ok(!html.includes('C04-GOAL-FINAL-PROOF:')); assert.ok(html.includes('C04-COMPLEX-LOCAL-PROOF:'));
function replaceHtml(pattern, replacement, label) {
  assert.equal([...html.matchAll(new RegExp(pattern.source, 'g' + (pattern.flags.includes('s') ? 's' : '')))].length, 1, 'HTML anchor changed: ' + label);
  html = html.replace(pattern, replacement);
}
const dataPattern = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const originalData = JSON.parse(dataPattern.exec(html)[1]), data = structuredClone(originalData);
assert.equal(data.modules.length, 16); assert.equal(data.items.length, 31); assert.equal(data.glossary.length, 93); assert.ok(data.snapshot.c04Complex);
data.snapshot.currentNotesAsOf = proof.recordedAt.slice(0, 10); data.snapshot.currentResults = resultPath;
data.snapshot.currentVerification = proofPath; data.snapshot.nextPlan = nextPath;
data.snapshot.c04Goal = { ...c04.goal_change_progress, nextChapter: 'C05', nextImplementationStarted: false,
  retainedModuleText: 'Existing module bodies and their historical next-step wording are preserved; this snapshot and latest status describe the current unit.' };
const link = (path, label) => `<a href="${path}" target="_blank" rel="noopener">${label} →</a>`;
const banner = `<!-- C04-GOAL-FINAL-PROOF: ${proofHash} --><div class="note gap-top" id="latest-status" data-c04-goal-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>C04 같은 업무의 목표 변경 · Linux 전체 ${pair(nativeAll)} 통과</strong><br>추가 설명·새 업무·기존 목표 교체를 구분하고, 목표를 바꾸어도 원문·근거·시도·사용량과 남은 한도를 보존한다. 버전과 마지막 적용 입력을 비교해 편집 중 새 지시를 덮어쓰지 않으며, 같은 요청 번호의 재전송은 처음 접수한 기록으로 확인한다.<br>${verified}. 복합 조사 시험도 이번 Linux 신규·전체 묶음에 포함했다. 묶음은 겹칠 수 있어 합산하지 않는다. 같은 소스·빌드 지문을 시험 전후 확인했고 macOS 전체 시험은 이번 소스에서 실행하지 않았다. Linux 필수 8단계와 원 로그 9개 회수, 관측 가능한 전용 프로세스 0·SSH 종료를 확인했다. 접근 불가능한 peer ${cleanup.inaccessiblePeers.length}개·범위 미확정 ${cleanup.unresolved.length}개를 별도 보존하므로 시스템 전체 프로세스 부재를 뜻하지 않는다.<br>일반 Web 목표 변경은 원문 입력 뒤 접수와 실행을 나눠 처리한다. 실제 브라우저는 Mac 잠금으로 화면·클릭을 확인하지 못했다. HTTP와 화면 상태 함수 시험은 실제 브라우저 관찰과 다르다. 임시 서버·담당은 정리했다.<br>${next} ${remaining}<br>아래 16개 기능 모듈·93개 용어·31개 P0~P6 작업은 기존 내용을 보존했다. 모듈 본문의 “다음 목표 변경”과 미실행 표시는 작성 당시 기록이며, 현재 결과는 이 배너·목표 변경 결과·챕터 작업 목록을 따른다. 이전 초기화 실패와 MCP 정체의 원인을 이번 통과로 확정하지 않는다.<br>${link('chapters/C04-goal-change-result.md', '목표 변경 결과')} · ${link('chapters/C04-goal-change-cli-usage.md', 'CLI 사용법')} · ${link('../' + proofPath, '최종 증거')} · ${link('../' + browserPath, '브라우저 시도')} · ${link('chapters/C05-host-tools-plan.md', '다음 C05 계획')}</div>`;
replaceHtml(/<!-- C04-COMPLEX-LOCAL-PROOF: [a-f0-9]{64} --><div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/,
  old => banner + '\n<details class="gap-top" data-c04-history="complex"><summary>v0.60 복합 조사 로컬 결과와 당시 다음 계획 펼치기</summary>' + old.replace('id="latest-status"', 'id="c04-complex-history-status"').replace('aria-label="최신 구현과 검증 상태"', 'aria-label="과거 C04 복합 조사 구현과 검증 상태"') + '</details>', 'latest/history');
replaceHtml(/<div class="hero-aside">[\s\S]*?<\/div>/,
  '<div class="hero-aside"><span class="badge partial">C04 목표 변경 검증</span><strong>같은 업무를 유지하며<br>목표를 명시적으로 바꾼다.</strong><p>원문·근거·사용량을 보존하고 오래된 답변을 현재 결과로 쓰지 않는다. 다음은 C05 호스트 읽기 도구·사용자·정책 연결이다.</p></div>', 'hero');
replaceHtml(/C04 복합 조사 설명 갱신<br>/, 'C04 목표 변경 설명 갱신<br>', 'sidebar');
replaceHtml(/<div class="note"><strong>현재 구현 순서는 C01~C10이다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note"><strong>현재 구현 순서는 C01~C10이다.</strong><br>C01 담당·설정 → C02 지속 대화·compact → C03 개인 기억 → C04 범용 대화·추론 → C05 도구·기억·스킬 효율 → C06 채널·업무 배치 → C07 게시판·아카이브 → C08 동료·반론·자원 → C09 에이전트 간 통신(A2A)·상시 임무 → C10 설치·운영.<br>지속 세션·개인 기억·등록 모델·문맥 창·복합 조사에 이어 같은 업무의 명시 목표 변경을 지원 POSIX에서 검증했다. 기본 개인 기억은 SQLite이며 문서 저장은 명시 선택한다. 각 챕터의 전체 완료를 뜻하지 않는다.<br>${next} 호스트는 에이전트를 실행하는 프로그램이고 actor는 요청 주체, policy는 허용된 자료·도구·목적지와 실행 방침이다. 도구·주체·정책은 신뢰된 시작 설정에서 준비하며 사용자 요청으로 권한을 늘리지 않는다.<br>${remaining}<br>${link('03-migration-plan.md', '통합 계획')} · ${link('implementation-backlog.json', '챕터 작업 목록')} · ${link('chapters/C04-goal-change-result.md', '현재 C04 결과')} · ${link('chapters/C05-host-tools-plan.md', '다음 구현 계획')}</div>`, 'roadmap current');
replaceHtml(/<div class="note gap-top"><strong>다음은 같은 업무의 명시 목표 변경을 일반 CLI\/Web에 연결하는 일이다\.<\/strong>[\s\S]*?<\/div>/,
  `<div class="note gap-top"><strong>다음은 C05 호스트 읽기 도구·사용자·정책 연결이다.</strong> 기존 도구 등록·목록·계약 검사·실행·현재성 검증을 재사용한다. 계획 채택과 구현 착수를 구분하며 실제 모델/API 시험을 자동 재개하지 않는다. C04 전체는 진행 중이고 아래 P0~P6 31개 항목은 당시 이력이다.</div>`, 'next unit');
replaceHtml(/최신 C04 복합 조사 로컬 인수와 과거 C02·C03·C04 첫 흐름·문맥 창·등록 모델 및 P0~P6 이력을 함께 보존한다\./,
  '최신 C04 목표 변경 결과와 과거 C02·C03·C04 첫 흐름·문맥 창·등록 모델·복합 조사 및 P0~P6 이력을 함께 보존한다.', 'footer scope');
replaceHtml(/C04 복합 조사 설명 갱신: \d{4}\.\d{2}\.\d{2}/, 'C04 목표 변경 설명 갱신: ' + proof.recordedAt.slice(0, 10).replaceAll('-', '.'), 'footer date');
replaceHtml(dataPattern, () => '<script id="review-data" type="application/json">' + JSON.stringify(data, null, 2).replaceAll('<', '\\u003c') + '</script>', 'snapshot');
const parsed = JSON.parse(dataPattern.exec(html)[1]);
for (const key of ['modules', 'items', 'glossary', 'scenarios']) assert.deepEqual(parsed[key], originalData[key], 'preserved content changed: ' + key);
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
updates.set('design/secumon-review.html', html);
assert.deepEqual([...updates.keys()].sort(), [...targets].sort());
assert.deepEqual(await verifyEvaluationBuild(runtime), proof.sourceAndBuild);
assert.equal(read(proofPath), proofText); assert.equal(read(browserPath), browserText);
for (const [path, original] of originals) assert.equal(read(path), original, 'document changed before publication: ' + path);
for (const [path, updated] of updates) writeFileSync(resolve(root, path), updated);
console.log(JSON.stringify({ status: 'updated_from_final_proof', updated: targets, revision: 'v0.61', proof: proofPath, proofSha256: proofHash,
  localNew, localRelated, nativeNew, nativeRelated, nativeAll, nextPlan: nextPath, nextImplementationStarted: false,
  preservedHtml: { modules: 16, historicalItems: 31, glossary: 93, executableScripts: true, styles: true },
  browser: browser.status, chapterComplete: false, goalComplete: false }));
