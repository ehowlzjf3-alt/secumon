// Prepare only; run once after final C04 registered-model collection/finalization. Reuses the window updater proof and static checks. Writes only the review HTML; no tests, models, or network.
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
const proofPath = 'runtime/evidence/C04-registered-linux-nas-20260907/verification.json';
const htmlPath = 'design/secumon-review.html';
const resultPath = 'design/chapters/C04-registered-model-result.md';
const usagePath = 'design/chapters/C04-registered-model-usage.md';
const nextPath = 'design/chapters/C04-complex-turn-plan.md';
const reviewPath = 'design/chapters/C04-after-registration-review.md';
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
assert.equal(proof.scope, 'registered_model_profile_general_entry_structured_compact');
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
const stepNames = ['build', 'new-registered-model-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
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
  const path = 'runtime/evidence/C04-registered-linux-nas-20260907/final/' + item.file;
  assert.equal(evidenceHashes.get(path), item.sha256); verifyEvidence(path, item.sha256);
}
for (const item of [local.newTests, local.relatedTests]) { verifyEvidence(item.result); verifyEvidence(item.log); }
for (const path of [resultPath, usagePath, nextPath, reviewPath]) checkedPath(path);

const original = read(htmlPath, 2 * 1024 * 1024).toString('utf8');
assert.ok(!original.includes('C04-REGISTERED-FINAL-PROOF:'), 'registered guide already updated; review explicitly instead of overwriting');
assert.ok(original.includes('C04-WINDOW-FINAL-PROOF:') && original.includes('C04-TURN-FINAL-PROOF:'), 'previous C04 histories required');
let html = original;
function replaceOnce(pattern, replacement, label) {
  const matches = [...html.matchAll(new RegExp(pattern.source, 'g' + (pattern.flags.includes('s') ? 's' : '')))];
  assert.equal(matches.length, 1, 'HTML anchor changed: ' + label);
  html = html.replace(pattern, replacement);
}
const dataPattern = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const originalData = JSON.parse(dataPattern.exec(original)?.[1] ?? 'null');
assert.ok(originalData && originalData.modules.length === 16 && originalData.items.length === 31 && originalData.snapshot.c04Window);
assert.equal(originalData.snapshot.c04Registered, undefined);
const data = structuredClone(originalData);
const count = n => n.toLocaleString('en-US');
const passed = c => `${count(c.pass)} / ${count(c.tests)}`;
const localText = `macOS 신규 ${passed(localNew)}·관련 ${passed(localRelated)}`;
const linuxText = `Linux ${native.environment.node} 신규 ${passed(nativeNew)}·관련 ${passed(nativeRelated)}·전체 ${passed(nativeAll)}`;
const verifiedText = `${localText}, ${linuxText} 통과. 시험 묶음은 겹칠 수 있어 합산하지 않는다. 로컬 신규·관련 시험은 각각 ${local.newTests.testNode}·${local.relatedTests.testNode}에서 실행했고 시험 전후 소스·빌드 지문이 같다. 종료 시각은 시험 프로세스 종료 후 로그 파일 닫힘을 관측한 시각이다. 이번 소스의 macOS 전체 시험은 실행하지 않았다. 합성 시험의 통과와 실행 시간은 실제 모델 품질·속도·토큰 절감 측정이 아니다.`;
const paths = (...names) => names.map(name => 'runtime/src/' + name);
function prior(id) { const module = originalData.modules.find(item => item.id === id); assert.ok(module); return module; }
const updates = {
  work: {
    how: [...prior('work').how, '담당 설정에 저장한 모델 이름을 호스트가 등록한 연결에서 찾는다. 등록된 주턴도 같은 접수·세션·목표·도구 실행·답변 확인 경로를 사용하며 업무마다 문맥을 새로 버리지 않는다.'],
    done: prior('work').done + ' 현재 등록 연결에서는 원문 접수부터 도구 읽기·반복 compact·근거 재조회·답변과 재시작 뒤 다음 업무까지 같은 코어로 이어지는 경로를 검증했다.',
    left: '등록 모델을 CLI·Web 입구에 연결했으며 기본 local-contract-v1은 정해진 문구만 처리하는 합성 규칙이다. 다음은 일반 요청 입구에서 복합 반례·부분 재계획·명시 목표 변경을 잇는 단위다. 실제 모델 판단·사내 업무 품질과 상시 담당의 자율 실행은 미검증이다.',
    extraTerms: ['host', 'modelRegistry', 'modelTransport'], extraDocs: [resultPath, usagePath, nextPath, reviewPath]
  },
  context: {
    summary: '등록 모델의 주턴과 compact를 같은 문맥·출처·입력 한도 검사에 연결한다.',
    how: [...prior('context').how,
      '호스트는 에이전트를 실행하는 프로그램이다. 등록표에서 담당 설정의 모델 이름을 찾고 주턴과 compact 연결을 제공한다. 설정의 이름을 파일 경로나 실행 모듈로 해석하지 않는다.',
      '전송 담당(transport)은 구조화한 요청을 받아 응답을 돌려주는 부분이다. 현재 로컬 예제는 기존 합성 규칙을 호출하며 실제 모델/API를 사용하지 않는다. 전송 담당이 원문을 직접 조회하거나 요약을 게시하지 않는다.',
      '등록된 주턴과 compact의 모델 신원·목적지·능력을 맞추고 두 입력 추정기와 고정 지시문 버전을 함께 묶는다. 지시문·스키마·도구 정의까지 포함해 크기를 측정하고 같은 출력 예약을 남긴다.',
      '도구 실행·근거 채택·요약 반복·재시작·사용량 정산은 기존 코어를 재사용한다. 저장된 응답이 있으면 그 응답을 확인해 이어가며 새 모델 호출로 대체하지 않는다.'
    ],
    done: `기존 입력 창 계산과 필수 상태 보호를 등록 모델의 일반 실행 입구에 연결했다. 실제 임시 담당 저장소에서 도구 읽기·반복 자동 compact·생략된 근거 재조회·답변·재시작 후 다음 업무를 합성 규칙으로 검증했다. ${verifiedText}`,
    left: '등록 입구는 구현됐다. 다음은 일반 입구에서 복합 반례·부분 재계획·명시 목표 변경을 연결하는 단위다. 실제 모델의 tokenizer 정확도·의미 보존·반론 누락·성능은 미검증이며 API 시험 중단을 유지한다. local-contract-v1의 한정된 근거 재조회 규칙은 실패·부분 응답 뒤의 범용 탐색 능력이 아니다.',
    files: [...prior('context').files, ...paths('infrastructure/structured-agent-model.ts', 'infrastructure/structured-session-compact.ts', 'presentation/host-models.ts')],
    extraTerms: ['host', 'modelRegistry', 'modelTransport', 'profileDigest'], extraDocs: [resultPath, usagePath, nextPath, reviewPath]
  },
  memory: {
    how: [...prior('memory').how, 'C04 등록 모델도 기존 원문 이력·세션 요약·선택된 개인 기억을 구분해 사용한다. 모델 연결을 바꾼다고 별도 기억 저장소를 만들거나 요약을 개인 장기기억으로 자동 등록하지 않는다.'],
    left: 'PostgreSQL 저장·이관, Windows 런타임 연결과 실제 검증, 자율 경험 출처 확장, 반복 읽기 비용과 실제 모델 의미 품질은 남아 있다. C03 전체와 전체 목표는 미완료다. C04 범용 대화·문맥 창·등록 모델 입구는 연결했으며 다음은 복합 반례·부분 재계획·명시 목표 변경이다. 실제 모델/API 시험은 중단 상태다.',
    extraDocs: [resultPath, usagePath, reviewPath]
  },
  channels: {
    summary: 'CLI·Web이 같은 등록 모델과 기존 세션·실행 흐름을 사용하며 접수·진행·답변을 나눠 표시한다.',
    how: [...prior('channels').how,
      'CLI와 Web 시작 시 --provider registered를 명시하면 담당 config.json의 model.profile 이름으로 호스트 등록표를 조회한다. 기존 synthetic 선택도 남기며 혼합하거나 등록이 없을 때 다른 모델로 대체하지 않는다.',
      'HTTP 요청으로 모델 이름·권한·코드 경로를 바꿀 수 없다. 모델과 저장소를 열 때 오류가 나도 이미 연 자원을 정리하고 최초 오류와 정리 오류를 함께 보존한다.',
      'modelInfo는 선택한 등록·모델 신원·compact 제공 여부와 실행 종류를 설명한다. 실제 모델 접속 성공이나 품질 검증을 뜻하지 않는다. 내부 호출 로그는 계속 별도 상세 기록으로 둔다.'
    ],
    done: `과거 CLI·HTTP·브라우저 관찰은 당시 소스의 기록으로 유지한다. 현재 등록 모델의 CLI 프로세스와 로컬 HTTP 접수·실행·조회·재시작, 정확한 등록 선택과 자원 종료를 검증했다. ${verifiedText} 이 HTML 갱신은 브라우저 렌더링·클릭을 실행하지 않는다.`,
    left: '호스트 등록 API와 CLI/Web 연결은 구현됐다. 현재 사용자·정책·도구 배치는 local 구성에 고정되어 있으며 사내 로그인·MCP·Knox 발송·운영 배포는 미연결 또는 미검증이다. 기억 관리 오류 문구와 업무 선택 복원 등 C06의 화면 보강도 남아 있다. 실제 모델/API 시험을 재개한 것은 아니다.',
    files: [...prior('channels').files, ...paths('presentation/host-models.ts', 'presentation/agent-turn-profile.ts', 'presentation/local-contract-model.ts', 'presentation/agent-turn-cli.ts', 'presentation/agent-web.ts')],
    extraTerms: ['host', 'modelRegistry', 'modelTransport'], extraDocs: [resultPath, usagePath, nextPath, reviewPath]
  }
};
const newTerms = [
  { id: 'modelRegistry', en: 'Model registry / AgentTurnHost.models', ko: '이름으로 모델 연결을 찾는 등록표',
    definition: '에이전트를 실행하는 프로그램인 호스트가 준비하는 이름과 모델 생성 함수의 목록. 담당 설정에는 이름만 저장하며 이 값으로 파일이나 모듈을 실행하지 않는다.',
    example: 'local-contract-v1이라는 이름을 현재의 로컬 합성 연결에서 찾는다. 등록 이름이 없으면 거절한다.', module: 'channels' },
  { id: 'modelTransport', en: 'Model transport', ko: '모델 요청·응답 전송 담당',
    definition: '구조화한 요청을 받아 응답을 돌려주는 연결 부분. 원문 조회·계획 검증·실행·요약 게시·정산은 기존 코어가 맡는다. 전송 부분을 등록했다는 사실만으로 실제 연결 성공을 증명하지 않는다.',
    example: '현재 로컬 전송은 고정 합성 규칙을 실행한다. 실제 사내 모델 연결은 별도로 구현하고 검증해야 한다.', module: 'context' }
];
const originalTermCards = [...original.matchAll(/<article class="glossary-item" id="term-([^"]+)" data-term-card="([^"]+)">[\s\S]*?<\/article>/g)];
const originalCardIds = new Set(originalTermCards.map(card => card[1]));
assert.equal(originalCardIds.size, originalTermCards.length, 'duplicate existing glossary card');
for (const card of originalTermCards) assert.equal(card[1], card[2]);
assert.deepEqual([...originalCardIds].sort(), originalData.glossary.map(term => term.id).sort(), 'existing glossary data/cards differ');
for (const term of newTerms) { assert.ok(!data.glossary.some(item => item.id === term.id)); data.glossary.push(term); }
for (const [id, update] of Object.entries(updates)) {
  const module = data.modules.find(item => item.id === id); assert.ok(module);
  const { extraDocs = [], extraTerms = [], ...fields } = update;
  Object.assign(module, fields); module.docs = [...new Set([...module.docs, ...extraDocs])];
  module.terms = [...new Set([...module.terms, ...extraTerms])]; module.files = [...new Set(module.files)];
  if (update.summary !== undefined) {
    const pattern = new RegExp('(<article class="module" data-module-card="' + id + '"[^>]*>[\\s\\S]*?<p>)[\\s\\S]*?(</p>)');
    replaceOnce(pattern, (_, before, after) => before + module.summary + after, 'module card ' + id);
  }
}
data.snapshot.currentNotesAsOf = proof.recordedAt.slice(0, 10);
data.snapshot.currentResults = resultPath; data.snapshot.currentVerification = proofPath; data.snapshot.nextPlan = nextPath;
data.snapshot.c04Registered = {
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
  registeredModelProfileEntry: 'implemented_static_host_registration_with_finite_local_fixture',
  localFixture: { profile: 'local-contract-v1', execution: 'deterministic_fixture', arbitraryLanguageUnderstanding: false,
    recallFailureOrPartialRecovery: 'not_implemented_or_verified' },
  priorAttempts: proof.priorAttempts, historicalEvidence: proof.historicalEvidence,
  nextPlan: nextPath, nextReview: reviewPath, limitations: proof.limitations
};
const latest = `<!-- C04-REGISTERED-FINAL-PROOF: ${proofHash} --><div class="note gap-top" id="latest-status" data-c04-registered-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>C04 등록 모델·CLI/Web 연결 · Linux 전체 ${passed(nativeAll)} 통과</strong><br>담당 설정의 모델 이름을 호스트 등록표에서 찾아 주턴과 compact를 연결했다. 기존 실행 루프·세션·원문·요약·사용량 정산을 재사용하며 작업마다 문맥을 버리지 않는다.<br>${verifiedText}<br>Linux 필수 ${native.steps.length}단계와 원로그 ${native.collectedFiles.length}개 회수, 관측 가능한 전용 프로세스 ${native.cleanup.observedOwnedProcesses}·SSH 종료를 확인했다. 접근하지 못한 다른 프로세스 ${native.cleanup.inaccessiblePeers.length}개와 범위를 확정하지 못한 항목 ${native.cleanup.unresolved.length}개는 별도 기록이며 시스템 전체의 프로세스 부재를 뜻하지 않는다.<br>local-contract-v1은 정해진 문구와 한정된 근거 재조회만 처리하는 합성 예제다. 실제 모델/API 시험은 중단 상태이며 사내 정책·도구 배치는 아직 local 구성이다. 다음은 일반 입구의 복합 반례·부분 재계획·명시 목표 변경이다. C04 전체와 전체 목표, Windows 실기·PostgreSQL·사내 MCP·Knox·C08 독립 반론 협업은 남아 있다. 최초 로컬 동시 초기화 오류와 과거 D2 초기화·MCP 정체의 원인을 이번 통과로 확정하지 않는다. 이 갱신은 브라우저를 실행하지 않았고 렌더링·클릭 통과를 주장하지 않는다.<br><a href="chapters/C04-registered-model-result.md" target="_blank" rel="noopener">등록 연결 결과 →</a> · <a href="chapters/C04-registered-model-usage.md" target="_blank" rel="noopener">설정과 사용법 →</a> · <a href="../${proofPath}" target="_blank" rel="noopener">최종 증거 →</a> · <a href="chapters/C04-complex-turn-plan.md" target="_blank" rel="noopener">다음 구현 계획 →</a> · <a href="chapters/C04-after-registration-review.md" target="_blank" rel="noopener">남은 범위 검토 →</a></div>`;
replaceOnce(/<!-- C04-WINDOW-FINAL-PROOF: [a-f0-9]{64} --><div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/,
  previous => latest + '\n<details class="gap-top" data-c04-history="window"><summary>C04 문맥 창 관리 당시의 결과·검증 기록 펼치기</summary>' + previous.replace('id="latest-status"', 'id="c04-window-history-status"').replace('aria-label="최신 구현과 검증 상태"', 'aria-label="과거 C04 문맥 창 구현과 검증 상태"') + '</details>', 'latest status and window history');
replaceOnce(/<div class="hero-aside">[\s\S]*?<\/div>/,
  '<div class="hero-aside"><span class="badge partial">C04 등록 모델 연결</span><strong>같은 에이전트 흐름에<br>모델 연결을 등록한다.</strong><p>CLI·Web이 등록된 주턴과 compact를 사용한다. 세션·원문·실행·정산은 기존 코어를 재사용하며 실제 모델/API 시험은 중단 상태다.</p></div>', 'hero');
replaceOnce(/C04 문맥 창 설명 갱신<br>/, 'C04 등록 모델 설명 갱신<br>', 'sidebar');
replaceOnce(/최신 C04 문맥 창 설명과 과거 C02·C03·C04 첫 흐름 및 P0~P6 이력을 함께 보존한다\./,
  '최신 C04 등록 모델 설명과 과거 C02·C03·C04 첫 흐름·문맥 창 및 P0~P6 이력을 함께 보존한다.', 'footer scope');
replaceOnce(/C04 문맥 창 설명 갱신: \d{4}\.\d{2}\.\d{2}/,
  'C04 등록 모델 설명 갱신: ' + proof.recordedAt.slice(0, 10).replaceAll('-', '.'), 'footer label');
replaceOnce(/기존 16개 기능 묶음을 유지하고 C04의 입력 창·필수 상태·대화 정리와 실행 자원 구분을 갱신했다\./,
  '기존 16개 기능 묶음을 유지하고 C04의 호스트 등록표·주턴과 compact·CLI/Web 연결을 갱신했다.', 'module introduction');
replaceOnce(/문맥 창 대응은 현재 단위에서 연결했다\. 다음은 등록된 모델의 한도·추정기 설정을 CLI·Web 실행 입구에 연결하는 일이며 아직 미구현이다\. 출력 여유는 모델이 답변을 작성하도록 남겨둘 공간이고 업무에 배정한 소비 자원과 다르다\./,
  '문맥 창 대응에 이어 등록 모델의 주턴·compact를 CLI·Web 실행 입구에 연결했다. 호스트는 에이전트 실행 프로그램이며 등록표에서 이름으로 연결을 찾는다. 다음은 기존 루프를 재사용해 일반 입구의 복합 반례·부분 재계획·명시 목표 변경을 검증하는 일이다.', 'roadmap current unit');
replaceOnce(/<a href="chapters\/C04-context-window-result\.md" target="_blank" rel="noopener">현재 C04 결과 →<\/a> · <a href="chapters\/C04-after-window-review\.md" target="_blank" rel="noopener">다음 연결 검토 →<\/a>/,
  '<a href="chapters/C04-registered-model-result.md" target="_blank" rel="noopener">현재 C04 결과 →</a> · <a href="chapters/C04-complex-turn-plan.md" target="_blank" rel="noopener">다음 구현 계획 →</a> · <a href="chapters/C04-after-registration-review.md" target="_blank" rel="noopener">남은 범위 검토 →</a>', 'roadmap links');
replaceOnce(/<div class="note gap-top"><strong>다음은 등록 모델 프로필과 실행 입구의 연결이다\.<\/strong>[\s\S]*?<\/div>/,
  '<div class="note gap-top"><strong>다음은 일반 입구의 복합 반례·부분 재계획·명시 목표 변경이다.</strong> 등록 모델·문맥 창·지속 세션·도구 실행·정산의 기존 연결을 재사용한다. 실제 모델/API 시험을 자동 재개하지 않는다. 아래 P0~P6의 31개 항목은 당시 이력이고 현행 C01~C10 챕터와 별도다.</div>', 'next action');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const termCards = newTerms.map(term => `<article class="glossary-item" id="term-${term.id}" data-term-card="${term.id}"><h3>${escape(term.ko)}</h3><code>${escape(term.en)}</code><p>${escape(term.definition)}</p><p class="example">예 · ${escape(term.example)}</p><button class="btn small ghost" type="button" data-module="${term.module}">관련 구현 보기 →</button></article>`).join('');
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
for (const key of ['asOf', 'kind', 'executionPlan', 'c03D2', 'c03D3', 'c04', 'c04Window']) assert.deepEqual(parsed.snapshot[key], originalData.snapshot[key]);
const previousFirstFlow = /<details class="gap-top" data-c04-history="first-flow">[\s\S]*?<\/details>/g;
assert.deepEqual(matching(html, previousFirstFlow), matching(original, previousFirstFlow), 'first-flow history changed');
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
assert.ok(html.includes('C04-REGISTERED-FINAL-PROOF: ' + proofHash));
assert.equal((html.match(/id="c04-window-history-status"/g) ?? []).length, 1);
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
  checkedLinks, browser: 'not_executed_by_this_update', chapterComplete: false, goalComplete: false }, null, 2));
