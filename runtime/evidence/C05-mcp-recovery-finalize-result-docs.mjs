// Run once from runtime with the build's Node24 after root authorizes the final proof.
// This reads retained evidence and changes only the four narrative documents below.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

assert.equal(process.argv.length, 2, 'no arguments; final recovery proof required');
assert.match(process.version, /^v24\./, 'use the recorded Node24 build runtime');
const runtime = realpathSync(fileURLToPath(new URL('../', import.meta.url))), root = dirname(runtime);
assert.equal(realpathSync(process.cwd()), runtime, 'run from runtime');
const evidence = 'runtime/evidence/C05-mcp-recovery-linux-nas-20260907';
const proofPath = evidence + '/verification.json';
const paths = {
  result: 'design/chapters/C05-mcp-response-recovery-result.md',
  plan: 'design/chapters/C05-mcp-response-recovery-plan.md',
  usage: 'design/chapters/C05-mcp-host-usage.md',
  next: 'design/chapters/C05-mcp-sent-authority-plan.md',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const observed = new Map();
function bytes(path) {
  assert.match(path, /^(?:runtime|design)\/[a-zA-Z0-9_./-]+$/);
  assert.ok(!path.split('/').includes('..'));
  const absolute = resolve(root, path), stat = lstatSync(absolute);
  assert.equal(realpathSync(absolute), absolute);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 128 * 1024 * 1024, 'bounded regular file: ' + path);
  const value = readFileSync(absolute), digest = sha(value);
  if (observed.has(path)) assert.equal(digest, observed.get(path), 'file changed while preparing update: ' + path);
  observed.set(path, digest); return value;
}
const read = path => bytes(path).toString('utf8'), json = path => JSON.parse(read(path));
// A missing or incomplete proof fails here, before any document is prepared or written.
const proof = json(proofPath), proofHash = observed.get(proofPath), pin = proof.sourceAndBuild;
assert.equal(proof.schemaVersion, 1); assert.equal(proof.chapter, 'C05');
assert.equal(proof.scope, 'mcp_stored_result_recovery_general_entry');
assert.equal(proof.status, 'verified_supported_local_posix_partial_chapter');
assert.equal(proof.chapterComplete, false); assert.equal(proof.goalComplete, false);
assert.ok(Number.isFinite(Date.parse(proof.recordedAt)));
assert.deepEqual(await verifyEvaluationBuild(runtime), pin);
assert.ok(Array.isArray(proof.files) && proof.files.length > 0 && proof.files.length <= 2048);
const retained = new Map(proof.files.map(item => [item.path, item.sha256]));
assert.equal(retained.size, proof.files.length, 'duplicate evidence path');
// The finalizer already hashed and parsed every original log. Recheck the selected
// result records and their manifest hashes here, rather than repeat that full audit.
function original(path) {
  assert.ok(retained.has(path), 'original absent from final hash manifest: ' + path);
  const value = bytes(path); assert.equal(sha(value), retained.get(path)); return JSON.parse(value.toString('utf8'));
}
function count(summary) {
  assert.ok(Number.isSafeInteger(summary.tests) && summary.tests > 0); assert.equal(summary.pass, summary.tests);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo', 'timeoutFailures']) assert.equal(summary[key], 0);
  return summary.tests;
}
const local = proof.local, native = proof.nativeLinux;
assert.equal(local.platform, 'darwin'); assert.equal(local.nodeScope, 'finalization_process_only');
assert.equal(local.build.node, process.version); assert.deepEqual(local.build.sourceAndBuild, pin);
assert.equal(sha(bytes(local.build.manifest)), local.build.manifestSha256);
assert.equal(local.fullTests.status, 'not_run_for_this_final_source_locally');
for (const selected of [local.newTests, local.relatedTests]) {
  const actual = original(selected.result);
  assert.equal(actual.code, 0); assert.equal(actual.signal, null); assert.equal(actual.timedOut, false);
  assert.equal(actual.processEvidence.exitCode, 0); assert.deepEqual(actual.sourceAndBuild, pin);
  assert.equal(actual.testNode, process.version); assert.equal(selected.testNode, actual.testNode);
  assert.equal(actual.sourceObservation.kind, 'per_run_source_and_build_verification');
  assert.deepEqual(actual.sourceObservation.before, pin); assert.deepEqual(actual.sourceObservation.after, pin);
  assert.equal(selected.log, 'runtime/' + actual.logPath); assert.ok(retained.has(selected.log));
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) assert.equal(actual.counts[key], selected.tests[key]);
}
const localNew = count(local.newTests.tests), localRelated = count(local.relatedTests.tests);
const rawNative = original(evidence + '/final/result.json');
const collection = original(evidence + '/final-collection.json'), cleanup = original(evidence + '/cleanup.json');
assert.equal(native.status, 'passed'); assert.equal(rawNative.status, 'passed'); assert.equal(collection.status, 'passed');
assert.deepEqual(rawNative.buildPin, pin); assert.deepEqual(native.sourceAndBuild, pin); assert.deepEqual(collection.sourceAndBuild, pin);
assert.equal(native.environment.platform, 'linux'); assert.equal(native.environment.node, 'v24.20.0');
assert.deepEqual(native.environment, rawNative.environment); assert.deepEqual(native.steps, rawNative.steps);
assert.equal(rawNative.finishedAt, native.finishedAt); assert.equal(collection.finishedAt, native.finishedAt);
assert.ok(Number.isFinite(Date.parse(native.finishedAt))); assert.ok(Date.parse(proof.recordedAt) >= Date.parse(native.finishedAt));
assert.deepEqual(native.cleanup, cleanup); assert.equal(cleanup.sshClosed, true); assert.equal(cleanup.observedOwnedProcesses, 0);
assert.deepEqual(cleanup.auditErrors, []); assert.equal(cleanup.globalProcessAbsenceProven, false);
assert.ok(Array.isArray(cleanup.inaccessiblePeers) && Array.isArray(cleanup.unresolved));
assert.ok(Date.parse(cleanup.at) >= Date.parse(native.finishedAt));
const stepNames = ['build', 'new-mcp-stored-result-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
assert.deepEqual(native.steps.map(step => step.name), stepNames);
for (const step of native.steps) {
  assert.equal(step.status, 'passed'); assert.equal(step.exitCode, 0); assert.equal(step.signal, null);
  assert.equal(step.timedOut, false); assert.equal(step.terminationReason, null); assert.equal(step.nodeTestTimeoutFailures, 0);
  assert.equal(step.groupAbsentConfirmed, true); assert.equal(step.finalGroupState, 'absent'); assert.equal(step.logFlushCompleted, true);
  assert.deepEqual(step.errors, []); assert.equal(step.leaderExit?.code, 0); assert.equal(step.stdioClose?.code, 0);
}
assert.deepEqual(native.collectedFiles, collection.files); assert.equal(collection.files.length, stepNames.length + 1);
assert.deepEqual(collection.files.map(item => item.file).sort(), ['result.json', ...stepNames.map(name => name + '.log')].sort());
for (const item of collection.files) assert.equal(retained.get(evidence + '/final/' + item.file), item.sha256);
const nativeNew = count(native.newTests), nativeRelated = count(native.relatedTests), nativeAll = count(native.tests);
for (const [name, summary] of [['new-mcp-stored-result-tests', native.newTests], ['related-existing-tests', native.relatedTests], ['all-tests', native.tests]]) {
  const recorded = rawNative.steps.find(step => step.name === name).tapSummary;
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) assert.equal(recorded[key], summary[key]);
}
assert.equal(nativeNew, localNew); assert.equal(nativeRelated, localRelated);
assert.deepEqual(native.targetedFiles, rawNative.targeted.files); assert.deepEqual(native.relatedFiles, rawNative.related.files);
const previousPath = 'runtime/evidence/C05-mcp-linux-nas-20260907/verification.json';
const previous = original(previousPath);
assert.ok(proof.historicalEvidence.some(item => item.path === previousPath && item.sha256 === observed.get(previousPath)));
assert.equal(previous.nativeLinux.status, 'passed');

const number = n => n.toLocaleString('en-US'), pair = n => `${number(n)}/${number(n)}`;
const verified = `macOS Node24 신규 ${pair(localNew)}·관련 ${pair(localRelated)}, NAS Linux Node24 신규 ${pair(nativeNew)}·관련 ${pair(nativeRelated)}·전체 ${pair(nativeAll)} 통과`;
const proofLink = `[복구 확정 증거](../../${proofPath})`;
const limits = 'C05 전체와 C01–C10 목표는 미완료다. 실제 모델/API 시험은 중단 상태이며 합성 모델·로컬 MCP peer의 계약 인수를 실제 모델 품질이나 사내 서비스 운영 검증으로 해석하지 않는다. native Windows runtime/file 연결·검증, PostgreSQL 및 설치·운영도 남아 있다.';
const marker = `<!-- C05-MCP-RECOVERY-NARRATIVE-PROOF: ${proofHash} -->`;
const originals = new Map(Object.values(paths).map(path => [path, read(path)])), updates = new Map();
for (const [path, text] of originals) assert.ok(!text.includes('C05-MCP-RECOVERY-NARRATIVE-PROOF:'), 'already finalized: ' + path);
function once(text, before, after, label) {
  const at = text.indexOf(before); assert.ok(at >= 0 && text.indexOf(before, at + before.length) < 0, 'anchor changed: ' + label);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function paragraph(text, prefix, transform) {
  const found = text.split('\n\n').filter(value => value.startsWith(prefix)); assert.equal(found.length, 1, 'paragraph anchor: ' + prefix);
  return once(text, found[0], transform(found[0]), prefix);
}
function section(text, start, end, replacement) {
  assert.equal(text.split(start).length, 2); assert.equal(text.split(end).length, 2);
  const from = text.indexOf(start), to = text.indexOf(end); assert.ok(to > from);
  return text.slice(0, from) + replacement + '\n\n' + text.slice(to);
}
function stamp(text) { const end = text.indexOf('\n\n'); assert.ok(end > 0); return text.slice(0, end + 2) + marker + '\n\n' + text.slice(end + 2); }
const date = proof.recordedAt.slice(0, 10);
let result = originals.get(paths.result);
result = paragraph(result, '2026-09-07 · **구현과 macOS의 Node24 검증을 마쳤다.', old => {
  assert.ok(old.includes('아직 통과 결과가 없다.'));
  return `${date} · **지원 POSIX의 단순 MCP 저장 응답 복구를 검증했다. ${verified}.** 같은 소스·빌드에서 필수 ${native.steps.length}단계와 원로그 회수·정리를 완료했다. ${proofLink}. ${limits}`;
});
const qualifier = '새 인수 시험은 SQLite/file-journal 저장소, 실제 stdio MCP 프로세스의 강제 종료와 새 소유자 재개를 포함한다.';
const evidenceText = result.slice(result.indexOf('## 현재 확인한 증거'), result.indexOf('## 남은 범위'));
const evidenceQualifier = evidenceText.split('\n\n').find(value => value.startsWith(qualifier)); assert.ok(evidenceQualifier);
result = section(result, '## 현재 확인한 증거', '## 남은 범위', `## 현재 확인한 증거

| 검증 | 확정 결과 |
|---|---|
| 로컬 Node24 빌드·코어 타입·계층 검사 | 원 종료코드 0, ${proofLink}의 원 로그·종료 기록과 동일 소스 확인 |
| 로컬 신규 ${native.targetedFiles.length}개 파일 | [${pair(localNew)} 통과 원로그](../../${local.newTests.log}) |
| 로컬 기존 관련 ${native.relatedFiles.length}개 파일 | [${pair(localRelated)} 통과 원로그](../../${local.relatedTests.log}) |
| NAS Linux 신규 / 관련 | [${pair(nativeNew)} 신규](../../${evidence}/final/new-mcp-stored-result-tests.log) · [${pair(nativeRelated)} 관련](../../${evidence}/final/related-existing-tests.log) |
| NAS Linux 전체 | [${pair(nativeAll)} 통과 원로그](../../${evidence}/final/all-tests.log) |
| NAS 필수 ${native.steps.length}단계 / 원로그 회수 | [모두 종료코드 0](../../${evidence}/final/result.json) · [${collection.files.length}개 결과·로그 회수](../../${evidence}/final-collection.json) |

로컬과 Linux의 소스는 \`${pin.sourceDigest}\`, 빌드는 \`${pin.filesDigest}\`로 일치했다. 빌드 출력은 ${number(pin.fileCount)}개 파일이다. Linux 종료 관측은 \`${native.finishedAt}\`이며 로컬 종료 관측의 의미는 원 stage 기록을 따른다. 이번 최종 소스의 전체 회귀는 Linux에서 수행했으며 macOS 전체 회귀를 추가 통과로 표시하지 않는다.

[정리 기록](../../${evidence}/cleanup.json)에서 관측 가능한 전용 경로의 소유 프로세스 ${cleanup.observedOwnedProcesses}개와 SSH 종료를 확인했다. 접근 불가 peer·소유를 확정할 수 없는 관측은 기록대로 남으며 시스템 전체 프로세스 부재를 증명한 것은 아니다. SIGKILL·주입 I/O 경계 인수는 전원 장애 내구성 시험이 아니다.

${evidenceQualifier}

MCP 최초 입구 연결 당시의 로컬 신규 ${pair(previous.local.newTests.tests.tests)}·관련 ${pair(previous.local.relatedTests.tests.tests)}·Linux 전체 ${pair(previous.nativeLinux.tests.tests)}는 [이전 확정 기록](../../${previousPath})으로 보존한다. 이 수치를 이번 복구 시험 수에 합산하지 않는다.`);
result = once(result, '다음 실행 절차는 [Linux 검증 준비 문서]', '실행·회수 절차는 [Linux 검증 준비 문서]', 'result procedure');
result += '\n다음 제품 단위는 [전송 뒤 권한 변경과 원응답 보존](C05-mcp-sent-authority-plan.md)이며 아직 구현에 착수하지 않았다.\n';
updates.set(paths.result, stamp(result));

let plan = originals.get(paths.plan);
plan = paragraph(plan, '2026-09-07 · **구현을 마치고 Node24 빌드·코어 타입·계층 검사를 통과했다.', old => {
  const split = ' 현재 MCP 최초 입구 연결은 '; assert.equal(old.split(split).length, 2);
  return `${date} · **단순 MCP 저장 응답 복구를 구현하고 지원 POSIX에서 검증했다. ${verified}.** 같은 소스·빌드의 필수 ${native.steps.length}단계·회수·정리가 ${proofLink}로 확정되었다. [현재 구현 결과](C05-mcp-response-recovery-result.md). ${limits}\n\nMCP 최초 입구 연결 당시의 기록: ${old.split(split)[1]}`;
});
plan = paragraph(plan, '현재 신규 시험은 코어·실행기·MCP 원문·실제 stdio 프로세스 중단·컴팩트 순서를 다루는 ', () =>
  `현재 신규 ${native.targetedFiles.length}개 파일은 코어·실행기·MCP 원문·실제 stdio 프로세스 중단·컴팩트 순서를 다룬다. ${verified}. 실행한 범위와 한계는 [결과 문서](C05-mcp-response-recovery-result.md)와 ${proofLink}를 따른다. 아래는 착수 당시의 경계 조사·계약 제안·시험 계획을 보존한 기록이며, “현재 공백”·“추가할” 표현은 당시 상태다.`);
plan = paragraph(plan, '새 인수와 영향받은 기존 execution·MCP·collection 복구·host/profile 회귀를 최종 소스에서 수행하고,', () =>
  `위 착수 계획에 이어 구현·통합 검증을 수행한 최종 결과는 ${proofLink}와 [결과 문서](C05-mcp-response-recovery-result.md)에 확정했다. 이 문서 갱신 자체는 시험 재실행이 아니다. 다음 [전송 후 권한 변경 수신 보존](C05-mcp-sent-authority-plan.md)은 제품 미착수이며, 서버 없는 일반 프로필 열기·페이지와 대기 입구·실제 사내 MCP·모델 API·Knox·native Windows를 이번 복구 완료로 함께 닫지 않는다.`);
updates.set(paths.plan, stamp(plan));

let usage = originals.get(paths.usage);
usage = paragraph(usage, '2026-09-07 · **구현과 지원 POSIX 검증을 완료한 연결의 사용·개념 문서다.**', old =>
  `${date} · **기존 MCP 등록 API에 단순 저장 응답 복구를 연결했다. ${verified}.** ${proofLink}와 [복구 결과](C05-mcp-response-recovery-result.md)를 기준으로 아래 재개 범위를 갱신했다. ${limits}\n\n최초 MCP 연결 당시 검증 기록(아래 “현재”는 당시 상태): ${old}`);
const offline = usage.split('\n\n').find(value => value.startsWith('**현재 재접속은 offline이 아니다.**')); assert.ok(offline);
usage = section(usage, '## 저장한 응답으로 이어가기', '## 실제로 확인한 예제와 남은 검증', `## 저장한 응답으로 이어가기

정상 읽기는 기존 **dispatch → MCP intent → 원응답 artifact → MCP response 영수증 → 실행기 received → 근거 채택 → 답변** 순서를 따른다. intent는 호출 의도 기록이고, received는 실행기가 결과를 수신한 상태다. 원문은 SDK가 해석한 MCP 응답 JSON이며 전송선의 wire 바이트 녹화가 아니다.

이제 **원응답과 MCP response 영수증이 모두 저장됐지만 received 전 프로그램이 종료된 경우**도 검증된 같은 시도의 결과로 복원한다. 원 dispatch·intent·영수증·실제 원문 바이트와 현재 목표·계획·권한·출처를 대조하며, 원 실행자와 lease(호출 유효 시간)를 바꾸지 않는다. lease 만료만 기록된 시도도 이 증명 범위에서 확인하지만 사용자 취소·명시 실패·새 계획·후속 시도를 옛 결과로 되살리지는 않는다. 이미 received이거나 완료된 경우는 기존의 중복 없는 수신·정산 경로를 유지한다.

재개 순서는 **저장 응답 수신 → 채택 또는 거절·정산 → 필요한 compact → 문맥 체크포인트 → 이후 계획과 실행**이다. compact는 긴 대화를 정리하는 과정이며 원응답 수신을 대신하지 않는다. 복구가 tools/call이나 논리 도구 호출 예산을 추가 소비하지 않고, 이후 새 답변·compact에는 기존 모델 예산과 deadline을 그대로 적용한다.

원문 파일만 있거나 intent만 있고 response 영수증이 없으면 \`stored_result_unavailable\`, 귀속·현재성 증명을 확인하지 못하면 \`stored_result_recovery_failed\`로 멈춘다. 자동 재조회로 누락을 숨기지 않는다. 이미 명시적으로 차단된 업무는 원 차단 사유를 유지하며 명시적 재개 뒤 다시 검증한다. 영수증의 관측 시각은 캡처·트랜잭션 준비 시각이지 물리 commit 완료나 재시작 간 단조 시계의 증명이 아니다.

${offline}

남은 범위는 [전송 뒤 권한 변경의 원응답·보고 사용량 보존](C05-mcp-sent-authority-plan.md), 서버 발견 없는 일반 CLI/Web 재개, 일반 입구의 페이지 수집·대기·재조정 연결이다. 전송된 뒤 Promise가 먼저 거절돼 실제 응답 값이 없는 경우를 복원 가능하다고 주장하지 않는다. [MCP 후속 순서](C05-mcp-host-plan.md)를 유지하며 기존 collection·wait 구현과 일반 입구 인수 완료를 구분한다.`);
usage = once(usage, '신규 로컬 30개 묶음에는 ', '최초 연결 당시 신규 로컬 30개 묶음에는 ', 'usage historical tests');
usage = once(usage, '[현재 결과](C05-mcp-host-result.md)에 로컬 회귀와 NAS 상태를 구분해 기록한다.',
  '[최초 연결 결과](C05-mcp-host-result.md)는 당시 기록이며, [현재 복구 결과](C05-mcp-response-recovery-result.md)에 이번 로컬·Linux 검증과 한계를 구분해 기록한다.', 'usage current result');
updates.set(paths.usage, stamp(usage));

let next = originals.get(paths.next);
next = paragraph(next, '2026-09-07 · **후속 구현 계획이며 제품 미착수다.**', () =>
  `${date} · **선행 단순 원응답 복구의 지원 POSIX 검증은 완료했고, 이 전송 후 권한 변경 단위는 제품 미착수다.** 선행 결과는 ${verified}. 같은 소스·빌드의 필수 ${native.steps.length}단계·회수·정리가 ${proofLink}로 확정되었다. [선행 결과](C05-mcp-response-recovery-result.md)를 보존하고 아래 좁은 계약을 확정한 뒤 다음 제품 구현을 시작한다. 실제 모델/API 시험은 계속 중단 상태다.`);
next = paragraph(next, '판단 근거는 [후속 소스 검토 기록]', old => {
  assert.ok(old.includes('진행 중 관측이며 최종 통과 수가 아니다.'));
  return '판단 근거는 [후속 소스 검토 기록](../../runtime/evidence/C05-mcp-sent-authority-source-review.json)에 분리했다. 해당 기록의 Linux 수치는 작성 당시 진행 중 관측으로 보존한다. 현재 선행 검증 결과는 위 확정 증거를 따르며, 선행 통과를 아래 새 권한·보관 기능의 구현 증거로 사용하지 않는다.';
});
next = paragraph(next, '선행 Linux 검증을 통과한 뒤 이 단위를 구현하고,', old => {
  const after = '서버 없는 일반 입구, collection/페이지/대기,'; assert.equal(old.split(after).length, 2);
  return '선행 Linux 검증은 완료되었다. 이 다음 단위는 아직 제품 미착수이며, 구현 후 최종 소스에서 새 인수·관련 MCP/host/execution/복구 회귀·build/core/계층 및 유한 Linux 통합 검증을 수행해야 종료할 수 있다. 이번 문서 갱신은 그 다음 검증을 실행한 것이 아니다. ' + after + old.split(after)[1];
});
updates.set(paths.next, stamp(next));

const codeBlocks = text => [...text.matchAll(/^```[^\n]*\n[\s\S]*?^```\s*$/gm)].map(match => match[0]);
assert.deepEqual(codeBlocks(updates.get(paths.usage)), codeBlocks(originals.get(paths.usage)), 'usage API/examples changed');
let checkedLinks = 0;
for (const [path, text] of updates) {
  assert.equal(text.split(marker).length, 2); assert.equal((text.match(/^```/gm) ?? []).length % 2, 0, 'unbalanced code fence');
  const markup = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  for (const match of markup.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
    const href = match[1]; if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    const file = resolve(dirname(resolve(root, path)), decodeURIComponent(href.split('#')[0]));
    assert.ok(file.startsWith(root + '/'), 'link escapes repository');
    const stat = lstatSync(file); assert.equal(realpathSync(file), file); assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'missing local link: ' + href);
    checkedLinks++;
  }
}
// Preparation is all-or-nothing. These are four ordinary file writes, not a filesystem-wide transaction.
assert.deepEqual(await verifyEvaluationBuild(runtime), pin);
for (const [path, digest] of observed) assert.equal(sha(readFileSync(resolve(root, path))), digest, 'input changed before write: ' + path);
for (const [path, text] of originals) assert.equal(readFileSync(resolve(root, path), 'utf8'), text);
for (const [path, text] of updates) writeFileSync(resolve(root, path), text, 'utf8');
for (const [path, text] of updates) assert.equal(readFileSync(resolve(root, path), 'utf8'), text, 'written content mismatch');
console.log(JSON.stringify({ status: 'updated', proof: { path: proofPath, sha256: proofHash }, sourceAndBuild: pin,
  local: { new: localNew, related: localRelated }, nativeLinux: { new: nativeNew, related: nativeRelated, all: nativeAll, finishedAt: native.finishedAt },
  nativeSteps: native.steps.length, collectedFiles: collection.files.length, checkedLocalLinks: checkedLinks,
  finalProofEvidenceFiles: retained.size, recheckedInputFiles: observed.size, usageCodeBlocksPreserved: codeBlocks(originals.get(paths.usage)).length,
  browserValidation: 'not_run', testsRunByThisScript: false, nextProductImplementation: 'not_started',
  documents: [...updates].map(([path, text]) => ({ path, beforeSha256: observed.get(path), afterSha256: sha(text) })) }, null, 2));
