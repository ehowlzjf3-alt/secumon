// Finalize the small unit's narrative only from collected and closed verification evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';
const root = resolve('..');
const proofPath = 'evidence/C05-mcp-linux-nas-20260907/verification.json';
const proofBytes = readFileSync(proofPath), proof = JSON.parse(proofBytes);
assert.equal(proof.status, 'verified_supported_local_posix_partial_chapter');
assert.equal(proof.scope, 'mcp_host_read_tools_general_entry');
assert.equal(proof.chapterComplete, false); assert.equal(proof.goalComplete, false);
assert.equal(proof.nativeLinux.status, 'passed'); assert.equal(proof.nativeLinux.cleanup.sshClosed, true);
assert.deepEqual(await verifyEvaluationBuild(resolve('.')), proof.sourceAndBuild);
const pair = tests => { assert.equal(tests.tests, tests.pass); assert.equal(tests.fail, 0); assert.equal(tests.cancelled, 0); return `${tests.pass.toLocaleString('en-US')}/${tests.tests.toLocaleString('en-US')}`; };
const native = proof.nativeLinux, updated = new Map();
const paths = ['design/chapters/C05-mcp-host-result.md', 'design/chapters/C05-mcp-host-plan.md', 'design/chapters/C05-mcp-host-usage.md', 'design/chapters/C05-mcp-response-recovery-plan.md'];
const originals = new Map(paths.map(path => [path, readFileSync(resolve(root, path), 'utf8')]));
let result = originals.get(paths[0]);
const old = '**구현과 macOS 검증 완료, 같은 소스의 NAS Linux 검증 진행 중.**';
assert.ok(result.includes(old)); result = result.replace(old, '**구현과 macOS·NAS Linux 검증 완료.**');
const begin = result.indexOf('## Linux 검증 상태'), end = result.indexOf('## 남은 필수 범위', begin);
assert.ok(begin > 0 && end > begin);
result = result.slice(0, begin) + `## Linux 검증 결과

같은 소스를 NAS Linux/Node24에서 신규 **${pair(native.newTests)}**, 관련 **${pair(native.relatedTests)}**, 전체 **${pair(native.tests)}**으로 검증했다. build·신규·관련·core·계층·CLI 구조·전체·fixtures의 필수 8단계가 모두 종료 코드 0이다. native exec22557는 ${native.finishedAt}에 종료했다. 원로그와 결과 9개를 회수하고 해시를 대조했으며, 관측 가능한 전용 프로세스 ${native.cleanup.observedOwnedProcesses}·SSH 종료·private 제어 폴더 정리를 확인했다. 접근 불가 같은 UID peer ${native.cleanup.unresolved.length}개의 범위는 미확정이고 시스템 전체 프로세스 부재로 확대하지 않는다. 시스템 Node18과 기존 자료는 유지했다.

[확정 증거](../../runtime/${proofPath}) · [실행 메타데이터](../../runtime/evidence/C05-mcp-linux-nas-20260907/run-metadata.json) · [원로그 회수](../../runtime/evidence/C05-mcp-linux-nas-20260907/final-collection.json).

` + result.slice(end);
updated.set(paths[0], result);
let plan = originals.get(paths[1]);
assert.ok(plan.includes('같은 소스의 NAS Linux 검증은 진행 중이다.'));
plan = plan.replace('같은 소스의 NAS Linux 검증은 진행 중이다.', `같은 소스의 NAS Linux 신규${pair(native.newTests)}·관련${pair(native.relatedTests)}·전체${pair(native.tests)}와 필수8단계·원로그 회수·정리를 완료했다.`);
updated.set(paths[1], plan);
let usage = originals.get(paths[2]);
assert.ok(usage.includes('같은 소스의 NAS Linux 검증은 진행 중이며'));
usage = usage.replace('같은 소스의 NAS Linux 검증은 진행 중이며', `같은 소스의 NAS Linux 전체 ${pair(native.tests)}와 필수8단계·원로그 회수·정리도 완료했으며`);
usage = usage.replace('**구현되어 검증 중인 연결의 사용·개념 문서다.**', '**구현과 지원 POSIX 검증을 완료한 연결의 사용·개념 문서다.**');
updated.set(paths[2], usage);
let next = originals.get(paths[3]);
assert.ok(next.includes('NAS 실행 22557은 진행 중이다.'));
next = next.replace('NAS 실행 22557은 진행 중이다.', `NAS 실행 22557도 전체 ${pair(native.tests)}·필수8단계와 회수·정리를 완료했다. [선행 확정 증거](../../runtime/${proofPath})를 보존한다.`);
updated.set(paths[3], next);
let links = 0;
for (const [path, body] of updated) {
  assert.equal((body.match(/^```/gm) ?? []).length % 2, 0);
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^(https?:|#)/.test(match[1])) continue;
    const absolute = resolve(root, dirname(path), match[1].split('#')[0]);
    assert.ok(existsSync(absolute) && statSync(absolute).isFile(), absolute); links++;
  }
  assert.equal(readFileSync(resolve(root, path), 'utf8'), originals.get(path));
}
assert.deepEqual(await verifyEvaluationBuild(resolve('.')), proof.sourceAndBuild);
assert.deepEqual(readFileSync(proofPath), proofBytes);
for (const [path, body] of updated) writeFileSync(resolve(root, path), body);
console.log(JSON.stringify({ status: 'narrative_finalized_from_proof', paths, links,
  proofSha256: createHash('sha256').update(proofBytes).digest('hex'), sourceAndBuild: proof.sourceAndBuild,
  nativeFinishedAt: native.finishedAt, chapterComplete: false, goalComplete: false }));
