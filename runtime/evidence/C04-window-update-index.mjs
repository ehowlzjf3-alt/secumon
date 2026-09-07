// Run only after the native result has been collected, cleaned up, and finalized.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const runtime = resolve('.'), root = resolve('..');
const proofPath = 'runtime/evidence/C04-window-linux-nas-20260907/verification.json';
const resultPath = 'design/chapters/C04-context-window-result.md', usagePath = 'design/chapters/C04-context-window-usage.md';
const nextPath = 'design/chapters/C04-after-window-review.md';
const read = path => readFileSync(resolve(root, path), 'utf8');
const proofText = read(proofPath), proof = JSON.parse(proofText);
assert.equal(proof.scope, 'model_input_window_profile_inspection_bounded_compact');
assert.equal(proof.status, 'verified_supported_local_posix_partial_chapter');
assert.equal(proof.chapterComplete, false); assert.equal(proof.goalComplete, false);
assert.deepEqual(await verifyEvaluationBuild(runtime), proof.sourceAndBuild);
assert.equal(proof.nativeLinux.status, 'passed'); assert.equal(proof.nativeLinux.cleanup.sshClosed, true);
assert.equal(proof.nativeLinux.cleanup.observedOwnedProcesses, 0);
for (const path of [resultPath, usagePath, nextPath]) assert.ok(read(path).length > 0);
const number = value => { assert.ok(value.tests > 0); assert.equal(value.tests, value.pass);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(value[key], 0); return value.tests; };
const fresh = number(proof.nativeLinux.newTests), related = number(proof.nativeLinux.relatedTests), all = number(proof.nativeLinux.tests);
assert.equal(number(proof.local.newTests.tests), fresh); assert.equal(number(proof.local.relatedTests.tests), related);
const intro = `모델 입력·출력·총 문맥 창을 구분하고, 필수 상태와 현재 원문이 들어가는지 먼저 확인한 뒤 과거 대화 compact를 연결했다. 같은 준비 결과를 재사용하며 실제 요청은 게시 후 다시 측정한다. macOS Node24 신규 **${fresh}/${fresh}**·관련 **${related}/${related}**, NAS Linux Node24 전체 **${all.toLocaleString('en-US')}/${all.toLocaleString('en-US')}**을 같은 소스로 통과했다. [C04 문맥 창 결과](${root}/${resultPath}) · [사용법](${root}/${usagePath}) · [확정 증거](${root}/${proofPath}). 다음은 [등록된 모델 프로필과 일반 입구 연결 검토](${root}/${nextPath})다. 실제 모델/API 시험은 중단 상태이며 C04 전체·Windows·PostgreSQL·사내 연동과 전체 goal은 미완료다.`;
function replaceExactly(text, before, after, label) {
  const at = text.indexOf(before); assert.ok(at >= 0 && text.indexOf(before, at + before.length) === -1, 'document anchor changed: ' + label);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
const updates = new Map();
for (const path of ['design/03-migration-plan.md', 'design/README.md', 'runtime/README.md']) {
  let text = read(path); assert.ok(!text.includes('C04 문맥 창 결과'));
  if (path !== 'runtime/README.md') text = replaceExactly(text, 'v0.57 · C04 일반 요청 첫 흐름 검증과 모델 입력 한도 연결', 'v0.58 · C04 문맥 창 검증과 등록 모델 입구 연결', path + ' revision');
  if (path === 'design/README.md') text = replaceExactly(text,
    '현재 goal은 C04 일반 요청 연결의 검증 결과를 보존하고 모델 입력 한도와 compact 조정을 이어 구현한다.',
    '현재 goal은 C04 일반 요청·문맥 창 검증 결과를 보존하고 등록된 모델 프로필을 CLI·Web의 일반 실행 입구에 연결하는 것이다. 이 입구 연결은 아직 미구현이다.', path + ' current goal');
  if (path === 'design/03-migration-plan.md') text = replaceExactly(text,
    '다음은 [모델 입력 한도와 compact 조정](chapters/C04-context-window-plan.md)이며 기존 호출 예약·정산·복구를 재사용한다.',
    '이어서 [문맥 창 연결](chapters/C04-context-window-result.md)을 검증했다. 다음은 [등록된 모델 프로필과 일반 입구 연결](chapters/C04-after-window-review.md)이며 아직 미구현이다. 기존 호출 예약·정산·복구를 재사용한다.', path + ' C04 next unit');
  if (path === 'runtime/README.md') text = replaceExactly(text,
    '현재 결과와 C03 후속은 문서 맨 위와 통합 계획을 따른다.',
    '현재 결과와 C04 후속은 문서 맨 위와 통합 계획을 따른다.', path + ' history scope');
  const firstBreak = text.indexOf('\n'); assert.ok(firstBreak > 0);
  text = text.slice(0, firstBreak + 1) + '\n' + intro + '\n' + text.slice(firstBreak + 1);
  text = text.replace('2026-09-07 일반 요청 → 주 모델 턴', '이전 C04 첫 흐름의 검증 기록: 2026-09-07 일반 요청 → 주 모델 턴');
  updates.set(path, text);
}
const verification = read('design/VERIFICATION.md');
assert.ok(!verification.includes('## C04 모델 문맥 창'));
updates.set('design/VERIFICATION.md', verification.replace('# 산출물 검증 결과\n', `# 산출물 검증 결과\n\n## C04 모델 문맥 창\n\n${intro}\n\n신규 1차의 fixture 소유 등록 누락과 기대값 오류, 2차의 file-journal 60초 timeout을 원로그와 함께 보존했다. 소스 변경 없이 제한된 병렬도에서 신규 전체가 통과했다. 시간 초과의 단일 원인을 확정하지 않는다. NAS 원로그/결과9개 회수와 전용 프로세스 감사·SSH 종료를 확인했다. 실제 모델의 tokenizer 정확도·요약/답변 품질·실사용 성능과 브라우저 렌더링은 이 결과의 범위 밖이다.\n`));
const backlog = JSON.parse(read('design/implementation-backlog.json'));
assert.equal(backlog.revision, 'v0.57'); backlog.revision = 'v0.58'; backlog.next_execution_chapter = 'C04';
const chapter = backlog.execution_chapters.find(item => item.id === 'C04'); assert.ok(chapter);
chapter.status = 'in_progress'; chapter.current_implementation = 'context window and adaptive compact verified; registered model entry integration next';
chapter.context_window_progress = { status: proof.status, currentVerification: proofPath, result: resultPath, usage: usagePath,
  sourceAndBuild: proof.sourceAndBuild, local: { node: 'v24.20.0', newTests: fresh, relatedTests: related, fullTests: 'not_run' },
  nativeLinux: { node: proof.nativeLinux.environment.node, sessionId: 13419, finishedAt: proof.nativeLinux.finishedAt,
    tests: all, newTests: fresh, relatedTests: related, sshClosed: true, observedOwnedProcesses: 0 },
  chapterComplete: false, goalComplete: false, realModelApi: 'cancelled', browser: 'not_executed_for_this_unit' };
chapter.nextPlan = nextPath;
const allocationNotes = chapter.follow_up_observations.filter(item => item.source === 'C02_compact_model_window_allocation');
assert.equal(allocationNotes.length, 1);
allocationNotes[0].item = 'Historical observation before the C04 window unit: ' + allocationNotes[0].item;
Object.assign(allocationNotes[0], { status: 'addressed_by_context_window_unit_on_supported_posix', addressed_by: resultPath,
  current_remaining: 'Registered model profile entry integration and real-model estimator/quality validation remain. Actual model/API experiments stay paused.' });
backlog.next_local_work_item = { id: 'C04', id_kind: 'execution_chapter', scope: 'registered_model_profile_general_entry_integration', next_design: nextPath,
  prerequisite_note: 'General turn and model window units are verified on Linux. Reuse existing adapters/lifecycle, preserve actual API pause, and do not rerun finished validation without a relevant change.' };
updates.set('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');
const checkpoint = `Checkpoint275: C04 문맥 창 단위는 macOS Node24 신규${fresh}/${fresh}·관련${related}/${related}, NAS Linux 전체${all}/${all} 및8단계를 같은 source/build로 통과했다. NAS13419 종료·원로그9개 회수·관측 가능한 전용 프로세스0·SSH 종료를 확인했다. ${proofPath}가 확정 근거다. 소스${proof.sourceAndBuild.sourceDigest}/build${proof.sourceAndBuild.filesDigest}/${proof.sourceAndBuild.fileCount}파일. 이전 실패·시간초과는 보존했고 원인을 과장하지 않는다. 다음은 ${nextPath}의 등록 모델 프로필 일반 입구 연결이다. 이번 단위·이전NAS를 반복하지 않는다. C04 전체/Windows/PostgreSQL/실제 연동/goal은 미완료이며 실제모델API중단 유지.`;
updates.set('design/IMPLEMENTATION-RESUME.md', replaceExactly(read('design/IMPLEMENTATION-RESUME.md'),
  '## 현재 진행 단위 — C04 모델 입력 한도와 compact 조정\n',
  '## 현재 진행 단위 — C04 등록 모델과 일반 입구 연결\n\n' + checkpoint + '\n\n### 이전 구현·검증 이력\n\n아래 Checkpoint274 이하와 재개 주의는 당시 상태를 보존한 기록이다. 실행 중 여부·Node 버전·다음 작업은 위 Checkpoint275와 현재 확정 증거를 따르며, 과거 명령을 새 지시로 실행하지 않는다.\n', 'resume current unit'));
updates.set('design/WORKLOG.md', read('design/WORKLOG.md') + '\n\n## Checkpoint275 — C04 문맥 창 검증\n\n' + checkpoint + '\n');
const progress = JSON.parse(read('runtime/evidence/C04-context-window-implementation-checkpoint.json'));
Object.assign(progress, { checkpoint: 275, status: proof.status, nativeFinished: true, nativeSSHClosed: true,
  finalProof: proofPath, proofSha256: createHash('sha256').update(proofText).digest('hex'), next: nextPath });
updates.set('runtime/evidence/C04-context-window-implementation-checkpoint.json', JSON.stringify(progress, null, 2) + '\n');
for (const [path, text] of updates) writeFileSync(resolve(root, path), text);
console.log(JSON.stringify({ updated: [...updates.keys()], fresh, related, all, next: nextPath }));
