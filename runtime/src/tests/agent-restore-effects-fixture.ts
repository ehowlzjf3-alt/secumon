import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { WorkStateSchema, ToolResultSchema } from '../application/contracts.js';
import type { AgentRestoreReconciliationBasis, AgentRestoreReconciliationReport, AgentRestoreReconciliationSource } from '../application/agent-restore-reconciliation-contracts.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { backupAgent, restoreAgentBackup } from '../infrastructure/agent-lifecycle.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { inspectAgentHostIdentity } from '../infrastructure/agent-host-identities.js';
import { rebindRestoredAgentHostIdentity } from '../infrastructure/agent-host-identity-recovery.js';
import { sha256 } from '../infrastructure/digest.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';
import { ENTRY_TEXT, WRITE_COMPUTER_PROFILE, WRITE_TOOL, writeComputerEntryFixture } from './host-write-computer-entry-fixture.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceId = 'fixture-company-note-history';
type SqlRows = Record<string, unknown>[];

function rows(path: string, sql: string): SqlRows {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

/** Real filesystem effects remain outside the agent/backup; this is not an HTTP or native UI service. */
export async function restoreEffectsFixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-restore-effects-'))), directory = join(base, 'agent');
  const archive = join(base, 'backup'), preserved = join(base, 'preserved-after-effect');
  const profiles = new FileAgentProfileStore(runtimeRoot), ready = profiles.initialize(directory, { stateBackend: 'sqlite' });
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...ready.config, model: { profile: WRITE_COMPUTER_PROFILE } }), { mode: 0o600 });
  const identityOptions = { registryDirectory: join(base, 'registry'), engineDirectories: [runtimeRoot] };
  const active = new Set<AgentTurnProfile>();
  const hosts: ReturnType<typeof writeComputerEntryFixture>[] = [];
  // Count actual sends, including a send that fails before a delivery becomes durable.
  const originalSend = LocalChannel.prototype.send;
  let sends = 0, modelOpens = 0, toolOpens = 0;
  LocalChannel.prototype.send = async function (value) { sends++; return originalSend.call(this, value); };
  t.after(async () => {
    const errors: unknown[] = [];
    try { for (const profile of active) try { await profile.close(); } catch (error) { errors.push(error); } }
    finally { LocalChannel.prototype.send = originalSend; rmSync(base, { recursive: true, force: true }); }
    if (errors.length) throw new AggregateError(errors, 'restore_effects_fixture_cleanup_failed');
  });
  async function open() {
    const host = writeComputerEntryFixture({ base, mode: 'write' }); hosts.push(host);
    const originalTools = host.host.tools!;
    const observedHost: AgentExecutionHost = { ...host.host,
      models: new Map([...host.host.models].map(([id, registration]) => [id, { ...registration,
        async open(...args: Parameters<typeof registration.open>) { modelOpens++; return registration.open(...args); } }])),
      tools: { ...originalTools, async open(...args: Parameters<typeof originalTools.open>) { toolOpens++; return originalTools.open(...args); } },
    };
    const profile = await openAgentTurnProfile(directory, { provider: 'registered' }, observedHost);
    active.add(profile); return { profile, host };
  }
  async function close(profile: AgentTurnProfile) { try { await profile.close(); } finally { active.delete(profile); } }
  function externalFiles() {
    return readdirSync(base).filter(name => /^write-.+\.json$/.test(name)).sort()
      .map(name => ({ name, bytes: readFileSync(join(base, name)).toString('utf8') }));
  }
  function stored() {
    const profile = profiles.inspect(directory); assert.equal(profile.status, 'ready');
    if (profile.status !== 'ready') throw new Error('fixture_profile_not_ready');
    return { works: rows(profile.paths.state, 'SELECT id,body FROM works ORDER BY id'),
      receipts: rows(profile.paths.state, 'SELECT work_id,command_id,digest,body FROM receipts ORDER BY work_id,command_id'),
      deliveries: rows(profile.paths.state, 'SELECT work_id,id,body FROM deliveries ORDER BY work_id,id'),
      messages: rows(join(profile.paths.metadata, 'channel.sqlite'), 'SELECT * FROM local_messages ORDER BY work_id,delivery_id') };
  }
  async function accept(profile: AgentTurnProfile) {
    const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'restore-effects' });
    return profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId: 'save-note', rawText: ENTRY_TEXT,
      mode: 'auto', scope: profile.scope, policy: profile.policy, limits: profile.limits,
      binding: { ...profile.executionActor, channel: 'test', conversationId: 'restore-effects',
        recipientId: profile.actor.principalId, destination: 'local' } });
  }
  async function writeAndAdopt(profile: AgentTurnProfile, workId: string) {
    const stop = new Error('fixture_stop_after_actual_write_adoption');
    await assert.rejects(profile.workflow.run(workId, profile.actor, { maxSteps: 12, async onStep() {
      const state = await profile.runtime.state(workId);
      if (state.attempts.some(attempt => attempt.toolId === WRITE_TOOL && attempt.adopted)) throw stop;
    } }), error => error === stop);
    const state = await profile.runtime.state(workId), attempt = state.attempts.find(item => item.toolId === WRITE_TOOL)!;
    assert.ok(attempt?.adopted && attempt.resultArtifact && attempt.effectReceipt);
    assert.equal(attempt.status, 'succeeded'); assert.equal(attempt.effectState, 'confirmed');
    assert.equal(state.budget.used.toolCalls, 1); assert.equal(state.budget.used.modelCalls, 1);
    assert.equal(state.generatedAnswer, undefined); assert.notEqual(state.status, 'completed');
    assert.equal(externalFiles().length, 1); return state;
  }
  function backup() {
    assert.equal(active.size, 0, 'offline snapshot follows actual profile close');
    return backupAgent(profiles, directory, archive, true);
  }
  async function restore(backupDigest: string) {
    assert.equal(active.size, 0);
    const profile = profiles.inspect(directory); assert.equal(profile.status, 'ready');
    if (profile.status !== 'ready') throw new Error('fixture_profile_not_ready');
    const head = inspectAgentHostIdentity(profile, identityOptions); assert.ok(head);
    const before = captureLifecycleTree(directory), archiveBefore = captureLifecycleTree(archive);
    renameSync(directory, preserved);
    const restored = restoreAgentBackup(profiles, archive, directory, backupDigest, true);
    return { restored, before, archiveBefore, async rebind() {
      return rebindRestoredAgentHostIdentity({ kind: 'local', directory, backupDirectory: archive,
        operationId: restored.operationId, expectedBackupDigest: backupDigest, expectedHeadDigest: head.digest, offline: true }, identityOptions);
    }, unchangedOriginals() {
      assert.deepEqual(captureLifecycleTree(preserved), before);
      assert.deepEqual(captureLifecycleTree(archive), archiveBefore);
    } };
  }
  const inspected: AgentRestoreReconciliationReport[] = [];
  let verifications = 0;
  async function report(basis: AgentRestoreReconciliationBasis, signal: AbortSignal): Promise<AgentRestoreReconciliationReport> {
    signal.throwIfAborted(); assert.equal(basis.agentId, ready.identity.agentId); assert.equal(basis.root, directory);
    const profile = profiles.inspect(directory); assert.equal(profile.status, 'ready');
    if (profile.status !== 'ready') throw new Error('fixture_profile_not_ready');
    const originals = stored(), external = externalFiles(), artifacts = new FileArtifactStore(profile.paths.artifacts);
    const states = originals.works.map(row => WorkStateSchema.parse(JSON.parse(String(row.body))));
    const receipts = originals.receipts.map(row => WorkStateSchema.parse(JSON.parse(String(row.body))));
    const unresolved: string[] = [];
    // Scan the complete external inventory, not just attempts visible in the restored snapshot.
    for (const file of external) {
      signal.throwIfAborted(); const record = JSON.parse(file.bytes);
      assert.equal(record.agentId, basis.agentId);
      const state = states.find(value => value.id === record.workId), attempt = state?.attempts.find(value => value.id === record.attemptId);
      if (!state || !attempt?.adopted || attempt.toolId !== WRITE_TOOL || !attempt.resultArtifact ||
          attempt.effectState !== 'confirmed' || !attempt.effectReceipt || !receipts.some(value => value.id === state.id &&
            value.attempts.some(item => item.id === attempt.id && item.adopted && item.resultArtifact?.id === attempt.resultArtifact!.id))) {
        unresolved.push(`unaccounted_external_effect:${record.attemptId}`); continue;
      }
      const result = ToolResultSchema.parse(JSON.parse(Buffer.from(await artifacts.get(attempt.resultArtifact, state.policy)).toString('utf8')));
      const original = await artifacts.get(attempt.effectReceipt.artifact, state.policy);
      if (result.attemptId !== attempt.id || result.effectState !== 'confirmed' || result.status !== 'success' ||
          JSON.stringify(result.effectReceipt) !== JSON.stringify(attempt.effectReceipt) ||
          !Buffer.from(original).equals(Buffer.from(file.bytes))) unresolved.push(`changed_external_effect:${record.attemptId}`);
    }
    for (const state of states) for (const attempt of state.attempts.filter(value => value.effectReceipt?.provider === 'company'))
      if (!external.some(file => file.name === `write-${attempt.id}.json`)) unresolved.push(`missing_external_effect:${attempt.id}`);
    signal.throwIfAborted();
    return { sourceId, sourceRevision: '1', basisDigest: basis.digest, status: unresolved.length ? 'unresolved' : 'consistent',
      sourceHead: sha256(JSON.stringify({ external, originals })), evidence: [
        { reference: 'fixture:restored-work-and-receipt-originals', digest: sha256(JSON.stringify(originals)) },
        ...external.map(file => ({ reference: `fixture:external/${file.name}`, digest: sha256(file.bytes) })),
      ], unresolved };
  }
  const source: AgentRestoreReconciliationSource = { revision: '1', async inspect(basis, signal) {
    const value = await report(basis, signal); inspected.push(structuredClone(value)); return value;
  }, async verify(basis, previous, signal) {
    verifications++; return isDeepStrictEqual(await report(basis, signal), previous);
  } };
  return { base, directory, archive, preserved, profiles, ready, identityOptions, hosts, source, inspected,
    sources: new Map([[sourceId, source]]), open, close, accept, writeAndAdopt, backup, restore, stored, externalFiles,
    counts: () => ({ models: hosts.reduce((sum, host) => sum + host.observed.inputs.length, 0),
      writes: hosts.reduce((sum, host) => sum + host.observed.writes, 0), sends, modelOpens, toolOpens, verifications }) };
}
