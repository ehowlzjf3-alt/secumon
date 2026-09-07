import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = path => readFileSync('../' + path, 'utf8');
const write = (path, text) => writeFileSync('../' + path, text);
const proof = JSON.parse(read('runtime/evidence/C03-documents-verification.json'));
assert.equal(proof.nativeLinux.status, 'passed'); assert.equal(proof.nativeLinux.cleanup.sshClosed, true);
const all = proof.nativeLinux.tests.pass.toLocaleString('en-US'), target = proof.nativeLinux.targeted.pass;
const intro = `2026-09-07 새 담당에서 개인 기억의 문서 저장 방식을 명시적으로 선택할 수 있게 연결했다. SQLite가 기본이며, 문서 선택 시 개인 기억은 Markdown 정본에, 업무 기억은 SQLite에 저장한다. NAS 실제 Linux/Node24에서 **전체 ${all}/${all}**, 관련 **${target}/${target}**을 같은 소스로 통과했다. [문서 기억 결과](/Users/seunghanee/Documents/secumon/design/chapters/C03-document-memory-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C03-documents-verification.json). 다음은 편집 초안의 명시 적용이며, 문서 읽기 비용 개선·이관·PostgreSQL·Windows 연결은 남아 있다. 실제 모델/API 시험은 중단 상태이며 C03 전체와 전체 goal은 진행 중이다.`;
for (const path of ['design/README.md', 'runtime/README.md', 'design/03-migration-plan.md']) {
  let text = read(path);
  assert.match(text, /2026-09-07 개인 기억의 명시 등록/);
  text = text.replace(/2026-09-07 개인 기억의 명시 등록[^\n]+/, intro);
  if (path === 'design/03-migration-plan.md') {
    text = text.replace('v0.52 · C03 명시적 개인 기억 연결과 잔여 범위 갱신', 'v0.53 · C03 문서 개인 기억 선택 검증과 편집 초안 계획');
    text = text.replace(/명시 등록·회상·정정·잊기 첫 흐름을[^\n]+/, '기본 SQLite의 기억 생애에 이어 [D1 문서 저장 선택](chapters/C03-document-memory-result.md)을 검증했다. 다음 [D2 편집 초안 적용](chapters/C03-document-draft-plan.md)은 기존 원문 접수·정정·영수증을 재사용한다. [문서 비용 관측](chapters/C03-document-memory-cost-notes.md)은 C05 개선 근거이며, [PostgreSQL 검토](chapters/C03-postgres-adapter-notes.md)와 이관·개인 출처 확장은 후속이다.');
  }
  if (path === 'design/README.md') text = text.replace('C03 개인 기억의 흐름·격리와 최신 Linux 검증 결과', 'C03 문서 기억 선택·개인/업무 저장 구분과 최신 Linux 검증 결과');
  write(path, text);
}
write('design/VERIFICATION.md', read('design/VERIFICATION.md').replace('# 산출물 검증 결과\n', `# 산출물 검증 결과\n\n## C03 D1 문서 개인 기억\n\n${intro}\n\nmacOS 관련 ${target}개와 NAS 전체 회귀를 확인했다. 새 구성의 Web은 실제 HTTP API로 검증했고 이번 브라우저 렌더링은 실행하지 않았다. 첫 관련 시험의 4프로세스 초기화 경합(197/198)은 원로그를 보존하고 제한된 임시파일 재관찰과 결정적 회귀를 추가해 수정했다. 원로그 8개·정적자산 7개·소스/빌드 지문 대조, 시험 프로세스 0·SSH 종료를 확인했다. 단회 계측의 반복 읽기는 [비용 검토](chapters/C03-document-memory-cost-notes.md)에 기록했다.\n`));
let plan = read('design/chapters/C03-document-memory-plan.md');
plan = plan.replace('2026-09-07 · D1 구현 진행 중 · 아래 제안과 현재 인수 결과를 구분', `2026-09-07 · D1 지원 POSIX 검증 완료 · D2/D3 후속\n\n[D1 결과](C03-document-memory-result.md): 같은 소스 Linux 전체 ${all}/${all}·관련 ${target}/${target}. 다음은 [D2 편집 초안 적용](C03-document-draft-plan.md)이다. 아래 착수 결정·초기 제안은 이력이며 현재 구현 결과와 구분한다.`);
plan = plan.replace('이 결정은 구현 착수이며 시험 통과나 D1 완료를 뜻하지 않는다.', '이 문단은 착수 당시 결정이다. D1의 최종 검증은 맨 위 결과 링크를 따른다.');
plan = plan.replace(/이 문서 작성 시 부모 작업이[^\n]+/, '아래는 최초 제안 당시의 코드 관찰과 D2/D3를 포함한 설계다. D1에서 확정한 계약은 맨 위 결정과 결과 문서를 기준으로 하며, D2/D3는 아직 구현하지 않았다.');
plan = plan.replace(/현재 `AgentConfigSchema.storage.memory`는[^\n]+/, '착수 당시 `AgentConfigSchema.storage.memory`와 openAgentStores는 SQLite 전용이었다. D1은 v2 personalMemory 선택과 개인/업무 router를 추가했으며, 업무 기억의 storage.memory는 계속 SQLite다.');
write('design/chapters/C03-document-memory-plan.md', plan);
write('design/chapters/C03-document-draft-plan.md', read('design/chapters/C03-document-draft-plan.md').replace(
  '현재 D1은 소스 동결 후 Linux 전체 검증이 진행 중이라는 부모 보고를 받았다. 이 문서는 코드를 읽어 작성했으며 그 실행의 성공이나 전체 C03 완료를 판정하지 않는다.',
  `D1은 이후 같은 소스 Linux 전체 ${all}/${all}·관련 ${target}/${target}으로 검증했고 [결과](C03-document-memory-result.md)에 기록했다. 이 문서 자체는 D2의 구현 제안이며 전체 C03 완료를 판정하지 않는다.`));
let result = read('design/chapters/C03-document-memory-result.md');
result = result.replace('2026-09-07 · 구현/검증 진행 중 · 현재 시험 통과를 아직 판정하지 않음', `2026-09-07 · D1 지원 POSIX 검증 완료 · C03 전체 진행 중\n\n${intro}`);
result = result.replace('저장하도록 연결하고 있다.', '저장하도록 연결했다.');
const start = result.indexOf('## 이번에 확인할 동작'), end = result.indexOf('## 범위와 남은 작업');
assert(start > 0 && end > start);
result = result.slice(0, start) + `## 확인한 동작과 근거\n\n설정/복제·기본값 회귀, 기억 등록·회상·정정·잊기, 두 실행 상태 backend, 새 대화의 실제 입력 프레임, 문서/SQLite 정본 분리, 사용자/담당 격리, 링크·손상 거절, CAS와 동시 게시, 실제 프로세스 종료·복구를 확인했다. CAS는 읽은 버전이 아직 최신일 때만 변경을 허용하는 검사다.\n\n| 검증 | 결과 |\n|---|---|\n| macOS Node24 빌드·관련 시험 | 통과, ${target}/${target}, 실패·취소·생략 0 |\n| NAS 실제 Linux Node24 | 전체 ${all}/${all}, 관련 ${target}/${target}, 실패·취소·생략 0 |\n| NAS 코어 타입·구조·CLI fixture·통합 fixture | 모두 통과, 안쪽 계층 ${proof.nativeLinux.architecture.inspected}개·위반 0 |\n| 원본 회수·환경 정리 | 로그/결과 8개 해시 대조, 전용 시험 프로세스 0·SSH 종료·root0700·기존 Node18 유지 |\n| 실제 CLI·Web | 빌드된 CLI 진입점과 실제 HTTP API 시험; 이번 브라우저 렌더링 미실행 |\n| 단회 비용 관측 | 16구간 통과. 병행 시험 중 단회이므로 속도 비교·처리량 보장 아님 |\n\n최종 소스: \`${proof.sourceAndBuild.sourceDigest}\`, 빌드: \`${proof.sourceAndBuild.filesDigest}\`, ${proof.sourceAndBuild.fileCount}파일. [원 검증 기록](../../runtime/evidence/C03-documents-verification.json). NAS 종료 ${proof.nativeLinux.finishedAt}. macOS 전체 시험은 새로 실행하지 않았고, 기존 코어/구조 검사는 후속 infrastructure 수정 전 동일 안쪽 소스에서 통과했다. NAS는 최종 pin으로 모든 필수 단계를 확인했다.\n\n첫 타입 검사 오류 2개와 첫 관련 시험 197/198 기록을 보존했다. 실제 네 프로세스 첫 열기에서 다른 게시자의 임시파일 삭제를 오류로 본 경합을 수정했다. 임시파일 소실/변경만 같은 root에서 제한적으로 재관찰하며 owner/format 손상·소실은 계속 거절한다. 마지막 기억 파일 삭제의 과거 버전 복귀 위험은 코드 검토에서 발견했고 게시 확인 기록과 회귀 시험으로 보강했다. 두 발견의 근거를 혼동하지 않는다.\n\n105B 기억의 문맥 준비에서 공통 파일 열기 1,104회·읽기 378,810B가 관측됐다. SQLite를 기본값으로 유지하고 최종 현재성 검사·복구를 보존하는 중복 제거를 C05로 남긴다. [비용과 한계](C03-document-memory-cost-notes.md). 실제 모델/API는 호출하지 않았다.\n\n` + result.slice(end);
result = result.replace('편집기에서 고친 Markdown 초안의 명시 적용은 D2', '편집기에서 고친 Markdown 초안의 명시 적용은 [D2](C03-document-draft-plan.md)');
write('design/chapters/C03-document-memory-result.md', result);
const backlog = JSON.parse(read('design/implementation-backlog.json')), chapter = backlog.execution_chapters.find(c => c.id === 'C03');
Object.assign(chapter.document_memory_progress, { status: 'document_backend_verified_partial_chapter', checkpoint: 245,
  currentVerification: 'runtime/evidence/C03-documents-verification.json', result: 'design/chapters/C03-document-memory-result.md',
  nativeLinux: { status: 'passed', sessionId: 63469, tests: proof.nativeLinux.tests, targeted: proof.nativeLinux.targeted,
    finishedAt: proof.nativeLinux.finishedAt, sshClosed: true, ownedProcesses: 0 },
  local: proof.local, costNotes: 'design/chapters/C03-document-memory-cost-notes.md',
  remaining: ['D2_edit_drafts', 'D3_explicit_data_migration', 'postgres', 'native_windows', 'read_efficiency'] });
chapter.nextPlan = 'design/chapters/C03-document-draft-plan.md';
backlog.next_local_work_item = { id: 'C03', id_kind: 'execution_chapter', scope: 'document_edit_draft_explicit_apply_receipt_recovery', next_design: chapter.nextPlan,
  prerequisite_note: 'D1 final source and native full pass collected; session63469 and collection completed, no duplicate rerun. Reuse document adapter and existing lifecycle. No real model/API.' };
const c05 = backlog.execution_chapters.find(c => c.id === 'C05');
c05.follow_up_observations ??= [];
c05.follow_up_observations.push({ source: 'C03_document_memory_measurement', item: '105B fixture context prepare observed 1104 common metadata opens and 378810 read bytes; preserve source/currentness/witness recovery while reducing repeated I/O. Concurrent single run is not a benchmark.', plan: 'design/chapters/C03-document-memory-cost-notes.md' });
write('design/implementation-backlog.json', JSON.stringify(backlog, null, 2) + '\n');
let resume = read('design/IMPLEMENTATION-RESUME.md');
resume = resume.replace('## 현재 진행 단위 — C03 D1 문서 기억', '## 다음 진행 단위 — C03 D2 편집 초안 적용');
resume = resume.replace(/Checkpoint244:[^\n]+/, `Checkpoint245: D1 문서 개인 기억 최종 소스 ${proof.sourceAndBuild.sourceDigest} / ${proof.sourceAndBuild.filesDigest} /${proof.sourceAndBuild.fileCount}파일에서 local ${target}/${target}, NAS 전체 ${all}/${all}·관련 ${target}/${target}을 통과했다. runtime/evidence/C03-documents-verification.json과 design/chapters/C03-document-memory-result.md가 확정 근거다. exec63469와 원로그 회수는 종료됐고 8개 파일 해시·프로세스0·root0700/defaultNode18·SSH 종료를 확인했다. 완료 세션을 다시 기다리거나 같은 검증을 반복하지 않는다. 다음은 C03-document-draft-plan.md의 편집 초안 고정→원문 적용→기억 정정→정확한 영수증 결과/재개. C03 전체/goal active, 실제 모델/API 중단 유지. 문서 비용과 한계는 C03-document-memory-cost-notes.md. D1 소스 변경은 이제 다음 단위로 기록한다.`);
resume = resume.replace(/\[C03 문서 기억 계획\]\(chapters\/C03-document-memory-plan.md\)의 D1[^\n]+/, '[D2 편집 초안 적용 계획](chapters/C03-document-draft-plan.md)을 작은 한 단위로 구현한다. 정본 어댑터·세션 원문 접수·개인 정정·영수증 복구를 재사용하고, 초안/고정 적용 내용과 정확한 원 반영 버전 조회만 추가한다. 기술 선택은 기존 goal 범위에서 진행하며 새 재승인을 요청하지 않는다. PostgreSQL·이관·C05 비용·C06 화면 개선·Windows 잔여는 유지한다.');
write('design/IMPLEMENTATION-RESUME.md', resume);
write('design/WORKLOG.md', read('design/WORKLOG.md') + `\n\n## Checkpoint 245 — C03 D1 문서 기억 검증 확정\n\n${intro}\n\nNAS exec63469 종료 ${proof.nativeLinux.finishedAt}; 원로그/결과 8개 회수·해시 대조, 프로세스0·root0700/defaultNode18·SSH 종료 확인. 최종 pin ${proof.sourceAndBuild.sourceDigest} / ${proof.sourceAndBuild.filesDigest} /${proof.sourceAndBuild.fileCount}파일. 첫 target197/198 경합 실패와 수정 기록 보존. 실제 모델/API 중단, native Windows·전원 장애·운영 미검증. D2 계획과 C05 비용 기록을 저장했으며 기존 D1을 다시 구현하지 않는다.\n`);
let html = read('design/secumon-review.html');
html = html.replace(/<div class="note gap-top" id="latest-status"[\s\S]*?<\/div>/,
  `<div class="note gap-top" id="latest-status" data-nas-run="63469" aria-label="최신 구현과 검증 상태"><strong>2026.09.07 · C03 문서 개인 기억 · Linux 전체 ${all} / ${all} 통과</strong><br>새 담당은 개인 기억의 문서 저장 방식을 선택할 수 있다. 기본은 SQLite이며, 문서를 선택하면 개인 기억만 Markdown에 저장하고 업무 기억과 대화 원문은 별도 저장한다. 기억하기·검색·정정·잊기·재시작과 실제 입력 문맥을 같은 서비스로 연결했다. 관련 ${target}개·전체 회귀, NAS 원로그 회수·시험 프로세스·SSH 정리까지 확인했다. 편집 초안 적용·PostgreSQL·Windows 연결과 문서 읽기 효율 개선은 남아 있다. C03 전체 완료는 아니다.<br><a href="chapters/C03-document-memory-result.md" target="_blank" rel="noopener">D1 결과 →</a> · <a href="../runtime/evidence/C03-documents-verification.json" target="_blank" rel="noopener">검증 근거 →</a> · <a href="chapters/C03-document-draft-plan.md" target="_blank" rel="noopener">다음 D2 초안 적용 →</a> · <a href="chapters/C03-document-memory-cost-notes.md" target="_blank" rel="noopener">실제 읽기 비용 →</a></div>`);
html = html.replace('C03 개인 기억 연결</span>', 'C03 문서 기억 선택</span>');
html = html.replace('기존 16개 기능 묶음을 유지하고 C02의 대화·문맥·기억 설명을 갱신했다.', '기존 16개 기능 묶음을 유지하고 C03의 문서 기억 선택·저장 구분·검증 범위를 갱신했다.');
const match = html.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/), data = JSON.parse(match[1]);
const memory = data.modules.find(m => m.id === 'memory'), storage = data.modules.find(m => m.id === 'storage');
memory.done = `개인 기억 등록·검색·정정·잊기를 기본 SQLite와 명시한 문서 저장소에 연결했다. 개인 문서와 업무 SQLite를 같은 기억 서비스에서 구분한다. 소유자·원문 출처·버전·게시 확인 기록과 실제 입력 frame을 검사했다. D1 Linux 관련 ${target}개·전체 ${all}개 통과.`;
memory.left = '편집한 초안의 명시 적용, 기존 데이터 이관, PostgreSQL, 자율 경험 출처, 반복 읽기 비용 개선과 실제 모델 품질.';
memory.how.push('문서 저장을 선택한 담당도 검색 결과를 자동으로 문맥에 넣지 않는다. 정본 파일을 직접 편집하는 흐름은 아직 지원하지 않으며 다음 D2가 별도 초안을 다룬다.');
memory.files.push('runtime/src/infrastructure/document-knowledge.ts', 'runtime/src/infrastructure/document-knowledge-owner.ts', 'runtime/src/infrastructure/agent-knowledge.ts');
memory.docs.push('design/chapters/C03-document-memory-result.md', 'design/chapters/C03-document-draft-plan.md', 'design/chapters/C03-document-memory-cost-notes.md');
storage.done = 'SQLite 기본값과 파일 저널 상태 저장, 담당별 소유 등록, 명시한 문서 개인 기억과 업무 SQLite 조합을 지원 POSIX에서 검증했다. 기억 본문과 명령 영수증은 한 Markdown 게시로 확정하고 순번·지문 확인 기록으로 마지막 파일 소실을 대조한다.';
storage.left = '문서 초안 적용·이관, PostgreSQL 등록, native Windows 실제 연결·검증, 호스트 실행 격리, 전원 장애·네트워크 저장소 검증.';
storage.files.push('runtime/src/infrastructure/agent-memory-profile.ts', 'runtime/src/infrastructure/document-knowledge-codec.ts');
storage.docs.push('design/chapters/C03-document-memory-result.md');
data.snapshot.currentResults = 'design/chapters/C03-document-memory-result.md';
data.glossary.push({ id: 'documentMemory', en: 'Document memory', ko: '문서에 저장한 개인 기억', definition: '개인 기억을 버전별 Markdown 파일에 저장하는 선택 방식. 기본 SQLite와 함께 같은 기억 서비스 계약을 사용한다.', example: '새 담당에서 documents를 선택해도 원문 대화와 업무 기억은 별도 저장한다.', module: 'memory' });
data.glossary.push({ id: 'publicationWitness', en: 'Publication witness', ko: '게시 확인 기록', definition: '어떤 순서와 내용 지문으로 기억을 저장했는지 확인하는 작은 파일. 본문을 한 번 더 저장하는 기억 DB는 아니다.', example: '마지막 기억 파일만 사라졌을 때 옛 버전을 현재 기억으로 돌려주지 않는다.', module: 'storage' });
html = html.replace(match[0], '<script id="review-data" type="application/json">' + JSON.stringify(data).replaceAll('<', '\\u003c') + '</script>');
write('design/secumon-review.html', html);
console.log(JSON.stringify({ updated: true, checkpoint: 245, nativeTests: all, targeted: target }));
