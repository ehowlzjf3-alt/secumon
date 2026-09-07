// Prepare only; run once after final C04 window collection/finalization. Writes only the review HTML; no tests, models, or network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

assert.equal(process.argv.length, 2, 'no arguments; run with the Node version in the current build manifest');
const runtime = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const repo = dirname(runtime);
const proofPath = 'runtime/evidence/C04-window-linux-nas-20260907/verification.json';
const htmlPath = 'design/secumon-review.html';
const resultPath = 'design/chapters/C04-context-window-result.md';
const usagePath = 'design/chapters/C04-context-window-usage.md';
const nextPath = 'design/chapters/C04-after-window-review.md';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function checkedPath(path) {
  assert.ok(typeof path === 'string' && !isAbsolute(path) && !path.split('/').includes('..'));
  assert.ok(/^(?:runtime|design)\/[a-zA-Z0-9_./-]+$/.test(path), 'known repository file required');
  const absolute = resolve(repo, path), stat = lstatSync(absolute);
  assert.equal(realpathSync(absolute), absolute, 'symlink path refused');
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  return { absolute, stat };
}
function read(path, limit = 128 * 1024 * 1024) {
  const { absolute, stat } = checkedPath(path);
  assert.ok(stat.size <= limit, 'bounded read: ' + path);
  const bytes = readFileSync(absolute);
  assert.ok(bytes.length <= limit);
  return bytes;
}
const proofBytes = read(proofPath, 8 * 1024 * 1024), proofHash = sha256(proofBytes);
const proof = JSON.parse(proofBytes.toString('utf8'));
assert.equal(proof.schemaVersion, 1);
assert.equal(proof.chapter, 'C04');
assert.equal(proof.scope, 'model_input_window_profile_inspection_bounded_compact');
assert.equal(proof.status, 'verified_supported_local_posix_partial_chapter');
assert.equal(proof.chapterComplete, false); assert.equal(proof.goalComplete, false);
assert.ok(Number.isFinite(Date.parse(proof.recordedAt)));
const pin = proof.sourceAndBuild;
for (const field of ['sourceDigest', 'filesDigest']) assert.match(pin[field], /^[a-f0-9]{64}$/);
assert.ok(Number.isSafeInteger(pin.fileCount) && pin.fileCount > 0);
assert.deepEqual(await verifyEvaluationBuild(runtime), pin);
const native = proof.nativeLinux, local = proof.local;
assert.equal(local.platform, 'darwin', 'this guide update expects the recorded macOS local run');
assert.equal(local.nodeScope, 'finalization_process_only');
for (const key of ['newTests', 'relatedTests']) {
  assert.equal(local.testNodeVersions[key], local[key].testNode); assert.match(local[key].testNode, /^v24\./);
  assert.equal(local[key].sourceObservation.kind, 'per_run_source_and_build_verification');
  assert.equal(local[key].sourceObservation.perRunBeforeCaptured, true);
  assert.deepEqual(local[key].sourceObservation.before, pin); assert.deepEqual(local[key].sourceObservation.after, pin);
  assert.equal(local[key].timestampMeaning, 'child_exit_then_log_close_observed_by_stage_runner');
  assert.equal(local[key].exactFinishedAtCaptured, false);
}
assert.equal(local.build.status, 'current_build_manifest_verified');
assert.deepEqual(local.build.sourceAndBuild, pin);
const manifestBytes = read('runtime/dist/build-manifest.json', 8 * 1024 * 1024);
assert.equal(sha256(manifestBytes), local.build.manifestSha256);
assert.deepEqual(JSON.parse(manifestBytes.toString('utf8')), local.build.manifestSnapshot);
assert.equal(process.version, local.build.node, 'use the actual current build runtime');
assert.equal(local.fullTests.status, 'not_run_for_this_final_source_locally');
assert.equal(native.status, 'passed'); assert.equal(native.environment.platform, 'linux');
assert.match(native.environment.node, /^v24\./);
assert.deepEqual(native.sourceAndBuild, pin);
assert.ok(Number.isFinite(Date.parse(native.finishedAt)));
function counts(value) {
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0);
  assert.ok(value.tests > 0); assert.equal(value.pass, value.tests);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo', 'timeoutFailures']) assert.equal(value[key], 0);
  return { tests: value.tests, pass: value.pass, fail: value.fail, cancelled: value.cancelled, skipped: value.skipped, todo: value.todo };
}
const localNew = counts(local.newTests.tests), localRelated = counts(local.relatedTests.tests);
for (const item of [local.newTests, local.relatedTests]) assert.deepEqual(item.sourceAndBuild, pin);
const nativeNew = counts(native.newTests), nativeRelated = counts(native.relatedTests), nativeAll = counts(native.tests);
const stepNames = ['build', 'new-context-window-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
assert.deepEqual(native.steps.map(step => step.name), stepNames);
for (const step of native.steps) {
  assert.equal(step.status, 'passed'); assert.equal(step.exitCode, 0); assert.equal(step.signal, null);
  assert.equal(step.timedOut, false); assert.equal(step.terminationReason, null); assert.equal(step.nodeTestTimeoutFailures, 0);
  assert.equal(step.groupAbsentConfirmed, true); assert.equal(step.finalGroupState, 'absent');
  assert.equal(step.logFlushCompleted, true); assert.deepEqual(step.errors, []);
}
assert.equal(native.cleanup.observedOwnedProcesses, 0); assert.equal(native.cleanup.sshClosed, true);
assert.equal(native.cleanup.globalProcessAbsenceProven, false); assert.deepEqual(native.cleanup.auditErrors, []);
assert.ok(Array.isArray(native.cleanup.inaccessiblePeers) && Array.isArray(native.cleanup.unresolved));
assert.equal(proof.recovery.powerLossTested, false);
const evidenceHashes = new Map(proof.files.map(item => [item.path, item.sha256]));
assert.equal(evidenceHashes.size, proof.files.length);
function verifyEvidence(path, expected = evidenceHashes.get(path)) {
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'recorded evidence hash required: ' + path);
  assert.equal(sha256(read(path)), expected, 'evidence changed: ' + path);
}
assert.equal(native.collectedFiles.length, stepNames.length + 1);
assert.deepEqual(native.collectedFiles.map(item => item.file).sort(), ['result.json', ...stepNames.map(name => name + '.log')].sort());
for (const item of native.collectedFiles) {
  const path = 'runtime/evidence/C04-window-linux-nas-20260907/final/' + item.file;
  assert.equal(evidenceHashes.get(path), item.sha256); verifyEvidence(path, item.sha256);
}
for (const item of [local.newTests, local.relatedTests]) { verifyEvidence(item.result); verifyEvidence(item.log); }
for (const path of [resultPath, usagePath, nextPath]) checkedPath(path);

const original = read(htmlPath, 2 * 1024 * 1024).toString('utf8');
assert.ok(!original.includes('C04-WINDOW-FINAL-PROOF:'), 'window guide already updated; review explicitly instead of overwriting');
assert.ok(original.includes('C04-TURN-FINAL-PROOF:'), 'first-flow history must already exist');
let html = original;
function replaceOnce(pattern, replacement, label) {
  const matches = [...html.matchAll(new RegExp(pattern.source, 'g' + (pattern.flags.includes('s') ? 's' : '')))];
  assert.equal(matches.length, 1, 'HTML anchor changed: ' + label);
  html = html.replace(pattern, replacement);
}
const dataPattern = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const originalData = JSON.parse(dataPattern.exec(original)?.[1] ?? 'null');
assert.ok(originalData && originalData.modules.length === 16 && originalData.items.length === 31 && originalData.snapshot.c04);
assert.equal(originalData.snapshot.c04Window, undefined);
const data = structuredClone(originalData);
const count = n => n.toLocaleString('en-US');
const passed = c => `${count(c.pass)} / ${count(c.tests)}`;
const localText = `macOS 신규 ${passed(localNew)}·관련 ${passed(localRelated)}`;
const linuxText = `Linux ${native.environment.node} 신규 ${passed(nativeNew)}·관련 ${passed(nativeRelated)}·전체 ${passed(nativeAll)}`;
const verifiedText = `${localText}, ${linuxText} 통과. 시험 묶음은 겹칠 수 있어 합산하지 않는다. 로컬 신규·관련 시험은 각각 ${local.newTests.testNode}·${local.relatedTests.testNode}에서 실행했고 시험 전후 소스·빌드 지문이 같다. 종료 시각은 시험 프로세스 종료 후 로그 파일 닫힘을 관측한 시각이다. 이번 소스의 macOS 전체 시험은 실행하지 않았다. 합성 시험의 통과와 실행 시간은 실제 모델의 품질·속도·토큰 절감 측정이 아니다.`;
const paths = (...names) => names.map(name => 'runtime/src/' + name);
const updates = {
  work: {
    done: 'C04 첫 요청·답변 연결 당시의 검증 기록: ' + originalData.modules.find(module => module.id === 'work').done
  },
  memory: {
    left: originalData.modules.find(module => module.id === 'memory').left.replace(
      'C03 전체와 전체 목표는 미완료이며 C04 범용 대화 연결은 다음 작업이다.',
      'C03 전체와 전체 목표는 미완료다. C04 범용 대화·문맥 창을 연결했으며 다음은 등록 모델 프로필을 일반 실행 입구에 연결하는 일이다. 실제 모델/API 시험은 중단 상태다.')
  },
  context: {
    summary: '현재 상태와 사용자 원문을 지키고, 모델 입력 창에 맞춰 과거 대화의 정리 범위를 고른다.',
    why: '계속 이어지는 대화가 모델의 한 번 입력 공간을 넘을 수 있다. 필요한 내용부터 보호하면서 과거 대화를 줄일 수 있는 경우와 줄여도 해결되지 않는 경우를 구분해야 한다.',
    how: [
      ...originalData.modules.find(module => module.id === 'context').how,
      '문맥 창(context window)은 모델 호출 한 번에 들어가는 입력과 출력의 총 공간이다. 입력 허용량과 전송 바이트 한도를 따로 보고 답변 공간도 먼저 남긴다. 답변 공간을 몰래 줄여 입력을 끼워 넣지 않는다.',
      '먼저 목표·가설·반론·미완료 의무·현재 사용자 원문·필수 도구 등 반드시 필요한 구성을 측정한다. 선택된 개인 기억과 이전 답변 초안도 포함한다. 이것만으로 초과하면 대화를 버리거나 불필요한 요약 호출을 만들지 않고 이유를 남겨 멈춘다.',
      '검사(inspect)는 문맥의 현재 버전을 가리키는 표지(head)·문맥 파일·업무 상태를 게시하지 않는다. 미리보기(preview)는 크기를 가늠하는 준비이며 모델 호출도 아니다. 실제 사용 단계(materialize)에서 원문과 상태를 재확인하고 게시한 최종 입력을 다시 측정한다.',
      '과거 대화 때문에 초과하면 완전한 앞부분 구간을 절반씩 줄여 최대 9개 후보를 로컬에서 측정한다. 선택된 한 구간만 기존 compact 호출로 예약한다. 현재 입력은 원문으로 남기며 발언 중간을 잘라 조용히 버리지 않는다.',
      '기존 도구 선택의 전체 설명·참조·생략을 재사용한다. 입력 추정기의 오류나 권한·원문 오류를 용량 부족으로 바꾸어 compact하지 않는다. 추정값은 실제 모델이 보고한 사용량과 다르다.',
      '새 호출은 모델·한도·추정기 설정의 지문을 저장한다. 보내기 전에 설정이 바뀌면 예약을 취소하고 다시 준비한다. 이미 받은 응답은 한도 설정만 바뀌었다는 이유로 버리지 않으며, 이미 정해진 도구 실행·완료 답변 전달도 새 모델 창 검사로 막지 않는다.'
    ],
    done: `기존 지속 세션·원문·요약·최근 발언을 재사용해 입력 한도 계산, 무쓰기 검사, 필수 상태 보호, 제한된 구간 선택과 호출 설정 변경 검사를 연결했다. 두 업무 장부의 반복 자동 compact·답변·재시작, 요약 경합과 compact 전용 배치도 합성 규칙으로 검증했다. ${verifiedText}`,
    left: '다음은 등록된 모델 프로필을 CLI·Web 실행 입구에 연결하는 단위이며 아직 미구현이다. 프로필은 모델 선택·한도·추정기 버전을 묶은 설정이다. 현재 합성 규칙을 임의 자연어를 이해하는 실제 모델로 해석하면 안 된다. 모델별 토큰 계산기(tokenizer)의 정확도·의미 보존·반론 누락·성능은 미검증이며 API 시험 중단을 유지한다.',
    example: '현재 지시와 필수 상태는 들어가지만 오래된 대화까지 넣으면 넘치는 경우, 들어갈 앞부분만 먼저 요약한다. 현재 지시 자체가 너무 크면 지시를 잘라내지 않고 입력 한도 문제를 알린다.',
    files: paths('application/context-compiler.ts', 'application/session-compactor.ts', 'application/planning-runtime.ts',
      'application/model-input-budget.ts', 'application/model-input-profile.ts', 'application/workflow-runtime.ts'),
    extraTerms: ['contextWindow', 'inputEstimator', 'preview', 'profileDigest'],
    extraDocs: [resultPath, usagePath, nextPath]
  },
  budget: {
    summary: '업무에 배정한 실행 자원과 모델 한 번의 문맥 공간을 따로 관리한다.',
    why: '잔여 호출 몫이 충분해도 입력 창은 넘칠 수 있다. 문맥 크기와 실제 사용량을 같은 값으로 처리하면 필요 없는 요약이나 잘못된 반환이 생긴다.',
    how: [
      ...originalData.modules.find(module => module.id === 'budget').how,
      '문맥 창은 모델 한 번의 입력·출력 공간이고, 실행 자원 장부는 업무에 쓸 수 있는 호출·토큰 등의 몫이다. 자원을 추가 배정해도 모델의 물리적인 문맥 창이 넓어지는 것은 아니다.',
      '입력 추정은 송신 가능 여부와 예약을 위한 계산이다. 실제 사용량은 저장된 모델 응답을 통해 정산한다. compact 후보를 로컬에서 여러 번 측정해도 그만큼 모델을 호출한 것은 아니다.',
      '예약 후 입력 설정이 바뀌면 미송신 예약은 취소·반환하고 새로 준비한다. 응답이 이미 왔다면 설정 변경만으로 그 응답과 사용량을 버리지 않는다. 이 장부의 종료가 담당 에이전트의 대화 문맥 폐기를 뜻하지 않는다.'
    ],
    done: originalData.modules.find(module => module.id === 'budget').done + ' C04 창 관리에서는 같은 기존 장부를 사용해 송신 전 설정 변경의 취소·반환과 응답 저장 뒤의 채택·정산 보존을 검증했다. 문맥 한도와 소비 한도는 별도 계산한다.',
    left: originalData.modules.find(module => module.id === 'budget').left + ' 실제 모델의 추정 오차·소비 비용과 운영 배정 정책은 이번 합성 시험으로 검증하지 않았다.',
    example: '업무에 호출 20회가 남아 있어도 한 호출의 입력이 모델 창을 넘으면 바로 보내지 않는다. 대화 정리가 가능한지 먼저 판단하고 실제 송신한 호출만 기존 장부로 처리한다.',
    files: [...originalData.modules.find(module => module.id === 'budget').files, ...paths('application/model-input-budget.ts', 'application/model-input-profile.ts', 'application/planning-runtime.ts')],
    extraTerms: ['contextWindow', 'inputEstimator', 'tokens'],
    extraDocs: [resultPath, usagePath]
  }
};
const newTerms = [
  { id: 'contextWindow', en: 'Context window / contextWindowTokens', ko: '모델 한 번의 입력·출력 공간',
    definition: '모델 호출 한 번이 처리할 수 있는 입력과 출력의 총 범위. 이번 답변을 작성할 공간을 빼고 입력 한도와 함께 비교한다. 업무에 배정한 소비 자원과 별개다.',
    example: '총 공간 10,000단위에서 출력 2,000단위를 남기면 입력은 최대 8,000단위이고, 별도 입력 한도가 더 작으면 그 한도를 따른다.', module: 'context' },
  { id: 'inputEstimator', en: 'Input estimator / inputEstimation', ko: '입력 크기 추정기',
    definition: '프롬프트·도구 설명·대화 등 실제 전송 형태의 크기를 보내기 전에 계산하는 방법과 버전. 정확한 모델 토큰 계산기 또는 보수적인 추정법일 수 있으며 실제 사용량 보고와 구분한다.',
    example: '한국어 글자 수만 세지 않고 모델별 입력 포장까지 포함해 크기를 가늠한다. 합성 추정기의 통과가 실제 모델 정확도를 증명하지는 않는다.', module: 'context' },
  { id: 'preview', en: 'Preview / inspect', ko: '게시 전 입력 크기 검사',
    definition: '아직 정상 문맥으로 게시하지 않은 재료로 입력 구성을 가늠하는 준비 단계. 여기서는 모델 호출·문맥 head 게시·업무 상태 변경을 하지 않으며 실제 사용 직전에 다시 확인한다.',
    example: '필수 상태와 현재 지시가 들어가는지 먼저 본 뒤, 과거 대화를 얼마나 담을지 고른다.', module: 'context' },
  { id: 'profileDigest', en: 'Profile digest / inputProfileDigest', ko: '입력 설정 변경 확인값',
    definition: '모델·한도·추정기 버전을 묶어 계산한 지문. 예약한 호출을 보내기 전에 설정이 같은지 확인한다. 응답의 진실성을 판정하는 값은 아니다.',
    example: '예약 뒤 추정기 버전이 바뀌면 새 설정으로 다시 준비한다. 이미 받은 응답은 이 변경만으로 버리지 않는다.', module: 'context' }
];
const originalTermCards = [...original.matchAll(/<article class="glossary-item" id="term-([^"]+)" data-term-card="([^"]+)">[\s\S]*?<\/article>/g)];
for (const card of originalTermCards) assert.equal(card[1], card[2], 'existing glossary card identity differs');
const originalCardIds = new Set(originalTermCards.map(card => card[1]));
assert.equal(originalCardIds.size, originalTermCards.length, 'duplicate existing glossary card');
const staticRepairs = originalData.glossary.filter(term => !originalCardIds.has(term.id));
for (const term of newTerms) {
  assert.ok(!data.glossary.some(item => item.id === term.id), 'term already exists');
  data.glossary.push(term);
}
for (const [id, update] of Object.entries(updates)) {
  const module = data.modules.find(item => item.id === id); assert.ok(module);
  const { extraDocs = [], extraTerms = [], ...fields } = update;
  Object.assign(module, fields); module.docs = [...new Set([...module.docs, ...extraDocs])];
  module.terms = [...new Set([...module.terms, ...extraTerms])];
  if (update.summary !== undefined) {
    const pattern = new RegExp('(<article class="module" data-module-card="' + id + '"[^>]*>[\\s\\S]*?<p>)[\\s\\S]*?(</p>)');
    replaceOnce(pattern, (_, before, after) => before + module.summary + after, 'module card ' + id);
  }
}
data.snapshot.currentNotesAsOf = proof.recordedAt.slice(0, 10);
data.snapshot.currentResults = resultPath; data.snapshot.currentVerification = proofPath; data.snapshot.nextPlan = nextPath;
data.snapshot.c04Window = {
  kind: proof.status, proofSha256: proofHash, sourceAndBuild: pin,
  local: { platform: local.platform, newTests: localNew, relatedTests: localRelated, fullTests: local.fullTests.status,
    testNodeVersions: local.testNodeVersions, newResult: local.newTests.result, relatedResult: local.relatedTests.result,
    sourceObservations: [local.newTests.sourceObservation, local.relatedTests.sourceObservation],
    timestampMeaning: 'child_exit_then_log_close_observed_by_stage_runner' },
  nativeLinux: { node: native.environment.node, newTests: nativeNew, relatedTests: nativeRelated, tests: nativeAll, finishedAt: native.finishedAt,
    observedOwnedProcesses: native.cleanup.observedOwnedProcesses, inaccessiblePeers: native.cleanup.inaccessiblePeers.length,
    unresolvedPeers: native.cleanup.unresolved.length, sshClosed: native.cleanup.sshClosed, globalProcessAbsenceProven: false },
  browser: { status: 'not_executed_by_this_update', renderVerified: false, interactionsVerified: false },
  chapterComplete: false, goalComplete: false, realModelApi: 'paused_not_tested',
  nativeWindows: 'runtime_bindings_unimplemented_or_unconnected_and_unverified', postgres: 'unimplemented_and_unverified',
  nextPlan: nextPath, registeredModelProfileEntry: 'not_implemented', limitations: proof.limitations
};
const latest = `<!-- C04-WINDOW-FINAL-PROOF: ${proofHash} --><div class="note gap-top" id="latest-status" data-c04-window-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>C04 문맥 창 관리 · Linux 전체 ${passed(nativeAll)} 통과</strong><br>필수 업무 상태와 현재 사용자 원문을 먼저 보호하고, 모델 한 번의 입력·출력 공간에 맞춰 대화 정리 구간을 고른다. 저장된 대화·요약·업무 장부를 재사용하며 작업마다 문맥을 버리지 않는다.<br>${verifiedText}<br>Linux 필수 ${native.steps.length}단계와 원로그 ${native.collectedFiles.length}개 회수, 관측 가능한 전용 프로세스 ${native.cleanup.observedOwnedProcesses}·SSH 종료를 확인했다. 접근하지 못한 다른 프로세스 ${native.cleanup.inaccessiblePeers.length}개와 범위를 확정하지 못한 항목 ${native.cleanup.unresolved.length}개는 별도 기록이며 시스템 전체의 프로세스 부재를 뜻하지 않는다.<br>다음은 등록 모델 프로필을 CLI·Web 입구에 연결하는 단위로 아직 미구현이다. 현재 합성 규칙의 구조 검증이며 실제 모델/API 시험 중단을 유지한다. 이 갱신은 브라우저를 실행하지 않았고 렌더링·클릭 통과를 주장하지 않는다. C04 전체와 전체 목표는 진행 중이며 Windows 실기·PostgreSQL·사내 MCP·Knox·C08 독립 반론 협업도 남아 있다. 과거 D2 초기화·MCP 정체 원인을 이번 통과로 확정하지 않는다.<br><a href="chapters/C04-context-window-result.md" target="_blank" rel="noopener">문맥 창 결과 →</a> · <a href="chapters/C04-context-window-usage.md" target="_blank" rel="noopener">동작과 설정 설명 →</a> · <a href="../${proofPath}" target="_blank" rel="noopener">최종 증거 →</a> · <a href="chapters/C04-after-window-review.md" target="_blank" rel="noopener">다음 등록 모델 연결 검토 →</a></div>`;
replaceOnce(/<!-- C04-TURN-FINAL-PROOF: [a-f0-9]{64} --><div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/,
  previous => latest + '\n<details class="gap-top" data-c04-history="first-flow"><summary>C04 첫 요청·답변 연결 당시의 결과·검증 기록 펼치기</summary>' + previous.replace('id="latest-status"', 'id="c04-first-flow-history-status"').replace('aria-label="최신 구현과 검증 상태"', 'aria-label="과거 C04 첫 흐름 구현과 검증 상태"') + '</details>', 'latest status and first-flow history');
replaceOnce(/<div class="hero-aside">[\s\S]*?<\/div>/,
  '<div class="hero-aside"><span class="badge partial">C04 문맥 창 관리</span><strong>필요한 상태는 지키고,<br>들어갈 대화를 고른다.</strong><p>입력·출력 공간과 실행 자원을 구분했다. 다음은 등록 모델 프로필을 CLI·Web에 연결하는 단위이며 실제 모델 시험은 중단 상태다.</p></div>', 'hero');
replaceOnce(/C04 일반 요청 설명 갱신/, 'C04 문맥 창 설명 갱신', 'sidebar');
replaceOnce(/최신 C02 설명과 과거 P0~P6 이력을 함께 보존한다\./,
  '최신 C04 문맥 창 설명과 과거 C02·C03·C04 첫 흐름 및 P0~P6 이력을 함께 보존한다.', 'footer current scope');
replaceOnce(/C02 설명 갱신: 2026\.09\.07/,
  'C04 문맥 창 설명 갱신: ' + proof.recordedAt.slice(0, 10).replaceAll('-', '.'), 'footer update label');
replaceOnce(/기존 16개 기능 묶음을 유지하고 C04의 일반 요청·주턴·답변·문맥·채널 연결을 갱신했다\./,
  '기존 16개 기능 묶음을 유지하고 C04의 입력 창·필수 상태·대화 정리와 실행 자원 구분을 갱신했다.', 'module introduction');
replaceOnce(/지금 다음 단위는 C04의 모델 문맥 창 대응이다\.[\s\S]*?출력 여유란 모델이 답변을 작성하도록 남겨둘 공간이다\./,
  '문맥 창 대응은 현재 단위에서 연결했다. 다음은 등록된 모델의 한도·추정기 설정을 CLI·Web 실행 입구에 연결하는 일이며 아직 미구현이다. 출력 여유는 모델이 답변을 작성하도록 남겨둘 공간이고 업무에 배정한 소비 자원과 다르다.', 'roadmap current unit');
replaceOnce(/<a href="chapters\/C04-general-turn-result\.md" target="_blank" rel="noopener">현재 C04 결과 →<\/a> · <a href="chapters\/C04-context-window-plan\.md" target="_blank" rel="noopener">다음 구현 계획 →<\/a>/,
  '<a href="chapters/C04-context-window-result.md" target="_blank" rel="noopener">현재 C04 결과 →</a> · <a href="chapters/C04-after-window-review.md" target="_blank" rel="noopener">다음 연결 검토 →</a>', 'roadmap links');
replaceOnce(/<div class="note gap-top"><strong>다음은 C04의 문맥 창 대응 연결이다\.<\/strong>[\s\S]*?<\/div>/,
  '<div class="note gap-top"><strong>다음은 등록 모델 프로필과 실행 입구의 연결이다.</strong> 이번 문맥 창 계산·필수 상태 보호·compact 구간 선택을 재사용한다. 현재 이 입구 연결은 미구현이며 실제 모델/API 시험은 자동 재개하지 않는다. 아래 P0~P6의 31개 항목은 당시 이력이고 현행 C01~C10 챕터와 별도다.</div>', 'next action');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const termCards = [...staticRepairs, ...newTerms].map(term => `<article class="glossary-item" id="term-${term.id}" data-term-card="${term.id}"><h3>${escape(term.ko)}</h3><code>${escape(term.en)}</code><p>${escape(term.definition)}</p><p class="example">예 · ${escape(term.example)}</p><button class="btn small ghost" type="button" data-module="${term.module}">관련 구현 보기 →</button></article>`).join('');
replaceOnce(/<\/div><p class="empty" id="glossary-empty"/,
  () => termCards + '</div><p class="empty" id="glossary-empty"', 'new glossary cards');
replaceOnce(/(<span class="fine" id="glossary-count" aria-live="polite">)[^<]*(<\/span>)/,
  (_, before, after) => before + data.glossary.length + '개 용어' + after, 'glossary count');
replaceOnce(dataPattern, () => '<script id="review-data" type="application/json">' + JSON.stringify(data).replaceAll('<', '\\u003c') + '</script>', 'review data');

const parsed = JSON.parse(dataPattern.exec(html)[1]);
assert.deepEqual(parsed, data); assert.equal(parsed.modules.length, 16); assert.equal(parsed.items.length, 31);
for (const key of ['scenarios', 'items']) assert.deepEqual(parsed[key], originalData[key], 'historical/data section changed: ' + key);
assert.deepEqual(parsed.glossary.slice(0, originalData.glossary.length), originalData.glossary);
assert.deepEqual(parsed.glossary.slice(originalData.glossary.length), newTerms);
for (const card of originalTermCards) assert.equal(html.split(card[0]).length, 2, 'existing glossary card changed');
for (const key of ['asOf', 'kind', 'executionPlan', 'c03D2', 'c03D3', 'c04']) assert.deepEqual(parsed.snapshot[key], originalData.snapshot[key]);
for (const module of originalData.modules.filter(item => !(item.id in updates))) assert.deepEqual(parsed.modules.find(item => item.id === module.id), module);
function matching(text, pattern) { return [...text.matchAll(pattern)].map(match => match[0]); }
for (const pattern of [/<details class="work-card"[\s\S]*?<\/details>/g, /<div class="road-phase">[\s\S]*?<\/span><\/div>/g])
  assert.deepEqual(matching(html, pattern), matching(original, pattern), 'P0-P6 historical markup changed');
for (const module of originalData.modules.filter(item => !(item.id in updates))) {
  const pattern = new RegExp('<article class="module" data-module-card="' + module.id + '"[\\s\\S]*?</article>', 'g');
  assert.deepEqual(matching(html, pattern), matching(original, pattern), 'unrelated module card changed');
}
const scripts = text => [...text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter(match => !match[1].includes('application/json')).map(match => match[0]);
assert.deepEqual(scripts(html), scripts(original), 'executable JavaScript changed');
for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) if (!match[1].includes('application/json')) new Script(match[2]);
assert.deepEqual(matching(html, /<style[^>]*>[\s\S]*?<\/style>/g), matching(original, /<style[^>]*>[\s\S]*?<\/style>/g), 'styles changed');
// Only actual static markup contains links here; exclude JavaScript source templates before checking hrefs.
const staticMarkup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const ids = [...staticMarkup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'duplicate HTML id');
let checkedLinks = 0;
for (const match of staticMarkup.matchAll(/\bhref="([^"]+)"/g)) {
  const href = match[1];
  if (href.startsWith('#')) { assert.ok(ids.includes(decodeURIComponent(href.slice(1))), 'missing local anchor: ' + href); continue; }
  assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//'), 'unexpected external link: ' + href);
  const [path] = href.split(/[?#]/); assert.ok(path);
  const absolute = resolve(dirname(resolve(repo, htmlPath)), decodeURIComponent(path));
  assert.ok(absolute.startsWith(repo + '/'), 'file link escapes repository');
  checkedPath(absolute.slice(repo.length + 1)); checkedLinks++;
}
for (const module of parsed.modules) {
  for (const path of [...module.files, ...module.docs]) { checkedPath(path); checkedLinks++; }
  for (const term of module.terms) assert.ok(parsed.glossary.some(item => item.id === term));
}
for (const term of parsed.glossary) assert.ok(ids.includes('term-' + term.id), 'missing glossary card');
const allCardIds = [...staticMarkup.matchAll(/\sdata-term-card="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual([...allCardIds].sort(), parsed.glossary.map(term => term.id).sort(), 'glossary data and cards differ');
assert.equal((html.match(/id="latest-status"/g) ?? []).length, 1);
assert.ok(html.includes('C04-WINDOW-FINAL-PROOF: ' + proofHash));
assert.deepEqual(await verifyEvaluationBuild(runtime), pin);
assert.equal(sha256(read(proofPath)), proofHash, 'proof changed during staging');
assert.equal(read(htmlPath, 2 * 1024 * 1024).toString('utf8'), original, 'HTML changed during staging');
// Preserve the existing file and mode. A shorter r+ write would leave trailing bytes, so refuse before writing.
assert.ok(Buffer.byteLength(html) >= Buffer.byteLength(original), 'replacement unexpectedly shorter');
writeFileSync(checkedPath(htmlPath).absolute, html, { encoding: 'utf8', flag: 'r+' });
assert.equal(read(htmlPath, 2 * 1024 * 1024).toString('utf8'), html);
console.log(JSON.stringify({ status: 'guide_updated_static_checks_only', output: htmlPath, proof: proofPath, proofSha256: proofHash,
  sourceAndBuild: pin, local: { newTests: localNew, relatedTests: localRelated }, nativeLinux: { newTests: nativeNew, relatedTests: nativeRelated, tests: nativeAll },
  updatedModules: Object.keys(updates), modules: parsed.modules.length, historicalItems: parsed.items.length, newTerms: newTerms.map(term => term.id),
  staticRepairs: staticRepairs.map(term => term.id),
  checkedLinks, browser: 'not_executed_by_this_update', chapterComplete: false, goalComplete: false }, null, 2));
