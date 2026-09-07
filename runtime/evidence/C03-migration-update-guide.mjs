// Prepare now; execute once only after the final D3 evidence is published.
// Reads local proof/source pins and writes only design/secumon-review.html.
// No build, test, browser, model, network, or migration execution.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

assert.equal(process.argv.length, 2, 'No path overrides or bypass arguments');
assert.equal(process.version, 'v24.20.0', 'Use the same supported Node version as the verified build');
const runtime = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const root = realpathSync(resolve(runtime, '..'));
const proofPath = 'runtime/evidence/C03-migration-verification.json';
const target = 'design/secumon-review.html';
const resultPath = 'design/chapters/C03-personal-memory-migration-result.md';
const usagePath = 'design/chapters/C03-memory-migrate-usage.md';
const nextPlan = 'design/chapters/C04-general-turn-plan.md';
const markerName = 'C03-D3-FINAL-PROOF';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function checkedPath(path) {
  assert.ok(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\'));
  const absolute = resolve(root, path), part = relative(root, absolute);
  assert.ok(part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part), 'Repository-relative path required');
  const stat = lstatSync(absolute);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Regular local file required: ' + path);
  assert.equal(realpathSync(absolute), absolute, 'Linked paths are not accepted');
  return absolute;
}
function read(path, maximum = 128 * 1024 * 1024) {
  const absolute = checkedPath(path);
  assert.ok(lstatSync(absolute).size <= maximum, 'Bounded local read: ' + path);
  const bytes = readFileSync(absolute);
  assert.ok(bytes.length <= maximum); return bytes;
}
const proofBytes = read(proofPath, 16 * 1024 * 1024);
const proof = JSON.parse(proofBytes.toString('utf8')), proofHash = hash(proofBytes);
assert.equal(proof.schemaVersion, 1); assert.equal(proof.chapter, 'C03');
assert.equal(proof.scope, 'D3_explicit_personal_memory_sqlite_to_documents_backup_fence_seed_activation_recovery');
assert.equal(proof.status, 'verified_supported_local_posix_partial_chapter');
assert.equal(proof.chapterComplete, false); assert.equal(proof.goalComplete, false);
assert.ok(Number.isFinite(Date.parse(proof.recordedAt)));
function pin(value) {
  assert.match(value?.sourceDigest ?? '', /^[a-f0-9]{64}$/);
  assert.match(value?.filesDigest ?? '', /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(value.fileCount) && value.fileCount > 0);
  return { sourceDigest: value.sourceDigest, filesDigest: value.filesDigest, fileCount: value.fileCount };
}
const expectedPin = pin(proof.sourceAndBuild);
const { verifyEvaluationBuild } = await import(pathToFileURL(checkedPath('runtime/dist/infrastructure/local-evaluation.js')).href);
assert.deepEqual(await verifyEvaluationBuild(runtime), expectedPin, 'Final proof must match current source and build');
const linux = proof.nativeLinux;
assert.equal(linux?.status, 'passed'); assert.ok(Number.isFinite(Date.parse(linux.finishedAt)));
assert.equal(linux.environment.platform, 'linux'); assert.equal(linux.environment.node, process.version);
assert.deepEqual(pin(linux.sourceAndBuild), expectedPin);
const expectedSteps = ['build', 'migration-new', 'migration-related', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
assert.deepEqual(linux.steps.map(step => step.name), expectedSteps);
for (const step of linux.steps) {
  assert.equal(step.status, 'passed'); assert.equal(step.exitCode, 0); assert.equal(step.signal, null);
  assert.equal(step.timedOut, false); assert.equal(step.terminationReason, null);
  assert.equal(step.nodeTestTimeoutFailures, 0); assert.equal(step.groupAbsentConfirmed, true);
  assert.equal(step.finalGroupState, 'absent'); assert.equal(step.logFlushCompleted, true);
  assert.deepEqual(step.errors, []);
}
function counts(value) {
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0);
  assert.ok(value.tests > 0); assert.equal(value.pass, value.tests);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo', 'timeoutFailures']) assert.equal(value[key], 0);
  return Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, value[key]]));
}
const full = counts(linux.tests), fresh = counts(linux.newTests), related = counts(linux.relatedTests);
assert.equal(proof.local.build.status, 'current_build_manifest_verified');
assert.deepEqual(pin(proof.local.build.sourceAndBuild), expectedPin);
for (const local of [proof.local.newTests, proof.local.relatedTests]) {
  assert.deepEqual(pin(local.sourceAndBuild), expectedPin); counts(local.tests);
}
for (const audit of [linux.beforeProcesses, linux.afterProcesses, linux.cleanup]) {
  assert.equal(audit.platform, 'linux'); assert.equal(audit.observedOwnedProcesses, 0);
  assert.deepEqual(audit.auditErrors, []); assert.ok(Array.isArray(audit.unresolved));
  assert.equal(audit.globalProcessAbsenceProven, false);
}
assert.equal(linux.cleanup.sshClosed, true);
assert.ok(Date.parse(linux.cleanup.at) >= Date.parse(linux.finishedAt));
assert.ok(Array.isArray(linux.collectedFiles) && linux.collectedFiles.length === expectedSteps.length + 1);
assert.equal(new Set(linux.collectedFiles.map(file => file.file)).size, linux.collectedFiles.length);
assert.equal(proof.recovery.powerLossTested, false);
assert.ok(Array.isArray(proof.limitations) && proof.limitations.length > 0);

// The finalizer already validates the native metadata, collected logs, and SSH cleanup.
// Recheck every referenced local evidence hash so a stale/edited proof cannot update the guide.
assert.ok(Array.isArray(proof.files) && proof.files.length > 0);
const evidence = new Map();
for (const file of proof.files) {
  assert.ok(file.path.startsWith('runtime/evidence/')); assert.ok(!evidence.has(file.path));
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(hash(read(file.path)), file.sha256, 'Evidence changed: ' + file.path);
  evidence.set(file.path, file.sha256);
}
const oldProofPath = 'runtime/evidence/C03-drafts-verification.json';
assert.equal(proof.priorD2.proof, oldProofPath);
assert.equal(proof.priorD2.scope, 'historical_D2_evidence_not_current_D3_verification');
assert.equal(evidence.get(oldProofPath), proof.priorD2.sha256);
const oldProof = JSON.parse(read(oldProofPath).toString('utf8'));
assert.deepEqual(pin(oldProof.sourceAndBuild), pin(proof.priorD2.sourceAndBuild));
for (const path of ['runtime/evidence/C03-drafts-initialization-diagnosis.json', 'runtime/evidence/C03-drafts-mcp-diagnosis.json']) {
  const diagnosis = proof.priorD2.unresolvedDiagnoses.filter(item => item.evidence === path);
  assert.equal(diagnosis.length, 1); assert.equal(diagnosis[0].status, 'bounded_limitation');
  assert.equal(diagnosis[0].sha256, evidence.get(path));
}
for (const path of [resultPath, usagePath, nextPlan, 'design/chapters/C03-remaining-acceptance-review.md']) checkedPath(path);

const original = read(target, 8 * 1024 * 1024).toString('utf8');
assert.ok(!original.includes(markerName), 'One-time update already applied; inspect before any retry');
const replaceOnce = (text, expression, replacement, label) => {
  const matches = [...text.matchAll(new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : expression.flags + 'g'))];
  assert.equal(matches.length, 1, 'Expected one anchor: ' + label);
  return text.replace(expression, () => replacement);
};
const dataExpression = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const dataMatches = [...original.matchAll(new RegExp(dataExpression.source, 'g'))]; assert.equal(dataMatches.length, 1);
const data = JSON.parse(dataMatches[0][1]), oldData = structuredClone(data);
assert.equal(data.snapshot.kind, 'historical-p0-p6');
assert.equal(data.snapshot.currentVerification, oldProofPath, 'Expected D2 guide as the starting point');
assert.equal(data.snapshot.c03D2.proofSha256, proof.priorD2.sha256);
assert.deepEqual(pin(data.snapshot.c03D2.sourceAndBuild), pin(proof.priorD2.sourceAndBuild));
const oldMarkerExpression = /<!-- C03-D2-FINAL-PROOF: ([a-f0-9]{64}) -->/;
assert.equal(original.match(oldMarkerExpression)?.[1], proof.priorD2.sha256);
const esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const number = value => value.toLocaleString('en-US');
const tally = value => `${number(value.pass)} / ${number(value.tests)}`;
const date = proof.recordedAt.slice(0, 10);
const limits = 'C03 전체와 전체 구현 목표는 진행 중이다. Windows 런타임 파일 연결은 미완성·미연결이며 실기 검증도 남았다. PostgreSQL 등록·이관은 미구현이다. 실제 모델/API 시험은 중단 상태이며 사내 서비스 연동은 미검증이다. 합성 시험을 모델 품질 검증으로 보지 않는다.';
const banner = `<!-- ${markerName}: ${proofHash} --><div class="note gap-top" id="latest-status" data-c03-d3-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>${esc(date.replaceAll('-', '.'))} · C03 D3 개인 기억 이관 · Linux 전체 ${tally(full)} 통과</strong><br>기존 SQLite 개인 기억의 명시 이관을 연결했다. 확인한 원본 → 백업 검증 → 원본 개인 기억 제한 → 문서 기록 검증 → 문서 활성화 순서이며 같은 작업 ID로 중단 뒤 이어간다. 대화·작업 상태·담당 ID는 유지한다. 새 담당의 기본 개인 기억은 SQLite다.<br>같은 최종 소스에서 Linux 신규 ${tally(fresh)}·관련 ${tally(related)}·전체 회귀와 필수 단계를 통과했다. 원로그 ${number(linux.collectedFiles.length)}개 회수·관측 가능한 전용 프로세스 ${number(linux.cleanup.observedOwnedProcesses)}·SSH 종료를 확인했다. 접근하지 못한 다른 프로세스 ${number(linux.cleanup.unresolved.length)}개는 범위를 확정하지 못했으므로 시스템 전체의 프로세스 부재를 주장하지 않는다.<br>${esc(limits)} 다음 연결은 C04 범용 대화·일반 업무 흐름이다. 기존 D2 초기화 실패와 MCP 정체의 원인은 여전히 미확정이다. 이번 갱신은 정적 문서 검사이며 브라우저 렌더링 통과를 뜻하지 않는다.<br><a href="chapters/C03-personal-memory-migration-result.md" target="_blank" rel="noopener">D3 결과 →</a> · <a href="../runtime/evidence/C03-migration-verification.json" target="_blank" rel="noopener">최종 증거 →</a> · <a href="chapters/C03-memory-migrate-usage.md" target="_blank" rel="noopener">이관 사용법 →</a> · <a href="chapters/C04-general-turn-plan.md" target="_blank" rel="noopener">다음 C04 연결 계획 →</a></div>`;
let html = replaceOnce(original, oldMarkerExpression, '', 'Move D2 historical marker');
html = replaceOnce(html, /<div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/, banner, 'Latest D3 banner');
const history = `<!-- C03-D2-FINAL-PROOF: ${proof.priorD2.sha256} --><p class="fine gap-top" data-c03-history="D2">과거 D2 검증은 당시 소스의 기록으로 보존했다. 현재 D3의 검증 수치와 구분한다. <a href="chapters/C03-document-draft-result.md" target="_blank" rel="noopener">D2 결과·실패 진단</a> · <a href="../runtime/evidence/C03-drafts-verification.json" target="_blank" rel="noopener">D2 증거</a>. 이후 통과가 당시 초기화·MCP 정체의 원인을 밝혔다는 뜻은 아니다.</p>`;
html = html.replace(banner, () => banner + '\n' + history);
html = replaceOnce(html, /<div class="hero-aside">[\s\S]*?<\/div>/,
  '<div class="hero-aside"><span class="badge partial">C03 D3 개인 기억 이관</span><strong>기억을 보존하며<br>저장 방식을 바꾼다.</strong><p>지원 POSIX 이관을 검증했다. C03 전체는 진행 중이며 다음 연결은 C04 범용 대화·일반 업무다.</p></div>', 'Overview hero');
const moduleById = id => { const found = data.modules.filter(item => item.id === id); assert.equal(found.length, 1); return found[0]; };
const unique = (left, right) => [...new Set([...left, ...right])];
const memory = moduleById('memory'), storage = moduleById('storage');
memory.summary = '개인 기억을 담당·사용자별로 선택해 쓰며, 기존 SQLite 기억을 보존한 채 문서 저장소로 명시 이관한다.';
memory.how.push('D3 이관은 기존 담당의 개인 기억 전체를 옮기는 오프라인 관리다. 대화 요약과 업무 근거는 그대로 두고 기억 ID·최신 내용·저장된 영수증과 감사 기록을 보존한다. 원 SQL에 없는 과거 본문을 만들지 않는다.');
memory.done = `SQLite 기본·문서 선택·편집 초안의 CLI/HTTP 흐름에 이어 기존 개인 기억의 preview·apply·status·같은 ID resume을 연결했다. 백업·원본 사용 제한·문서 활성화를 구분하며 새 기억·정정·잊기를 계속 받는다. D3 같은 최종 소스의 Linux 신규 ${tally(fresh)}·관련 ${tally(related)}·전체 ${tally(full)} 통과. D2 수치는 당시 기록으로 따로 보존한다.`;
memory.left = 'PostgreSQL 저장·이관, Windows 런타임 연결과 실제 검증, 자율 경험 출처 확장, 반복 읽기 비용과 실제 모델 의미 품질은 남아 있다. C03 전체와 전체 목표는 미완료이며 C04 범용 대화 연결은 다음 작업이다.';
memory.files = unique(memory.files, ['runtime/src/presentation/memory-migration-cli.ts', 'runtime/src/infrastructure/personal-memory-migration.ts', 'runtime/src/infrastructure/document-knowledge-import.ts']);
memory.docs = unique(memory.docs, [resultPath, usagePath, nextPlan, 'design/chapters/C03-remaining-acceptance-review.md']);
memory.terms = unique(memory.terms, ['snapshot', 'fence', 'activation']);
storage.how.push('이관은 검증한 SQLite 백업을 문서 초기 기록으로 옮긴 뒤 별도의 활성화 기록으로 현재 정본을 선택한다. 초기 config·배정 기록은 보존하고 effectivePersonalMemory로 현재 방식을 확인한다. 원 DB는 업무 근거와 이관 전 기억을 보존하므로 삭제하지 않는다.');
storage.done += ` D3는 원본 snapshot·백업·초기 기록과 모든 저장 영수증·색인 상태를 대조하고, 원본 제한 뒤 같은 작업으로 재개한다. 문서 format 완료와 실제 활성화는 분리했다. 실제 SIGKILL과 주입 I/O 오류의 합성 복구 시험을 포함하며 Linux 전체 ${tally(full)}을 확인했다.`;
storage.left = 'Windows 공통 파일 경계·SQLite 백업 연결과 실기 검증, PostgreSQL 구현·등록·이관, 역이관과 제한 뒤 취소, 전체 운영 복원은 남아 있다. 전원 장애·원격 공유 파일시스템·동일 계정의 정본과 확인 기록 동시 되돌리기를 검증한 것은 아니다.';
storage.files = unique(storage.files, ['runtime/src/infrastructure/personal-memory-backup.ts', 'runtime/src/infrastructure/personal-memory-migration-profile.ts', 'runtime/src/infrastructure/document-knowledge-import-codec.ts']);
storage.docs = unique(storage.docs, [resultPath, usagePath, nextPlan, 'design/chapters/C03-remaining-acceptance-review.md']);
storage.terms = unique(storage.terms, ['snapshot', 'fence', 'activation']);
for (const term of [
  { id: 'snapshot', en: 'Snapshot', ko: '한 시점에 확인한 기록 묶음', definition: '이관할 기억과 영수증·색인 상태를 같은 시점으로 읽은 묶음. 지문으로 확인한 원본과 나중에 옮기는 내용이 같은지 대조한다.', example: 'preview 뒤 기억이 바뀌면 확인했던 지문과 달라져 전환을 거절한다. 대화 요약이나 과거 본문 복원이라는 뜻은 아니다.', module: 'storage' },
  { id: 'fence', en: 'Source fence', ko: '원본 개인 기억 사용 제한', definition: '검증한 백업 이후 원본 SQLite 개인 기억의 사용을 막아 두 저장소가 각각 새 정본으로 바뀌는 일을 방지하는 기록.', example: '이후 중단되면 같은 이관 ID로 재개한다. 업무 근거는 SQLite를 계속 사용하며 오래된 프로세스 자체가 자동 종료되는 것은 아니다.', module: 'storage' },
  { id: 'activation', en: 'Activation', ko: '현재 저장소로 최종 선택', definition: '문서 초기 기록과 영수증 검증을 마친 뒤 문서를 현재 개인 기억의 정본으로 선택하는 별도 기록.', example: '문서 파일이 생긴 것만으로 완료가 아니다. status의 activated와 effectivePersonalMemory를 확인한다.', module: 'storage' },
]) { assert.ok(!data.glossary.some(item => item.id === term.id), 'Glossary ID already exists: ' + term.id); data.glossary.push(term); }
data.snapshot.currentNotesAsOf = date;
data.snapshot.currentResults = resultPath; data.snapshot.currentVerification = proofPath; data.snapshot.nextPlan = nextPlan;
data.snapshot.c03D3 = { kind: 'current_supported_local_posix_partial_chapter', proofSha256: proofHash,
  sourceAndBuild: expectedPin, nativeLinux: { tests: full, newTests: fresh, relatedTests: related, finishedAt: linux.finishedAt,
    observedOwnedProcesses: linux.cleanup.observedOwnedProcesses, unresolvedPeers: linux.cleanup.unresolved.length, sshClosed: true,
    globalProcessAbsenceProven: false, collectedFiles: linux.collectedFiles.length }, priorD2: proof.priorD2,
  chapterComplete: false, goalComplete: false, nativeWindows: 'runtime_bindings_unimplemented_or_unconnected_and_unverified',
  postgres: 'unimplemented_and_unverified', realModelApi: 'paused_not_tested', browser: 'not_executed_by_this_update',
  nextPlan, limitations: proof.limitations };
const encoded = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
html = replaceOnce(html, dataExpression, `<script id="review-data" type="application/json">${encoded}</script>`, 'Review data');

// Static consistency only: preserve CSS, executable scripts, unrelated modules, and old snapshots.
const parsed = JSON.parse(html.match(dataExpression)[1]);
assert.deepEqual(parsed.snapshot.c03D2, oldData.snapshot.c03D2);
for (const key of ['asOf', 'kind', 'executionPlan']) assert.deepEqual(parsed.snapshot[key], oldData.snapshot[key]);
assert.deepEqual(parsed.modules.map(item => item.id), oldData.modules.map(item => item.id));
for (const item of oldData.modules) if (!['memory', 'storage'].includes(item.id)) assert.deepEqual(parsed.modules.find(value => value.id === item.id), item);
for (const key of Object.keys(oldData)) if (!['modules', 'glossary', 'snapshot'].includes(key)) assert.deepEqual(parsed[key], oldData[key]);
assert.deepEqual(parsed.glossary.slice(0, oldData.glossary.length), oldData.glossary);
const styles = text => [...text.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map(match => match[0]);
const behavior = text => [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(match => !match[1].includes('application/json')).map(match => match[0]);
assert.deepEqual(styles(html), styles(original)); assert.deepEqual(behavior(html), behavior(original));
for (const expression of [/id="latest-status"/g, /id="review-data"/g, new RegExp(markerName, 'g')]) assert.equal([...html.matchAll(expression)].length, 1);
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (match[1].includes('application/json')) JSON.parse(match[2]);
  else if (!/\bsrc\s*=/.test(match[1])) new Script(match[2], { filename: 'secumon-review.html:inline' });
}
for (const item of parsed.modules) for (const path of [...item.files, ...item.docs]) checkedPath(path);
// Generated link templates inside scripts are not static hrefs; module paths were checked above.
const staticMarkup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
for (const match of staticMarkup.matchAll(/href="([^"]+)"/g)) {
  const path = match[1].split('#')[0];
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path)) continue;
  checkedPath(relative(root, resolve(root, 'design', path)));
}
assert.equal(hash(read(proofPath)), proofHash, 'Proof changed during preparation');
assert.deepEqual(await verifyEvaluationBuild(runtime), expectedPin, 'Source/build changed during preparation');
assert.equal(read(target).toString('utf8'), original, 'Guide changed during preparation');
writeFileSync(checkedPath(target), html);
console.log(JSON.stringify({ updated: target, proof: proofPath, proofSha256: proofHash, sourceAndBuild: expectedPin,
  nativeLinux: { full, newTests: fresh, relatedTests: related }, historicalD2Preserved: true,
  staticHtmlValidated: true, browserExecuted: false, chapterComplete: false, goalComplete: false, nextPlan }));
