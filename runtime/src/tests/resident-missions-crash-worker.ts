import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { asJson } from '../application/plan-validator.js';
import { residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';

const [directory] = process.argv.slice(2); assert.ok(directory); assert.equal(realpathSync(directory), directory);
const deadline = setTimeout(() => { process.stderr.write('resident_crash_worker_deadline\n'); process.exit(2); }, 45000);
let fixture: Awaited<ReturnType<typeof residentEntryFixture>> | undefined;
let failure: unknown;
try {
  // The parent owns the directory. This worker only borrows the fixture's profile assembly, not its removal hook.
  const context = { after() {} } as unknown as TestContext;
  fixture = await residentEntryFixture(context, false, { base: directory });
  const f = fixture, registered = await f.register(), profile = f.current();
  const event = residentEvent('accepted-before-controller', 'RESIDENT_CRASH_ORIGINAL'); f.pages.first.push([event]);
  const accept = profile.sessions.accept.bind(profile.sessions), digest = (value: unknown) => profile.services.digester.digest(asJson(value));
  const tickStartedAt = Date.now();
  profile.sessions.accept = async (...args) => {
    const accepted = await accept(...args);
    const work = await profile.runtime.state(accepted.workId), basis = work.conversation?.session; assert.ok(basis);
    assert.equal(basis.scope.sessionId, registered.sessionId);
    const input = await profile.sessions.repository.input(basis.scope, basis.input.messageId); assert.ok(input);
    const receipt = await profile.services.state.receipt(work.id, 'conversation.accept'); assert.ok(receipt);
    assert.equal(input.status, 'applied'); assert.equal(input.workId, work.id); assert.equal(input.kind, 'work');
    assert.equal(input.digest, digest({ scope: input.scope, text: input.text, payload: input.payload, kind: input.kind, workId: input.workId }));
    assert.equal(receipt.digest, digest({ input: input.payload, session: basis }));
    assert.ok(input.text.includes('RESIDENT_CRASH_ORIGINAL'));
    assert.equal(work.modelCalls.length, 0); assert.equal(work.attempts.length, 0);
    assert.equal(f.observed.inputs.first.length + f.observed.inputs.second.length, 0);
    const controller = await profile.runtime.state(registered.workId), subscription = controller.subscriptions?.find(value => value.provider === 'resident-mission');
    assert.ok(subscription); const artifact = controller.artifacts.find(value => subscription.checkpointId === `resident:${value.sha256}`); assert.ok(artifact);
    const controllerReceipt = await profile.services.state.receipt(controller.id, subscription.checkpointId); assert.ok(controllerReceipt);
    const bytes = await profile.services.artifacts.get(artifact, controller.policy);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    assert.equal(controllerReceipt.digest, digest({ type: 'resident_checkpoint', data: { subscriptionId: subscription.id, artifact } }));
    assert.deepEqual(controllerReceipt.state.subscriptions?.find(value => value.id === subscription.id), subscription);
    const checkpoint = z.object({ claim: z.object({ owner: z.string(), until: z.number().int() }),
      pending: z.array(z.object({ event: z.object({ id: z.string() }), workId: z.string().nullable(), started: z.boolean() })) })
      .parse(JSON.parse(new TextDecoder().decode(bytes)));
    assert.deepEqual(checkpoint.pending.map(value => ({ eventId: value.event.id, workId: value.workId, started: value.started })),
      [{ eventId: event.id, workId: null, started: false }]);
    assert.ok(checkpoint.claim.until >= tickStartedAt + 60000); assert.ok(checkpoint.claim.until <= Date.now() + 60000);
    assert.equal(controller.status, 'paused'); assert.equal(controller.attempts.length + controller.modelCalls.length, 0);
    assert.notEqual(controller.conversation?.session?.scope.sessionId, registered.sessionId);
    const history = await profile.sessions.history(profile.actor, registered.sessionId, profile.policy, { limit: 100 });
    const message = { kind: 'accepted', pid: process.pid, base: directory, eventId: event.id, controllerId: controller.id, workId: work.id,
      sessionId: registered.sessionId, controllerSessionId: controller.conversation!.session!.scope.sessionId,
      claim: checkpoint.claim, tickStartedAt, observedAt: Date.now(), controllerDigest: digest(controller),
      checkpointId: subscription.checkpointId, checkpointReceiptDigest: controllerReceipt.digest, checkpointSha256: artifact.sha256,
      workDigest: digest(work), inputMessageId: input.messageId, inputDigest: digest(input), acceptDigest: receipt.digest, historyDigest: digest(history) };
    assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 16384); assert.ok(process.send);
    await new Promise<void>((resolve, reject) => process.send!(message, error => error ? reject(error) : resolve()));
    // No controller acceptance receipt can be published until this original sessions.accept wrapper returns.
    await new Promise<never>(() => {});
    return accepted;
  };
  await f.driver().tick(registered.workId, { maxSteps: 20 });
  assert.fail('parent must SIGKILL after the actual event intake and before controller publication');
} catch (error) { failure = error; }
finally {
  if (fixture) for (const role of ['first', 'second'] as const) {
    try { await fixture.current(role).close(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'resident_worker_cleanup_failed', { cause: failure }) : error; }
  }
  clearTimeout(deadline);
}
if (failure) { console.error(failure); process.exitCode = 1; }
if (process.connected) process.disconnect();
