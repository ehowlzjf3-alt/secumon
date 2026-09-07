// Run once after final C04 collection/finalization. Writes only the review HTML; no tests, models, or network.
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
const proofPath = 'runtime/evidence/C04-turn-linux-nas-20260907/verification.json';
const browserPath = 'runtime/evidence/C04-turn-browser-observation.json';
const htmlPath = 'design/secumon-review.html';
const resultPath = 'design/chapters/C04-general-turn-result.md';
const usagePath = 'design/chapters/C04-general-turn-usage.md';
const nextPath = 'design/chapters/C04-context-window-plan.md';
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
assert.equal(proof.scope, 'general_agent_turn_response_source_integrity_previous_draft_and_delivery');
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
assert.equal(local.testNodeVersion, 'not_captured_in_selected_local_results');
assert.equal(local.build.status, 'current_build_manifest_verified');
assert.deepEqual(local.build.sourceAndBuild, pin);
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
const stepNames = ['build', 'new-agent-turn-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
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
  const path = 'runtime/evidence/C04-turn-linux-nas-20260907/final/' + item.file;
  assert.equal(evidenceHashes.get(path), item.sha256); verifyEvidence(path, item.sha256);
}
for (const item of [local.newTests, local.relatedTests]) { verifyEvidence(item.result); verifyEvidence(item.log); }
const browserBytes = read(browserPath, 64 * 1024), browser = JSON.parse(browserBytes.toString('utf8'));
assert.equal(browser.status, 'not_executed_host_locked');
assert.equal(browser.renderVerified, false); assert.equal(browser.interactionsVerified, false);
assert.equal(browser.fixtureProcessExited, true); assert.equal(browser.fixtureDirectoryRemoved, true);
for (const path of [resultPath, usagePath, nextPath]) checkedPath(path);

const original = read(htmlPath, 2 * 1024 * 1024).toString('utf8');
assert.ok(!original.includes('C04-TURN-FINAL-PROOF:'), 'C04 guide already updated; review explicitly instead of overwriting');
let html = original;
function replaceOnce(pattern, replacement, label) {
  const matches = [...html.matchAll(new RegExp(pattern.source, 'g' + (pattern.flags.includes('s') ? 's' : '')))];
  assert.equal(matches.length, 1, 'HTML anchor changed: ' + label);
  html = html.replace(pattern, replacement);
}
const dataPattern = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const originalData = JSON.parse(dataPattern.exec(original)?.[1] ?? 'null');
assert.ok(originalData && originalData.modules.length === 16 && originalData.items.length === 31);
const data = structuredClone(originalData);
const count = n => n.toLocaleString('en-US');
const passed = c => `${count(c.pass)} / ${count(c.tests)}`;
const localText = `macOS 신규 ${passed(localNew)}·관련 ${passed(localRelated)}`;
const linuxText = `Linux ${native.environment.node} 신규 ${passed(nativeNew)}·관련 ${passed(nativeRelated)}·전체 ${passed(nativeAll)}`;
const verifiedText = `${localText}, ${linuxText} 통과. 묶음별 시험은 겹칠 수 있으므로 합산하지 않는다. macOS 전체 시험은 이번 소스에서 실행하지 않았고, 로컬 시험 당시 Node 버전은 수집하지 않았다. 로컬 소스·빌드 지문은 각 실행 후 확인했으며, 종료·지문 관측의 정확한 범위는 결과 문서와 원 기록을 따른다. 시험 수와 실행 시간을 모델 품질·속도·토큰 절감의 측정으로 해석하지 않는다.`;
const docs = [resultPath, usagePath];
const paths = (...names) => names.map(name => 'runtime/src/' + name);
const updates = {
  work: {
    summary: '요청 원문을 먼저 저장하고, 답변 요구와 진행 상태를 같은 업무에 연결한다.',
    why: '접수 사실, 답변 내용, 업무 완료를 구분해야 재시작하거나 추가 질문에 답해도 같은 일을 이어갈 수 있다.',
    how: [
      '주턴(agent turn)은 현재 요청과 문맥을 읽고 답변·추가 질문·실행 계획 중 다음 행동을 고르는 모델 호출 한 번이다. 새 요청도 기존 세션과 업무 저장소를 사용한다.',
      '최초 요청과 이후 보충 입력을 각각 보존한다. 같은 접수 ID와 같은 내용의 재전송은 기존 업무를 가리키며 권한과 담당 ID는 호스트가 정한다.',
      '질문에 답할 때는 해당 질문 ID를 지정해 같은 업무를 이어간다. 일반 추가 입력만으로 미해결 질문을 자동 해제하지 않는다.',
      'X가 끝나도 대화 문맥은 유지된다. 다음 업무 Y는 X의 실제 답변을 읽을 수 있지만 목표·계획·호출 사용량 장부는 새로 분리한다.'
    ],
    done: `C04에서 시나리오 선택 없는 원문 접수, 질문 뒤 계속하기, 완료한 X에서 새 Y로 문맥 잇기, 재접속 조회를 연결했다. ${verifiedText}`,
    left: '현재 제공자는 명시적으로 선택한 합성 규칙이다. 임의 자연어를 이해하는 실제 모델, 사내 도구를 사용하는 전체 업무 품질과 상시 담당의 자율 실행은 미검증이다.',
    example: '교정 요청을 접수한 뒤 답변하고, 같은 대화의 다음 요청에서 앞선 교정문을 다시 참고한다. 이전 업무를 복사해 새 업무의 완료 근거로 삼지 않는다.',
    files: paths('application/agent-turn-service.ts', 'application/session-service.ts', 'domain/agent-turn.ts')
  },
  plan: {
    summary: '답변·질문·실행 계획을 고르고, 계획이 필요하면 기존 가설·검증 루프로 연결한다.',
    why: '간단한 답변에 불필요한 도구 계획을 만들지 않으면서, 조사할 때는 근거와 반증 검토를 생략하지 않아야 한다.',
    how: [
      '원문·현재 문맥·고정 프롬프트를 한 입력으로 만든다. 프롬프트는 모델에게 주는 공통 지침이며 버전과 내용 지문을 함께 기록한다.',
      '답변은 본문과 자체 검토, 질문은 필요한 보충 질문, 계획은 기존 계획 제안 형식으로 반환한다. 잘못된 응답을 고치려고 숨은 모델 호출을 추가하지 않는다.',
      '계획의 도구·버전·권한·선행 관계·근거 연결을 기존 검사기로 확인한다. 가설의 예상 관측과 반증 조건을 유지하며 반증이 들어오면 다시 평가한다.',
      'counterarguments는 검토한 반론 목록이다. 미해결 사항은 missing에 남기고 needs_work, 즉 보완 필요로 표시한다. 모델의 자체 검토는 독립적인 사실 근거가 아니다.',
      '보완할 초안은 다음 주턴에 참고로 전달할 수 있다. 원래 호출·입력·응답 파일의 현재성을 다시 확인하고 반복은 기존 호출 한도 안에서 진행한다.'
    ],
    done: 'C04의 구조화 응답 검사, 답변/질문/계획 분기, 부족한 초안 재검토와 오래된 응답 거절을 합성 제공자와 대역 전송으로 검증했다. 기존 가설·계획 검사와 호출 정산을 재사용했다.',
    left: '실제 모델의 가설·계획·자체 반론 품질은 미검증이다. 필요할 때 독립된 동료가 반론을 조사하는 동적 협업은 C08의 남은 범위다. 고정 리드–워커 조직을 도입한 것은 아니다.',
    example: '교정은 답변으로, 자료가 불명확하면 질문으로, 자료를 확인해야 하면 읽기 계획으로 진행한다. 시험에서는 정해진 문구만 이 분기를 수행한다.',
    files: paths('infrastructure/agent-turn-prompt.ts', 'infrastructure/structured-agent-turn.ts', 'infrastructure/synthetic-agent-turn.ts', 'application/agent-turn-runtime.ts', 'application/planning-runtime.ts', 'application/plan-validator.ts', 'domain/hypotheses.ts')
  },
  execute: {
    summary: '도구 실행과 답변 작성을 기존 호출 장부로 처리하고, 원본과 미완료 조건을 확인한 뒤 결과를 보낸다.',
    why: '모델이 답변했다고 미완료 작업이나 질문까지 해결된 것은 아니다. 결과를 다시 보낼 때도 같은 검증이 필요하다.',
    how: [
      '모델·도구 호출의 예약 → 실행 → 응답 저장 → 사용량 정산 → 채택 수명을 재사용한다. 취소하거나 늦게 도착한 응답을 거절해도 이미 보고된 사용량은 보존한다.',
      '직접 답변은 가짜 도구 실행이나 사실 근거로 바꾸지 않는다. 자료를 읽은 경우에는 기존 실행 결과를 채택한 뒤 다음 주턴에서 답변한다.',
      '현재 목표·계획·자료·입력에 맞는 답변인지 검사한다. 미완료 계획 작업, 미해결 의무, 검토할 입력·기억과 기존 사실 근거 조건이 남으면 완료하지 않는다.',
      '답변 본문은 산출물(artifact), 즉 다시 검증할 수 있는 저장 파일로 남긴다. 이전 초안과 최종 답변의 원본이 없어지거나 권한이 바뀌면 복사된 본문만으로 통과하지 못한다.',
      '결과 준비와 전달은 구분한다. 조회·전달·재시작에서도 현재 답변의 지문을 사용해 이전 답변이 현재 결과로 섞이지 않게 한다.'
    ],
    done: '직접 교정 답변, 자료 읽기 뒤 답변, 질문 대기·보충 입력, 부족한 초안, 늦은 응답·취소·원본 소실·응답 저장 뒤 재개를 확인했다. 답변으로 기존 미완료 작업을 우회하는 경우도 거절한다. 프로세스 강제 종료 회귀는 전원 차단 내구성 시험과 구분한다.',
    left: '실제 모델의 답변 정확도·추론 품질과 사내 도구 결과의 완전성은 미검증이다. 운영 성능이나 전원 차단·파일 시스템 장애 전반의 내구성을 이 시험으로 보장하지 않는다.',
    example: '자료 조회가 실패한 계획에서 “완료했습니다”라는 답변만 와도 완료시키지 않는다. 실제 성공하거나 검증된 계획 변경으로 해당 작업을 정리해야 한다.',
    files: paths('application/workflow-runtime.ts', 'application/generated-answer.ts', 'application/agent-turn-previous.ts', 'application/conversation-service.ts', 'domain/completion.ts', 'domain/task-status.ts')
  },
  context: {
    summary: '대화 원문·요약·최근 입력을 실제 주턴에 넣고, 작업이 끝나거나 재시작해도 이어간다.',
    how: [...originalData.modules.find(module => module.id === 'context').how,
      'C04 주턴에는 최초 요청 조건, 실제 반영한 최신 입력, 현재 업무 상태와 선택한 개인 기억이 들어간다. 이전 답변 초안을 넣을 때도 원 호출과 파일을 확인한다.',
      '현재성 검사는 이 자료가 지금도 같은 원본·버전·권한으로 유효한지 확인하는 과정이다. 요약의 새 버전이 생겼다는 이유만으로 같은 입력 기준의 진행 중 호출을 무효화하지 않는다.'
    ],
    done: originalData.modules.find(module => module.id === 'context').done + ' C04에서는 교정 완료 → 다음 업무의 질문·보충 입력 → compact → 재시작·답변 → 후속 업무·반복 compact를 실제 CLI/HTTP 연결과 저장된 입력으로 검증했다. 합성 제공자의 정해진 인용 규칙을 사용했다.',
    left: '다음 C04 단위는 모델의 문맥 창(한 호출에 넣을 입력과 출력의 총 공간)에 맞춘 조합이다. 고정 프롬프트·도구 설명·현재 입력과 답변 공간을 함께 계산하고, 들어갈 수 있는 원문 구간부터 compact하는 연결은 아직 계획이다. 실제 모델의 의미 보존·반론 누락·토큰 추정 정확도·속도 개선은 미검증이다.',
    files: paths('application/context-compiler.ts', 'application/agent-turn-request.ts', 'application/agent-turn-previous.ts', 'application/session-service.ts', 'application/session-compactor.ts', 'application/planning-runtime.ts'),
    extraDocs: [nextPath]
  },
  channels: {
    summary: 'CLI·Web에서 원문을 접수하고 질문·답변을 표시한다. 조회만으로 모델을 다시 실행하지 않는다.',
    how: [...originalData.modules.find(module => module.id === 'channels').how,
      'C04의 CLI chat과 Web 일반 요청은 같은 접수 서비스를 사용한다. 호스트가 담당·권한을 정하고, 요청 본문에 임의 권한이나 시나리오를 주입하면 거절한다.',
      '접수 확인을 먼저 반환한 뒤 명시 실행으로 진행한다. 질문 답변은 같은 업무에 연결하고 새 업무도 같은 세션의 문맥을 이어받는다. 다른 선택 세션의 업무 조회·실행은 차단한다.',
      '재접속과 상태 조회는 읽기 경로다. 내부 모델·도구 로그를 새 말풍선으로 쌓지 않고 진행 상태와 상세 기록을 분리한다.'
    ],
    done: '과거 C02/C03와 D2의 CLI·HTTP·일부 별도 브라우저 관찰은 각 당시 소스의 기록으로 보존한다. C04는 실제 CLI 프로세스와 로컬 HTTP에서 접수 → 실행 → 질문·답변 → 후속 업무 → 재접속·세션 격리를 검증했다. 이번 브라우저 렌더링·클릭은 Mac 잠금으로 미실행이며 HTTP 통과가 이를 대신하지 않는다.',
    left: '현재 CLI/Web 제공자는 명시 선택한 합성 규칙이며 실제 모델·사내 로그인·Knox 발송·운영 배포는 미연결 또는 미검증이다. 기존 기억 관리 오류 문구와 업무 선택 복원 등 C06의 화면 보강도 남아 있다.',
    example: '“접수했습니다” → 현재 작업 상태 → 필요하면 질문 → 실제 답변. 같은 화면을 다시 열어도 모델 호출이나 도구 실행이 새로 시작되지 않는다.',
    files: paths('presentation/agent-turn-profile.ts', 'presentation/agent-turn-cli.ts', 'presentation/local-workbench.ts', 'presentation/web-server.ts', 'presentation/web/client.ts', 'application/agent-turn-service.ts', 'application/conversation-service.ts')
  }
};
for (const [id, update] of Object.entries(updates)) {
  const module = data.modules.find(item => item.id === id);
  assert.ok(module);
  const { extraDocs = [], ...fields } = update;
  Object.assign(module, fields);
  module.docs = [...new Set([...module.docs, ...docs, ...extraDocs])];
  for (const path of [...module.files, ...module.docs]) checkedPath(path);
  const pattern = new RegExp('(<article class="module" data-module-card="' + id + '"[^>]*>[\\s\\S]*?<p>)[\\s\\S]*?(</p>)');
  replaceOnce(pattern, (_, before, after) => before + module.summary + after, 'module card ' + id);
}
data.snapshot.currentNotesAsOf = proof.recordedAt.slice(0, 10);
data.snapshot.currentResults = resultPath; data.snapshot.currentVerification = proofPath; data.snapshot.nextPlan = nextPath;
data.snapshot.c04 = {
  kind: proof.status, proofSha256: proofHash, sourceAndBuild: pin,
  local: { platform: local.platform, newTests: localNew, relatedTests: localRelated, fullTests: local.fullTests.status,
    nodeScope: local.nodeScope, testNodeVersion: local.testNodeVersion, newResult: local.newTests.result, relatedResult: local.relatedTests.result },
  nativeLinux: { node: native.environment.node, newTests: nativeNew, relatedTests: nativeRelated, tests: nativeAll, finishedAt: native.finishedAt,
    observedOwnedProcesses: 0, inaccessiblePeers: native.cleanup.inaccessiblePeers.length, unresolvedPeers: native.cleanup.unresolved.length,
    sshClosed: true, globalProcessAbsenceProven: false },
  browser: { path: browserPath, sha256: sha256(browserBytes), status: browser.status, renderVerified: false, interactionsVerified: false },
  chapterComplete: false, goalComplete: false, realModelApi: 'paused_not_tested',
  nativeWindows: 'runtime_bindings_unimplemented_or_unconnected_and_unverified', postgres: 'unimplemented_and_unverified',
  counteragent: 'C08_remaining', nextPlan: nextPath, limitations: proof.limitations
};
const latest = `<!-- C04-TURN-FINAL-PROOF: ${proofHash} --><div class="note gap-top" id="latest-status" data-c04-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>C04 일반 요청 연결 · Linux 전체 ${passed(nativeAll)} 통과</strong><br>요청 원문 접수 → 답변·질문·실행 계획 선택 → 기존 도구 실행과 검증 → 실제 답변 전달을 연결했다. 같은 대화의 다음 업무와 재시작에도 문맥을 이어간다. 주턴은 현재 요청과 문맥으로 다음 행동을 고르는 모델 호출 한 번이다.<br>${verifiedText}<br>Linux 필수 8단계와 원로그 ${native.collectedFiles.length}개 회수, 관측 가능한 전용 프로세스 0·SSH 종료를 확인했다. 접근하지 못한 다른 프로세스 ${native.cleanup.inaccessiblePeers.length}개와 범위를 확정하지 못한 항목 ${native.cleanup.unresolved.length}개는 별도 기록이며 시스템 전체의 프로세스 부재를 뜻하지 않는다.<br>현재 CLI/Web은 명시 선택한 합성 규칙으로 동작한다. 구조·출처·중단 복구의 검증이며 임의 질문을 이해하는 실제 모델의 품질 검증이 아니다. Mac 잠금으로 이번 브라우저 렌더링·클릭은 미실행이다. C04 전체와 전체 목표는 진행 중이다.<br>다음은 모델의 문맥 창에 맞춰 입력과 답변 공간을 계산하고 compact를 연결하는 단위다. C08의 독립 반론·동료 협업, Windows 런타임 파일 연결·실기 검증, PostgreSQL 등록 지원, 사내 MCP·Knox와 운영 검증은 남아 있다. 실제 모델/API 시험은 중단 상태다. 과거 D2 초기화·MCP 정체의 원인을 이번 통과로 확정하지 않는다.<br><a href="chapters/C04-general-turn-result.md" target="_blank" rel="noopener">C04 결과 →</a> · <a href="chapters/C04-general-turn-usage.md" target="_blank" rel="noopener">CLI·Web 사용법 →</a> · <a href="../${proofPath}" target="_blank" rel="noopener">최종 증거 →</a> · <a href="../${browserPath}" target="_blank" rel="noopener">브라우저 미실행 기록 →</a> · <a href="chapters/C04-context-window-plan.md" target="_blank" rel="noopener">다음 문맥 창 계획 →</a></div>`;
replaceOnce(/<!-- C03-D3-FINAL-PROOF: [a-f0-9]{64} --><div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/,
  previous => latest + '\n<details class="gap-top" data-c03-history="D3"><summary>C03 D3 당시의 결과·검증 기록 펼치기</summary>' + previous.replace('id="latest-status"', 'id="c03-d3-history-status"').replace('aria-label="최신 구현과 검증 상태"', 'aria-label="과거 C03 D3 구현과 검증 상태"') + '</details>', 'latest status and D3 history');
replaceOnce(/<div class="hero-aside">[\s\S]*?<\/div>/,
  '<div class="hero-aside"><span class="badge partial">C04 일반 요청 연결</span><strong>요청을 받고,<br>같은 문맥으로 이어간다.</strong><p>답변·질문·도구 계획을 기존 코어에 연결했다. 현재 합성 규칙으로 검증했으며 다음은 모델 입력 창에 맞춘 문맥 조합이다.</p></div>', 'hero');
replaceOnce(/2026\.09\.07 C03 설명 갱신/, 'C04 일반 요청 설명 갱신', 'sidebar');
replaceOnce(/현재 D3의 검증 수치와 구분한다\./, '현재 C04의 검증 수치와 구분한다.', 'D2 history caption');
replaceOnce(/고정 모델 대역으로 계획·실행·근거·재개 흐름 검증/, '원문 접수부터 질문·답변·자료 읽기까지 합성 규칙으로 검증', 'overview current capability');
replaceOnce(/기존 16개 기능 묶음을 유지하고 C03의 문서 기억 선택·저장 구분·검증 범위를 갱신했다\./,
  '기존 16개 기능 묶음을 유지하고 C04의 일반 요청·주턴·답변·문맥·채널 연결을 갱신했다.', 'module introduction');
replaceOnce(/<div class="note"><strong>현재 구현 순서는 C01~C10이다\.<\/strong>[\s\S]*?<\/div>/,
  '<div class="note"><strong>현재 구현 순서는 C01~C10이다.</strong><br>C01 담당·설정 → C02 지속 대화·compact → C03 개인 기억 → C04 범용 대화·추론 → C05 도구·기억·스킬 효율 → C06 채널·업무 배치 → C07 게시판·아카이브 → C08 동료·반론·자원 → C09 에이전트 간 통신(A2A)·상시 임무 → C10 설치·운영.<br>C01 담당 디렉터리, C02 지속 세션, C03 개인 기억·문서 초안·명시 이관을 재사용해 C04 일반 요청을 연결했다. 새 담당의 기본 개인 기억은 SQLite이고 문서 저장은 명시적으로 선택한다. 각 챕터의 전체 완료를 뜻하지 않는다.<br>지금 다음 단위는 C04의 모델 문맥 창 대응이다. 프롬프트·도구 설명·원문과 출력 여유를 함께 계산하고 작은 창에 들어갈 구간부터 정리한다. 출력 여유란 모델이 답변을 작성하도록 남겨둘 공간이다. 실제 모델 품질, Windows 파일 연결, PostgreSQL 등록과 C08의 독립 반론 협업은 별도 남은 범위다.<br><a href="03-migration-plan.md" target="_blank" rel="noopener">통합 계획 →</a> · <a href="implementation-backlog.json" target="_blank" rel="noopener">챕터 작업 목록 →</a> · <a href="chapters/C04-general-turn-result.md" target="_blank" rel="noopener">현재 C04 결과 →</a> · <a href="chapters/C04-context-window-plan.md" target="_blank" rel="noopener">다음 구현 계획 →</a></div>', 'current roadmap');
replaceOnce(/<div class="note gap-top"><strong>지금 다음 행동은 ‘설계 검토’다\.<\/strong>[\s\S]*?<\/div>/,
  '<div class="note gap-top"><strong>다음은 C04의 문맥 창 대응 연결이다.</strong> 이미 검증한 요청·호출·정산·원문 보존을 재사용한다. 입력이 크면 필요한 범위부터 정리하며, 필수 원문만으로도 한도를 넘으면 버리지 않고 이유를 남겨 멈춘다. 아래 P0~P6 목록은 당시 이력으로 보존한다. 실제 모델/API 시험은 자동 재개하지 않는다.</div>', 'next action');
replaceOnce(dataPattern, () => '<script id="review-data" type="application/json">' + JSON.stringify(data).replaceAll('<', '\\u003c') + '</script>', 'review data');

const parsed = JSON.parse(dataPattern.exec(html)[1]);
assert.deepEqual(parsed, data);
for (const key of ['glossary', 'scenarios', 'items']) assert.deepEqual(parsed[key], originalData[key], 'historical/data section changed: ' + key);
for (const key of ['asOf', 'kind', 'executionPlan', 'c03D2', 'c03D3']) assert.deepEqual(parsed.snapshot[key], originalData.snapshot[key]);
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
const staticMarkup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const ids = [...staticMarkup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'duplicate HTML id');
for (const module of parsed.modules) for (const term of module.terms) assert.ok(parsed.glossary.some(item => item.id === term));
assert.equal((html.match(/id="latest-status"/g) ?? []).length, 1);
assert.ok(html.includes('C04-TURN-FINAL-PROOF: ' + proofHash));
assert.deepEqual(await verifyEvaluationBuild(runtime), pin);
assert.equal(sha256(read(proofPath)), proofHash, 'proof changed during staging');
assert.equal(sha256(read(browserPath)), sha256(browserBytes), 'browser observation changed during staging');
assert.equal(read(htmlPath, 2 * 1024 * 1024).toString('utf8'), original, 'HTML changed during staging');
// Preserve the existing file and mode. A shorter r+ write would leave old trailing bytes, so refuse it before writing.
assert.ok(Buffer.byteLength(html) >= Buffer.byteLength(original), 'replacement unexpectedly shorter');
writeFileSync(checkedPath(htmlPath).absolute, html, { encoding: 'utf8', flag: 'r+' });
assert.equal(read(htmlPath, 2 * 1024 * 1024).toString('utf8'), html);
console.log(JSON.stringify({ status: 'guide_updated_static_checks_only', output: htmlPath, proof: proofPath, proofSha256: proofHash,
  sourceAndBuild: pin, local: { newTests: localNew, relatedTests: localRelated }, nativeLinux: { newTests: nativeNew, relatedTests: nativeRelated, tests: nativeAll },
  updatedModules: Object.keys(updates), browser: browser.status, chapterComplete: false, goalComplete: false }, null, 2));
