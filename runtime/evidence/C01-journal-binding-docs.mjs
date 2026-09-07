import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const result = JSON.parse(fs.readFileSync('evidence/C01-journal-binding-verification.json', 'utf8'));
const cleanup = JSON.parse(fs.readFileSync('evidence/C01-journal-binding-linux-nas-20260907/cleanup.json', 'utf8'));
assert.equal(result.status, 'journal_binding_scope_verified_partial_chapter');
assert.equal(cleanup.ownedTestProcesses.length, 0); assert.equal(cleanup.sshClosed, true);
assert.deepEqual(await verifyEvaluationBuild(process.cwd()), result.sourceAndBuild);
const root = resolve('..'); const read = path => fs.readFileSync(resolve(root, path), 'utf8');
const write = (path, text) => fs.writeFileSync(resolve(root, path), text);
const evidenceLink = '[확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-journal-binding-verification.json)';
const resultLink = '[파일 저널 담당 연결 결과](/Users/seunghanee/Documents/secumon/design/chapters/C01-file-journal-binding-result.md)';
const nextLink = '[공통 파일 경계의 첫 추출](/Users/seunghanee/Documents/secumon/design/chapters/C01-file-boundary-extraction-plan.md)';
const summary = `2026-09-07 파일 저널을 담당별 상태 저장소에 연결하고 첫 저장 방식을 고정했다. 담당용 v2 owner와 기존 독립 v1 호환, clone의 빈 저장소, 소유/저장 방식 불일치 거절을 연결했다. NAS Debian 12/x64/ext4/Node24.20.0에서 **전체 2,580/2,580**, 관련 **192/192**, macOS 관련 **192/192**를 통과했다. ${resultLink} · ${evidenceLink}. 다음은 ${nextLink}이며 네이티브 Windows·지속 세션·실제 모델/사내 연동은 별도 미완료 범위다. C01 전체는 진행 중이다.`;

let chapter = read('design/chapters/C01-file-journal-binding-result.md');
chapter = chapter.replace('현재 구현 및 macOS 대상 검증 완료, NAS 전체 검증 진행 중', '해당 POSIX 구현 범위 및 NAS Linux 전체 검증 완료 · C01 전체 진행 중');
chapter = chapter.replace('- NAS Linux 전체 검증은 실행 중이다. 완료 결과와 원 로그를 회수·해시 대조한 뒤 확정한다. 현재 macOS 전체 시험과 네이티브 Windows 시험을 새로 통과했다고 주장하지 않는다.',
  `- NAS Debian 12 / Linux 6.12.30+ / x64 / ext4 / Node24.20.0: 전체 **2,580/2,580**, 관련 **192/192**, 실패·취소·skip·todo 0. 빌드·코어 타입·계층 125파일/위반0·계층 CLI 4사례·합성 4시나리오/22판정 통과. 종료 ${result.finishedAt}. 파일 병렬2/nice10. lint 미설정.\n- 회수한 원 로그 8개와 source/build, 정적 자산7개를 대조했다. ${evidenceLink}. macOS 전체 및 네이티브 Windows 시험은 이 수정본에서 실행하지 않았다.\n- 시험 소유 프로세스 잔여0과 기존 Node18·시험 루트0700을 확인하고 SSH 연결을 닫았다. 전용 Node24/자료/캐시는 보존했다. NAS의 ext4 nobarrier 조건 때문에 프로세스 중단 복구를 전원 장애 검증으로 해석하지 않는다.`);
chapter = chapter.replace('Windows를 위한 공통 파일 경계 추출과 실제 OS 어댑터를 진행한다.', `다음은 ${nextLink}이며 이어서 실제 Windows OS 어댑터를 연결한다.`);
write('design/chapters/C01-file-journal-binding-result.md', chapter);
write('runtime/README.md', read('runtime/README.md').replace(/^2026-09-07 현재:.*$/m, summary));
write('design/README.md', read('design/README.md').replace(/^2026-09-07 새 담당 복제와.*$/m, summary));
const verification = read('design/VERIFICATION.md');
if (!verification.includes('## C01 파일 저널 담당 연결과 저장 방식 고정')) write('design/VERIFICATION.md', verification.replace('# 산출물 검증 결과\n',
  `# 산출물 검증 결과\n\n## C01 파일 저널 담당 연결과 저장 방식 고정\n\n${summary}\n\n신규57개, 실제 프로세스 종료12사례(자동재개10·보존거절2). 종료 ${result.finishedAt}. source80a2d62d... / build6acbc8d1... /1065파일 및 정적자산7개 확인. SQLite 읽기 전용 owner 확인의 WAL 조정 파일과 hot-journal 복원 요구를 구분한다. 최초 CLI backend 선택은 C06, 자동 복원/이행은 C03/C10 잔여다.\n`));

const path = 'design/implementation-backlog.json'; const backlog = JSON.parse(read(path));
const c01 = backlog.execution_chapters.find(x => x.id === 'C01');
c01.status = 'in_progress';
c01.remaining_implementation = c01.remaining_implementation.filter(x => x !== 'file_journal_profile_owner_and_backend_binding');
c01.file_journal_progress = { implementation: 'complete_for_posix_scope', verification: result.status,
  result: 'design/chapters/C01-file-journal-binding-result.md', evidence: 'runtime/evidence/C01-journal-binding-verification.json',
  sourceAndBuild: result.sourceAndBuild, macosTargeted: result.macos.targeted, nativeLinuxFull: result.nativeLinux.tests,
  nativeLinuxTargeted: result.nativeLinux.targeted, newTests: result.newTests, actualProcessTerminationCases: result.actualProcessTerminationCases,
  remaining: ['first_setup_cli_backend_selection_C06', 'explicit_owned_recovery_and_backend_migration_C03_C10', 'native_windows'] };
Object.assign(c01.platform_work, { linux: result.status, linux_evidence: 'runtime/evidence/C01-journal-binding-verification.json',
  linux_tests: result.nativeLinux.tests, linux_source_digest: result.sourceAndBuild.sourceDigest,
  file_journal_result: 'design/chapters/C01-file-journal-binding-result.md', file_boundary_extraction_plan: 'design/chapters/C01-file-boundary-extraction-plan.md' });
backlog.next_local_work_item = { id: 'C01', id_kind: 'execution_chapter', scope: 'common_file_boundary_then_windows_native_adapter',
  next_design: 'design/chapters/C01-file-boundary-extraction-plan.md',
  prerequisite_note: 'Owned file-journal binding and immutable backend selection passed native Linux full verification (2580) and targeted verification on Linux/macOS (192 each). Do not repeat the completed run. C01 remains partial. Model/API testing stays stopped.' };
write(path, JSON.stringify(backlog, null, 2) + '\n');

let resume = read('design/IMPLEMENTATION-RESUME.md'); const start = resume.indexOf('## 현재 진행 중: C01 파일 저널 담당 연결');
const end = resume.indexOf('2026-09-07 · 현재 goal', start); assert.ok(start >= 0 && end > start);
resume = resume.slice(0, start) + `## 최신 완료 단위 — C01 파일 저널 담당 연결\n\n- ${summary}\n- source ${result.sourceAndBuild.sourceDigest}, build ${result.sourceAndBuild.filesDigest}, ${result.sourceAndBuild.fileCount}파일. 최종 build4/관련2 로그를 사용한다. 이전 실패 로그도 보존했다.\n- NAS exec16059는 ${result.finishedAt}에 완료됐다. 재기다림/중복 재시작 금지. 원 로그 회수와 소스·빌드·7정적자산 대조 완료. 같은 소스의 전체 시험을 다시 실행할 이유는 없다.\n- 시험 프로세스0·기본 Node18·루트0700 확인, SSH 제어 연결 종료. 메타데이터/cleanup은 runtime/evidence/C01-journal-binding-linux-nas-20260907/. 전용 폴더와 Node24/캐시는 유지한다.\n- 최초 setup backend 입력은 C06, hot-journal 소유 조회 불가시 명시 복원과 실제 저장 이행은 C03/C10에 연결했다. SQLite 조정 sidecar 생성 가능성과 owner/schema 변경 금지를 구분한다.\n- 다음은 chapters/C01-file-boundary-extraction-plan.md. profile/journal metadata의 공통 POSIX 경계부터 추출한다. Windows native·실제 검증, 수동 복사 ID 운영과 호스트 실행 쓰기 경계도 C01 잔여다. goal active 유지.\n\n` + resume.slice(end);
resume = resume.replace('## 최신 작업 — C01 clone 구현·검증 완료', '## 이전 완료 기록 — C01 clone');
resume = resume.replace('1. 기존 file-journal의 담당 소유와 backend 선택을 연결한다. format.json 원자 게시에 owner를 포함하고 v1 독립 저널 호환을 유지한다. 설정 변경만으로 빈 상태 저장소가 갈라지지 않게 한다. chapters/C01-file-journal-binding-plan.md 참조.',
  '1. chapters/C01-file-boundary-extraction-plan.md에 따라 profile/journal metadata의 공통 POSIX 파일 검사·제한 읽기·동기화 경계를 추출한다. 소유/복구/계측의 기존 의미를 보존한다. file-journal 담당 연결은 위 결과에서 완료됐으므로 다시 구현하지 않는다.');
write('design/IMPLEMENTATION-RESUME.md', resume);
fs.appendFileSync(resolve(root, 'design/WORKLOG.md'), `\n\n## Checkpoint 206 · 파일 저널 담당 연결 NAS 전체 검증 확정\n\n- ${result.finishedAt} NAS 전체 2580/2580, 관련192/192, 빌드·코어타입·계층125/위반0·계층CLI4·fixture4/22 통과. 관련 macOS192/192. source/build/7자산 대조 완료.\n- 57개 신규 시험, 실제 종료12(자동재개10·보존거절2). 실패 이력은 보존한다. 결과와 backlog/resume/README/검증문서 갱신.\n- 시험 프로세스0 확인 후 SSH 종료. C01/goal 미완료 유지. 다음은 공통 파일 경계 첫 추출이며 제품 소스는 이 검증 이후 수정하지 않았다.\n`);
console.log(JSON.stringify({ status: 'docs_updated', sourceAndBuild: result.sourceAndBuild, next: backlog.next_local_work_item.next_design }));
