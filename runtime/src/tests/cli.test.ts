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

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../presentation/cli.js', import.meta.url));
async function invoke(dir: string, args: string[], json = true) {
  return execute(process.execPath, [cli, ...args, '--data-dir', dir, ...(json ? ['--json'] : [])], { timeout: 10000, maxBuffer: 1048576 });
}
async function call(dir: string, args: string[]) { const result = await invoke(dir, args); assert.equal(result.stderr, ''); assert.doesNotMatch(result.stdout, /\u001b/); return JSON.parse(result.stdout); }

test('CLI resumes across processes, keeps conversation/work identities and separates disconnect, pause and cancel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-cli-'));
  try {
    const accepted = await call(dir, ['accept', '--request-id', 'r1']); const id = accepted.workId;
    assert.equal(accepted.accepted, true); assert.equal(accepted.snapshot.status, 'ready');
    const duplicate = await call(dir, ['accept', '--request-id', 'r1']); assert.equal(duplicate.workId, id); assert.equal(duplicate.accepted, false);
    const before = await call(dir, ['status', id]);
    const disconnected = await call(dir, ['disconnect', id]); assert.equal(disconnected.workCancelled, false); assert.deepEqual(disconnected.snapshot, before.snapshot);
    await call(dir, ['attach', id, '--conversation', 'another-chat']); assert.deepEqual((await call(dir, ['list', '--conversation', 'another-chat'])).workIds, [id]);
    await call(dir, ['demo-plan', id]); await call(dir, ['pause', id]); assert.equal((await call(dir, ['run', id])).snapshot.status, 'paused');
    await call(dir, ['resume', id]); const done = await call(dir, ['run', id]);
    assert.equal(done.snapshot.status, 'completed'); assert.equal(done.snapshot.resultDelivery, 'delivered'); assert.equal(done.snapshot.usage.toolCalls, 1);
    const messages = (await call(dir, ['messages'])).messages; assert.deepEqual(messages.map((m: { kind: string }) => m.kind), ['ack', 'result']);
    await call(dir, ['run', id]); assert.equal((await call(dir, ['messages'])).messages.length, 2);
    const other = await call(dir, ['accept', '--request-id', 'r2']); await call(dir, ['cancel', other.workId]);
    assert.equal((await call(dir, ['run', other.workId])).snapshot.status, 'cancelled');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const family of ['documents-simple', 'observations-simple']) test(`CLI human output is reception plus result, with no internal events or ANSI: ${family}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-cli-quiet-'));
  try {
    const result = await invoke(dir, ['demo', '--scenario', family, '--request-id', 'human'], false);
    assert.equal(result.stderr, ''); assert.match(result.stdout, /^\[work-.*\] 요청을 접수했습니다\.\n/); assert.match(result.stdout, /확인 결과/); assert.match(result.stdout, /출처/);
    assert.equal((result.stdout.match(/요청을 접수했습니다/g) ?? []).length, 1);
    assert.doesNotMatch(result.stdout, /attempt_reserved|attempt_dispatched|result_received|response_prepared|\u001b/);
    const messages = await call(dir, ['messages']); assert.deepEqual(messages.messages.map((m: { kind: string }) => m.kind), ['ack', 'result']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI goal changes require an explicit revision and failures have no success JSON on stdout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-cli-goal-'));
  try {
    const accepted = await call(dir, ['accept', '--request-id', 'goal']); const id = accepted.workId;
    const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
    const path = join(dir, 'goal.json'); await writeFile(path, JSON.stringify({ ...scenario.goal, revision: 2 }));
    await assert.rejects(invoke(dir, ['change-goal', id, '--file', path]), (error: unknown) => {
      const e = error as { code: number; stdout: string; stderr: string }; assert.equal(e.code, 1); assert.equal(e.stdout, ''); assert.match(e.stderr, /goal_revision_required/); return true;
    });
    const updated = await call(dir, ['change-goal', id, '--file', path, '--goal-revision', '1', '--control-revision', '1']); assert.equal(updated.snapshot.goalRevision, 2);
    await assert.rejects(invoke(dir, ['cancel', id, '--goal-revision', '1']), (error: unknown) => {
      const e = error as { code: number; stdout: string; stderr: string }; assert.equal(e.code, 1); assert.equal(e.stdout, ''); assert.match(e.stderr, /stale_user_command/); return true;
    });
    const events = await call(dir, ['events', id]); assert.ok(events.events.length > 0); assert.ok(events.events.every((e: Record<string, unknown>) => !('data' in e)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI checkpoint is a derived reference and an old resume file does not reverse a paused work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-cli-checkpoint-'));
  try {
    const accepted = await call(dir, ['accept', '--request-id', 'checkpoint']); const id = accepted.workId;
    await call(dir, ['demo-plan', id]); const before = await call(dir, ['status', id]);
    const saved = await call(dir, ['checkpoint', id]); assert.equal(saved.stateRevision, before.snapshot.revision);
    assert.equal((await call(dir, ['status', id])).snapshot.revision, before.snapshot.revision);
    const path = join(dir, 'checkpoint.json'); await writeFile(path, JSON.stringify(saved));
    await call(dir, ['pause', id]); const paused = await call(dir, ['run', id, '--resume-file', path]);
    assert.equal(paused.snapshot.status, 'paused'); assert.equal(paused.resumeDisposition, 'regenerated'); assert.equal(paused.snapshot.usage.toolCalls, 0);
    await call(dir, ['resume', id]); const done = await call(dir, ['run', id, '--resume-file', path]);
    assert.equal(done.snapshot.status, 'completed'); assert.equal(done.snapshot.usage.toolCalls, 1); assert.equal(done.snapshot.usage.modelCalls, 0);
    assert.ok(done.checkpoint); assert.equal((await call(dir, ['messages'])).messages.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
