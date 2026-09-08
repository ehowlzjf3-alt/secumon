import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { A2aCall, A2aMessage, A2aPeer, A2aTask } from '../application/a2a-contracts.js';
import type { Tool } from '../application/ports.js';
import type { Policy, TaskSpec } from '../domain/model.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import type { HostA2aContext, HostA2aRegistration } from '../presentation/host-a2a.js';
import { HOST_ENTRY_PROFILE, hostEntryFixture } from './host-tool-entry-fixture.js';

export const A2A_REGISTRATION_ID = 'registered-a2a';
export function a2aRegistrationFixture(t: TestContext, enabled = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'host-a2a-registration-'))), directory = join(base, 'agent');
  const ready = new FileAgentProfileStore(fileURLToPath(new URL('../../', import.meta.url))).initialize(directory);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...ready.config, model: { profile: HOST_ENTRY_PROFILE },
    features: { ...ready.config.features, a2a: enabled }, skills: { mode: 'off' } }), { mode: 0o600 });
  const entry = hostEntryFixture({ text: 'A2A is optional; this original belongs to the ordinary persistent session.',
    identityRegistryDirectory: join(base, 'registry') });
  const policy: Policy = { tenantId: 'company', principalId: 'operator', allowedTools: [], allowedLabels: ['internal', 'public'],
    allowedDestinations: ['local'], allowWrites: false };
  const controller = new AbortController(), closers: Array<() => Promise<void>> = [];
  const context: HostA2aContext = { agentId: ready.identity.agentId, root: directory, scope: `agent:${ready.identity.agentId}`,
    actor: policy, signal: controller.signal };
  t.after(async () => {
    controller.abort(); const errors: unknown[] = [];
    for (const close of closers.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    try { rmSync(base, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'a2a_registration_fixture_cleanup_failed');
  });
  return { base, directory, entry, policy, controller, context,
    track<T extends { close(): Promise<void> }>(value: T): T { closers.push(() => value.close()); return value; } };
}

/** Deterministic port callbacks only; late replies deliberately leave lifecycle enforcement to the host wrapper. */
export function a2aRegistrationProbe(allowWrites?: boolean) {
  const counts = { opens: 0, closes: 0, peerCloses: 0, gets: 0, sends: 0, cancels: 0 };
  const contexts: HostA2aContext[] = [], calls: Array<{ operation: 'get' | 'send' | 'cancel'; call: A2aCall; taskId: string; message?: A2aMessage }> = [];
  const controls: { openError?: Error; closeError?: Error; beforeOpen?: () => Promise<void>;
    beforeCall?: (operation: 'get' | 'send' | 'cancel', call: A2aCall) => Promise<void>; beforeClose?: () => Promise<void> } = {};
  const remote = (taskId: string): A2aTask => ({ id: taskId, contextId: 'remote-context', status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: [{ artifactId: 'remote-artifact', parts: [{ text: 'Unreviewed remote text; not local evidence.' }] }] });
  const begin = async (operation: 'get' | 'send' | 'cancel', taskId: string, call: A2aCall, message?: A2aMessage) => {
    call.signal.throwIfAborted(); await call.authorize?.(); call.signal.throwIfAborted();
    counts[operation === 'get' ? 'gets' : operation === 'send' ? 'sends' : 'cancels']++;
    calls.push({ operation, taskId, call, ...(message ? { message: structuredClone(message) } : {}) });
    await controls.beforeCall?.(operation, call);
  };
  const labels = ['internal'];
  const peer: A2aPeer = { id: A2A_REGISTRATION_ID, protocolVersion: '1.0', destination: 'local', labels,
    async get(id, call) { assert.equal(this, peer); await begin('get', id, call); return remote(id); },
    async send(message, call) { assert.equal(this, peer); await begin('send', 'remote-task', call, message); return { task: remote('remote-task') }; },
    async cancel(id, call) { assert.equal(this, peer); await begin('cancel', id, call); return { ...remote(id), status: { state: 'TASK_STATE_CANCELED' } }; },
    async close() { assert.equal(this, peer); counts.peerCloses++; } };
  const lease = { peer, async close() {
    assert.equal(this, lease); counts.closes++; await controls.beforeClose?.(); await peer.close();
    if (controls.closeError) throw controls.closeError;
  } };
  const registration: HostA2aRegistration = { ...(allowWrites === undefined ? {} : { allowWrites }), async open(context) {
    assert.equal(this, registration); counts.opens++; contexts.push(context); await controls.beforeOpen?.();
    if (controls.openError) throw controls.openError; return lease;
  } };
  return { registration, lease, peer, labels, contexts, calls, controls, counts };
}

export function a2aTask(operation: 'get' | 'send' | 'cancel'): TaskSpec {
  return { id: 'registration-' + operation, description: 'Check the host registration boundary.',
    toolId: `${A2A_REGISTRATION_ID}.${operation}`, toolVersion: '1.0', effect: operation === 'get' ? 'read' : 'write',
    input: operation === 'send' ? { parts: [{ text: 'Explicit bounded request.' }] } : { taskId: 'remote-task' },
    dependsOn: [], satisfies: [], maxAttempts: 1 };
}
export function a2aInvocation(policy: Policy, authorize?: () => Promise<void>): Parameters<Tool['execute']>[1] {
  return { workId: 'registration-work', attemptId: 'registration-attempt', policy, signal: new AbortController().signal,
    ...(authorize ? { authorize } : {}) };
}
export function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
export async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('a2a_registration_wait_timeout')), 3000);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
export const errorLeaves = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(errorLeaves) : [error];
