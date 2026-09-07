// Adapted from C04-window-update-index.mjs; run only after final proof. Updates exactly three design index files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const runtime = realpathSync(fileURLToPath(new URL('../', import.meta.url))), root = resolve(runtime, '..');
assert.equal(realpathSync(process.cwd()), runtime, 'run from runtime with the final local build Node');
const proofPath = 'runtime/evidence/C04-registered-linux-nas-20260907/verification.json';
const resultPath = 'design/chapters/C04-registered-model-result.md', usagePath = 'design/chapters/C04-registered-model-usage.md';
const nextPath = 'design/chapters/C04-complex-turn-plan.md', reviewPath = 'design/chapters/C04-after-registration-review.md';
const diagnosisPath = 'runtime/evidence/C04-registered-profile-diagnosis.json';
const targets = ['design/README.md', 'design/03-migration-plan.md', 'design/implementation-backlog.json'];
const sha = value => createHash('sha256').update(value).digest('hex');
const read = path => readFileSync(resolve(root, path), 'utf8');
const proofText = read(proofPath), proof = JSON.parse(proofText), proofSha256 = sha(proofText);
assert.equal(proof.schemaVersion, 1); assert.equal(proof.chapter, 'C04');
assert.equal(proof.scope, 'registered_model_profile_general_entry_structured_compact');
assert.equal(proof.status, 'verified_supported_local_posix_partial_chapter');
assert.equal(proof.chapterComplete, false); assert.equal(proof.goalComplete, false);
assert.deepEqual(await verifyEvaluationBuild(runtime), proof.sourceAndBuild);
assert.equal(proof.local.build.node, process.version); assert.match(process.version, /^v24\./);
assert.equal(proof.nativeLinux.status, 'passed'); assert.equal(proof.nativeLinux.environment.platform, 'linux');
assert.equal(proof.nativeLinux.environment.node, 'v24.20.0');
assert.deepEqual(proof.nativeLinux.sourceAndBuild, proof.sourceAndBuild);
const cleanup = proof.nativeLinux.cleanup;
assert.equal(cleanup.sshClosed, true); assert.equal(cleanup.observedOwnedProcesses, 0);
assert.equal(cleanup.globalProcessAbsenceProven, false); assert.deepEqual(cleanup.auditErrors, []);
assert.ok(Array.isArray(cleanup.inaccessiblePeers) && Array.isArray(cleanup.unresolved));
assert.ok(Number.isFinite(Date.parse(proof.nativeLinux.finishedAt)));
assert.deepEqual(proof.nativeLinux.steps.map(step => step.name), ['build', 'new-registered-model-tests', 'related-existing-tests',
  'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures']);
for (const step of proof.nativeLinux.steps) {
  assert.equal(step.status, 'passed'); assert.equal(step.exitCode, 0); assert.equal(step.signal, null);
  assert.equal(step.timedOut, false); assert.equal(step.groupAbsentConfirmed, true);
}
// The finalizer already checks original logs. Verify its retained file fingerprints before summarizing them.
assert.ok(Array.isArray(proof.files) && proof.files.length > 0);
for (const item of proof.files) {
  assert.ok(/^runtime\/evidence\/[a-zA-Z0-9_./-]+$/.test(item.path) && !item.path.split('/').includes('..'));
  assert.equal(sha(readFileSync(resolve(root, item.path))), item.sha256, 'retained evidence changed: ' + item.path);
}
for (const path of [resultPath, usagePath, nextPath, reviewPath]) assert.ok(read(path).trim().length > 0, path + ' required');
const diagnosisText = read(diagnosisPath), diagnosis = JSON.parse(diagnosisText);
assert.equal(diagnosis.status, 'unresolved_existing_initialization_observation');
assert.equal(diagnosis.original.preciseThrowKnown, false);
const number = value => {
  assert.ok(Number.isSafeInteger(value.tests) && value.tests > 0); assert.equal(value.tests, value.pass);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(value[key], 0);
  return value.tests;
};
const localNew = number(proof.local.newTests.tests), localRelated = number(proof.local.relatedTests.tests);
const nativeNew = number(proof.nativeLinux.newTests), nativeRelated = number(proof.nativeLinux.relatedTests), all = number(proof.nativeLinux.tests);
for (const selected of [proof.local.newTests, proof.local.relatedTests]) {
  assert.match(selected.testNode, /^v24\./); assert.deepEqual(selected.sourceAndBuild, proof.sourceAndBuild);
  assert.equal(selected.sourceObservation.kind, 'per_run_source_and_build_verification');
  assert.deepEqual(selected.sourceObservation.before, proof.sourceAndBuild); assert.deepEqual(selected.sourceObservation.after, proof.sourceAndBuild);
}
const format = value => value.toLocaleString('en-US');
const intro = `담당 설정에 저장한 모델 등록 이름을 CLI·Web의 같은 일반 요청 입구에 연결했다. 주턴과 compact는 기존 호출 예약·정산·복구를 사용하며, 기본 등록 예제는 네트워크 없는 구조화 전송 대역이다. macOS Node24 신규 **${localNew}/${localNew}**·관련 **${localRelated}/${localRelated}**, NAS Linux Node24 신규 **${nativeNew}/${nativeNew}**·관련 **${nativeRelated}/${nativeRelated}**·전체 **${format(all)}/${format(all)}**을 같은 소스로 통과했다. [등록 모델 결과](${root}/${resultPath}) · [사용법](${root}/${usagePath}) · [확정 증거](${root}/${proofPath}). 다음은 [일반 입구의 복합 가설·반증·부분 재계획](${root}/${nextPath})이며 [잔여 검토](${root}/${reviewPath})의 명시 목표 변경도 남는다. 실제 모델/API 시험은 중단 상태다. C04 전체·Windows·PostgreSQL·사내 연동과 전체 goal은 미완료다.`;
function replaceExactly(text, before, after, label) {
  const at = text.indexOf(before);
  assert.ok(at >= 0 && text.indexOf(before, at + before.length) === -1, 'document anchor changed: ' + label);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
const original = new Map(targets.map(path => [path, read(path)])), updates = new Map();
for (const path of targets.slice(0, 2)) {
  let text = original.get(path);
  text = replaceExactly(text, 'v0.58 · C04 문맥 창 검증과 등록 모델 입구 연결',
    'v0.59 · C04 등록 모델 연결 검증과 복합 일반 요청 인수', path + ' revision');
  text = replaceExactly(text, '\n\n모델 입력·출력·총 문맥 창을 구분하고,',
    '\n\n이전 C04 문맥 창 검증 기록: 모델 입력·출력·총 문맥 창을 구분하고,', path + ' historical window intro');
  if (path === 'design/README.md') text = replaceExactly(text,
    '현재 goal은 C04 일반 요청·문맥 창 검증 결과를 보존하고 등록된 모델 프로필을 CLI·Web의 일반 실행 입구에 연결하는 것이다. 이 입구 연결은 아직 미구현이다.',
    `현재 goal은 C04 일반 요청·문맥 창·등록 모델의 검증 결과를 보존하고, [복합 일반 요청 인수](${root}/${nextPath})와 [명시 목표 변경의 남은 연결](${root}/${reviewPath})을 이어가는 것이다. 기존 코어를 다시 만들지 않는다.`, path + ' current goal');
  else text = replaceExactly(text,
    '다음은 [등록된 모델 프로필과 일반 입구 연결](chapters/C04-after-window-review.md)이며 아직 미구현이다. 기존 호출 예약·정산·복구를 재사용한다.',
    '이어서 [등록 모델 입구와 구조화 compact](chapters/C04-registered-model-result.md)를 검증했다. 다음은 [일반 입구의 복합 가설·반증·부분 재계획](chapters/C04-complex-turn-plan.md) 인수다. [잔여 검토](chapters/C04-after-registration-review.md)에 명시 목표 변경 연결을 남긴다. 기존 호출 예약·정산·복구와 계획 검사기를 재사용한다.', path + ' C04 next unit');
  const firstBreak = text.indexOf('\n'); assert.ok(firstBreak > 0);
  text = text.slice(0, firstBreak + 1) + '\n' + intro + '\n' + text.slice(firstBreak + 1);
  updates.set(path, text);
}
const backlog = JSON.parse(original.get(targets[2]));
assert.equal(backlog.revision, 'v0.58'); backlog.revision = 'v0.59'; backlog.next_execution_chapter = 'C04';
const chapters = backlog.execution_chapters.filter(item => item.id === 'C04'); assert.equal(chapters.length, 1);
const chapter = chapters[0]; assert.equal(chapter.status, 'in_progress'); assert.equal(chapter.registered_model_progress, undefined);
chapter.current_implementation = 'registered model entry and structured compact verified; complex general-turn acceptance and explicit goal-change entry remain';
chapter.registered_model_progress = { status: proof.status, currentVerification: proofPath, proofSha256, result: resultPath, usage: usagePath,
  sourceAndBuild: proof.sourceAndBuild,
  local: { platform: proof.local.platform, testNodeVersions: { newTests: proof.local.newTests.testNode, relatedTests: proof.local.relatedTests.testNode },
    newTests: localNew, relatedTests: localRelated, fullTests: proof.local.fullTests.status },
  nativeLinux: { node: proof.nativeLinux.environment.node, attempt: proof.nativeLinux.attempt, finishedAt: proof.nativeLinux.finishedAt,
    tests: all, newTests: nativeNew, relatedTests: nativeRelated, sshClosed: true, observedOwnedProcesses: 0,
    unresolvedPeers: cleanup.unresolved.length, globalProcessAbsenceProven: false },
  initializationDiagnosis: { path: diagnosisPath, sha256: sha(diagnosisText), status: diagnosis.status,
    original: diagnosis.original, boundedRepeat: diagnosis.boundedRepeat, relatedRepeat: diagnosis.relatedRepeat },
  priorAttempts: proof.priorAttempts, historicalEvidence: proof.historicalEvidence,
  chapterComplete: false, goalComplete: false, realModelApi: 'cancelled', browser: 'not_claimed_by_this_proof', remainingReview: reviewPath };
chapter.nextPlan = nextPath;
const observations = chapter.follow_up_observations.filter(item => item.source === 'C02_compact_model_window_allocation');
assert.equal(observations.length, 1);
observations[0].current_remaining = 'Registered profile entry is now verified through deterministic transport fixtures. Real-model estimator and response/summary quality remain unverified; model/API experiments stay paused. Complex general-turn acceptance and explicit goal-change entry remain in C04.';
backlog.next_local_work_item = { id: 'C04', id_kind: 'execution_chapter', scope: 'complex_general_turn_counterevidence_partial_replanning',
  next_design: nextPath, remaining_review: reviewPath,
  prerequisite_note: 'General turn, model window and registered model units are verified on supported POSIX. Reuse existing hypothesis/plan/execution/response gates, preserve raw-source and accounting boundaries, and keep actual model/API experiments paused.' };
updates.set(targets[2], JSON.stringify(backlog, null, 2) + '\n');
assert.deepEqual([...updates.keys()].sort(), [...targets].sort());
assert.deepEqual(await verifyEvaluationBuild(runtime), proof.sourceAndBuild);
assert.equal(sha(read(proofPath)), proofSha256, 'proof changed during index preparation');
assert.equal(read(diagnosisPath), diagnosisText, 'diagnosis changed during index preparation');
for (const [path, before] of original) assert.equal(read(path), before, 'document changed during index preparation: ' + path);
for (const [path, text] of updates) writeFileSync(resolve(root, path), text);
console.log(JSON.stringify({ updated: [...updates.keys()], revision: backlog.revision, localNew, localRelated, nativeNew, nativeRelated, all,
  next: nextPath, chapterComplete: false, goalComplete: false, proofSha256 }));
