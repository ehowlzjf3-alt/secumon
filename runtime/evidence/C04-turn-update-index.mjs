import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';
const root = '../';
const read = path => fs.readFileSync(root + path, 'utf8');
const proofPath = 'runtime/evidence/C04-turn-linux-nas-20260907/verification.json';
const proofText = read(proofPath), proof = JSON.parse(proofText);
assert.equal(proof.status, 'verified_supported_local_posix_partial_chapter');
assert.equal(proof.nativeLinux.cleanup.sshClosed, true);
assert.equal(proof.nativeLinux.cleanup.observedOwnedProcesses, 0);
assert.deepEqual(await verifyEvaluationBuild(process.cwd()), proof.sourceAndBuild);
assert.equal(proof.chapterComplete, false); assert.equal(proof.goalComplete, false);
const count = x => ({ tests: x.tests, pass: x.pass, fail: x.fail, cancelled: x.cancelled, skipped: x.skipped, todo: x.todo });
const total = proof.nativeLinux.tests.pass.toLocaleString('en-US');
const fresh = proof.nativeLinux.newTests.pass, related = proof.nativeLinux.relatedTests.pass;
const resultPath = 'design/chapters/C04-general-turn-result.md';
const usagePath = 'design/chapters/C04-general-turn-usage.md';
const nextPlan = 'design/chapters/C04-context-window-plan.md';
for (const path of [resultPath, usagePath, nextPlan]) assert.ok(fs.existsSync(root + path));
const link = (label, path) => `[${label}](/Users/seunghanee/Documents/secumon/${path})`;
const intro = `2026-09-07 일반 요청 → 주 모델 턴 → 직접 답변·질문·검증된 계획 → 기존 도구 실행 → 응답 검토·전달을 연결했다. 작업이 끝나도 같은 세션의 원문·요약을 다음 요청에 사용한다. 같은 소스에서 macOS 신규 **${fresh}/${fresh}**·관련 **${related}/${related}**, NAS 실제 Linux/Node24 전체 **${total}/${total}**을 통과했다. ${link('C04 첫 흐름 결과', resultPath)} · ${link('확정 증거', proofPath)} · ${link('사용법', usagePath)}. 다음은 ${link('모델 입력 한도와 compact 조정', nextPlan)}이다. 합성 모델로 계약을 확인했으며 실제 모델/API 시험은 중단 상태다. C04 전체·Windows·PostgreSQL·사내 연동 및 전체 goal의 남은 범위는 유지한다.`;
const updates = new Map();
let result = read(resultPath);
result = result.replace('**로컬 검증 완료, Linux 최종 검증 결과 대기 중인 초안.**', '**첫 연결 단위의 로컬·Linux 검증 완료.**');
result = result.replace('이 로컬 지문 자체가 아직 진행 중인 Linux 실행의 최종 성공을 증명하지는 않는다.', '회수한 Linux 빌드 지문과 같은 값임을 최종 증거에서 대조했다.');
result = result.replace('## Linux 최종 확인 — 결과 확정 후 보완', `로컬 build5 manifest는 Node ${proof.local.build.node}를 기록했다. 지원 버전 Node 24로 로컬 증거 확정기를 실행하자 verifier의 실행 버전 일치 검사에서 한 번 거절됐고, 실제 로컬 빌드 버전으로 대조해 원 지문을 확인했다. 소스·빌드·원로그를 고치거나 시험을 반복하지 않았다. NAS의 지원 Node 24.20.0 결과와 로컬 빌드 환경을 구분한다. [빌드 manifest](../../runtime/evidence/C04-turn-local-build5-manifest.json) · [진단](../../runtime/evidence/C04-turn-finalize-diagnosis.json).\n\n## Linux 최종 확인 — 결과 확정 후 보완`);
result = result.replace(/## Linux 최종 확인 — 결과 확정 후 보완[\s\S]*?(?=## 남은 범위)/,
  `## Linux 최종 확인\n\nNAS의 별도 시험 디렉터리에서 Linux x64·Node ${proof.nativeLinux.environment.node}로 실행했다. ${proof.nativeLinux.finishedAt}에 정상 종료했으며 8단계 모두 exit 0·시간초과 없음이다.\n\n| 확인 항목 | 결과 |\n| --- | --- |\n| 신규·기존 관련 | ${fresh}/${fresh} · ${related}/${related} |\n| 전체 회귀 | ${total}/${total}, 실패·취소·건너뜀 0 |\n| 필수 단계 | 빌드·코어 타입·계층·CLI 구조 fixture·일반 fixture 통과 |\n| 소스·빌드 | 위 build5 지문과 일치, dependency lock 불변 |\n| 원로그 회수 | 결과 JSON 1개와 단계 로그 8개, SHA256 대조 |\n| 정리 | 관측 가능한 전용 프로세스 0, SSH와 로컬 제어 소켓·폴더 정리 |\n\n[확정 증거](../../${proofPath})에서 실제 환경·종료·시험 수·원로그와 해시를 확인할 수 있다. 접근 불가 같은 UID 프로세스 ${proof.nativeLinux.cleanup.unresolved.length}개는 범위 미확정으로 남긴다. 이 관측은 시스템 전체의 프로세스 부재나 전원 장애 복구의 보장이 아니다. 기존 D2 초기화 실패와 MCP 정체의 원인 미확정도 이번 통과로 해소됐다고 표시하지 않는다.\n\n`);
result = result.replace('연결을 구현하고 로컬에서 검증했다. 실제 모델 연결과 품질 평가, 브라우저 실기 확인, Linux 최종 판정은 별개로 남아 있다.', '연결을 구현하고 로컬·Linux에서 검증했다. 실제 모델 연결과 품질 평가, 브라우저 실기 확인은 별개로 남아 있다.');
result = result.replace('[다음 구현 메모](C04-next-implementation-notes.md)와 전체 계획에서 우선순위를 정하며', '[모델 입력 한도와 compact 조정](C04-context-window-plan.md)을 따르며');
updates.set(resultPath, result);
let usage = read(usagePath);
usage = usage.replace(/2026-09-07 · 구현 후 로컬 검증[^\n]+/, `2026-09-07 · 신규 ${fresh}/${fresh}·관련 ${related}/${related}, NAS Linux 전체 ${total}/${total} 검증 완료. 실제 모델/API 시험은 중단 상태다. [결과](C04-general-turn-result.md).`);
updates.set(usagePath, usage);
let plan = read('design/chapters/C04-general-turn-plan.md');
plan = plan.replace(/2026-09-07 · 구현 계획[^\n]+/, '2026-09-07 · 첫 연결 단위의 구현·로컬·Linux 검증을 마쳤다. 아래는 착수 당시 계획이며 현재 사실은 [결과](C04-general-turn-result.md)와 [사용법](C04-general-turn-usage.md)을 따른다. C04 전체는 진행 중이다.');
updates.set('design/chapters/C04-general-turn-plan.md', plan);
let windowPlan = read(nextPlan);
windowPlan = windowPlan.replace('현재 일반 요청·답변 연결의 소스는 동결되어 Linux 검증을 진행 중이다. 이 문서는 그 검증 결과를 선반영하지 않는다. 제품·시험·기존 계획·백로그는 변경하지 않았다.', '앞선 일반 요청·답변 연결은 [결과](C04-general-turn-result.md)의 같은 소스 Linux 검증을 마쳤다. 이 문서의 모델 입력 한도·구간 조정은 아직 구현하지 않았다.');
updates.set(nextPlan, windowPlan);
for (const path of ['design/README.md', 'runtime/README.md', 'design/03-migration-plan.md']) {
  let text = read(path);
  assert.match(text, /2026-09-07 기존 SQLite 개인 기억을 문서 저장으로[^\n]+/);
  text = text.replace(/2026-09-07 기존 SQLite 개인 기억을 문서 저장으로[^\n]+/, intro);
  text = text.replace(/v0\.5[56] · C0[^\n]+/, 'v0.57 · C04 일반 요청 첫 흐름 검증과 모델 입력 한도 연결');
  text = text.replace('현재 goal은 검증한 C03 세션·기억 계약을 재사용해 C04 일반 요청과 답변을 연결한다.', '현재 goal은 C04 일반 요청 연결의 검증 결과를 보존하고 모델 입력 한도와 compact 조정을 이어 구현한다.');
  text = text.replace('추가 저장 어댑터와 범용 프롬프트는 남아 있다.', '추가 저장 어댑터와 실제 모델 적합성·품질 검증은 남아 있다.');
  text = text.replace('C03 문서 기억 선택·개인/업무 저장 구분과 최신 Linux 검증 결과를 반영했다.', 'C04 일반 요청·답변·질문·도구 실행과 지속 문맥의 연결, 최신 Linux 검증 결과를 반영했다.');
  if (path === 'design/03-migration-plan.md') {
    text = text.replace(/\[첫 일반 요청 연결 계획\][^\n]+/, '[첫 일반 요청 연결 결과](chapters/C04-general-turn-result.md)와 [사용법](chapters/C04-general-turn-usage.md)을 확인했다. 다음은 [모델 입력 한도와 compact 조정](chapters/C04-context-window-plan.md)이며 기존 호출 예약·정산·복구를 재사용한다. C04 전체 및 PostgreSQL·Windows의 남은 범위는 유지한다.');
    text = text.replace(/\[최소 실행 연결 메모\][^\n]+/, '[최소 실행 연결 메모](chapters/C04-next-implementation-notes.md)는 착수 전 공백의 역사 기록이다. 현재 원문 접수·답변·질문·완료 판정의 첫 연결은 위 결과 문서를 따른다. 실제 모델/API 시험은 재개하지 않는다.');
  }
  updates.set(path, text);
}
let verification = read('design/VERIFICATION.md');
assert.ok(!verification.includes('## C04 일반 요청 첫 흐름'));
verification = verification.replace('# 산출물 검증 결과\n', `# 산출물 검증 결과\n\n## C04 일반 요청 첫 흐름\n\n${intro}\n\nNAS 신규 ${fresh}/${fresh}·관련 ${related}/${related}와 필수 8단계가 통과했다. 원로그/결과 9개를 회수하고 전용 프로세스 감사와 SSH 종료를 확인했다. Web은 실제 HTTP 시험을 통과했으나 Mac 잠금으로 화면 렌더링은 검증하지 못했다. 최초 타입 검사·시험 실패와 교정은 결과 문서에 남긴다. 로컬 신규 시험의 정확한 종료 시각·각 시험 직전 pin·실제 시험 Node 버전은 수집되지 않았으므로 관측 시각·동결 빌드의 사후 대조·원로그와 구분한다. NAS 환경과 실행 종료는 원 runner가 기록했다.\n`);
updates.set('design/VERIFICATION.md', verification);
const backlog = JSON.parse(read('design/implementation-backlog.json'));
backlog.revision = 'v0.57'; backlog.next_execution_chapter = 'C04';
const c04 = backlog.execution_chapters.find(x => x.id === 'C04');
c04.status = 'in_progress'; c04.current_implementation = 'general turn first flow verified; model context window integration next';
c04.general_turn_progress = { status: proof.status, checkpoint: 270, plan: c04.plan,
  currentVerification: proofPath, result: resultPath, usage: usagePath, sourceAndBuild: proof.sourceAndBuild,
  local: { platform: proof.local.platform, newTests: count(proof.local.newTests.tests), relatedTests: count(proof.local.relatedTests.tests), fullTests: 'not_run', testNodeVersion: proof.local.testNodeVersion },
  nativeLinux: { status: 'passed', sessionId: 17226, attempt: proof.nativeLinux.attempt, finishedAt: proof.nativeLinux.finishedAt,
    tests: count(proof.nativeLinux.tests), newTests: count(proof.nativeLinux.newTests), relatedTests: count(proof.nativeLinux.relatedTests), sshClosed: true, observedOwnedProcesses: 0 },
  browser: 'not_executed_mac_locked', chapterComplete: false, goalComplete: false, realModelApi: 'cancelled' };
c04.nextPlan = nextPlan;
backlog.next_local_work_item = { id: 'C04', id_kind: 'execution_chapter', scope: 'model_input_window_and_bounded_compact_sizing', next_design: nextPlan,
  prerequisite_note: 'General turn exact-source Linux pass, raw logs collected and SSH closed. Do not repeat completed tests. Real-model/API tests remain cancelled.' };
updates.set('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');
const checkpoint = `Checkpoint270: C04 첫 일반 요청 흐름을 같은 소스로 macOS 신규${fresh}/${fresh}·관련${related}/${related}, NAS Linux 전체${total}/${total}·신규${fresh}/${fresh}·관련${related}/${related} 및8단계 검증했다. ${proofPath}가 확정 근거다. NAS exec17226은 ${proof.nativeLinux.finishedAt}에 종료했고 원로그/결과9개 회수·관측 가능한 전용 프로세스0·SSH 종료를 확인했다. 완료된 실행을 반복하지 않는다. Web HTTP는 통과했으며 Mac잠금으로 브라우저 렌더링은 미실행이다. C04 전체·Windows·PostgreSQL·실제 연동·전체 goal은 미완료, 실제 모델/API 시험 중단 유지. 다음은 ${nextPlan}의 모델 입력 추정·필수 문맥 공간·compact 구간 조정이다.`;
let resume = read('design/IMPLEMENTATION-RESUME.md');
resume = resume.replace('## 현재 진행 단위 — C04 일반 요청과 답변 연결\n', '## 현재 진행 단위 — C04 모델 입력 한도와 compact 조정\n\n' + checkpoint + '\n');
updates.set('design/IMPLEMENTATION-RESUME.md', resume);
updates.set('design/WORKLOG.md', read('design/WORKLOG.md') + '\n\n## Checkpoint270 — C04 첫 일반 요청 흐름 검증\n\n' + checkpoint + '\n\n' + intro + '\n');
const progressPath = 'runtime/evidence/C04-general-turn-implementation-checkpoint.json';
const progress = JSON.parse(read(progressPath));
Object.assign(progress, { checkpoint: 270, status: proof.status, finalProof: proofPath,
  proofSha256: createHash('sha256').update(proofText).digest('hex'), next: nextPlan, nextImplementationStarted: false });
Object.assign(progress.NAS, { connected: false, runFinished: true, status: 'passed', finishedAt: proof.nativeLinux.finishedAt,
  tests: count(proof.nativeLinux.tests), logsCollected: 9, sshClosed: true, observedOwnedProcesses: 0 });
delete progress.NAS.runningStage; delete progress.NAS.latestObservedProgress;
progress.localBuildNode = proof.local.build.node;
progress.finalizationDiagnosis = 'runtime/evidence/C04-turn-finalize-diagnosis.json';
updates.set(progressPath, JSON.stringify(progress, null, 2) + '\n');
for (const [path, text] of updates) fs.writeFileSync(root + path, text);
console.log(JSON.stringify({ updated: [...updates.keys()], total, fresh, related, checkpoint: 270, nextPlan }));
