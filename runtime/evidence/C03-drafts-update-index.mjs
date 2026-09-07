import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';
const read = path => readFileSync('../' + path, 'utf8');
const write = (path, text) => writeFileSync('../' + path, text);
const proof = JSON.parse(read('runtime/evidence/C03-drafts-verification.json'));
assert.equal(proof.nativeLinux.status, 'passed');
assert.equal(proof.nativeLinux.cleanup.sshClosed, true);
assert.equal(proof.nativeLinux.cleanup.ownedProcesses, 0);
assert.deepEqual(await verifyEvaluationBuild(process.cwd()), proof.sourceAndBuild);
const all = proof.nativeLinux.tests.pass.toLocaleString('en-US'), target = proof.nativeLinux.targeted.pass;
const intro = `2026-09-07 문서로 내보낸 개인 기억의 초안을 편집하고 CLI/Web에서 명시적으로 적용하는 흐름을 연결했다. 편집 내용과 요청 ID를 고정한 뒤 기존 원문 접수·기억 정정·영수증 조회로 이어가며, 중단 후 같은 요청을 재개할 수 있다. NAS 실제 Linux/Node24에서 **전체 ${all}/${all}**, 관련 **${target}/${target}**을 같은 소스로 통과했다. [초안 적용 결과](/Users/seunghanee/Documents/secumon/design/chapters/C03-document-draft-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C03-drafts-verification.json). 다음은 기존 SQLite 개인 기억의 명시적 문서 이관이다. SQLite 기본값·대화 원문·업무 기억 구분은 유지하며 PostgreSQL·Windows·호출 비용 개선은 남아 있다. 실제 모델/API 시험은 중단 상태이며 C03 전체와 전체 goal은 진행 중이다.`;
for (const path of ['design/README.md', 'runtime/README.md', 'design/03-migration-plan.md']) {
  let text = read(path);
  assert.match(text, /2026-09-07 새 담당에서 개인 기억의 문서 저장 방식/);
  text = text.replace(/2026-09-07 새 담당에서 개인 기억의 문서 저장 방식[^\n]+/, intro);
  if (path === 'design/03-migration-plan.md') {
    text = text.replace('### C04 — 범용 메인 프롬프트·모델 연결·단일 실행 루프\n', '### C04 — 범용 메인 프롬프트·모델 연결·단일 실행 루프\n\n[최소 실행 연결 메모](chapters/C04-next-implementation-notes.md)는 현재 재사용 코드와 자연어 입력·답변·완료 판정의 공백을 정리한다. D3/등록형 PostgreSQL을 첫 범용 실행의 기술적 필수조건으로 확대하지 않으며 현재 구현 순서는 유지한다.\n');
    text = text.replace('v0.53 · C03 문서 개인 기억 선택 검증과 편집 초안 계획', 'v0.54 · C03 문서 초안 적용 검증과 명시적 기억 이관 계획');
    text = text.replace(/기본 SQLite의 기억 생애에 이어 \[D1 문서 저장 선택\][^\n]+/,
      '기본 SQLite·D1 문서 저장 선택에 이어 [D2 초안 적용](chapters/C03-document-draft-result.md)을 검증했다. 다음은 [D3 명시적 문서 이관](chapters/C03-personal-memory-migration-plan.md)이며, [이관 경계 검토](chapters/C03-personal-memory-migration-review.md)를 반영해 기존 ID·출처·원 영수증을 보존한다. 문서 반복 읽기 개선은 C05, PostgreSQL은 C03 후속이다.');
  }
  if (path === 'design/README.md') {
    text = text.replace('v0.52 · C03 개인 기억과 후속 저장 어댑터 반영', 'v0.54 · C03 문서 초안 적용과 명시적 기억 이관 반영');
    text = text.replace('현재 goal은 C03 개인 기억 첫 흐름을 검증하고 문서 기억·등록형 PostgreSQL로 이어간다.', '현재 goal은 C03 문서 초안 적용을 검증하고 기존 기억 이관·등록형 PostgreSQL로 이어간다.');
  }
  write(path, text);
}
let verification = read('design/VERIFICATION.md');
assert(!verification.includes('## C03 D2 문서 초안 적용'));
verification = verification.replace('# 산출물 검증 결과\n', `# 산출물 검증 결과\n\n## C03 D2 문서 초안 적용\n\n${intro}\n\n실제 CLI·HTTP API, 고정 요청의 원문/기억 중복 방지, 편집 내용 재개, 8개 실제 프로세스 종료 경계와 두 상태 저장소를 확인했다. 이번 브라우저 렌더링은 실행하지 않았다. 첫 NAS 관련 시험의 원문 snapshot 경합은 제한된 동일 요청 재검증과 결정적 시험으로 수정했다. ${proof.initializationDiagnosis.summary} ${proof.mcpDiagnosis.summary} ${proof.documentConcurrencyDiagnosis.summary}\n\n최종 NAS exec${proof.nativeLinux.sessionId} 종료 ${proof.nativeLinux.finishedAt}. 원로그/결과 ${proof.nativeLinux.collectedFiles}개 해시와 소스/빌드 지문, 관측 가능한 전용 프로세스 0·SSH 종료(접근 불가 peer는 별도 기록)를 확인했다. macOS 전체 시험과 native Windows·실제 모델·운영 검증은 미실행이다.\n`);
write('design/VERIFICATION.md', verification);
const backlog = JSON.parse(read('design/implementation-backlog.json'));
backlog.revision = 'v0.54';
const chapter = backlog.execution_chapters.find(c => c.id === 'C03');
Object.assign(chapter.document_draft_progress, { status: 'document_draft_verified_partial_chapter', checkpoint: 257,
  verifiedCurrentChanges: true, localChangesVerified: true, localTargetSession: null,
  currentVerification: 'runtime/evidence/C03-drafts-verification.json', result: 'design/chapters/C03-document-draft-result.md',
  sourceAndBuild: proof.sourceAndBuild, local: proof.local, nativeLinux: proof.nativeLinux,
  initializationDiagnosis: 'runtime/evidence/C03-drafts-initialization-diagnosis.json',
  mcpDiagnosis: 'runtime/evidence/C03-drafts-mcp-diagnosis.json', activeDiagnostic: null,
  documentConcurrencyDiagnosis: 'runtime/evidence/C03-drafts-native-attempt3-diagnosis.json',
  next: 'D3_explicit_personal_memory_migration', chapterComplete: false, goalComplete: false });
chapter.document_memory_progress.remaining = chapter.document_memory_progress.remaining.filter(x => x !== 'D2_edit_drafts');
chapter.nextPlan = 'design/chapters/C03-personal-memory-migration-plan.md';
chapter.personal_memory_migration_progress = { status: 'planned_not_implemented', plan: chapter.nextPlan,
  review: 'design/chapters/C03-personal-memory-migration-review.md', previousVerification: 'runtime/evidence/C03-drafts-verification.json',
  sourceBackupOrActivationExecuted: false, chapterComplete: false };
backlog.next_local_work_item = { id: 'C03', id_kind: 'execution_chapter', scope: 'explicit_sqlite_personal_memory_to_documents_migration',
  next_design: chapter.nextPlan, prerequisite_note: `D2 same source native full ${all} and targeted ${target} collected and cleaned. exec${proof.nativeLinux.sessionId} terminal, no duplicate rerun. Reuse source/receipt/CAS/witness paths; preserve unresolved macOS initialization observation. No model/API.` };
const observations = backlog.execution_chapters.find(c => c.id === 'C05').follow_up_observations ??= [];
if (!observations.some(x => x.source === 'C03_document_drafts')) observations.push({ source: 'C03_document_drafts',
  item: 'Draft origin/intent namespaces currently scan bounded files on every operation. Reduce repeated I/O without weakening owner/immutable-intent/currentness checks; draft retention needs C10 policy. No speed or token reduction claim.',
  plan: 'design/chapters/C03-document-draft-result.md' });
const c01 = backlog.execution_chapters.find(c => c.id === 'C01');
c01.follow_up_observations ??= [];
if (!c01.follow_up_observations.some(x => x.source === 'C03_drafts_initialization_diagnosis')) c01.follow_up_observations.push({
  source: 'C03_drafts_initialization_diagnosis', item: proof.initializationDiagnosis.summary,
  evidence: 'runtime/evidence/C03-drafts-initialization-diagnosis.json', status: proof.initializationDiagnosis.status });
const c05 = backlog.execution_chapters.find(c => c.id === 'C05');
c05.follow_up_observations ??= [];
if (!c05.follow_up_observations.some(x => x.source === 'C03_drafts_MCP_stall')) c05.follow_up_observations.push({ source: 'C03_drafts_MCP_stall', item: proof.mcpDiagnosis.summary, evidence: 'runtime/evidence/C03-drafts-mcp-diagnosis.json', status: proof.mcpDiagnosis.status });
write('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');
const checkpoint = `Checkpoint257: C03 D2 문서 초안 적용을 같은 소스로 macOS 관련 ${target}/${target}, NAS 전체 ${all}/${all}·관련 ${target}/${target} 검증했다. runtime/evidence/C03-drafts-verification.json이 확정 근거다. exec${proof.nativeLinux.sessionId} 및 원로그 ${proof.nativeLinux.collectedFiles}개 회수·관측 가능한 전용 프로세스0·SSH 정리 완료. 이 완료 세션을 다시 기다리거나 같은 검증을 반복하지 않는다. 첫 NAS 원문 snapshot 경합의 수정과 세 번째 NAS 파일 목록 경합 재현·공통 수정과 macOS 초기화 및 MCP 정체 원인 미확정 관측을 각각 보존했다. 다음은 C03-personal-memory-migration-plan.md와 migration-review.md의 명시적 SQLite→문서 이관이다. 이관 구현·백업·전환은 아직 없고 원 ID/revision/receipt·대화/업무 분리를 보존해야 한다. C03 전체/goal active, 실제 모델/API 중단 유지.`;
let resume = read('design/IMPLEMENTATION-RESUME.md');
resume = resume.replace('## 현재 진행 단위 — C03 D2 편집 초안 적용', '## 다음 진행 단위 — C03 D3 개인 기억 이관\n\n' + checkpoint + '\n\n아래 Checkpoint246~256는 D2 구현 중간 이력이며 모두 종료한 실행이다.');
resume = resume.replace(/\[D2 편집 초안 적용 계획\]\(chapters\/C03-document-draft-plan.md\)을 작은 한 단위로 구현한다[^\n]+/,
  '[D3 개인 기억 이관 계획](chapters/C03-personal-memory-migration-plan.md)과 [검토](chapters/C03-personal-memory-migration-review.md)를 구체화하고 구현한다. 기존 기억 서비스·소유자·영수증·CAS·문서 게시 검사를 재사용하며 저장된 최신 기억과 모든 실제 영수증을 보존한다. 백업 후보/seed wire schema/범위·용량 제한을 확정한 뒤 작은 수직 흐름으로 구현한다. 첫 fence 이후 취소는 제외하고 같은 작업 재개를 지원한다. PostgreSQL·C05 비용·Windows 잔여와 실제 모델/API 중단은 유지한다.');
write('design/IMPLEMENTATION-RESUME.md', resume);
write('design/WORKLOG.md', read('design/WORKLOG.md') + `\n\n## Checkpoint 257 — D2 초안 적용 검증 확정\n\n${checkpoint}\n\n${intro}\n\n소스 ${proof.sourceAndBuild.sourceDigest} / 빌드 ${proof.sourceAndBuild.filesDigest} /${proof.sourceAndBuild.fileCount}파일. ${proof.initializationDiagnosis.summary} ${proof.mcpDiagnosis.summary}\n`);
console.log(JSON.stringify({ updated: true, checkpoint: 257, nativeTests: proof.nativeLinux.tests, targeted: target }));
