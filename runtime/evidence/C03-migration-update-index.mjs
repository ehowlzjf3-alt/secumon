import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';
const read = path => readFileSync('../' + path, 'utf8');
const outputs = new Map();
const write = (path, text) => outputs.set(path, text);
const proofPath = 'runtime/evidence/C03-migration-verification.json';
const proofText = read(proofPath), proof = JSON.parse(proofText);
assert.equal(proof.status, 'verified_supported_local_posix_partial_chapter');
assert.equal(proof.nativeLinux.status, 'passed');
assert.equal(proof.nativeLinux.cleanup.sshClosed, true);
assert.equal(proof.nativeLinux.cleanup.observedOwnedProcesses, 0);
assert.equal(proof.chapterComplete, false); assert.equal(proof.goalComplete, false);
assert.deepEqual(await verifyEvaluationBuild(process.cwd()), proof.sourceAndBuild);
const all = proof.nativeLinux.tests.pass.toLocaleString('en-US');
const fresh = proof.nativeLinux.newTests.pass, related = proof.nativeLinux.relatedTests.pass;
const counts = ({ tests, pass, fail, cancelled, skipped, todo, timeoutFailures }) => ({ tests, pass, fail, cancelled, skipped, todo, timeoutFailures });
const resultPath = 'design/chapters/C03-personal-memory-migration-result.md';
const nextPlan = 'design/chapters/C04-general-turn-plan.md';
const intro = `2026-09-07 기존 SQLite 개인 기억을 문서 저장으로 명시적으로 옮기는 D3 흐름을 검증했다. 검증된 백업 → 원 SQLite 개인 기억 쓰기 제한 → 문서 초기 기록 검증 → 활성화로 이어지며 같은 ID·영수증·세션·compact를 보존한다. NAS 실제 Linux/Node24에서 **전체 ${all}/${all}**, 신규 **${fresh}/${fresh}**, 관련 **${related}/${related}**을 같은 소스로 통과했다. [D3 결과](/Users/seunghanee/Documents/secumon/${resultPath}) · [확정 증거](/Users/seunghanee/Documents/secumon/${proofPath}) · [이관 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C03-memory-migrate-usage.md). 다음은 [C04 일반 요청과 답변 연결](/Users/seunghanee/Documents/secumon/${nextPlan})이다. PostgreSQL과 Windows 연결·실기 검증, C05 호출 비용 개선은 남겨 두며 C03 전체와 전체 goal은 완료가 아니다. 실제 모델/API 시험 중단을 유지한다.`;
for (const path of ['design/README.md', 'runtime/README.md', 'design/03-migration-plan.md']) {
  let text = read(path);
  assert.match(text, /2026-09-07 문서로 내보낸 개인 기억의 초안을 편집하고[^\n]+/);
  text = text.replace(/2026-09-07 문서로 내보낸 개인 기억의 초안을 편집하고[^\n]+/, intro);
  text = text.replace(/v0\.54 · C03 [^\n]+/, 'v0.55 · C03 개인 기억 이관 검증과 C04 일반 요청 연결');
  text = text.replace('현재 goal은 C03 문서 초안 적용을 검증하고 기존 기억 이관·등록형 PostgreSQL로 이어간다.', '현재 goal은 검증한 C03 세션·기억 계약을 재사용해 C04 일반 요청과 답변을 연결한다. PostgreSQL 등록·적합성은 C03 잔여로 유지한다.');
  if (path === 'design/03-migration-plan.md') {
    text = text.replace(/기본 SQLite·D1 문서 저장 선택에 이어 \[D2 초안 적용\][^\n]+/,
      '기본 SQLite·D1 문서 저장·D2 초안 적용에 이어 [D3 명시 이관](chapters/C03-personal-memory-migration-result.md)을 지원 POSIX에서 검증했다. C03 전체는 진행 중이며 PostgreSQL과 Windows 연결·실기 검증을 남긴다. 문서 반복 읽기 개선은 C05에서 다룬다.');
    text = text.replace('### C04 — 범용 메인 프롬프트·모델 연결·단일 실행 루프\n',
      '### C04 — 범용 메인 프롬프트·모델 연결·단일 실행 루프\n\n[첫 일반 요청 연결 계획](chapters/C04-general-turn-plan.md)을 다음 실행 단위로 채택한다. D3 검증·정리 뒤 기존 세션과 개인 기억 계약을 사용해 착수하며 C03 전체의 완료를 선행 조건으로 삼지 않는다. PostgreSQL과 Windows 잔여는 해당 챕터에 보존한다.\n');
  }
  write(path, text);
}
let result = read(resultPath);
result = result.replace(/2026-09-07 · Checkpoint\d+[^\n]+/, '2026-09-07 · Checkpoint265 · 지원 POSIX의 D3 구현·로컬 및 Linux 검증 완료. C03 전체와 전체 goal은 진행 중이다.');
result = result.replace(/현재 최종 후보 소스의 신규 시험[^\n]+/, `최종 소스는 macOS 신규 **${fresh}/${fresh}**·관련 **${related}/${related}**, NAS Linux 전체 **${all}/${all}**·신규 **${fresh}/${fresh}**·관련 **${related}/${related}**을 통과했다. NAS의 빌드·코어 타입·구조·CLI 구조 fixture·일반 fixture도 통과했으며 원로그/결과 9개를 회수해 해시를 대조했다. [확정 증거](../../runtime/evidence/C03-migration-verification.json). 실사용 DB·실제 모델/API·사내 서비스는 검증하지 않았다. Windows는 실행 연결 구현과 실제 검증이 모두 남아 있다.`);
result = result.replace('최종 후보 지문은', '최종 검증 지문은').replace('이를 아직 Linux 전체 통과 증거로 사용하지 않는다.', `NAS 종료 시각은 ${proof.nativeLinux.finishedAt}이며 관측 가능한 전용 프로세스 0과 SSH 종료를 확인했다. 접근 불가 같은 UID 프로세스는 별도 미확정 범위로 보존하므로 시스템 전체 프로세스 부재를 뜻하지 않는다.`);
result += `\n첫 신규/관련 실패와 진단 원로그를 보존했다. D2의 macOS 초기화 및 MCP 정체 원인 미확정 관측도 이번 통과로 해소됐다고 표시하지 않는다. 문서 조회 시 전체 초기 기록 재검사 비용은 C05의 미측정 항목이며, 백업 후보 4개를 소진한 경우 자동 삭제·무한 재시도하지 않는다.\n\n[사용 가이드](C03-memory-migrate-usage.md) · [남은 인수 범위](C03-remaining-acceptance-review.md) · [다음 C04 계획](C04-general-turn-plan.md)\n`;
write(resultPath, result);
const planPath = 'design/chapters/C03-personal-memory-migration-plan.md';
let plan = read(planPath).replace('설계 확정 후 구현·검증 진행 중', '지원 POSIX 구현·검증 완료; C03 전체 진행 중');
plan = plan.replace(/Checkpoint262에서는[^\n]+/, `Checkpoint265에서 신규 ${fresh}/${fresh}·관련 ${related}/${related}·Linux 전체 ${all}/${all}, 원로그 회수와 환경 정리를 확정했다. 아래 구현 전 결정과 실사용 검증 한계를 구분한다.`);
write(planPath, plan);
let verification = read('design/VERIFICATION.md');
assert(!verification.includes('## C03 D3 개인 기억 이관'));
verification = verification.replace('# 산출물 검증 결과\n', `# 산출물 검증 결과\n\n## C03 D3 개인 기억 이관\n\n${intro}\n\n원 SQLite/문서 저장소와 실제 자식 프로세스 종료를 사용하는 합성 내용 시험이다. 백업·fence·seed·활성화의 재개, compact/세션/영수증 보존, clone·이동, 원본 파일 불변과 빈 DB fallback 거절을 확인했다. SIGKILL·주입 I/O 오류를 전원 장애나 실사용 성능 검증으로 확대하지 않는다. 브라우저 렌더링은 이번 단위에서 실행하지 않았고 실제 CLI/HTTP와 정적 UI 계약을 확인했다. 이전 D2 원인 미확정 관측은 확정 증거의 priorD2에 유지한다.\n`);
write('design/VERIFICATION.md', verification);
const backlog = JSON.parse(read('design/implementation-backlog.json')); backlog.revision = 'v0.55';
const c03 = backlog.execution_chapters.find(x => x.id === 'C03'), c04 = backlog.execution_chapters.find(x => x.id === 'C04');
Object.assign(c03.personal_memory_migration_progress, { status: proof.status, checkpoint: 265,
  currentVerification: proofPath, result: resultPath, sourceAndBuild: proof.sourceAndBuild,
  local: { platform: proof.local.platform, node: proof.local.node, newTests: counts(proof.local.newTests.tests), relatedTests: counts(proof.local.relatedTests.tests), fullTests: 'not_run' },
  nativeLinux: { status: 'passed', attempt: proof.nativeLinux.attempt,
    finishedAt: proof.nativeLinux.finishedAt, tests: counts(proof.nativeLinux.tests), newTests: counts(proof.nativeLinux.newTests),
    relatedTests: counts(proof.nativeLinux.relatedTests), sshClosed: true, observedOwnedProcesses: 0 },
  syntheticMigrationExecuted: true, userDatabaseMigrationExecuted: false, chapterComplete: false, goalComplete: false });
delete c03.personal_memory_migration_progress.sourceBackupOrActivationExecuted;
c03.document_memory_progress.remaining = c03.document_memory_progress.remaining.filter(x => x !== 'D3_explicit_data_migration');
c03.nextPlan = 'design/chapters/C03-postgres-adapter-notes.md';
c03.remainingReview = 'design/chapters/C03-remaining-acceptance-review.md';
c04.plan = nextPlan;
c04.prerequisite_gate = { wholeChapterCompletionRequired: false, satisfiedForSupportedPOSIX: true,
  scope: 'verified agent-owned raw sessions, repeated compact, personal-memory currentness and D3 storage routing',
  evidence: proofPath, remaining: 'C03 PostgreSQL and C01/C03 Windows runtime binding/native tests remain explicit outstanding work; model/API tests remain cancelled' };
backlog.next_execution_chapter = 'C04';
backlog.next_local_work_item = { id: 'C04', id_kind: 'execution_chapter', scope: 'general_request_main_turn_existing_loop_response_delivery',
  next_design: nextPlan, prerequisite_note: 'D3 final exact-pin Linux pass, logs collected and SSH closed. Do not rerun completed D3. C03 remains in progress for PostgreSQL/Windows; no model/API calls.' };
const observations = backlog.execution_chapters.find(x => x.id === 'C05').follow_up_observations ??= [];
observations.push({ source: 'C03_D3_import_validation_cost', item: 'Activated document profiles currently validate complete immutable import prefixes. Measure repeated read/hash cost before optimizing; retain owner, seed, witness and currentness checks.', plan: resultPath });
write('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');
const checkpoint = `Checkpoint265: C03 D3 최종 소스에서 macOS 신규${fresh}/${fresh}·관련${related}/${related}, NAS 전체${all}/${all}·신규${fresh}/${fresh}·관련${related}/${related}과8단계 모두 통과했다. runtime/evidence/C03-migration-verification.json이 확정 근거다. NAS exec80096 종료·원로그9개 회수·관측 가능한 전용 프로세스0·SSH 종료를 확인했다. 해당 세션/검증을 반복하지 않는다. 원 실패 new1/related1과 기존D2 원인미확정은 보존했다. 다음은 C04-general-turn-plan.md의 일반 원문 접수→주 턴→기존 실행→답변/질문/전달이다. C04 제품 구현은 아직 없으며 C03 전체에는 PostgreSQL과 Windows 미연결/실기 검증이 남는다. 실제 사용자DB 이관/모델API 중단, 전체 goal active.`;
let resume = read('design/IMPLEMENTATION-RESUME.md').replace('## 현재 진행 단위 — C03 D3 개인 기억 이관', '## 다음 진행 단위 — C04 일반 요청과 답변 연결\n\n' + checkpoint + '\n\n아래 Checkpoint258~264는 종료한 D3 구현·검증 중간 이력이다.');
resume = resume.replace(/\[D3 개인 기억 이관 계획\]\(chapters\/C03-personal-memory-migration-plan.md\)과 \[검토\][^\n]+/, '[C04 일반 요청 연결 계획](chapters/C04-general-turn-plan.md)에 따라 기존 세션·문맥 조합·모델 호출 장부·실행 루프·outbox를 연결한다. 원문 기반 응답 요구와 답변/질문/계획 계약을 먼저 정하고, CLI/HTTP의 한 사용자 흐름까지 구현·검증한다. C03 PostgreSQL과 C01/C03 Windows는 잔여로 유지한다. 완료된 D3 검증과 실제 모델/API 중단을 반복하거나 해제하지 않는다.');
write('design/IMPLEMENTATION-RESUME.md', resume);
write('design/WORKLOG.md', read('design/WORKLOG.md') + '\n\n## Checkpoint 265 — D3 최종 검증과 C04 연결 순서\n\n' + checkpoint + '\n\n' + intro + '\n');
const progressPath = 'runtime/evidence/C03-migration-implementation-checkpoint.json';
const progress = JSON.parse(read(progressPath)); Object.assign(progress, { checkpoint: 265, status: proof.status,
  finalProof: proofPath, proofSha256: createHash('sha256').update(proofText).digest('hex'), nextPlan, nextImplementationStarted: false });
Object.assign(progress.linux, { status: 'passed', finishedAt: proof.nativeLinux.finishedAt, runningStage: null,
  collectedFiles: 9, sshClosed: true, observedOwnedProcesses: 0, tests: counts(proof.nativeLinux.tests) });
delete progress.linux.partialObservation;
write(progressPath, JSON.stringify(progress, null, 2) + '\n');
for (const [path, text] of outputs) writeFileSync('../' + path, text);
console.log(JSON.stringify({ updated: [...outputs.keys()], checkpoint: 265, full: all, newTests: fresh, relatedTests: related, next: nextPlan }));
