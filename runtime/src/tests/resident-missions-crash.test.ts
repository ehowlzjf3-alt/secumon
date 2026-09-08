import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { asJson } from '../application/plan-validator.js';
import { residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().min(1).max(256), time = z.number().int().nonnegative();
const AcceptedSchema = z.strictObject({ kind: z.literal('accepted'), pid: z.number().int().positive(), base: z.string(), eventId: id,
  controllerId: id, workId: id, sessionId: id, controllerSessionId: id, claim: z.strictObject({ owner: id, until: time }), tickStartedAt: time, observedAt: time,
  controllerDigest: hash, checkpointId: id, checkpointReceiptDigest: hash, checkpointSha256: hash,
  workDigest: hash, inputMessageId: id, inputDigest: hash, acceptDigest: hash, historyDigest: hash });
async function bounded<T>(pending: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function crashAfterIntake(base: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const child = fork(new URL('./resident-missions-crash-worker.js', import.meta.url), [base],
    { execPath: process.execPath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined, closedObserved = false;
  let stderr = '', outputBytes = 0, messageCount = 0, spawnError: Error | undefined;
  const abort = () => { if (!exited) child.kill('SIGKILL'); };
  child.stdout!.on('data', value => { outputBytes += Buffer.byteLength(value); if (outputBytes > 65536) abort(); });
  child.stderr!.on('data', value => { outputBytes += Buffer.byteLength(value); stderr = (stderr + String(value)).slice(-16384); if (outputBytes > 65536) abort(); });
  child.on('error', error => { spawnError = error; });
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => {
    closedObserved = true; resolve({ code, signal });
  }));
  const message = new Promise<unknown>((resolve, reject) => child.on('message', value => {
    messageCount++;
    if (Buffer.byteLength(JSON.stringify(value)) > 16384 || messageCount > 1) { abort(); reject(new Error('resident_worker_message_limit')); }
    else resolve(value);
  }));
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  let failure: unknown, accepted: z.infer<typeof AcceptedSchema> | undefined;
  try {
    accepted = AcceptedSchema.parse(await bounded(Promise.race([message, closed.then(() => {
      throw new Error('resident_worker_closed_before_intake', { cause: spawnError });
    })]), 30000, 'resident_worker_intake_timeout'));
    assert.equal(accepted.base, base); assert.equal(accepted.pid, child.pid); assert.equal(exited, undefined);
    assert.ok(accepted.claim.until >= accepted.tickStartedAt + 60000);
    assert.ok(accepted.claim.until <= accepted.observedAt + 60000);
    assert.equal(child.kill('SIGKILL'), true);
    const terminal = await bounded(closed, 5000, 'resident_worker_terminal_unobserved');
    assert.deepEqual(terminal, { code: null, signal: 'SIGKILL' }); assert.deepEqual(exited, terminal);
    assert.equal(messageCount, 1); assert.equal(spawnError, undefined); assert.ok(outputBytes <= 65536);
  } catch (error) { failure = error; }
  finally {
    if (!closedObserved) {
      abort();
      try { await bounded(closed, 5000, 'resident_worker_cleanup_terminal_unobserved'); }
      catch (error) { failure = failure ? new AggregateError([failure, error], 'resident_worker_cleanup_failed', { cause: failure }) : error; }
    }
    signal.removeEventListener('abort', abort);
  }
  if (failure) throw Object.assign(new Error(`resident_crash_worker_failed: ${stderr}`, { cause: failure }), { terminalObserved: closedObserved });
  assert.ok(accepted); return accepted;
}

test('SIGKILL after resident event intake reuses its original work and session after the actual 60-second claim expires',
  { timeout: 180000, skip: process.platform === 'win32' ? 'POSIX SIGKILL acceptance; native Windows process recovery is verified separately.' : false }, async t => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'resident-crash-'))), cleanups: (() => Promise<void>)[] = [];
    let removable = true, failure: unknown;
    try {
      const accepted = await crashAfterIntake(base, t.signal);
      const oldLeases = ['first', 'second'].flatMap(role => {
        const directory = join(base, role, '.secumon', 'runtime-leases');
        const leases = readdirSync(directory).map(name => ({ path: join(directory, name), bytes: readFileSync(join(directory, name), 'utf8') }))
          .filter(value => (JSON.parse(value.bytes) as { pid: number }).pid === accepted.pid);
        assert.equal(leases.length, 1); return leases;
      });
      // Run fixture teardown explicitly before removing its parent, including when assertions fail.
      const context = { after(callback: () => Promise<void>) { cleanups.push(callback); } } as unknown as TestContext;
      const f = await residentEntryFixture(context, false, { base }), p = f.current(), digest = (value: unknown) => p.services.digester.digest(asJson(value));
      const controller = await p.runtime.state(accepted.controllerId), before = await p.runtime.state(accepted.workId);
      assert.equal(digest(controller), accepted.controllerDigest); assert.equal(digest(before), accepted.workDigest);
      const basis = before.conversation?.session; assert.ok(basis);
      assert.equal(basis.scope.sessionId, accepted.sessionId); assert.equal(controller.conversation?.session?.scope.sessionId, accepted.controllerSessionId);
      assert.notEqual(accepted.sessionId, accepted.controllerSessionId);
      const input = await p.sessions.repository.input(basis.scope, accepted.inputMessageId); assert.ok(input);
      const receipt = await p.services.state.receipt(before.id, 'conversation.accept'); assert.ok(receipt);
      assert.equal(digest(input), accepted.inputDigest); assert.equal(receipt.digest, accepted.acceptDigest);
      assert.equal(input.status, 'applied'); assert.equal(input.workId, before.id); assert.ok(input.text.includes('RESIDENT_CRASH_ORIGINAL'));
      const originalHistory = await p.sessions.history(p.actor, accepted.sessionId, p.policy, { limit: 100 });
      assert.equal(digest(originalHistory), accepted.historyDigest);
      const subscription = controller.subscriptions!.find(value => value.checkpointId === accepted.checkpointId); assert.ok(subscription);
      const artifact = controller.artifacts.find(value => value.sha256 === accepted.checkpointSha256); assert.ok(artifact);
      const bytes = await p.services.artifacts.get(artifact, controller.policy);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
      const controllerReceipt = await p.services.state.receipt(controller.id, accepted.checkpointId); assert.ok(controllerReceipt);
      assert.equal(controllerReceipt.digest, accepted.checkpointReceiptDigest);
      assert.deepEqual((await f.driver().status(controller.id)).pending, [{ eventId: accepted.eventId, workId: null }]);
      assert.ok(Date.now() < accepted.claim.until, 'reopen must actually observe the unexpired original claim');
      const waiting = await f.driver().tick(controller.id, { maxSteps: 20 });
      assert.equal(waiting.kind, 'wait'); if (waiting.kind !== 'wait') assert.fail('an unexpired claim must remain waiting');
      assert.deepEqual(waiting, { kind: 'wait', reason: 'resident_claim_active', wakeAt: accepted.claim.until });
      assert.deepEqual(await p.runtime.state(controller.id), controller); assert.deepEqual(await p.runtime.state(before.id), before);
      assert.equal(f.observed.inputs.first.length + f.observed.polls.length, 0);
      const milliseconds = Math.max(0, waiting.wakeAt - Date.now() + 20); assert.ok(milliseconds <= 60020);
      await delay(milliseconds, undefined, { signal: t.signal }); assert.ok(Date.now() >= accepted.claim.until);
      const resumed = await f.driver().tick(controller.id, { maxSteps: 20 });
      assert.equal(resumed.kind, 'event'); if (resumed.kind !== 'event') assert.fail('the original pending event must resume');
      assert.equal(resumed.workId, before.id); assert.equal(resumed.eventId, accepted.eventId); assert.equal(resumed.sessionId, accepted.sessionId);
      assert.equal(resumed.status, 'completed'); const completed = await p.runtime.state(before.id);
      assert.equal(completed.budget.used.modelCalls, 1); assert.equal(completed.budget.used.toolCalls, 0);
      assert.equal(f.observed.inputs.first.length, 1); assert.equal(f.observed.inputs.second.length, 0); assert.equal(f.observed.polls.length, 0);
      assert.deepEqual(completed.goal, before.goal); assert.deepEqual(completed.policy, before.policy);
      assert.deepEqual(completed.budget.limits, before.budget.limits); assert.equal(completed.deadlineAt, before.deadlineAt);
      assert.deepEqual(completed.conversation?.session, basis); assert.deepEqual(completed.evidence, []);
      assert.deepEqual(await p.sessions.repository.input(basis.scope, input.messageId), input);
      assert.deepEqual(await p.services.state.receipt(before.id, 'conversation.accept'), receipt);
      const history = await p.sessions.history(p.actor, accepted.sessionId, p.policy, { limit: 100 });
      for (const entry of originalHistory.entries) assert.deepEqual(history.entries.find(value => value.sequence === entry.sequence), entry);
      assert.equal(history.entries.filter(value => value.role === 'user' && value.sourceId === input.messageId).length, 1);
      const binding = completed.conversation!.bindings.find(value => value.id === completed.conversation!.primaryBindingId)!;
      assert.deepEqual(await p.services.state.workIdsForConversation(binding.tenantId, binding.principalId, binding.channel, binding.conversationId), [before.id]);
      const deliveries = await p.services.state.deliveries(before.id); assert.equal(deliveries.filter(value => value.kind === 'result' && value.status === 'delivered').length, 1);
      const event = residentEvent(accepted.eventId, 'RESIDENT_CRASH_ORIGINAL'); f.pages.first.push([event], [event]);
      const duplicate = await f.driver().tick(controller.id, { maxSteps: 20 }); assert.equal(duplicate.kind, 'wait');
      assert.equal((await f.driver().status(controller.id)).cursor, 2);
      assert.equal(f.observed.inputs.first.length, 1); assert.deepEqual(await p.runtime.state(before.id), completed);
      assert.deepEqual(await p.sessions.history(p.actor, accepted.sessionId, p.policy, { limit: 100 }), history);
      assert.deepEqual(await p.services.state.deliveries(before.id), deliveries);
      assert.deepEqual(await p.services.artifacts.get(artifact, controller.policy), bytes);
      assert.deepEqual(await p.services.state.receipt(controller.id, accepted.checkpointId), controllerReceipt);
      const finalController = await p.runtime.state(controller.id);
      assert.equal(finalController.status, 'paused'); assert.equal(finalController.attempts.length + finalController.modelCalls.length, 0);
      assert.deepEqual(finalController.budget, controller.budget); assert.deepEqual(await f.memory('first'), []);
      for (const lease of oldLeases) assert.equal(readFileSync(lease.path, 'utf8'), lease.bytes);
    } catch (error) {
      if (error && typeof error === 'object' && 'terminalObserved' in error && error.terminalObserved === false) removable = false;
      failure = error;
    } finally {
      for (const cleanup of cleanups) try { await cleanup(); }
      catch (error) { removable = false; failure = failure ? new AggregateError([failure, error], 'resident_crash_cleanup_failed', { cause: failure }) : error; }
      if (removable) rmSync(base, { recursive: true, force: true });
    }
    if (failure) throw failure;
  });
