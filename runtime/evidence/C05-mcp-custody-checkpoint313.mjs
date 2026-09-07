import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../../', import.meta.url), evidence = new URL('./', import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, evidence), 'utf8'));
const note = 'Checkpoint313: 현재 소스와 원로그를 다시 확인하고 종료된 실행을 반복하지 않았다. build5/build6 및 이번 core2(exec61731)/architecture2는 실제 exit0이다. build6 source a85b2ce7e8c6a172afb0a869bbca70b41d54dac986865d5ea8ef97cb7c2cc8d2/build dcf66e91b472228531794d86e2ea7333e2bf0de3215198b2bf7518aba0540d4a/1743파일에서 신규 new3(exec46229)은120개 중113pass/7fail로 exit1 종료했다. 5개는 CLI/Web fixture가 변경 불가능한 clock.now를 수정하려던 오류이며 담당이 시험만 교정 중이다. 2개는 미전송 예약의 실제 execution:not_invoked를 누락한 제품 선별 오류여서 root가 수정하고, 실제 전송 뒤 같은 오류 문자열이 생긴 시도는 제외하지 않는 회귀도 추가했다. 원실패 로그와 지문을 보존한다. 관련 선택은 local-workbench/프로필/Web/goal 변경을 포함해52파일로 확대했다. 제품/시험은 이 두 교정에 한해 동결 해제 중이며 새 build7/new4/related2/Linux는 아직 미실행이다. Linux 관리 스크립트와 결과 초안을 별도 준비 중이고 연결·전송·SSH는 없다. 실제 모델/API 중단, C05 및 전체 goal 미완료.';
const prior = json('C05-mcp-custody-implementation-checkpoint.json');
const observed = {};
for (const stage of ['build5', 'build6', 'core2', 'architecture2', 'new3']) {
  const result = json(`C05-mcp-custody-${stage}.json`), log = readFileSync(new URL(`C05-mcp-custody-${stage}.log`, evidence));
  observed[stage] = { status: result.status, exitCode: result.exitCode, source: result.sourceAfter,
    groupAbsentConfirmed: result.groupAbsentConfirmed, logSha256: createHash('sha256').update(log).digest('hex') };
}
const checkpoint = { ...prior, checkpoint: 313, recordedAt: new Date().toISOString(), note, sourceFrozen: false,
  currentValidation: 'new3_113_pass_7_fail_corrections_in_progress', sourcePin: null, buildPin: null, buildFiles: null,
  running: {}, observed, results: { ...prior.results, new3: { tests: 120, pass: 113, fail: 7 }, finalSourceFullRegression: false },
  nextAction: 'Freeze entry fixture and reservation fixes; build7; new4 expanded13; related2 selected52; final integrated Linux after actual local success.' };
writeFileSync(new URL('C05-mcp-custody-checkpoint313.json', evidence), JSON.stringify(checkpoint, null, 2) + '\n', { flag: 'wx' });
writeFileSync(new URL('C05-mcp-custody-implementation-checkpoint.json', evidence), JSON.stringify(checkpoint, null, 2) + '\n');
const resumePath = new URL('design/IMPLEMENTATION-RESUME.md', root);
let resume = readFileSync(resumePath, 'utf8');
resume = resume.replace('## 현재 진행 단위 — C05 전송 후 권한 변경과 응답 보관\n', '## 현재 진행 단위 — C05 전송 후 권한 변경과 응답 보관\n\n' + note + '\n');
resume = resume.replace(/## 바로 다음 행동\n[\s\S]*?(?=\n## 이전 완료 단위 — C02)/,
  '## 바로 다음 행동\n\n신규 new3의 원로그와 실패를 보존한 뒤 예약 상태 선별과 CLI/Web 시험 시계 준비를 교정한다. 동결 후 build7 → 신규13파일 new4 → 관련52파일 related2 → 최종 같은 소스의 Linux 검증 순서다. 실패가 확인되면 그 원인만 수정하고 기존 검증은 보존한다.\n\n종료한 build6/core2/architecture2/new3를 다시 기다리지 않는다. 현재 live exec/SSH는 없다. 새 Linux 관리 스크립트와 결과 초안은 준비 중이며 연결·전송·검증 완료를 뜻하지 않는다. [현재 checkpoint](../runtime/evidence/C05-mcp-custody-implementation-checkpoint.json)와 [현재 계획](chapters/C05-mcp-sent-authority-plan.md)을 따른다. 실제 모델/API 중단과 전체 goal의 범위를 유지한다.\n');
writeFileSync(resumePath, resume);
appendFileSync(new URL('design/WORKLOG.md', root), '\n\n' + note + '\n');
console.log('checkpoint313 saved; original validation evidence preserved');
