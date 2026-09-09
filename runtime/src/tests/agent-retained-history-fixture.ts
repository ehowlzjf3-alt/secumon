import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { readFileSync, renameSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ArtifactSchema } from '../application/contracts.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { WorkflowRuntime } from '../application/workflow-runtime.js';
import type { AgentRestoreReconciliationBasis, AgentRestoreReconciliationReport, AgentRestoreReconciliationSource } from '../application/agent-restore-reconciliation-contracts.js';
import type { AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { backupAgent, restoreAgentBackup } from '../infrastructure/agent-lifecycle.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { inspectAgentHostIdentity } from '../infrastructure/agent-host-identities.js';
import { rebindRestoredAgentHostIdentity } from '../infrastructure/agent-host-identity-recovery.js';
import { inspectAgentRestoreReconciliation, reconcileAgentRestore } from '../infrastructure/agent-restore-reconciliation.js';
import { sha256 } from '../infrastructure/digest.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { RESIDENT_RULE, residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceId = 'fixture-retained-local-ledgers';
const slash = (value: string) => value.split(sep).join('/');

export async function retainedWork(profile: AgentTurnProfile, workId: string) {
  const state = await profile.runtime.state(workId), events = await profile.services.state.events(workId, 0);
  const receipts = await Promise.all(events.map(async event => {
    const receipt = await profile.services.state.receipt(workId, event.commandId); assert.ok(receipt);
    return { commandId: event.commandId, receipt };
  }));
  const publications = await Promise.all(events.filter(event => ['mission_checkpoint', 'resident_checkpoint', 'resident_control'].includes(event.type)).map(async event => {
    const payload = event.data['payload']; assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    const artifact = ArtifactSchema.parse(payload['artifact']);
    const receipt = receipts.find(value => value.commandId === event.commandId)!.receipt;
    assert.ok(receipt.state.artifacts.some(value => isDeepStrictEqual(value, artifact)));
    return { commandId: event.commandId, artifact, bytes: Array.from(await profile.services.artifacts.get(artifact, state.policy)) };
  }));
  return { state, events, receipts, publications };
}

export async function retainedMissionHead(profile: AgentTurnProfile, workId: string) {
  const state = await profile.runtime.state(workId), subscription = state.subscriptions?.find(value => value.provider === 'mission');
  assert.ok(subscription); const artifact = state.artifacts.find(value => subscription.checkpointId === `mission:${value.sha256}`); assert.ok(artifact);
  const receipt = await profile.services.state.receipt(workId, subscription.checkpointId); assert.ok(receipt);
  const bytes = await profile.services.artifacts.get(artifact, state.policy);
  return { state, subscription, artifact, receipt, bytes,
    body: JSON.parse(new TextDecoder().decode(bytes)) as { seen: { id: string; digest: string }[]; cursor: number; pendingRun: boolean;
      events: ReturnType<typeof residentEvent>[]; seenHistory?: { checkpointId: string; revision: number } } };
}

/** Real local backup/rebind/reconciliation; the 512-entry legacy segment is bounded setup, not 512 executed observations. */
export async function retainedHistoryRestoreFixture(t: TestContext, backend: 'sqlite' | 'file-journal') {
  let now = Date.now(), sends = 0;
  t.mock.method(Date, 'now', () => now);
  const send = LocalChannel.prototype.send;
  t.mock.method(LocalChannel.prototype, 'send', async function (this: LocalChannel, ...args: Parameters<typeof send>) {
    sends++; return send.apply(this, args);
  });
  const f = await residentEntryFixture(t, false, { stateBackend: backend }), p = f.current();
  const registered = await f.register(), pause = { commandId: 'backup-original-pause', expectedControlRevision: 0, kind: 'pause' as const };
  const paused = await f.driver().control(registered.workId, pause), pauseRecords = await retainedWork(p, registered.workId);
  const pausePublication = pauseRecords.publications.find(value => pauseRecords.events.find(event => event.commandId === value.commandId)?.revision === paused.appliedStateRevision);
  assert.ok(pausePublication);
  const resumed = await f.driver().control(registered.workId, { commandId: 'backup-later-resume', expectedControlRevision: paused.current.controlRevision, kind: 'resume' });
  await f.driver().control(registered.workId, { commandId: 'backup-later-stop', expectedControlRevision: resumed.current.controlRevision, kind: 'stop' });

  const session = await p.sessions.open(p.actor, { channel: 'test', conversationId: 'retained-event-backup' });
  const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'retained-event-request',
    rawText: 'Observe the original local event stream and keep its exact event identities.', mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits,
    binding: { ...p.executionActor, channel: 'test', conversationId: 'retained-event-backup', recipientId: p.actor.principalId, destination: 'local' } });
  assert.ok(p.missions);
  const rule = { ...RESIDENT_RULE, id: 'retained-event-rule', resourceId: 'retained-event-resource' };
  await p.missions.register(accepted.workId, rule); const initial = await retainedMissionHead(p, accepted.workId);
  const originals = Array.from({ length: 512 }, (_, index) => residentEvent(`legacy-event-${index}`, `Retained original ${index}`));
  const archiveBytes = new TextEncoder().encode(JSON.stringify({ kind: 'fixture_legacy_segment_originals', events: originals }));
  const archived = await p.services.artifacts.put(archiveBytes, { tenantId: p.policy.tenantId, labels: [...p.policy.allowedLabels], mediaType: 'application/json' });
  const seededBody = { ...JSON.parse(new TextDecoder().decode(initial.bytes)), cursor: 42, snapshotDigest: 'legacy-retained-segment',
    nextPollAt: now, seen: originals.map(event => ({ id: event.id, digest: p.services.digester.digest(asJson(event)) })), events: [] };
  const seeded = await p.services.artifacts.put(new TextEncoder().encode(JSON.stringify(seededBody)),
    { tenantId: p.policy.tenantId, labels: [...p.policy.allowedLabels], mediaType: 'application/json' });
  const subscription = { ...initial.subscription, cursor: 42, checkpointId: `mission:${seeded.sha256}` };
  await transact(p.services, accepted.workId, subscription.checkpointId, 'mission_checkpoint', asJson({ subscriptionId: subscription.id, artifact: seeded }), next => {
    next.subscriptions = next.subscriptions!.map(value => value.id === subscription.id ? subscription : value);
    next.artifacts.push(archived, seeded);
  });
  const anchor = await retainedMissionHead(p, accepted.workId), fresh = Array.from({ length: 32 }, (_, index) => residentEvent(`next-segment-${index}`, `New original ${index}`));
  f.pages.first[42] = fresh;
  await p.missions.refresh(accepted.workId); const admitted = await retainedMissionHead(p, accepted.workId);
  assert.deepEqual(admitted.body.events, fresh);
  assert.deepEqual(admitted.body.seenHistory, { checkpointId: anchor.subscription.checkpointId, revision: anchor.receipt.state.revision });
  // The normal execution controller has no plan: this real workflow returns replan without opening a model or inventing a read ACK.
  const workflow = new WorkflowRuntime(p.services, p.runtime, null, p.conversation, p.outbox);
  const settled = await p.missions.tick(accepted.workId, workflow, { maxSteps: 4 }); assert.equal(settled.kind, 'ran');
  if (settled.kind === 'ran') assert.equal(settled.result.control.kind, 'replan');
  const head = await retainedMissionHead(p, accepted.workId); assert.equal(head.body.pendingRun, false); assert.equal(head.subscription.status, 'active');
  const resident = await retainedWork(p, registered.workId), mission = await retainedWork(p, accepted.workId);
  assert.equal(resident.state.artifacts.some(value => value.id === pausePublication.artifact.id), false);
  assert.equal(mission.state.artifacts.some(value => value.id === anchor.artifact.id), false);
  assert.equal(mission.state.artifacts.some(value => value.id === admitted.artifact.id), false);
  const counts = () => ({ sends, polls: f.observed.polls.length, models: f.observed.inputs.first.length + f.observed.inputs.second.length,
    compacts: f.observed.compacts.length });
  const beforeCounts = counts(); assert.equal(beforeCounts.models + beforeCounts.compacts, 0); assert.equal(beforeCounts.polls, 1);
  assert.equal(mission.state.attempts.length + resident.state.attempts.length, 0);
  await f.current().close(); await f.current('second').close();

  const directory = join(f.base, 'first'), backupDirectory = join(f.base, 'retained-backup'), preserved = join(f.base, 'retained-original');
  const profiles = new FileAgentProfileStore(runtimeRoot), profile = profiles.inspect(directory);
  assert.equal(profile.status, 'ready'); if (profile.status !== 'ready') throw new Error('retained_profile_unavailable');
  const identityOptions = { registryDirectory: join(f.base, 'registry'), engineDirectories: [runtimeRoot] };
  const identity = inspectAgentHostIdentity(profile, identityOptions); assert.ok(identity);
  const backupStart = performance.now();
  const backup = backupAgent(profiles, directory, backupDirectory, true), backupMs = performance.now() - backupStart;
  const backupTree = captureLifecycleTree(backupDirectory), artifactDirectory = slash(relative(directory, profile.paths.artifacts));
  for (const publication of [...resident.publications, ...mission.publications]) {
    const path = `${artifactDirectory}/${publication.artifact.id}.blob`, entry = backup.manifest.entries.find(value => value.path === path);
    assert.ok(entry?.kind === 'file'); assert.equal(entry.sha256, publication.artifact.sha256);
    assert.equal(entry.bytes, publication.bytes.length);
    assert.deepEqual(Array.from(readFileSync(join(backupDirectory, 'data', path))), publication.bytes);
  }
  // Backup's read-only SQLite preflight may create coordination sidecars before retirement.
  const beforeTree = captureLifecycleTree(directory);
  renameSync(directory, preserved);
  const restoreStart = performance.now(), restored = restoreAgentBackup(profiles, backupDirectory, directory, backup.manifest.digest, true);
  const restoreMs = performance.now() - restoreStart, rebindStart = performance.now();
  await rebindRestoredAgentHostIdentity({ kind: 'local', directory, backupDirectory, operationId: restored.operationId,
    expectedBackupDigest: backup.manifest.digest, expectedHeadDigest: identity.digest, offline: true }, identityOptions);
  const rebindMs = performance.now() - rebindStart;
  assert.equal(inspectAgentRestoreReconciliation(profiles, directory, identityOptions).status, 'required');

  const stores = [slash(relative(directory, profile.paths.state)), slash(relative(directory, profile.paths.memory)),
    `${slash(relative(directory, profile.paths.metadata))}/channel.sqlite`, artifactDirectory];
  // Match backupInclude's exact SHM exclusions; main DB, WAL and all retained originals remain compared.
  const excludedSharedMemory = new Set(['.secumon/runtime.sqlite-shm', '.secumon/channel.sqlite-shm', 'memory/memory.sqlite-shm']);
  const storedPath = (path: string) => !excludedSharedMemory.has(path) &&
    stores.some(root => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}-`));
  const inventory = backup.manifest.entries.filter(value => storedPath(value.path));
  const parents = new Set(backup.manifest.entries.filter(value => value.kind === 'directory').map(value => value.path));
  const currentInventory = () => captureLifecycleTree(directory, path => parents.has(path) || storedPath(path)).filter(value => storedPath(value.path));
  let inspections = 0, verifications = 0, inventoryFailure: string | undefined;
  const report = (basis: AgentRestoreReconciliationBasis, signal: AbortSignal): AgentRestoreReconciliationReport => {
    signal.throwIfAborted(); assert.equal(basis.agentId, p.agentId); assert.equal(basis.root, directory);
    const actual = currentInventory(), originalStores = captureLifecycleTree(preserved, path => parents.has(path) || storedPath(path)).filter(value => storedPath(value.path));
    const consistent = isDeepStrictEqual(actual, inventory) && isDeepStrictEqual(originalStores, inventory) && isDeepStrictEqual(counts(), beforeCounts);
    if (!consistent) try {
      assert.deepEqual({ restored: actual, preserved: originalStores, counts: counts() },
        { restored: inventory, preserved: inventory, counts: beforeCounts });
    } catch (error) { inventoryFailure = error instanceof Error ? error.message : String(error); }
    return { sourceId, sourceRevision: '1', basisDigest: basis.digest, status: consistent ? 'consistent' : 'unresolved',
      sourceHead: sha256(JSON.stringify({ actual, originalStores, counts: counts() })),
      evidence: [{ reference: 'fixture:retained-local-state-channel-memory-artifacts', digest: sha256(JSON.stringify(actual)) }],
      unresolved: consistent ? [] : ['retained_local_inventory_changed'] };
  };
  const source: AgentRestoreReconciliationSource = { revision: '1', async inspect(basis, signal) { inspections++; return report(basis, signal); },
    async verify(basis, previous, signal) { verifications++; return isDeepStrictEqual(report(basis, signal), previous); } };
  const reconciliationStart = performance.now();
  const reconciliation = await reconcileAgentRestore(profiles, { directory, offline: true }, { ...identityOptions, sources: new Map([[sourceId, source]]) });
  const reconciliationMs = performance.now() - reconciliationStart;
  assert.equal(reconciliation.status, 'reconciled', inventoryFailure); assert.equal(inspections, 1); assert.equal(verifications, 1);
  assert.deepEqual(counts(), beforeCounts);
  await f.reopen();
  const preservation = () => {
    assert.deepEqual(captureLifecycleTree(preserved), beforeTree);
    assert.deepEqual(captureLifecycleTree(backupDirectory), backupTree);
  };
  preservation();
  const files = backup.manifest.entries.filter(value => value.kind === 'file');
  return { f, current: f.current, resident, mission, rule, pause, paused, pausePublication, anchor, admitted, archived, archiveBytes, originals, head,
    counts, beforeCounts, preservation, advance: () => { now += 1000; },
    metrics: { backend, backupEntries: backup.manifest.entries.length, backupFiles: files.length,
      backupFileBytes: files.reduce((sum, value) => sum + value.bytes, 0), backupMs, restoreMs, rebindMs, reconciliationMs,
      retainedPublications: resident.publications.length + mission.publications.length } };
}
