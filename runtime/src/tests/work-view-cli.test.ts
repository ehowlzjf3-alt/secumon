import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScenario } from '../application/fixtures.js';
import type { WorkViewResult } from '../domain/work-view.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../presentation/cli.js', import.meta.url));
async function invoke(directory: string, args: string[], json = true) {
  return execute(process.execPath, [cli, ...args, '--data-dir', directory, ...(json ? ['--json'] : [])], { timeout: 15000, maxBuffer: 1048576 });
}
async function call(directory: string, args: string[]) {
  const result = await invoke(directory, args); assert.equal(result.stderr, ''); assert.doesNotMatch(result.stdout, /\u001b/);
  return JSON.parse(result.stdout);
}
function snapshot(value: WorkViewResult) { assert.equal(value.kind, 'snapshot'); if (value.kind !== 'snapshot') throw new Error('expected_snapshot'); return value.view; }
async function denied(directory: string, args: string[]) {
  await assert.rejects(invoke(directory, args), (error: unknown) => {
    const result = error as { code: number; stdout: string; stderr: string };
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /^오류: [a-z][a-z0-9_]+\n$/); return true;
  });
}

for (const backend of ['sqlite', 'file-journal']) {
  test(`${backend}: public CLI cursor survives process reconnect without executing or changing the work`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'work-view-cli-'));
    try {
      const accepted = await call(directory, ['accept', '--request-id', 'view-reconnect', '--state-backend', backend]);
      const id = accepted.workId; const before = await call(directory, ['status', id]); const messages = await call(directory, ['messages']);
      const first: WorkViewResult = await call(directory, ['work-view', id]); const view = snapshot(first);
      assert.equal(view.progress.status, 'ready'); assert.equal(view.progress.resultReady, false);
      assert.equal(view.mode.requested, 'auto'); assert.deepEqual(view.messages.map(message => message.kind), ['ack']);
      assert.equal(view.details, undefined); assert.equal(view.diagnostics, undefined);
      const again = await call(directory, ['work-view', id, '--cursor', first.cursor]);
      assert.deepEqual(again, { kind: 'unchanged', cursor: first.cursor });
      assert.deepEqual(await call(directory, ['status', id]), before); assert.deepEqual(await call(directory, ['messages']), messages);
      const human = await invoke(directory, ['work-view', id, '--cursor', first.cursor], false);
      assert.equal(human.stdout, '표시 내용에 변경이 없습니다.\n'); assert.equal(human.stderr, '');
      const details: WorkViewResult = await call(directory, ['work-view', id, '--level', 'details', '--cursor', first.cursor]);
      assert.ok(snapshot(details).details); assert.notEqual(details.cursor, first.cursor);
      const diagnostics: WorkViewResult = await call(directory, ['work-view', id, '--level', 'diagnostics']);
      assert.ok(snapshot(diagnostics).diagnostics);
      assert.doesNotMatch(JSON.stringify(diagnostics), /"(?:input|resultArtifact|context|data|prompt)":/);
      assert.deepEqual(await call(directory, ['status', id]), before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test(`${backend}: public CLI binds reconnect to the registered conversation and keeps the primary reply route`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'work-view-cli-route-'));
    try {
      const firstWork = await call(directory, ['accept', '--request-id', 'one', '--state-backend', backend]);
      const secondWork = await call(directory, ['accept', '--request-id', 'two', '--scenario', 'observations-simple']);
      const first: WorkViewResult = await call(directory, ['work-view', firstWork.workId]);
      const second: WorkViewResult = await call(directory, ['work-view', secondWork.workId, '--cursor', first.cursor]);
      assert.equal(snapshot(second).workId, secondWork.workId); assert.notEqual(first.cursor, second.cursor);
      await denied(directory, ['work-view', firstWork.workId, '--conversation', 'another']);
      await call(directory, ['attach', firstWork.workId, '--conversation', 'another']);
      const primary: WorkViewResult = await call(directory, ['work-view', firstWork.workId]);
      const attached: WorkViewResult = await call(directory, ['work-view', firstWork.workId, '--conversation', 'another', '--cursor', primary.cursor]);
      assert.equal(snapshot(primary).reply.observingPrimary, true); assert.equal(snapshot(attached).reply.observingPrimary, false);
      assert.equal(snapshot(attached).reply.channel, 'cli'); assert.notEqual(primary.cursor, attached.cursor);
      assert.deepEqual(await call(directory, ['messages', '--conversation', 'another']), { messages: [] });
      const before = await call(directory, ['status', firstWork.workId]);
      assert.deepEqual(await call(directory, ['work-view', firstWork.workId, '--conversation', 'another', '--cursor', attached.cursor]), { kind: 'unchanged', cursor: attached.cursor });
      assert.deepEqual(await call(directory, ['status', firstWork.workId]), before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test(`${backend}: delivered results disappear from the current CLI view after a goal change and explicit cancel`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'work-view-cli-current-'));
    try {
      const done = await call(directory, ['demo', '--request-id', 'done', '--state-backend', backend]); const id = done.workId;
      const delivered: WorkViewResult = await call(directory, ['work-view', id]); const view = snapshot(delivered);
      assert.equal(view.progress.resultReady, true); assert.equal(view.progress.resultDelivery, 'delivered');
      assert.deepEqual(view.messages.map(message => message.kind), ['ack', 'result']);
      const shown = await invoke(directory, ['work-view', id], false);
      assert.equal(shown.stderr, ''); assert.match(shown.stdout, /확인 결과/); assert.match(shown.stdout, /전달 확인/);
      assert.doesNotMatch(shown.stdout, /\u001b|attempt_reserved|result_received|response_prepared|"input"|실행 진단/);
      const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
      const goalPath = join(directory, 'next-goal.json'); await writeFile(goalPath, JSON.stringify({ ...scenario.goal, revision: 2, description: '다시 확인할 문서 비교' }));
      await call(directory, ['change-goal', id, '--file', goalPath, '--goal-revision', '1', '--control-revision', '1']);
      const changed: WorkViewResult = await call(directory, ['work-view', id, '--cursor', delivered.cursor]);
      assert.equal(snapshot(changed).goalRevision, 2); assert.equal(snapshot(changed).progress.resultReady, false);
      assert.equal(snapshot(changed).messages.some(message => message.kind === 'result'), false);
      const historical = await call(directory, ['messages']); assert.equal(historical.messages.some((message: { kind: string }) => message.kind === 'result'), true);
      await call(directory, ['cancel', id, '--goal-revision', '2']);
      const cancelled: WorkViewResult = await call(directory, ['work-view', id, '--cursor', changed.cursor]);
      assert.equal(snapshot(cancelled).progress.status, 'cancelled'); assert.equal(snapshot(cancelled).messages.some(message => message.kind === 'result'), false);
      const state = await call(directory, ['status', id]); assert.equal(state.snapshot.usage.toolCalls, 1); assert.equal(state.snapshot.usage.modelCalls, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('public CLI rejects ambiguous view flags without printing a success response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'work-view-cli-options-'));
  try {
    for (const args of [['status', 'missing', '--level', 'details'], ['work-view', 'missing', '--level', 'all'], ['work-view'], ['work-view', 'missing', '--cursor', 'x'.repeat(257)]]) await denied(directory, args);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
