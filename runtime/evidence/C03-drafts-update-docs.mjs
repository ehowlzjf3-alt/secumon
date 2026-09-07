// One-time documentation update, run only after the parent records final evidence.
// Creation of this script does not run it. No build, test, browser, model, or network call.
// Scope: D2 result/plan, D3 historical introduction, and the review HTML only.
// Remaining README/plan v0.54/VERIFICATION/backlog/resume/WORKLOG updates belong to the parent.
// Required additional proof field:
// initializationDiagnosis: { status: 'resolved' | 'bounded_limitation', summary: string,
//   evidence: string[] /* repository-relative runtime/evidence paths */ }
// 'bounded_limitation' is an explicit reviewed limitation, not an inferred successful fix.
// Writes are sequential, not a multi-file transaction. A partial write refuses a rerun.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

assert.equal(process.argv.length, 2, 'No path overrides or bypass arguments are supported');
const runtimeRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const root = realpathSync(resolve(runtimeRoot, '..'));
const proofPath = 'runtime/evidence/C03-drafts-verification.json';
const targets = [
  'design/chapters/C03-document-draft-result.md',
  'design/chapters/C03-document-draft-plan.md',
  'design/chapters/C03-personal-memory-migration-plan.md',
  'design/secumon-review.html',
];
const markerName = 'C03-D2-FINAL-PROOF';
const hash = value => createHash('sha256').update(value).digest('hex');
const checkedPath = path => {
  assert.equal(typeof path, 'string');
  assert(path.length > 0 && !isAbsolute(path) && !path.includes('\\'), 'Repository-relative path required');
  const resolved = resolve(root, path), rel = relative(root, resolved);
  assert(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Path escapes repository');
  assert.equal(realpathSync(resolved), resolved, 'Linked document or evidence path is not accepted');
  return resolved;
};
const read = path => readFileSync(checkedPath(path), 'utf8');
const proofBytes = read(proofPath), proof = JSON.parse(proofBytes), proofHash = hash(proofBytes);
const marker = `<!-- ${markerName}: ${proofHash} -->`;
assert.equal(proof.schemaVersion, 1);
assert.equal(proof.chapter, 'C03');
assert.match(proof.scope, /^D2(?:_|$)/);
assert(['verified_supported_local_posix_partial_chapter', 'verified_supported_posix_partial_chapter'].includes(proof.status),
  'Final supported POSIX verification is required; pending/failed status cannot publish final documentation');
assert.equal(proof.chapterComplete, false);
assert.equal(proof.goalComplete, false);
assert.equal(proof.next, 'design/chapters/C03-personal-memory-migration-plan.md');
assert(Number.isFinite(Date.parse(proof.recordedAt)), 'Final recordedAt required');

const pin = value => {
  assert.match(value?.sourceDigest ?? '', /^[a-f0-9]{64}$/);
  assert.match(value?.filesDigest ?? '', /^[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(value.fileCount) && value.fileCount > 0);
  return { sourceDigest: value.sourceDigest, filesDigest: value.filesDigest, fileCount: value.fileCount };
};
const { verifyEvaluationBuild } = await import(pathToFileURL(resolve(runtimeRoot, 'dist/infrastructure/local-evaluation.js')).href);
const currentPin = await verifyEvaluationBuild(runtimeRoot);
assert.deepEqual(pin(proof.sourceAndBuild), currentPin, 'Final evidence must match the current source and compiled outputs');
assert.deepEqual(pin(proof.nativeLinux?.sourceAndBuild), currentPin, 'Linux evidence must refer to the same source and outputs');
const cleanTests = value => {
  assert(Number.isSafeInteger(value?.tests) && value.tests > 0, 'Missing executed test count');
  assert.equal(value.pass, value.tests);
  for (const field of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(value[field], 0, `Nonzero ${field}`);
  return value.tests;
};
const linux = proof.nativeLinux;
assert.equal(linux.status, 'passed');
const fullCount = cleanTests(linux.tests), targetedCount = cleanTests(linux.targeted);
assert.equal(linux.environment?.platform, 'linux');
assert(Number.isFinite(Date.parse(linux.finishedAt)), 'Linux finish time required');
assert(Number.isSafeInteger(linux.architecture?.inspected) && linux.architecture.inspected > 0);
assert.deepEqual(linux.architecture.failures, []);
assert(Array.isArray(linux.steps) && linux.steps.length > 0);
for (const name of ['build', 'drafts-targeted', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures']) {
  const steps = linux.steps.filter(step => step.name === name);
  assert.equal(steps.length, 1, `Missing/duplicate final step ${name}`);
  assert.equal(steps[0].status, 'passed'); assert.equal(steps[0].exitCode, 0);
}
assert.equal(linux.cleanup?.ownedProcesses, 0);
assert.equal(linux.cleanup.sshClosed, true);
assert(Number.isSafeInteger(linux.collectedFiles) && linux.collectedFiles > 0);
assert.equal(proof.local?.build, 'passed');
assert.equal(proof.browser?.status, 'not_run_this_unit', 'This updater describes no D2 browser render');
assert.equal(proof.browser.guideRender, 'file_url_policy_blocked_not_bypassed');
assert(Array.isArray(proof.priorAttempts) && proof.priorAttempts.length > 0, 'Historical failures must be retained in the proof');
assert(Array.isArray(proof.limitations) && proof.limitations.length > 0, 'Partial chapter limitations must be explicit');
const diagnosis = proof.initializationDiagnosis;
assert(proof.mcpDiagnosis && ['resolved', 'bounded_limitation'].includes(proof.mcpDiagnosis.status));
assert(diagnosis && ['resolved', 'bounded_limitation'].includes(diagnosis.status), 'Initialization diagnosis still pending or absent');
assert.equal(typeof diagnosis.summary, 'string');
assert(diagnosis.summary.trim().length > 0 && diagnosis.summary.length <= 12000);
assert(Array.isArray(diagnosis.evidence) && diagnosis.evidence.length > 0);
for (const path of diagnosis.evidence) { assert(path.startsWith('runtime/evidence/')); checkedPath(path); }
assert(Array.isArray(proof.files) && proof.files.length > 0, 'Collected evidence hashes required');
const evidenceFiles = new Set();
for (const entry of proof.files) {
  assert(entry.path.startsWith('runtime/evidence/'));
  assert(!evidenceFiles.has(entry.path), 'Duplicate evidence file'); evidenceFiles.add(entry.path);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.equal(hash(readFileSync(checkedPath(entry.path))), entry.sha256, `Evidence hash mismatch: ${entry.path}`);
}
for (const path of diagnosis.evidence) assert(evidenceFiles.has(path), `Diagnosis evidence not included in proof.files: ${path}`);

// Historical anchors are retained verbatim in meaning, regardless of the final diagnosis.
const historyLinks = [
  'runtime/evidence/C03-drafts-target1.log',
  'runtime/evidence/C03-drafts-linux-nas-20260907/attempt-1/drafts-targeted.log',
  'runtime/evidence/C03-drafts-target2.log',
  'runtime/evidence/C03-drafts-owner-open-diagnostic1.json',
  'runtime/evidence/C03-drafts-owner-open-diagnostic2.json',
];
for (const path of historyLinks) checkedPath(path);
const originals = new Map(targets.map(path => [path, read(path)]));
for (const [path, text] of originals) assert(!text.includes(markerName), `Already/partially applied: inspect ${path} before retrying`);
const replaceOnce = (text, expression, replacement, label) => {
  const matches = [...text.matchAll(new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : expression.flags + 'g'))];
  assert.equal(matches.length, 1, `Expected one anchor: ${label}`);
  return text.replace(expression, () => replacement);
};
const esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const comma = value => value.toLocaleString('en-US');
const date = proof.recordedAt.slice(0, 10), full = comma(fullCount), targeted = comma(targetedCount);
const finalIntro = `문서 저장을 선택한 담당에서 초안 생성 → 외부 편집기로 파일 편집 → 명시 적용 → 원문·기억 상태 확인 → 같은 ID로 재개하는 CLI/Web 흐름을 연결했다. 기본은 SQLite다. 같은 최종 소스의 NAS 실제 Linux에서 **전체 ${full}/${full}·관련 ${targeted}/${targeted}**을 통과했고, 원로그 ${linux.collectedFiles}개 회수·관측 가능한 전용 시험 프로세스 0·SSH 종료를 확인했다. 다음은 D3의 기존 SQLite 개인 기억 명시 이관이며 아직 구현·검증하지 않았다. PostgreSQL·Windows 연결·문서 읽기 효율·실제 모델 품질은 남아 있고 C03 전체와 전체 goal은 진행 중이다.`;
const proofLink = '[최종 검증 근거](../../runtime/evidence/C03-drafts-verification.json)';
const diagnosisLinks = diagnosis.evidence.map(path => `[${path.slice('runtime/evidence/'.length)}](../../${path})`).join(' · ');
const historical = `build2의 로컬 관련 **295/295**는 중간 소스의 확인값이다. 첫 NAS 관련 시험은 **294/295**로 실패했으며 같은 apply ID의 두 프로세스가 사용자 원문을 검증하는 동안 업무 revision이 경합한 \`knowledge_contention\`이었다. 이후 build3의 로컬 target2는 **298/299**로 실패했고 기존 첫 초기화 경계의 오류를 별도로 조사했다. 공개 API를 통한 제한된 **40워커** 진단에서는 재현되지 않았으나, 미재현을 최초 실패의 해소나 원인 규명으로 간주하지 않는다.`;

let result = originals.get(targets[0]);
result = replaceOnce(result, /^2026-09-07 · 로컬 빌드·관련 시험 통과 · NAS 검증 진행 중 · C03 전체 진행 중$/m,
  `${date} · D2 지원 POSIX 검증 완료 · C03 전체 진행 중\n\n${marker}`, 'D2 result status');
result = replaceOnce(result, /^문서 저장을 선택한 담당에서 기존 개인 기억의 편집 초안을[^\n]+$/m,
  `${finalIntro} ${proofLink} · [다음 D3 계획](C03-personal-memory-migration-plan.md)`, 'D2 result introduction');
const finalVerification = `## 최종 검증과 초기화 진단\n\n| 검증 | 확정 값 |\n|---|---|\n| 최종 macOS 관련 시험 | ${proof.local.targeted.pass}/${proof.local.targeted.tests}; 전체 시험은 별도 실행하지 않음 |\n| NAS 실제 Linux | 전체 ${full}/${full}, 관련 ${targeted}/${targeted}; 실패·취소·생략 0 |\n| NAS 빌드·코어·구조·fixture | 필수 7단계 통과, 안쪽 계층 ${linux.architecture.inspected}파일·위반 0 |\n| 원본 회수·환경 정리 | ${linux.collectedFiles}개 회수 근거의 해시 대조, 관측 가능한 전용 프로세스 0·SSH 종료 |\n| CLI/Web | 실제 CLI 및 HTTP 회귀; 이번 D2 브라우저 렌더링 미실행 |\n| 안내 HTML | 정적 JSON·스크립트·참조 검사만 수행. file URL 정책 차단을 우회하지 않음 |\n| 실제 모델/API | 중단 상태 유지; 합성 구조 시험과 모델 의미 품질은 구분 |\n\n최종 \`sourceDigest=${currentPin.sourceDigest}\`, \`filesDigest=${currentPin.filesDigest}\`, \`fileCount=${currentPin.fileCount}\`. NAS 종료 ${linux.finishedAt}. ${proofLink}. 로컬 선행 실행은 아래 역사적 기록의 각 소스 지문에 해당하며 최종 NAS 소스로 소급하지 않는다.\n\n**초기화 진단의 최종 분류: \`${diagnosis.status}\`.** 다음 내용은 최종 증거 파일에 루트가 확정한 결론을 그대로 인용한다.\n\n${diagnosis.summary.trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n진단 근거: ${diagnosisLinks}. \`bounded_limitation\`으로 기록된 경우 제한을 남긴 것이며 해당 원인이 수정·입증됐다는 의미가 아니다.\n\n${historical}\n\n**세 번째 NAS 관련 시험과 수정:** ${proof.documentConcurrencyDiagnosis.summary} [진단·재현 기록](../../runtime/evidence/C03-drafts-native-attempt3-diagnosis.json).\n\n**후속 전체 시험의 MCP 정체:** ${proof.mcpDiagnosis.summary} [진단·원기록](../../runtime/evidence/C03-drafts-mcp-diagnosis.json). 자연 assertion 실패와 진단용 프로세스 종료를 구분한다.\n\n[중간 로컬 원로그](../../${historyLinks[0]}) · [첫 NAS 실패](../../${historyLinks[1]}) · [build3 target2](../../${historyLinks[2]}) · [진단 1](../../${historyLinks[3]}) · [진단 2](../../${historyLinks[4]}). 후속 발견·수정·재현의 상세 이력은 최종 증거의 \`priorAttempts\`와 \`initializationDiagnosis\`에 보존하며, 최초 실패 위치가 미확정인 경우 더 구체적인 원인으로 바꾸어 서술하지 않는다.\n\n## 구현 중간의 로컬 검증 기록\n\n아래 값은 build2 시점 기록이다. 현재 완료 여부는 위 최종 검증을 기준으로 한다.`;
result = replaceOnce(result, /^## 현재 확인한 검증과 증거$/m, finalVerification, 'D2 result verification heading');
result = replaceOnce(result, /^\| NAS 실제 Linux \| 전송·검증 진행 중\.[^\n]+$/m,
  '| 당시 NAS 상태 | build2 직후 진행 중이었으며 이후 첫 관련 시험은 294/295로 실패했다. 최종 결과와 진단은 위에서 별도 확인한다. |', 'historical NAS row');
result = replaceOnce(result, /^다음 판단은 NAS 확정 근거와 별도 남은 범위를[^\n]+$/m,
  '다음은 [D3 명시 이관 계획](C03-personal-memory-migration-plan.md)이다. D2의 확정 검증이 D3의 백업·복원·전환 검증을 대신하지 않는다. 이 결과는 C01·C02·C03 전체나 전체 goal 완료 선언이 아니다.', 'D2 next step');

let plan = originals.get(targets[1]);
plan = replaceOnce(plan, /^2026-09-07 · \*\*D2 구현 진행 중\.[^\n]+$/m,
  `${date} · D2 지원 POSIX 검증 완료 · D3 후속 · C03 전체 진행 중\n\n${marker}\n\n${finalIntro}\n\n[D2 구현 결과](C03-document-draft-result.md) · ${proofLink} · [다음 D3 계획](C03-personal-memory-migration-plan.md). 아래는 착수 당시의 제안·설계 이력이다. 실제 배치는 \`memory/drafts/<owner 지문>/<draftId>.origin.json\`, \`<draftId>.md\`, \`<applyId>.intent.json\`의 평면 구조이며 별도 완료 파일 없이 기존 원문·정정 영수증으로 상태를 계산한다. 대상 원문만 반영하는 \`inputOnly\`를 연결했다. 제안 표의 다른 경로·완료 파일·일반 input/resume 설명은 현재 구현 계약으로 읽지 않는다.`, 'D2 plan top');

let migration = originals.get(targets[2]);
migration = replaceOnce(migration, /^D1은 별도 결과에서 검증되었다\. D2는 이 문서를 작성할 때[^\n]+$/m,
  `${marker}\n\nD1에 이어 D2는 같은 최종 소스의 Linux 전체 ${full}/${full}·관련 ${targeted}/${targeted}과 환경 정리까지 확인했다. [D2 결과](C03-document-draft-result.md) · ${proofLink}. 이 문서가 처음 작성될 때는 build2 관련 295/295 뒤 NAS 검증 중이었으며, 이후의 실패·진단·수정 이력은 D2 결과에 별도로 보존했다. D3는 여전히 설계 단계이며 실제 사용자 DB의 백업·이관·전환·복원은 수행하지 않았다. 별도 합성 SQLite snapshot/backup 결합 probe 1회는 통과했으며 [관측 결과](../../runtime/evidence/C03-migration-backup-snapshot-probe.json)에 분리했다. D2 통과를 이관 검증으로 간주하지 않는다. [현재 실행 순서](../03-migration-plan.md) · [D1/D2/D3의 범위](C03-document-memory-plan.md).`, 'D3 historical introduction');

let html = originals.get(targets[3]);
const banner = `${marker}<div class="note gap-top" id="latest-status" data-nas-run="${linux.sessionId}" data-c03-d2-proof="${proofHash}" aria-label="최신 구현과 검증 상태"><strong>${esc(date.replaceAll('-', '.'))} · C03 편집 초안 적용 · Linux 전체 ${full} / ${full} 통과</strong><br>문서 기억에서 초안 생성 → 외부 파일 편집 → 명시 적용 → 상태 확인·같은 ID 재개를 연결했다. 원문 반영과 기억 정정을 따로 확인하며, 원 반영 버전과 현재 잊기 상태를 구분한다. 기본은 SQLite다. 관련 ${targeted}개·전체 회귀, 원로그 회수·관측 가능한 시험 프로세스 0·SSH 종료를 확인했다. 다음 D3 이관은 아직 설계 단계이고 PostgreSQL·Windows·읽기 효율·실제 모델 품질은 남아 있다. C03 전체 완료는 아니다.<br>중간 295/295 → 첫 NAS 294/295 실패 → build3 target2 298/299 실패와 40워커 미재현은 역사적 근거로 보존했다. 세 번째 NAS 관련297/299 실패 후 파일 목록 경합의 고정 재현·공통 읽기 수정을 별도로 검증했다. 초기화와 MCP 정체의 원인은 미확정으로 남겼다. 진단 분류: ${esc(diagnosis.status)}. 이번 브라우저 렌더링은 실행하지 않았으며 URL 정책 차단을 우회하지 않았다.<br><a href="chapters/C03-document-draft-result.md" target="_blank" rel="noopener">D2 결과·진단 →</a> · <a href="../runtime/evidence/C03-drafts-verification.json" target="_blank" rel="noopener">최종 증거 →</a> · <a href="chapters/C03-personal-memory-migration-plan.md" target="_blank" rel="noopener">다음 D3 이관 계획 →</a></div>`;
html = replaceOnce(html, /<div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/, banner, 'HTML latest banner');
html = html.replace('C03 문서 기억 선택</span>', 'C03 편집 초안 적용</span>');
const dataExpression = /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/;
const matches = [...html.matchAll(new RegExp(dataExpression.source, 'g'))]; assert.equal(matches.length, 1);
const data = JSON.parse(matches[0][1]), moduleIds = data.modules.map(module => module.id);
const module = id => { const selected = data.modules.filter(item => item.id === id); assert.equal(selected.length, 1); return selected[0]; };
const unique = (old, added) => [...new Set([...old, ...added])];
const memory = module('memory'), storage = module('storage'), channels = module('channels');
memory.done = `개인 기억의 SQLite 기본·문서 선택에 이어 편집 초안 생성·명시 적용·상태·재개를 CLI와 HTTP에 연결했다. 원문과 정정 영수증, 원 반영 버전과 현재 상태, 정정 뒤 실제 문맥의 최신 기억 재선택을 검증했다. D2 최종 Linux 관련 ${targeted}개·전체 ${full}개 통과. C03 전체 완료는 아니다.`;
memory.left = 'D3 기존 개인 기억 이관, PostgreSQL, 자율 경험 출처, 반복 읽기 비용과 실제 모델 의미 품질. 네이티브 Windows 연결·검증도 남아 있다.';
memory.how = memory.how.filter(text => !text.includes('다음 D2가 별도 초안을 다룬다.'));
memory.how.push('문서 초안 저장만으로 기억이 바뀌지 않는다. 사용자가 명시 적용하면 내용을 고정하고 원문 반영·기억 정정을 각각 확인한다. 재개는 같은 ID와 고정 내용을 사용하며 검색·정정만으로 최신 기억을 문맥에 자동 선택하지 않는다.');
memory.files = unique(memory.files, ['runtime/src/presentation/local-memory-drafts.ts', 'runtime/src/infrastructure/personal-memory-drafts.ts', 'runtime/src/application/personal-memory-draft-contracts.ts']);
memory.docs = unique(memory.docs, [targets[0], targets[1], targets[2]]);
storage.done += ' D2 초안의 origin·Markdown·고정 intent는 정본 밖의 한 소유 범위 폴더에 나란히 저장한다. 별도 완료 파일 없이 기존 영수증으로 부분 진행과 원래 결과를 확인한다.';
storage.left = 'D3 명시 이관·백업·복원, PostgreSQL 등록, native Windows 연결·검증, 호스트 실행 격리, 전원 장애·네트워크 저장소 검증.';
storage.docs = unique(storage.docs, [targets[0], targets[2]]);
channels.done += ' D2의 초안 생성·외부 편집·명시 적용·상태·재개는 빌드된 CLI와 실제 HTTP로 검증했다. 이번 D2 브라우저 렌더링은 실행하지 않았으며 과거 C03 브라우저 관찰과 소스를 구분한다.';
channels.how.push('초안 경로·적용 ID·진행 상태는 같은 기억 관리 영역에서 갱신한다. 관리 알림을 말풍선으로 쌓지 않고 실제 반영된 사용자 원문만 대화 이력에 보존한다.');
channels.docs = unique(channels.docs, [targets[0]]);
data.snapshot.currentNotesAsOf = date;
data.snapshot.currentResults = targets[0];
data.snapshot.currentVerification = proofPath;
data.snapshot.nextPlan = targets[2];
data.snapshot.c03D2 = { proofSha256: proofHash, sourceAndBuild: currentPin, nativeLinux: { tests: linux.tests, targeted: linux.targeted, finishedAt: linux.finishedAt, ownedProcesses: 0, sshClosed: true }, initializationDiagnosis: diagnosis, chapterComplete: false, goalComplete: false, browser: proof.browser };
data.glossary = uniqueGlossary(data.glossary, [
  { id: 'memoryDraft', en: 'Memory draft', ko: '기억 편집 초안', definition: '기존 기억에서 복사해 편집하는 파일. 저장만으로 정본이나 대화 원문이 바뀌지 않는다.', example: '파일 편집 뒤 명시 적용하면 그 내용을 고정하고 원문과 기억의 처리 기록을 각각 확인한다.', module: 'memory' },
  { id: 'applyId', en: 'Apply ID', ko: '한 적용 요청의 식별값', definition: '중단 뒤에도 같은 편집 내용을 이어 처리하고 중복을 확인하는 ID. 재시도마다 새로 만들지 않는다.', example: '이 요청의 반영 버전은 v2이고 지금 기억은 v3에서 잊힌 상태일 수 있다.', module: 'memory' },
]);
function uniqueGlossary(old, added) {
  const result = [...old];
  for (const entry of added) { assert(!result.some(value => value.id === entry.id), `Existing glossary term ${entry.id}`); result.push(entry); }
  return result;
}
const encoded = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
html = replaceOnce(html, dataExpression, `<script id="review-data" type="application/json">${encoded}</script>`, 'HTML review JSON');

// Validate all proposed output before the first write; these are static checks, not UI verification.
const parsedData = JSON.parse(html.match(dataExpression)[1]);
assert.deepEqual(parsedData.modules.map(value => value.id), moduleIds, 'Historical module inventory must remain unchanged');
assert.equal(parsedData.snapshot.c03D2.chapterComplete, false);
assert.equal(parsedData.snapshot.c03D2.goalComplete, false);
assert.equal((html.match(/id="latest-status"/g) ?? []).length, 1);
assert.equal((html.match(/id="review-data"/g) ?? []).length, 1);
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (match[1].includes('application/json')) JSON.parse(match[2]);
  else if (!/\bsrc\s*=/.test(match[1])) new Script(match[2], { filename: 'secumon-review.html:inline' });
}
for (const item of parsedData.modules) for (const path of [...item.files, ...item.docs]) checkedPath(path);
for (const path of [proofPath, targets[0], targets[1], targets[2]]) checkedPath(path);
const outputs = new Map([[targets[0], result], [targets[1], plan], [targets[2], migration], [targets[3], html]]);
for (const text of outputs.values()) assert.equal(text.split(markerName).length - 1, 1);
assert.equal(read(proofPath), proofBytes, 'Verification changed during preparation');
assert.deepEqual(await verifyEvaluationBuild(runtimeRoot), currentPin, 'Source/build changed during preparation');
for (const [path, original] of originals) assert.equal(read(path), original, `Document changed during preparation: ${path}`);
for (const [path, text] of outputs) {
  assert.equal(read(path), originals.get(path), `Concurrent document update: ${path}`);
  writeFileSync(checkedPath(path), text);
}
console.log(JSON.stringify({ updated: targets, proof: proofPath, proofSha256: proofHash, sourceAndBuild: currentPin,
  nativeTests: fullCount, targetedTests: targetedCount, initializationDiagnosis: diagnosis.status,
  staticHtmlValidated: true, browserExecuted: false, chapterComplete: false, goalComplete: false,
  parentUpdatesRemaining: ['README.md/design-README', 'runtime/README.md', 'design/03-migration-plan.md v0.54', 'design/VERIFICATION.md', 'design/implementation-backlog.json', 'design/IMPLEMENTATION-RESUME.md', 'design/WORKLOG.md'],
}));
